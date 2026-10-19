import type { DB, JsonValue } from "@classhub/db";
import {
  sql,
  type InsertQueryBuilder,
  type InsertResult,
  type Kysely,
  type RawBuilder,
} from "kysely";
import { isMariaDbOperatorDatabase } from "./operator-engine.js";

export function operatorJson(database: Kysely<DB>, value: unknown): RawBuilder<JsonValue> {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("운영 감사 JSON 값이 비어 있습니다.");
  return isMariaDbOperatorDatabase(database)
    ? sql<JsonValue>`${text}`
    : sql<JsonValue>`${text}::jsonb`;
}

export function operatorDate(database: Kysely<DB>, value: string): RawBuilder<Date> {
  return isMariaDbOperatorDatabase(database)
    ? sql<Date>`CAST(${value} AS DATE)`
    : sql<Date>`${value}::date`;
}

export function operatorDateText(database: Kysely<DB>, column: string): RawBuilder<string> {
  return isMariaDbOperatorDatabase(database)
    ? sql<string>`DATE_FORMAT(${sql.ref(column)},'%Y-%m-%d')`
    : sql<string>`${sql.ref(column)}::text`;
}

export function operatorNow(database: Kysely<DB>): RawBuilder<Date> {
  return isMariaDbOperatorDatabase(database)
    ? sql<Date>`UTC_TIMESTAMP(6)`
    : sql<Date>`clock_timestamp()`;
}

export function operatorTimestamp(value: Date | string): Date {
  if (value instanceof Date) return value;
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u.test(value)) {
    throw new Error("운영 DB의 UTC 시각 형식이 올바르지 않습니다.");
  }
  const date = new Date(value.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) throw new Error("운영 DB의 UTC 시각이 올바르지 않습니다.");
  return date;
}

export function parseOperatorJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

export async function operatorInsertedId<T extends "operators" | "users" | "admin_accounts">(
  database: Kysely<DB>,
  query: InsertQueryBuilder<DB, T, InsertResult>,
): Promise<string> {
  if (!isMariaDbOperatorDatabase(database)) {
    const result = await query.returning(sql<string>`id`.as("id")).executeTakeFirstOrThrow();
    return result.id;
  }
  const result = await query.executeTakeFirstOrThrow();
  if (result.insertId === undefined || result.insertId <= 0n) {
    throw new Error("운영 DB의 새 행 번호를 확인할 수 없습니다.");
  }
  return result.insertId.toString();
}
