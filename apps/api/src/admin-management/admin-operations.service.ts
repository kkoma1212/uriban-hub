import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AppEnvironment } from "../config/environment.js";

const WORKER_TIMEOUT_MS = 2_000;
const AUDIT_STATUSES = ["ok", "attention", "degraded", "unknown"] as const;
// 작업자 계약의 상태 사유 목록(OPERATIONS audit-health-policy와 같음). 모르는 값은 버린다.
const AUDIT_CONDITIONS = new Set([
  "database_deferred",
  "cycle_failed",
  "cycle_overdue",
  "metadata_unavailable",
  "metadata_stale",
  "lag_unknown",
  "pending_age_unknown",
  "queue_backlog",
  "quarantine_present",
]);
type AuditQueueStatus = (typeof AUDIT_STATUSES)[number];

/** 운영 상태: 숫자·시각·통과 여부만(경로·해시·키·백업 이름은 보내지 않는다). 못 읽으면 null. */
export interface AdminOperationsStatus {
  generated_at: string;
  /** 보안 감사 기록 처리(작업자). 격리 = 저장에 실패해 따로 보관된 기록 수 */
  audit_queue: {
    status: AuditQueueStatus;
    quarantine_entries: number | null;
    pending_entries: number | null;
    sampled_at: string | null;
    /** 상태 사유(작업자 계약의 알려진 값만) */
    conditions: string[];
    /** 가장 최근 격리 시각 */
    latest_quarantined_at: string | null;
    /** 운영자가 확인을 마친 격리의 마지막 시각 — 이때까지의 격리는 과거 건으로 보인다 */
    quarantine_reviewed_through: string | null;
  } | null;
  /** 이 서버에 백업 상태 폴더가 설정됐는지 — false면 아래 두 값은 항상 null */
  status_source_configured: boolean;
  backup: { at: string; verified: boolean } | null;
  /** 최근 격리 복원 검증. 표·원장 수 = 그 시점의 DB 설치 상태 */
  restore_check: {
    at: string;
    passed: boolean;
    tables: number;
    expected_tables: number;
    ledger_rows: number;
    expected_ledger_rows: number;
  } | null;
  /** PC 밖(USB) 반출: 마지막 반출 시각과 그때 담은 백업 시각. 반출한 적 없거나 못 읽으면 null */
  offline_backup: { at: string; backup_at: string } | null;
}

const isoTime = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const count = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

@Injectable()
export class AdminOperationsService {
  private readonly statusDirectory: string | undefined;
  private readonly workerUrl: string;
  private readonly quarantineReviewedThrough: string | null;

  constructor(config: ConfigService<AppEnvironment, true>) {
    this.statusDirectory = config.get("ADMIN_OPERATIONS_STATUS_DIR", { infer: true });
    this.workerUrl = config.get("ADMIN_WORKER_PROCESSING_URL", { infer: true });
    this.quarantineReviewedThrough = isoTime(
      config.get("ADMIN_AUDIT_QUARANTINE_REVIEWED_THROUGH", { infer: true }),
    );
  }

  async status(): Promise<AdminOperationsStatus> {
    const [auditQueue, backup, restore, offline] = await Promise.all([
      this.auditQueue(),
      this.readStatusFile("backup-status.json"),
      this.readStatusFile("backup-restore-status.json"),
      this.readStatusFile("offline-backup-status.json"),
    ]);
    return {
      generated_at: new Date().toISOString(),
      audit_queue: auditQueue,
      status_source_configured: this.statusDirectory !== undefined,
      backup: this.backup(backup),
      restore_check: this.restoreCheck(restore),
      offline_backup: this.offlineBackup(offline),
    };
  }

  private async auditQueue(): Promise<AdminOperationsStatus["audit_queue"]> {
    try {
      const response = await fetch(this.workerUrl, {
        signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
      });
      // 작업자는 상태가 ok가 아니면 503과 함께 같은 상태 본문을 보낸다 — 코드가 아니라 본문을 읽는다.
      const body = record(await response.json());
      if (body === null) return null;
      const status = AUDIT_STATUSES.find((value) => value === body.status) ?? "unknown";
      return {
        status,
        quarantine_entries: count(body.quarantineEntries),
        pending_entries: count(body.pendingEntries),
        sampled_at: isoTime(body.sampledAt),
        conditions: Array.isArray(body.conditions)
          ? body.conditions.filter(
              (value): value is string => typeof value === "string" && AUDIT_CONDITIONS.has(value),
            )
          : [],
        latest_quarantined_at: isoTime(body.latestQuarantineAt),
        quarantine_reviewed_through: this.quarantineReviewedThrough,
      };
    } catch {
      // 작업자가 꺼져 있거나 다른 기계에 있으면 "확인 불가"로 보인다.
      return null;
    }
  }

  // 파일 이름은 위 세 개로 고정 — 요청 값으로 경로를 만들지 않는다.
  private async readStatusFile(name: string): Promise<Record<string, unknown> | null> {
    if (this.statusDirectory === undefined) return null;
    try {
      return record(JSON.parse(await readFile(join(this.statusDirectory, name), "utf8")));
    } catch {
      return null;
    }
  }

  private backup(file: Record<string, unknown> | null): AdminOperationsStatus["backup"] {
    const at = isoTime(file?.at);
    if (file === null || at === null) return null;
    return {
      at,
      verified: file.status === "native_backup_verified" && file.roundTripVerified === true,
    };
  }

  private offlineBackup(
    file: Record<string, unknown> | null,
  ): AdminOperationsStatus["offline_backup"] {
    const at = isoTime(file?.at);
    const backupAt = isoTime(file?.backupAt);
    if (file?.status !== "offline_backup_exported" || at === null || backupAt === null) return null;
    return { at, backup_at: backupAt };
  }

  private restoreCheck(
    file: Record<string, unknown> | null,
  ): AdminOperationsStatus["restore_check"] {
    const at = isoTime(file?.at);
    const catalog = record(file?.catalog);
    const tables = count(file?.restoredTables);
    const ledgerRows = count(file?.ledgerRows);
    const expectedTables = count(catalog?.expectedTables);
    const expectedLedgerRows = count(catalog?.expectedLedgerRows);
    if (
      file === null ||
      at === null ||
      tables === null ||
      ledgerRows === null ||
      expectedTables === null ||
      expectedLedgerRows === null
    )
      return null;
    return {
      at,
      passed: file.passed === true,
      tables,
      expected_tables: expectedTables,
      ledger_rows: ledgerRows,
      expected_ledger_rows: expectedLedgerRows,
    };
  }
}
