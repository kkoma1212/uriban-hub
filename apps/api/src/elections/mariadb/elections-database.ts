import type { DB } from "@classhub/db";
import type { ConfigService } from "@nestjs/config";
import type { InsertObject, Transaction, UpdateObject } from "kysely";

import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbCount,
  mariaDbDateTime,
  mariaDbId,
  mariaDbInsertId,
  mariaDbNullable,
} from "../../common/database/mariadb-values.js";
import type { AppEnvironment } from "../../config/environment.js";
import type { ClassHubDatabase } from "../../database/database.module.js";
import type { ElectionRow } from "../elections.model.js";

export type ElectionDatabaseEngine = "postgres" | "mariadb";

export const ELECTION_RETURNING = [
  "class_id",
  "closed_at",
  "created_at",
  "created_by_member_id",
  "id",
  "opened_at",
  "published_at",
  "results_visibility",
  "row_version",
  "status",
  "tie_break",
  "tie_break_applied",
  "title",
  "winner_candidate_id",
] as const;

const codec = () =>
  createMariaDbRowCodec({
    id: mariaDbId,
    class_id: mariaDbId,
    member_id: mariaDbId,
    user_id: mariaDbId,
    candidate_id: mariaDbId,
    created_by_member_id: mariaDbId,
    winner_candidate_id: mariaDbNullable(mariaDbId),
    created_at: mariaDbDateTime,
    opened_at: mariaDbNullable(mariaDbDateTime),
    closed_at: mariaDbNullable(mariaDbDateTime),
    published_at: mariaDbNullable(mariaDbDateTime),
    deleted_at: mariaDbNullable(mariaDbDateTime),
    is_active: mariaDbBoolean,
    temporary_password_must_change: mariaDbNullable(mariaDbBoolean),
    tie_break_applied: mariaDbBoolean,
    vote_count: mariaDbCount,
    total: mariaDbCount,
  });

export function electionDatabase(
  database: ClassHubDatabase,
  config?: ConfigService<AppEnvironment, true>,
) {
  const engine: ElectionDatabaseEngine =
    config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
  if (engine !== "postgres" && engine !== "mariadb") throw new Error("Unsupported database engine");
  return { database: engine === "mariadb" ? database.withPlugin(codec()) : database, engine };
}

export const electionTransaction = (
  transaction: Transaction<DB>,
  engine: ElectionDatabaseEngine,
) => (engine === "mariadb" ? transaction.withPlugin(codec()) : transaction);

export async function insertElection(
  transaction: Transaction<DB>,
  values: InsertObject<DB, "elections">,
  engine: ElectionDatabaseEngine,
): Promise<ElectionRow> {
  const insert = transaction.insertInto("elections").values(values);
  if (engine === "postgres") return insert.returning(ELECTION_RETURNING).executeTakeFirstOrThrow();
  const result = await insert.executeTakeFirstOrThrow();
  return transaction
    .selectFrom("elections")
    .select(ELECTION_RETURNING)
    .where("id", "=", mariaDbInsertId(result.insertId))
    .where("class_id", "=", values.class_id as string)
    .executeTakeFirstOrThrow();
}

export async function insertElectionCandidate(
  transaction: Transaction<DB>,
  values: InsertObject<DB, "election_candidates">,
  engine: ElectionDatabaseEngine,
): Promise<{ id: string }> {
  const insert = transaction.insertInto("election_candidates").values(values);
  if (engine === "postgres") return insert.returning("id").executeTakeFirstOrThrow();
  return { id: mariaDbInsertId((await insert.executeTakeFirstOrThrow()).insertId) };
}

export async function updateElection(
  transaction: Transaction<DB>,
  electionId: string,
  values: UpdateObject<DB, "elections">,
  engine: ElectionDatabaseEngine,
): Promise<ElectionRow> {
  // Every caller already holds the class and election row locks. No retry or upsert.
  const update = transaction.updateTable("elections").set(values).where("id", "=", electionId);
  if (engine === "postgres") return update.returning(ELECTION_RETURNING).executeTakeFirstOrThrow();
  const result = await update.executeTakeFirstOrThrow();
  if (result.numUpdatedRows !== 1n) throw new Error("Election update did not affect one row");
  return transaction
    .selectFrom("elections")
    .select(ELECTION_RETURNING)
    .where("id", "=", electionId)
    .executeTakeFirstOrThrow();
}
