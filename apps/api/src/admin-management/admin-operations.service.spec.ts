import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppEnvironment } from "../config/environment.js";
import { AdminOperationsService } from "./admin-operations.service.js";

describe("AdminOperationsService", () => {
  let directory: string;
  let server: Server | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "classhub-admin-ops-"));
  });
  afterEach(async () => {
    server?.close();
    server = undefined;
    await rm(directory, { force: true, recursive: true });
  });

  const service = (options: { dir?: string; workerUrl?: string }) =>
    new AdminOperationsService(
      new ConfigService<AppEnvironment, true>({
        ...(options.dir === undefined ? {} : { ADMIN_OPERATIONS_STATUS_DIR: options.dir }),
        ADMIN_WORKER_PROCESSING_URL: options.workerUrl ?? "http://127.0.0.1:9/processingz",
        ADMIN_AUDIT_QUARANTINE_REVIEWED_THROUGH: "2026-09-09T23:59:59.999Z",
      }),
    );

  async function worker(body: unknown, status = 200): Promise<string> {
    server = createServer((_request, response) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/processingz`;
  }

  it("passes only counts, times and pass flags from the worker and the status files", async () => {
    const workerUrl = await worker({
      status: "attention",
      quarantineEntries: 130,
      pendingEntries: 0,
      sampledAt: "2026-09-30T10:59:43.946Z",
      latestQuarantineAt: "2026-09-09T11:36:02.007Z",
      conditions: ["quarantine_present", "made_up_condition"],
      databaseFailures: { secret: "connection detail" },
    });
    await writeFile(
      join(directory, "backup-status.json"),
      JSON.stringify({
        status: "native_backup_verified",
        roundTripVerified: true,
        at: "2026-09-30T06:35:34.569Z",
        backup: "backup-20260930T063534569Z",
        sha256: "a".repeat(64),
      }),
    );
    await writeFile(
      join(directory, "backup-restore-status.json"),
      JSON.stringify({
        at: "2026-09-29T22:23:54.644Z",
        passed: true,
        restoredTables: 75,
        ledgerRows: 80,
        catalog: { expectedTables: 75, expectedLedgerRows: 80, id: "b".repeat(64) },
      }),
    );
    await writeFile(
      join(directory, "offline-backup-status.json"),
      JSON.stringify({
        status: "offline_backup_exported",
        at: "2026-09-28T01:00:00.000Z",
        backupAt: "2026-09-27T18:35:00.000Z",
        roundTripVerified: true,
        file: "G:\classhub-backup\secret-path.chob",
      }),
    );

    const result = await service({ dir: directory, workerUrl }).status();

    expect(result).toMatchObject({
      audit_queue: {
        status: "attention",
        quarantine_entries: 130,
        pending_entries: 0,
        sampled_at: "2026-09-30T10:59:43.946Z",
        conditions: ["quarantine_present"],
        latest_quarantined_at: "2026-09-09T11:36:02.007Z",
        quarantine_reviewed_through: "2026-09-09T23:59:59.999Z",
      },
      status_source_configured: true,
      backup: { at: "2026-09-30T06:35:34.569Z", verified: true },
      restore_check: {
        at: "2026-09-29T22:23:54.644Z",
        passed: true,
        tables: 75,
        expected_tables: 75,
        ledger_rows: 80,
        expected_ledger_rows: 80,
      },
      offline_backup: { at: "2026-09-28T01:00:00.000Z", backup_at: "2026-09-27T18:35:00.000Z" },
    });
    // 백업 이름·해시·반출 경로·작업자 내부 오류 내용은 밖으로 나가지 않는다.
    expect(JSON.stringify(result)).not.toMatch(/backup-2026|aaaa|bbbb|secret|connection|chob/u);
  });

  it("still reads the worker body when it answers 503 because something needs attention", async () => {
    const workerUrl = await worker({ status: "attention", quarantineEntries: 130 }, 503);
    expect((await service({ workerUrl }).status()).audit_queue).toMatchObject({
      status: "attention",
      quarantine_entries: 130,
    });
  });

  it("reports unknown instead of failing when the worker or files are missing or malformed", async () => {
    const workerUrl = await worker({ status: "weird", quarantineEntries: -1 });
    await writeFile(join(directory, "backup-status.json"), "{not json");
    await writeFile(
      join(directory, "backup-restore-status.json"),
      JSON.stringify({ at: "2026-09-29T22:23:54.644Z", passed: false, restoredTables: "75" }),
    );

    expect(await service({ dir: directory, workerUrl }).status()).toMatchObject({
      audit_queue: { status: "unknown", quarantine_entries: null },
      backup: null,
      restore_check: null,
      offline_backup: null,
    });
    // 작업자 연결 실패 + 폴더 미설정
    expect(await service({}).status()).toMatchObject({
      audit_queue: null,
      status_source_configured: false,
      backup: null,
      restore_check: null,
    });
  });

  it("marks an unverified backup and a failed restore check instead of hiding them", async () => {
    await writeFile(
      join(directory, "backup-status.json"),
      JSON.stringify({ status: "native_backup_failed", at: "2026-09-30T06:35:34.569Z" }),
    );
    await writeFile(
      join(directory, "backup-restore-status.json"),
      JSON.stringify({
        at: "2026-09-29T22:23:54.644Z",
        passed: false,
        restoredTables: 74,
        ledgerRows: 80,
        catalog: { expectedTables: 75, expectedLedgerRows: 80 },
      }),
    );
    const result = await service({ dir: directory }).status();
    expect(result.backup).toEqual({ at: "2026-09-30T06:35:34.569Z", verified: false });
    expect(result.restore_check).toMatchObject({ passed: false, tables: 74, expected_tables: 75 });
  });
});
