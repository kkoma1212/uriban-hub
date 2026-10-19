import type { DB } from "@classhub/db";
import type { Kysely } from "kysely";

const mariaDbAdapters = new WeakSet<object>();

export function markMariaDbOperatorDatabase(database: Kysely<DB>): Kysely<DB> {
  mariaDbAdapters.add(database.getExecutor().adapter);
  return database;
}

export function isMariaDbOperatorDatabase(database: Kysely<DB>): boolean {
  return mariaDbAdapters.has(database.getExecutor().adapter);
}
