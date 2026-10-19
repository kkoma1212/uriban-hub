import { sql } from "kysely";

export type SupplyDatabaseEngine = "postgres" | "mariadb";

export const supplyDate = (value: string, engine: SupplyDatabaseEngine) =>
  engine === "mariadb" ? sql<Date>`CAST(${value} AS DATE)` : sql<Date>`${value}::date`;

export const supplyBigint = (value: string, engine: SupplyDatabaseEngine) =>
  engine === "mariadb" ? sql<string>`CAST(${value} AS SIGNED)` : sql<string>`${value}::bigint`;

/** Use an explicit escape character so MariaDB SQL string escaping cannot reinterpret it. */
export function supplySearchPattern(term: string): string {
  return `%${term.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
}

export const supplyProjection = [
  "audience_mode",
  "category",
  "content_revision",
  "description",
  "id",
  "needed_on",
  "row_version",
  "title",
] as const;
