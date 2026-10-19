import { sql, type RawBuilder } from "kysely";
import type { ClassHubDatabase } from "../database/database.module.js";
import { mariaDbDateTime } from "../common/database/mariadb-values.js";
import {
  encodeNoticeConfirmationsCursor,
  type NoticeConfirmationsCursor,
} from "./notices.cursor.js";
import { NoticeNotFoundException } from "./notices.errors.js";
import type { ListNoticeConfirmationsResult, NoticeConfirmationFilter } from "./notices.types.js";

interface SnapshotRow {
  content_revision: string;
  confirmed: string;
  modified_unconfirmed: string;
  reconfirmed: string;
  unread: string;
  excluded_member_count: string;
  requested_at: Date | string | null;
  server_today: string;
  member_id: string | null;
  display_name: string | null;
  student_number: number | null;
}

function cursorPredicate(cursor: NoticeConfirmationsCursor | undefined): RawBuilder<boolean> {
  if (!cursor) return sql<boolean>`TRUE`;
  const followingName = sql<boolean>`(display_name > ${cursor.displayName}
    OR (display_name = ${cursor.displayName} AND member_id > ${cursor.memberId}))`;
  return cursor.studentNumber === null
    ? sql<boolean>`student_number IS NULL AND ${followingName}`
    : sql<boolean>`(student_number > ${cursor.studentNumber} OR student_number IS NULL
        OR (student_number = ${cursor.studentNumber} AND ${followingName}))`;
}

/**
 * The guarded MariaDB driver intentionally permits READ COMMITTED only. Keeping the
 * notice revision, current audience, counts, page and reminder timestamp in one SELECT
 * gives them one InnoDB statement snapshot without weakening PG's multi-read snapshot.
 */
export async function readMariaDbNoticeConfirmations(
  database: ClassHubDatabase,
  input: {
    classId: string;
    noticeId: string;
    state: NoticeConfirmationFilter;
    cursor?: NoticeConfirmationsCursor;
  },
): Promise<ListNoticeConfirmationsResult> {
  const state =
    input.state === "unread"
      ? sql`read_id IS NULL`
      : input.state === "confirmed"
        ? sql`confirmed_revision = content_revision`
        : sql`confirmed_revision < content_revision`;
  const result = await sql<SnapshotRow>`WITH snapshot_notice AS (
    SELECT id,class_id,audience_mode,content_revision FROM notices
    WHERE id=${input.noticeId} AND class_id=${input.classId}
      AND deleted_at IS NULL AND published_at<=UTC_TIMESTAMP(6)
  ), current_members AS (
    SELECT member.id AS member_id,member.student_number,
      COALESCE(member.display_name_in_class,account.display_name) AS display_name,
      notice.content_revision,notice_read.id AS read_id,notice_read.confirmed_revision,
      notice_read.first_confirmed_at,notice_read.confirmed_at,
      (notice.audience_mode='legacy_class' OR audience_recipient.member_id IS NOT NULL) AS in_audience
    FROM snapshot_notice AS notice
    JOIN class_members AS member ON member.class_id=notice.class_id
    JOIN users AS account ON account.id=member.user_id
    LEFT JOIN notice_recipients AS audience_recipient ON audience_recipient.notice_id=notice.id
      AND audience_recipient.class_id=member.class_id AND audience_recipient.member_id=member.id
    LEFT JOIN notice_reads AS notice_read ON notice_read.notice_id=notice.id AND notice_read.member_id=member.id
    WHERE member.role='student' AND member.status='approved' AND account.is_active=TRUE AND account.deleted_at IS NULL
  ), counts AS (
    SELECT COUNT(CASE WHEN in_audience AND confirmed_revision=content_revision THEN 1 END) AS confirmed,
      COUNT(CASE WHEN in_audience AND confirmed_revision<content_revision THEN 1 END) AS modified_unconfirmed,
      COUNT(CASE WHEN in_audience AND confirmed_revision=content_revision
        AND confirmed_at>first_confirmed_at THEN 1 END) AS reconfirmed,
      COUNT(CASE WHEN in_audience AND read_id IS NULL THEN 1 END) AS unread,
      COUNT(CASE WHEN NOT in_audience THEN 1 END) AS excluded_member_count FROM current_members
  ), page AS (
    SELECT member_id,student_number,display_name FROM current_members
    WHERE in_audience AND ${state} AND ${cursorPredicate(input.cursor)}
    ORDER BY student_number IS NULL,student_number,display_name,member_id LIMIT 21
  )
  SELECT notice.content_revision,counts.confirmed,counts.modified_unconfirmed,counts.reconfirmed,counts.unread,counts.excluded_member_count,
    (SELECT DATE_FORMAT(MAX(created_at),'%Y-%m-%d %H:%i:%s.%f') FROM in_app_reminder_batches
      WHERE class_id=notice.class_id AND notice_id=notice.id AND content_revision=notice.content_revision) AS requested_at,
    DATE_FORMAT(UTC_TIMESTAMP(6)+INTERVAL 9 HOUR,'%Y-%m-%d') AS server_today,
    page.member_id,page.student_number,page.display_name
  FROM snapshot_notice AS notice CROSS JOIN counts LEFT JOIN page ON TRUE
  ORDER BY page.student_number IS NULL,page.student_number,page.display_name,page.member_id`.execute(
    database,
  );
  const first = result.rows[0];
  if (!first) throw new NoticeNotFoundException();
  const members = result.rows.filter((row) => row.member_id !== null);
  const page = members.slice(0, 20);
  const last = page.at(-1);
  return {
    content_revision: first.content_revision,
    counts: {
      confirmed: Number(first.confirmed),
      modified_unconfirmed: Number(first.modified_unconfirmed),
      reconfirmed: Number(first.reconfirmed),
      unread: Number(first.unread),
      excluded_member_count: Number(first.excluded_member_count),
    },
    items: page.map((row) => ({
      confirmation_state: input.state,
      display_name: row.display_name!,
      member_id: row.member_id!,
      student_number: row.student_number,
    })),
    last_reminder_requested_at:
      first.requested_at === null ? null : mariaDbDateTime(first.requested_at).toISOString(),
    next_cursor:
      members.length > 20 && last
        ? encodeNoticeConfirmationsCursor({
            displayName: last.display_name!,
            memberId: last.member_id!,
            noticeId: input.noticeId,
            state: input.state,
            studentNumber: last.student_number,
          })
        : null,
    server_today: first.server_today,
  };
}
