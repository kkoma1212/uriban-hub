import type { SecurityAuditWorkerCycleResult } from "./security-audit-worker.js";
import {
  SECURITY_AUDIT_STORE_FAILURE_REASONS,
  type SecurityAuditStoreFailureCounts,
} from "./store-failure.js";

const SAMPLE_INTERVAL_MS = 15_000;
const SAMPLE_TIMEOUT_MS = 2_000;
const STALE_AFTER_MS = 45_000;
const LOG_INTERVAL_MS = 60_000;

export interface SecurityAuditQueueMetadata {
  queueEntries: number;
  pendingEntries: number;
  undeliveredLag: number | null;
  oldestPendingEnqueuedAtMs: number | null;
  quarantineEntries: number;
  /** When the newest quarantined entry was added (its stream ID time); null when none. */
  latestQuarantineAtMs: number | null;
}

export interface SecurityAuditProcessingSnapshot {
  /** Attempts since this worker started; not distinct events or historical DLQ causes. */
  databaseFailures: SecurityAuditStoreFailureCounts;
  status: "ok" | "attention" | "degraded" | "unknown";
  conditions: string[];
  sampledAt: string | null;
  cycleStartedAt: string | null;
  cycleCompletedAt: string | null;
  lastDbHandledAt: string | null;
  lastDeferredAt: string | null;
  deferredSince: string | null;
  acknowledgedAttempts: number;
  deferredAttempts: number;
  deadLetteredAttempts: number;
  invalidAttempts: number;
  queueEntries: number | null;
  pendingEntries: number | null;
  undeliveredLag: number | null;
  oldestPendingAgeMs: number | null;
  quarantineEntries: number | null;
  latestQuarantineAt: string | null;
}

interface ProcessingStatusOptions {
  readMetadata: () => Promise<SecurityAuditQueueMetadata>;
  log: (snapshot: SecurityAuditProcessingSnapshot) => void;
  now?: () => number;
  monotonicNow?: () => number;
}

function addAttempts(current: number, count: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + count);
}

/** Operational progress is deliberately independent of process/dependency readiness. */
export class SecurityAuditProcessingStatus {
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private metadata: SecurityAuditQueueMetadata | undefined;
  private sampledAt: string | null = null;
  private sampledAtTick = Number.NEGATIVE_INFINITY;
  private nextSampleTick = Number.NEGATIVE_INFINITY;
  private lastLogTick = Number.NEGATIVE_INFINITY;
  private lastCriticalLogTick = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | undefined;
  private metadataUnavailable = true;
  private cycleFailed = false;
  private cycleStartedTick: number | undefined;
  private deferredGeneration = 0;
  private readonly databaseFailures: SecurityAuditStoreFailureCounts = {};
  private readonly progress = {
    cycleStartedAt: null as string | null,
    cycleCompletedAt: null as string | null,
    lastDbHandledAt: null as string | null,
    lastDeferredAt: null as string | null,
    deferredSince: null as string | null,
    acknowledgedAttempts: 0,
    deferredAttempts: 0,
    deadLetteredAttempts: 0,
    invalidAttempts: 0,
  };

  constructor(private readonly options: ProcessingStatusOptions) {
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  cycleStarted(): void {
    this.progress.cycleStartedAt = new Date(this.now()).toISOString();
    this.cycleStartedTick = this.monotonicNow();
  }

  cycleCompleted(result: SecurityAuditWorkerCycleResult): void {
    for (const reason of SECURITY_AUDIT_STORE_FAILURE_REASONS) {
      const count = result.databaseFailures?.[reason];
      if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) {
        this.databaseFailures[reason] = addAttempts(this.databaseFailures[reason] ?? 0, count);
      }
    }
    const timestamp = new Date(this.now()).toISOString();
    this.progress.cycleCompletedAt = timestamp;
    this.cycleStartedTick = undefined;
    this.cycleFailed = false;
    this.progress.acknowledgedAttempts = addAttempts(
      this.progress.acknowledgedAttempts,
      result.acknowledged,
    );
    this.progress.deferredAttempts = addAttempts(this.progress.deferredAttempts, result.deferred);
    this.progress.deadLetteredAttempts = addAttempts(
      this.progress.deadLetteredAttempts,
      result.deadLettered,
    );
    this.progress.invalidAttempts = addAttempts(this.progress.invalidAttempts, result.invalid);
    // ACK includes idempotent/already-handled events; it is not an insertion counter.
    if (result.acknowledged > 0) this.progress.lastDbHandledAt = timestamp;
    const firstDeferred = result.deferred > 0 && this.progress.deferredSince === null;
    if (result.deferred > 0) {
      this.progress.lastDeferredAt = timestamp;
      this.progress.deferredSince ??= timestamp;
      this.deferredGeneration += 1;
    }
    this.logIfDue(firstDeferred);
  }

  cycleErrored(): void {
    this.cycleStartedTick = undefined;
    this.cycleFailed = true;
    this.logIfDue();
  }

  /** Never await telemetry in the worker loop. At most one unresolved sample exists. */
  sampleIfDue(): void {
    if (this.inFlight !== undefined || this.monotonicNow() < this.nextSampleTick) return;
    this.nextSampleTick = this.monotonicNow() + SAMPLE_INTERVAL_MS;
    const generation = this.deferredGeneration;
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      this.metadataUnavailable = true;
      this.logIfDue();
    }, SAMPLE_TIMEOUT_MS);
    timer.unref();
    const flight = Promise.resolve()
      .then(this.options.readMetadata)
      .then((metadata) => {
        if (expired) return;
        this.metadata = metadata;
        this.sampledAt = new Date(this.now()).toISOString();
        this.sampledAtTick = this.monotonicNow();
        this.metadataUnavailable = false;
        if (
          generation === this.deferredGeneration &&
          metadata.queueEntries === 0 &&
          metadata.pendingEntries === 0 &&
          metadata.undeliveredLag === 0
        ) {
          this.progress.deferredSince = null;
        }
      })
      .catch(() => {
        this.metadataUnavailable = true;
      })
      .finally(() => {
        clearTimeout(timer);
        if (this.inFlight === flight) this.inFlight = undefined;
        this.logIfDue();
      });
    this.inFlight = flight;
  }

  snapshot(): SecurityAuditProcessingSnapshot {
    const conditions: string[] = [];
    const tick = this.monotonicNow();
    const metadata = this.metadata;
    const oldestTimestamp = metadata?.oldestPendingEnqueuedAtMs;
    const age = oldestTimestamp == null ? null : this.now() - oldestTimestamp;
    const oldestPendingAgeMs = age !== null && age >= 0 ? age : null;
    if (this.progress.deferredSince !== null) conditions.push("database_deferred");
    if (this.cycleFailed) conditions.push("cycle_failed");
    if (this.cycleStartedTick !== undefined && tick - this.cycleStartedTick >= LOG_INTERVAL_MS) {
      conditions.push("cycle_overdue");
    }
    if (this.metadataUnavailable) conditions.push("metadata_unavailable");
    if (tick - this.sampledAtTick >= STALE_AFTER_MS) conditions.push("metadata_stale");
    if (metadata !== undefined) {
      if (metadata.undeliveredLag === null) conditions.push("lag_unknown");
      if (metadata.pendingEntries > 0 && oldestPendingAgeMs === null)
        conditions.push("pending_age_unknown");
      if (
        metadata.queueEntries > 0 ||
        metadata.pendingEntries > 0 ||
        (metadata.undeliveredLag ?? 0) > 0
      ) {
        conditions.push("queue_backlog");
      }
      if (metadata.quarantineEntries > 0) conditions.push("quarantine_present");
    }
    const degraded =
      this.progress.deferredSince !== null ||
      this.cycleFailed ||
      conditions.includes("cycle_overdue");
    const unknown = conditions.some(
      (value) => value.endsWith("unknown") || value.startsWith("metadata_"),
    );
    return {
      status: degraded
        ? "degraded"
        : unknown
          ? "unknown"
          : conditions.length > 0
            ? "attention"
            : "ok",
      conditions,
      sampledAt: this.sampledAt,
      ...this.progress,
      databaseFailures: { ...this.databaseFailures },
      queueEntries: metadata?.queueEntries ?? null,
      pendingEntries: metadata?.pendingEntries ?? null,
      undeliveredLag: metadata?.undeliveredLag ?? null,
      oldestPendingAgeMs,
      quarantineEntries: metadata?.quarantineEntries ?? null,
      latestQuarantineAt:
        metadata?.latestQuarantineAtMs == null
          ? null
          : new Date(metadata.latestQuarantineAtMs).toISOString(),
    };
  }

  private logIfDue(firstDeferred = false): void {
    const tick = this.monotonicNow();
    // A startup/healthy sample must not hide the first persistence failure.
    // Independently cap this exception so rapid drain/fail cycles cannot flood logs.
    const criticalDue = firstDeferred && tick - this.lastCriticalLogTick >= LOG_INTERVAL_MS;
    if (!criticalDue && tick - this.lastLogTick < LOG_INTERVAL_MS) return;
    if (criticalDue) this.lastCriticalLogTick = tick;
    this.lastLogTick = tick;
    try {
      this.options.log(this.snapshot());
    } catch {
      // Observability must not change persistence, acknowledgement, or retry behavior.
    }
  }
}
