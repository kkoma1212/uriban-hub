import { sql } from "kysely";
import type { ClassHubDatabase } from "../database/database.module.js";
import type { HomeReminder } from "./home.types.js";
import {
  homeBigint,
  homeDate,
  homeCurrentTimestamp,
  homeNoticeVisibleSince,
  type HomeDatabaseEngine,
} from "./home.database.js";

export async function readHomeReminders(
  database: ClassHubDatabase,
  context: { classId: string; memberId: string; role: "student" | "teacher" },
  serverToday: string,
  engine: HomeDatabaseEngine,
): Promise<HomeReminder[]> {
  if (context.role === "teacher") return [];

  const result = await sql<{
    category: "general" | "homework" | null;
    reminder_type: "notice" | "supply";
    requested_at: Date | string;
    resource_id: string;
    title: string;
  }>`
      SELECT
        active_reminder.reminder_type,
        active_reminder.category,
        active_reminder.requested_at,
        active_reminder.resource_id,
        active_reminder.title
      FROM (
        (
          SELECT ${engine === "mariadb" ? sql`` : sql`DISTINCT ON (notice.id)`}
            ${engine === "mariadb" ? sql`ROW_NUMBER() OVER (PARTITION BY notice.id ORDER BY batch.created_at DESC, CAST(batch.id AS CHAR) COLLATE utf8mb4_bin DESC) AS reminder_rank,` : sql``}
            ${engine === "mariadb" ? sql`'notice'` : sql`'notice'::text`} AS reminder_type,
            /* 공지에는 분류가 없다. UNION 이라 칸을 맞춰 두고 값은 비운다. */
            ${engine === "mariadb" ? sql`NULL` : sql`NULL::text`} AS category,
            batch.created_at AS requested_at,
            ${engine === "mariadb" ? sql`CAST(notice.id AS CHAR) COLLATE utf8mb4_bin` : sql`notice.id::text`} AS resource_id,
            notice.title
          FROM in_app_reminder_recipients AS recipient
          INNER JOIN in_app_reminder_batches AS batch
            ON batch.id = recipient.batch_id
            AND batch.class_id = recipient.class_id
          INNER JOIN notices AS notice
            ON notice.id = batch.notice_id
            AND notice.class_id = batch.class_id
          INNER JOIN class_members AS member
            ON member.id = recipient.member_id
            AND member.class_id = recipient.class_id
          INNER JOIN users AS account ON account.id = member.user_id
          INNER JOIN classes AS class ON class.id = recipient.class_id
          LEFT JOIN notice_reads AS notice_read
            ON notice_read.member_id = recipient.member_id
            AND notice_read.notice_id = notice.id
          WHERE recipient.class_id = ${homeBigint(context.classId, engine)}
            AND recipient.member_id = ${homeBigint(context.memberId, engine)}
            AND recipient.resolved_at IS NULL
            AND batch.notice_id IS NOT NULL
            AND batch.content_revision = notice.content_revision
            AND notice.deleted_at IS NULL
            AND notice.published_at <= ${homeCurrentTimestamp(engine)}
            AND notice.published_at >= ${homeNoticeVisibleSince(engine)}
            AND (
              notice.audience_mode = 'legacy_class'
              OR EXISTS (
                SELECT 1
                FROM notice_recipients AS audience_recipient
                WHERE audience_recipient.notice_id = notice.id
                  AND audience_recipient.class_id = notice.class_id
                  AND audience_recipient.member_id = recipient.member_id
              )
            )
            AND class.status = 'active'
            AND member.role = 'student'
            AND member.status = 'approved'
            AND account.is_active = TRUE
            AND account.deleted_at IS NULL
            AND (
              notice_read.id IS NULL
              OR notice_read.confirmed_revision < notice.content_revision
            )
          ${engine === "mariadb" ? sql`` : sql`ORDER BY notice.id, batch.created_at DESC, batch.id DESC`}
        )
        UNION ALL
        (
          SELECT ${engine === "mariadb" ? sql`` : sql`DISTINCT ON (supply.id)`}
            ${engine === "mariadb" ? sql`ROW_NUMBER() OVER (PARTITION BY supply.id ORDER BY batch.created_at DESC, CAST(batch.id AS CHAR) COLLATE utf8mb4_bin DESC) AS reminder_rank,` : sql``}
            ${engine === "mariadb" ? sql`'supply'` : sql`'supply'::text`} AS reminder_type,
            /* 준비물과 숙제는 같은 표를 쓴다 — 이 값이 "가져올 것 / 할 것"을 가른다. */
            ${engine === "mariadb" ? sql`supply.category` : sql`supply.category::text`} AS category,
            batch.created_at AS requested_at,
            ${engine === "mariadb" ? sql`CAST(supply.id AS CHAR) COLLATE utf8mb4_bin` : sql`supply.id::text`} AS resource_id,
            supply.title
          FROM in_app_reminder_recipients AS recipient
          INNER JOIN in_app_reminder_batches AS batch
            ON batch.id = recipient.batch_id
            AND batch.class_id = recipient.class_id
          INNER JOIN supplies AS supply
            ON supply.id = batch.supply_id
            AND supply.class_id = batch.class_id
          INNER JOIN class_members AS member
            ON member.id = recipient.member_id
            AND member.class_id = recipient.class_id
          INNER JOIN users AS account ON account.id = member.user_id
          INNER JOIN classes AS class ON class.id = recipient.class_id
          LEFT JOIN supply_checks AS supply_check
            ON supply_check.member_id = recipient.member_id
            AND supply_check.supply_id = supply.id
          WHERE recipient.class_id = ${homeBigint(context.classId, engine)}
            AND recipient.member_id = ${homeBigint(context.memberId, engine)}
            AND recipient.resolved_at IS NULL
            AND batch.supply_id IS NOT NULL
            AND batch.content_revision = supply.content_revision
            AND supply.deleted_at IS NULL
            -- 필요한 날이 지난 준비물·숙제는 재알림이 남아 있어도 홈에서 뺀다(2026-10-01 사용자 결정).
            AND supply.needed_on >= ${homeDate(serverToday, engine)}
            AND (
              supply.audience_mode = 'legacy_class'
              OR EXISTS (
                SELECT 1
                FROM supply_recipients AS audience_recipient
                WHERE audience_recipient.supply_id = supply.id
                  AND audience_recipient.class_id = supply.class_id
                  AND audience_recipient.member_id = recipient.member_id
              )
            )
            AND class.status = 'active'
            AND member.role = 'student'
            AND member.status = 'approved'
            AND account.is_active = TRUE
            AND account.deleted_at IS NULL
            AND (
              supply_check.id IS NULL
              OR supply_check.is_checked = FALSE
              OR supply_check.confirmed_revision IS NULL
              OR supply_check.confirmed_revision < supply.content_revision
            )
          ${engine === "mariadb" ? sql`` : sql`ORDER BY supply.id, batch.created_at DESC, batch.id DESC`}
        )
      ) AS active_reminder
      ${engine === "mariadb" ? sql`WHERE active_reminder.reminder_rank = 1` : sql``}
      ORDER BY
        active_reminder.requested_at DESC,
        active_reminder.reminder_type ASC,
        active_reminder.resource_id DESC
    `.execute(database);

  return result.rows.map((row) => ({
    /* 공지는 분류가 없다 — 칸 자체를 싣지 않는다. */
    ...(row.category === null ? {} : { category: row.category }),
    reminder_type: row.reminder_type,
    requested_at:
      row.requested_at instanceof Date
        ? row.requested_at.toISOString()
        : new Date(row.requested_at).toISOString(),
    resource_id: row.resource_id,
    title: row.title,
  }));
}
