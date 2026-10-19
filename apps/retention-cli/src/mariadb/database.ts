import {
  boundedMariaDbPoolFactory,
  createMariaDbDatabase,
  type DB,
  type MariaDbConnectionOptions,
  type MariaDbPoolFactory,
} from "@classhub/db";
import { sql } from "kysely";
import type { RetentionDatabase } from "../database.js";
import { RetentionMariaDbError } from "./errors.js";

export type RetentionMariaDbOptions = Omit<
  MariaDbConnectionOptions,
  "runtimeRole" | "runtimeGrantProfile" | "accountHost"
> & {
  accountHost: string;
  mailLogsGrantInstalled?: boolean;
  auditConsentsGrantInstalled?: boolean;
  adminRecordsGrantInstalled?: boolean;
  classArchivesGrantProfile?: "none" | "active" | "legacy";
};

export async function openRetentionMariaDbDatabase(
  createPool: MariaDbPoolFactory,
  options: RetentionMariaDbOptions,
): Promise<RetentionDatabase> {
  let database: RetentionDatabase | undefined;
  const {
    mailLogsGrantInstalled = false,
    auditConsentsGrantInstalled = false,
    adminRecordsGrantInstalled = false,
    classArchivesGrantProfile = "none",
    ...connection
  } = options;
  // 권한 검사는 정확히 일치해야 하므로 DB에 넣은 권한 단계와 같은 묶음을 고른다.
  const runtimeGrantProfile =
    classArchivesGrantProfile === "legacy"
      ? "retention_class_archives_legacy_v1"
      : classArchivesGrantProfile === "active"
        ? "retention_class_archives_v1"
        : adminRecordsGrantInstalled
          ? "retention_admin_records_v1"
          : auditConsentsGrantInstalled
            ? "retention_audit_consents_v1"
            : mailLogsGrantInstalled
              ? "retention_mail_logs_v1"
              : "retention_v1";
  try {
    database = createMariaDbDatabase<DB>(
      boundedMariaDbPoolFactory(
        createPool,
        () => false,
        undefined,
        (reason) => new RetentionMariaDbError(reason),
        10000,
      ),
      {
        ...connection,
        runtimeRole: "retention",
        runtimeGrantProfile,
      },
    );
    // Every lease attests exact identity/TLS/baseline 45 + immutable lock SELECT.
    const result = await sql<{ ready: number }>`SELECT 1 AS ready`.execute(database);
    if (result.rows.length !== 1 || result.rows[0]?.ready !== 1)
      throw new RetentionMariaDbError("role");
    return database;
  } catch {
    if (database) {
      try {
        await database.destroy();
      } catch {
        throw new RetentionMariaDbError("cleanup");
      }
    }
    throw new RetentionMariaDbError(database ? "role" : "configuration");
  }
}
