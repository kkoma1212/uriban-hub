import { sql } from "kysely";
import { mariaDbCount } from "../../common/database/mariadb-values.js";
import type { ClassHubDatabase } from "../../database/database.module.js";
import { encodeSupplyChecksCursor, type SupplyChecksCursor } from "../supplies.cursor.js";
import { SupplyNotFoundException } from "../supplies.errors.js";
import type { ListSupplyChecksResult, SupplyCheckFilter } from "../supplies.types.js";

interface CheckSnapshotRow {
  content_revision: string;
  checked: string | number;
  modified_unconfirmed: string | number;
  reconfirmed: string | number;
  unchecked: string | number;
  excluded_member_count: string | number;
  requested_at: Date | null;
  page_member_id: string | null;
  student_number: number | null;
  display_name: string | null;
}

/** The guarded driver permits RC only. One SELECT preserves the PG repeatable-read
 * agreement between revision, counts, reminder time and page without changing the driver. */
export async function listSupplyChecksMariaDb(
  database: ClassHubDatabase,
  input: {
    classId: string;
    supplyId: string;
    state: SupplyCheckFilter;
    cursor: SupplyChecksCursor | undefined;
    serverToday: string;
  },
): Promise<ListSupplyChecksResult> {
  const cursor = input.cursor;
  const afterName =
    cursor === undefined
      ? sql<boolean>`TRUE`
      : sql<boolean>`(
    display_name > ${cursor.displayName}
    OR (display_name = ${cursor.displayName} AND member_id > CAST(${cursor.memberId} AS SIGNED))
  )`;
  const afterCursor =
    cursor === undefined
      ? sql<boolean>`TRUE`
      : cursor.studentNumber === null
        ? sql<boolean>`student_number IS NULL AND ${afterName}`
        : sql<boolean>`(student_number > ${cursor.studentNumber} OR student_number IS NULL
        OR (student_number = ${cursor.studentNumber} AND ${afterName}))`;
  const result = await sql<CheckSnapshotRow>`
    WITH snapshot_supply AS (
      SELECT id, class_id, audience_mode, content_revision, updated_at FROM supplies
      WHERE id=${input.supplyId} AND class_id=${input.classId} AND deleted_at IS NULL
    ), eligible_members AS (
      SELECT member.id AS member_id, member.student_number,
        COALESCE(member.display_name_in_class, account.display_name) COLLATE utf8mb4_nopad_bin AS display_name,
        (snapshot.audience_mode='legacy_class' OR recipient.member_id IS NOT NULL) AS included,
        CASE
          WHEN checked.id IS NULL OR checked.is_checked=FALSE THEN 'unchecked'
          WHEN checked.is_checked=TRUE AND checked.confirmed_revision=snapshot.content_revision THEN 'checked'
          WHEN checked.is_checked=TRUE AND checked.confirmed_revision<snapshot.content_revision THEN 'modified_unconfirmed'
          ELSE NULL
        END AS check_state,
        -- 준비물은 내용 수정 때만 updated_at 이 바뀐다. 마지막 수정 전부터 체크 기록이 있던 학생이
        -- 현재 내용을 체크했으면 재확인으로 본다(공지의 first_confirmed_at 에 해당하는 칸이 없어 근사).
        (checked.created_at<snapshot.updated_at) AS recorded_before_revision
      FROM snapshot_supply snapshot
      JOIN class_members member ON member.class_id=snapshot.class_id
      JOIN users account ON account.id=member.user_id
      LEFT JOIN supply_recipients recipient ON recipient.supply_id=snapshot.id
        AND recipient.class_id=member.class_id AND recipient.member_id=member.id
      LEFT JOIN supply_checks checked ON checked.supply_id=snapshot.id AND checked.member_id=member.id
      WHERE member.role='student' AND member.status='approved'
        AND account.is_active=TRUE AND account.deleted_at IS NULL
    ), counts AS (
      SELECT COUNT(CASE WHEN included=TRUE AND check_state='checked' THEN 1 END) AS checked,
        COUNT(CASE WHEN included=TRUE AND check_state='modified_unconfirmed' THEN 1 END) AS modified_unconfirmed,
        COUNT(CASE WHEN included=TRUE AND check_state='checked' AND recorded_before_revision THEN 1 END) AS reconfirmed,
        COUNT(CASE WHEN included=TRUE AND check_state='unchecked' THEN 1 END) AS unchecked,
        COUNT(CASE WHEN NOT included THEN 1 END) AS excluded_member_count
      FROM eligible_members
    ), paged_members AS (
      SELECT member_id, student_number, display_name FROM eligible_members
      WHERE included=TRUE AND check_state=${input.state} AND ${afterCursor}
      ORDER BY student_number IS NULL, student_number ASC, display_name ASC, member_id ASC LIMIT 21
    )
    SELECT snapshot.content_revision, counts.checked, counts.modified_unconfirmed, counts.reconfirmed, counts.unchecked,
      counts.excluded_member_count,
      (SELECT MAX(created_at) FROM in_app_reminder_batches WHERE class_id=snapshot.class_id
        AND supply_id=snapshot.id AND content_revision=snapshot.content_revision) AS requested_at,
      page.member_id AS page_member_id, page.student_number, page.display_name
    FROM snapshot_supply snapshot CROSS JOIN counts LEFT JOIN paged_members page ON TRUE
    ORDER BY page.student_number IS NULL, page.student_number ASC, page.display_name ASC, page.member_id ASC
  `.execute(database);
  const summary = result.rows[0];
  if (summary === undefined) throw new SupplyNotFoundException();
  const members = result.rows.filter((row) => row.page_member_id !== null);
  const page = members.slice(0, 20);
  const last = page.at(-1);
  return {
    content_revision: summary.content_revision,
    counts: {
      checked: mariaDbCount(summary.checked),
      modified_unconfirmed: mariaDbCount(summary.modified_unconfirmed),
      reconfirmed: mariaDbCount(summary.reconfirmed),
      unchecked: mariaDbCount(summary.unchecked),
      excluded_member_count: mariaDbCount(summary.excluded_member_count),
    },
    items: page.map((row) => ({
      check_state: input.state,
      display_name: row.display_name!,
      member_id: row.page_member_id!,
      student_number: row.student_number,
    })),
    last_reminder_requested_at: summary.requested_at?.toISOString() ?? null,
    next_cursor:
      members.length > 20 && last !== undefined
        ? encodeSupplyChecksCursor({
            displayName: last.display_name!,
            memberId: last.page_member_id!,
            state: input.state,
            studentNumber: last.student_number,
            supplyId: input.supplyId,
          })
        : null,
    server_today: input.serverToday,
  };
}
