import { sql } from "kysely";
import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbCount,
  mariaDbDateOnly,
  mariaDbId,
  mariaDbNullable,
  mariaDbTimestamp,
} from "../../common/database/mariadb-values.js";
import type { ClassHubDatabase } from "../../database/database.module.js";
import type { NoticeAccessContext } from "../../notices/notices-access.service.js";
import type { UpdatesCursor } from "../updates.cursor.js";
import type { UpdatesFeedRow, UpdatesFilter } from "../updates.types.js";

function publishedAt(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value))
    throw new Error("Invalid MariaDB application value.");
  mariaDbTimestamp(value.replace("T", " ").slice(0, -1));
  return value;
}

const codec = createMariaDbRowCodec({
  server_today: mariaDbDateOnly,
  unresolved_count: mariaDbNullable(mariaDbCount),
  id: mariaDbNullable(mariaDbId),
  content_revision: mariaDbNullable(mariaDbId),
  row_version: mariaDbNullable(mariaDbId),
  is_important: mariaDbNullable(mariaDbBoolean),
  needed_on: mariaDbNullable(mariaDbDateOnly),
  published_at: mariaDbNullable(publishedAt),
});

type SnapshotRow = { [K in keyof UpdatesFeedRow]: UpdatesFeedRow[K] | null } & {
  server_today: string;
  unresolved_count: number | null;
};

/** RC-compatible statement snapshot: the clock sentinel survives an empty page. */
export async function readMariaDbUpdates(
  database: ClassHubDatabase,
  context: NoticeAccessContext,
  filter: UpdatesFilter,
  search: string | undefined,
  cursor: UpdatesCursor | undefined,
  limit: number,
  // 지난 반 보기는 마감일과 관계없이 그 반의 준비물·숙제를 모두 보여 준다.
  recentSuppliesOnly = true,
): Promise<{ rows: UpdatesFeedRow[]; serverToday: string; unresolvedCount: number | null }> {
  const noticeFilter =
    filter === "supplies" || filter === "materials" || filter === "homework"
      ? sql`FALSE`
      : filter === "notices"
        ? sql`notice.category = 'general'`
        : filter === "unresolved"
          ? sql`NOT (notice_read.confirmed_revision <=> notice.content_revision)`
          : filter === "important"
            ? sql`notice.is_important = TRUE`
            : filter === "performance"
              ? sql`notice.category = 'performance'`
              : sql`TRUE`;
  const supplyFilter =
    filter === "homework"
      ? sql`supply.category = 'homework'`
      : filter === "materials"
        ? sql`supply.category = 'general'`
        : filter === "unresolved"
          ? sql`NOT COALESCE(supply_check.is_checked = TRUE
              AND supply_check.confirmed_revision = supply.content_revision, FALSE)`
          : filter === "all" || filter === "supplies"
            ? sql`TRUE`
            : sql`FALSE`;
  // Bind the original backslash literally; only !, %, and _ are LIKE metacharacters here.
  const pattern = search?.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
  const noticeSearch =
    pattern === undefined
      ? sql``
      : sql`AND (LOWER(notice.title) COLLATE utf8mb4_nopad_bin LIKE LOWER(${`%${pattern}%`}) ESCAPE '!'
          OR LOWER(notice.content) COLLATE utf8mb4_nopad_bin LIKE LOWER(${`%${pattern}%`}) ESCAPE '!')`;
  const supplySearch =
    pattern === undefined
      ? sql``
      : sql`AND (LOWER(supply.title) COLLATE utf8mb4_nopad_bin LIKE LOWER(${`%${pattern}%`}) ESCAPE '!'
          OR LOWER(supply.description) COLLATE utf8mb4_nopad_bin LIKE LOWER(${`%${pattern}%`}) ESCAPE '!')`;
  const noticeAudience =
    context.role === "student"
      ? sql`AND (notice.audience_mode = 'legacy_class' OR EXISTS (
          SELECT 1 FROM notice_recipients AS audience_recipient
          WHERE audience_recipient.notice_id = notice.id
            AND audience_recipient.class_id = notice.class_id
            AND audience_recipient.member_id = CAST(${context.memberId} AS SIGNED)))`
      : sql``;
  const supplyAudience =
    context.role === "student"
      ? sql`AND (supply.audience_mode = 'legacy_class' OR EXISTS (
          SELECT 1 FROM supply_recipients AS audience_recipient
          WHERE audience_recipient.supply_id = supply.id
            AND audience_recipient.class_id = supply.class_id
            AND audience_recipient.member_id = CAST(${context.memberId} AS SIGNED)))`
      : sql``;
  // Never route cursor values through Date: the final three fractional digits order ties.
  const cursorTime = cursor?.publishedAt.replace("T", " ").slice(0, -1);
  const afterCursor =
    cursor === undefined
      ? sql``
      : sql`WHERE (
          feed.source_published_at < CAST(${cursorTime} AS DATETIME(6))
          OR (feed.source_published_at = CAST(${cursorTime} AS DATETIME(6))
            AND feed.item_kind > ${cursor.itemKind})
          OR (feed.source_published_at = CAST(${cursorTime} AS DATETIME(6))
            AND feed.item_kind = ${cursor.itemKind}
            AND feed.id < CAST(${cursor.id} AS SIGNED)))`;
  const unresolvedCount =
    context.role === "student"
      ? sql`(
        (SELECT COUNT(*) FROM notices AS notice
          CROSS JOIN statement_clock
          WHERE notice.class_id = CAST(${context.classId} AS SIGNED)
            AND notice.deleted_at IS NULL
            AND notice.published_at <= statement_clock.utc_now
            ${noticeAudience}
            AND NOT EXISTS (
              SELECT 1 FROM notice_reads AS confirmed
              WHERE confirmed.notice_id = notice.id
                AND confirmed.member_id = CAST(${context.memberId} AS SIGNED)
                AND confirmed.confirmed_revision = notice.content_revision
            ))
        + (SELECT COUNT(*) FROM supplies AS supply
          CROSS JOIN statement_clock
          WHERE supply.class_id = CAST(${context.classId} AS SIGNED)
            AND supply.deleted_at IS NULL
            ${recentSuppliesOnly ? sql`AND supply.needed_on >= DATE_SUB(CAST(statement_clock.server_today AS DATE), INTERVAL 90 DAY)` : sql``}
            ${supplyAudience}
            AND NOT EXISTS (
              SELECT 1 FROM supply_checks AS confirmed
              WHERE confirmed.supply_id = supply.id
                AND confirmed.member_id = CAST(${context.memberId} AS SIGNED)
                AND confirmed.is_checked = TRUE
                AND confirmed.confirmed_revision = supply.content_revision
            ))
      )`
      : sql`NULL`;
  const result = await sql<SnapshotRow>`
    WITH statement_clock AS (
      SELECT UTC_TIMESTAMP(6) AS utc_now,
        DATE_FORMAT(UTC_TIMESTAMP(6) + INTERVAL 9 HOUR, '%Y-%m-%d') AS server_today
    ), feed AS (
      SELECT notice.audience_mode, notice.category, NULL AS check_state,
        CASE WHEN ${context.role} <> 'student' THEN NULL
          WHEN notice_read.id IS NULL THEN 'unread'
          WHEN notice_read.confirmed_revision = notice.content_revision THEN 'confirmed'
          ELSE 'modified_unconfirmed' END AS confirmation_state,
        notice.content, notice.content_revision, notice.id, notice.is_important,
        'notice' AS item_kind, NULL AS needed_on,
        notice.published_at AS source_published_at, notice.row_version, notice.title
      FROM notices AS notice
      CROSS JOIN statement_clock
      LEFT JOIN notice_reads AS notice_read ON notice_read.notice_id = notice.id
        AND notice_read.member_id = CAST(${context.memberId} AS SIGNED)
      WHERE notice.class_id = CAST(${context.classId} AS SIGNED)
        AND notice.deleted_at IS NULL AND notice.published_at <= statement_clock.utc_now
        AND ${noticeFilter} ${noticeSearch} ${noticeAudience}
      UNION ALL
      SELECT supply.audience_mode, supply.category,
        CASE WHEN ${context.role} <> 'student' THEN NULL
          WHEN supply_check.is_checked = TRUE
            AND supply_check.confirmed_revision = supply.content_revision THEN 'checked'
          WHEN supply_check.is_checked = TRUE
            AND supply_check.confirmed_revision < supply.content_revision THEN 'modified_unconfirmed'
          ELSE 'unchecked' END AS check_state,
        NULL AS confirmation_state, supply.description AS content,
        supply.content_revision, supply.id, FALSE AS is_important, 'supply' AS item_kind,
        DATE_FORMAT(supply.needed_on, '%Y-%m-%d') AS needed_on,
        supply.created_at AS source_published_at, supply.row_version, supply.title
      FROM supplies AS supply
      CROSS JOIN statement_clock
      LEFT JOIN supply_checks AS supply_check ON supply_check.supply_id = supply.id
        AND supply_check.member_id = CAST(${context.memberId} AS SIGNED)
      WHERE supply.class_id = CAST(${context.classId} AS SIGNED)
        AND supply.deleted_at IS NULL
        ${recentSuppliesOnly ? sql`AND supply.needed_on >= DATE_SUB(CAST(statement_clock.server_today AS DATE), INTERVAL 90 DAY)` : sql``}
        AND ${supplyFilter} ${supplySearch} ${supplyAudience}
    ), unresolved AS (
      SELECT ${unresolvedCount} AS total
    ), page AS (
      SELECT feed.* FROM feed ${afterCursor}
      ORDER BY feed.source_published_at DESC, feed.item_kind ASC, feed.id DESC
      LIMIT ${limit}
    )
    SELECT statement_clock.server_today, unresolved.total AS unresolved_count, page.audience_mode, page.category,
      page.check_state, page.confirmation_state, page.content,
      CAST(page.content_revision AS CHAR) AS content_revision, CAST(page.id AS CHAR) AS id,
      page.is_important, page.item_kind, page.needed_on,
      DATE_FORMAT(page.source_published_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS published_at,
      CAST(page.row_version AS CHAR) AS row_version, page.title
    FROM statement_clock CROSS JOIN unresolved LEFT JOIN page ON TRUE
    ORDER BY page.source_published_at DESC, page.item_kind ASC, page.id DESC
  `.execute(database.withPlugin(codec));
  const first = result.rows[0];
  if (first === undefined) throw new Error("Invalid MariaDB application value.");
  if (context.role === "student" && typeof first.unresolved_count !== "number")
    throw new Error("Invalid MariaDB application value.");
  const rows = result.rows.filter((row) => row.id !== null);
  for (const row of rows) {
    if (
      row.audience_mode === null ||
      row.category === null ||
      row.content_revision === null ||
      row.is_important === null ||
      row.item_kind === null ||
      row.published_at === null ||
      row.row_version === null ||
      row.title === null
    )
      throw new Error("Invalid MariaDB application value.");
  }
  return {
    rows: rows as UpdatesFeedRow[],
    serverToday: first.server_today,
    unresolvedCount: context.role === "student" ? first.unresolved_count : null,
  };
}
