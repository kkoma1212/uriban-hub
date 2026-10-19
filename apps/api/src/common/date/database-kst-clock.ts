import type { DB } from "@classhub/db";
import { sql, type Kysely } from "kysely";

/**
 * 요청에서 사용할 한국 표준시의 오늘을 DB clock으로 한 번 확정한다.
 * 호출자는 반환값을 같은 요청의 모든 날짜 조건에 전달해야 한다.
 */
export async function readDatabaseKstToday(
  database: Kysely<DB>,
  dialect: "postgres" | "mariadb" = "postgres",
): Promise<string> {
  const selection =
    dialect === "mariadb"
      ? sql<string>`DATE_FORMAT(UTC_TIMESTAMP(6) + INTERVAL 9 HOUR, '%Y-%m-%d')`
      : sql<string>`to_char(
          (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date,
          'YYYY-MM-DD'
        )`;
  const row = await database.selectNoFrom(selection.as("server_today")).executeTakeFirstOrThrow();

  return row.server_today;
}
