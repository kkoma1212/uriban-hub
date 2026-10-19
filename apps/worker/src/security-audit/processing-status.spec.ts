import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SecurityAuditProcessingStatus,
  type SecurityAuditQueueMetadata,
} from "./processing-status.js";

const empty: SecurityAuditQueueMetadata = {
  queueEntries: 0,
  pendingEntries: 0,
  undeliveredLag: 0,
  oldestPendingEnqueuedAtMs: null,
  quarantineEntries: 0,
  latestQuarantineAtMs: null,
};
const idle = { acknowledged: 0, deferred: 0, deadLettered: 0, invalid: 0 };

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
  const readMetadata = vi.fn(async () => ({ ...empty }));
  const log = vi.fn();
  const status = new SecurityAuditProcessingStatus({ readMetadata, log });
  return { status, readMetadata, log };
}

async function sample(status: SecurityAuditProcessingStatus): Promise<void> {
  status.sampleIfDue();
  await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => vi.useRealTimers());

describe("SecurityAuditProcessingStatus", () => {
  it("counts failure attempts without exposing input fields or resetting them after recovery", async () => {
    const { status, log } = fixture();
    await sample(status);
    const failures = { reference_missing: 2, permission_denied: 1, unknown: 1, secret: 99 };
    status.cycleCompleted({ ...idle, deferred: 4, databaseFailures: failures });
    expect(status.snapshot().databaseFailures).toEqual({
      reference_missing: 2,
      permission_denied: 1,
      unknown: 1,
    });
    expect(log.mock.calls.at(-1)?.[0].databaseFailures).toEqual(status.snapshot().databaseFailures);
    failures.reference_missing = 100;
    status.snapshot().databaseFailures.reference_missing = 200;
    status.cycleCompleted({ ...idle, databaseFailures: { reference_missing: 1 } });
    status.cycleCompleted({ ...idle, acknowledged: 1 });
    await vi.advanceTimersByTimeAsync(15_000);
    await sample(status);
    expect(status.snapshot()).toMatchObject({
      status: "ok",
      databaseFailures: { reference_missing: 3, permission_denied: 1, unknown: 1 },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  it("ignores invalid category counts and saturates valid attempts", () => {
    const { status } = fixture();
    status.cycleCompleted({
      ...idle,
      databaseFailures: {
        unknown: Number.MAX_SAFE_INTEGER,
        permission_denied: -1,
        reference_missing: Number.NaN,
        contention: 0.5,
      },
    });
    status.cycleCompleted({ ...idle, databaseFailures: { unknown: 1 } });
    expect(status.snapshot().databaseFailures).toEqual({ unknown: Number.MAX_SAFE_INTEGER });
  });
  it("logs the first deferred transition immediately after startup and caps repeated recover/fail transitions", async () => {
    const { status, log } = fixture();
    await sample(status);
    expect(log).toHaveBeenCalledTimes(1);
    status.cycleCompleted({ ...idle, deferred: 1 });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0]).toMatchObject({ status: "degraded", deferredAttempts: 1 });
    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      await sample(status);
      status.cycleCompleted({ ...idle, deferred: 1 });
    }
    expect(log).toHaveBeenCalledTimes(2);
    expect(status.snapshot().deferredAttempts).toBe(4);
    await vi.advanceTimersByTimeAsync(15_000);
    await sample(status);
    status.cycleCompleted({ ...idle, deferred: 1 });
    expect(log).toHaveBeenCalledTimes(4);
    expect(log.mock.calls[3]?.[0]).toMatchObject({ status: "degraded", deferredAttempts: 5 });
  });

  it("starts unknown and restores persisted quarantine visibility without running a cycle", async () => {
    const { status, readMetadata } = fixture();
    expect(status.snapshot().status).toBe("unknown");
    readMetadata.mockResolvedValue({
      ...empty,
      quarantineEntries: 130,
      latestQuarantineAtMs: Date.parse("2026-09-09T07:40:00.000Z"),
    });
    await sample(status);
    expect(status.snapshot()).toMatchObject({
      status: "attention",
      quarantineEntries: 130,
      latestQuarantineAt: "2026-09-09T07:40:00.000Z",
      conditions: ["quarantine_present"],
    });
  });

  it("latches a DB failure across idle cycles and other successful ACKs until the queue drains", async () => {
    const { status, readMetadata } = fixture();
    const pending = {
      ...empty,
      queueEntries: 1,
      pendingEntries: 1,
      oldestPendingEnqueuedAtMs: Date.now() - 10_000,
    };
    readMetadata.mockResolvedValue(pending);
    status.cycleStarted();
    status.cycleCompleted({ ...idle, deferred: 1 });
    const since = status.snapshot().deferredSince;
    await sample(status);
    for (let index = 0; index < 60; index += 1) status.cycleCompleted(idle);
    status.cycleCompleted({ ...idle, acknowledged: 1 });
    expect(status.snapshot()).toMatchObject({
      status: "degraded",
      deferredSince: since,
      deferredAttempts: 1,
      acknowledgedAttempts: 1,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await sample(status);
    expect(status.snapshot().status).toBe("degraded");
    readMetadata.mockResolvedValue(empty);
    await vi.advanceTimersByTimeAsync(15_000);
    await sample(status);
    expect(status.snapshot()).toMatchObject({
      status: "ok",
      deferredSince: null,
      deferredAttempts: 1,
    });
  });

  it("does not let a metadata sample started before a new DB failure clear that failure", async () => {
    const { status, readMetadata } = fixture();
    let settle!: (value: SecurityAuditQueueMetadata) => void;
    readMetadata.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await sample(status);
    status.cycleCompleted({ ...idle, deferred: 1 });
    settle(empty);
    await vi.advanceTimersByTimeAsync(0);
    expect(status.snapshot().status).toBe("degraded");
    await vi.advanceTimersByTimeAsync(15_000);
    await sample(status);
    expect(status.snapshot().status).toBe("ok");
  });

  it("bounds unresolved telemetry to one flight, rejects late success, and recovers on a fresh sample", async () => {
    const { status, readMetadata } = fixture();
    let settle!: (value: SecurityAuditQueueMetadata) => void;
    readMetadata.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await sample(status);
    await vi.advanceTimersByTimeAsync(2_001);
    for (let index = 0; index < 20; index += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      await sample(status);
    }
    expect(readMetadata).toHaveBeenCalledOnce();
    expect(status.snapshot().status).toBe("unknown");
    settle(empty);
    await vi.advanceTimersByTimeAsync(0);
    expect(status.snapshot().sampledAt).toBeNull();
    await sample(status);
    expect(readMetadata).toHaveBeenCalledTimes(2);
    expect(status.snapshot().status).toBe("ok");
  });

  it.each([
    { ...empty, undeliveredLag: null },
    { ...empty, queueEntries: 1, pendingEntries: 1 },
    {
      ...empty,
      queueEntries: 1,
      pendingEntries: 1,
      oldestPendingEnqueuedAtMs: Date.parse("2027-01-01"),
    },
  ])("does not hide unknown lag or unknown/future pending age", async (metadata) => {
    const { status, readMetadata } = fixture();
    readMetadata.mockResolvedValue(metadata);
    await sample(status);
    expect(status.snapshot().status).toBe("unknown");
    expect(status.snapshot().oldestPendingAgeMs).toBeNull();
  });

  it("keeps a deferred latch when lag is unknown despite empty counts", async () => {
    const { status, readMetadata } = fixture();
    status.cycleCompleted({ ...idle, deferred: 1 });
    readMetadata.mockResolvedValue({ ...empty, undeliveredLag: null });
    await sample(status);
    expect(status.snapshot().conditions).toContain("database_deferred");
  });

  it("reports stale samples, long cycles, and failed cycles without reporting healthy processing", async () => {
    const { status } = fixture();
    await sample(status);
    status.cycleStarted();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(status.snapshot().conditions).toEqual(
      expect.arrayContaining(["metadata_stale", "cycle_overdue"]),
    );
    status.cycleErrored();
    expect(status.snapshot().conditions).toContain("cycle_failed");
    status.cycleCompleted(idle);
    await sample(status);
    expect(status.snapshot().status).toBe("ok");
  });

  it("bounds logs and counters, and swallows log failures without changing results", async () => {
    const { status, log } = fixture();
    log.mockImplementation(() => {
      throw new Error("private logger failure");
    });
    for (let index = 0; index < 100; index += 1) {
      expect(() =>
        status.cycleCompleted({ ...idle, acknowledged: Number.MAX_SAFE_INTEGER }),
      ).not.toThrow();
    }
    await sample(status);
    expect(log).toHaveBeenCalledOnce();
    expect(status.snapshot().acknowledgedAttempts).toBe(Number.MAX_SAFE_INTEGER);
    await vi.advanceTimersByTimeAsync(60_000);
    status.cycleCompleted(idle);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("never exposes dependency error text", async () => {
    const { status, readMetadata, log } = fixture();
    readMetadata.mockRejectedValue(new Error("redis://secret@private/event-body"));
    await sample(status);
    expect(status.snapshot().conditions).toContain("metadata_unavailable");
    expect(JSON.stringify([status.snapshot(), log.mock.calls])).not.toMatch(
      /secret|private|event-body/u,
    );
  });
});
