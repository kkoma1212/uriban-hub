import { assertPostgresRuntimeRole, createDatabase, type DB } from "@classhub/db";
import type { Kysely } from "kysely";

export type RetentionDatabase = Kysely<DB>;

export async function openRetentionDatabase(connectionString: string): Promise<RetentionDatabase> {
  const database = createDatabase<DB>(connectionString, {
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });
  try {
    await assertPostgresRuntimeRole(database, {
      expectedRole: "classhub_retention",
      runtimeName: "retention CLI",
    });
    return database;
  } catch (attestationError) {
    try {
      await database.destroy();
    } catch {
      throw new Error("retention DB 역할 검증 실패 후 연결 정리에도 실패했습니다.");
    }
    throw attestationError;
  }
}
