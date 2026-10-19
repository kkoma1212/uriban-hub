import type { DB } from "@classhub/db";
import { sql, type Transaction } from "kysely";

/*
 * 2026-10-02 사용자 결정(P-025①, 총검수 A1-02): '반 전체'로 올린 공지·준비물·숙제는 나중에 승인된
 * 학생에게도 보인다. 보는 규칙(약 25곳)은 그대로 두고, 학생이 승인되는 같은 트랜잭션에서 그 반의
 * 기존 '반 전체' 글 받는 사람 목록에 이 학생을 더한다. 확인·체크 진행률도 그대로 맞는다.
 * 특정 학생만 고른 글(selected_snapshot)과 예전 반 글(legacy_class)은 건드리지 않는다.
 * 학생 ID는 class_members에서 읽어 넣어(엔진별 형 변환 없이) PostgreSQL·MariaDB에서 같은 SQL을 쓴다.
 */
export async function includeMemberInClassWideContent(
  transaction: Transaction<DB>,
  classId: string,
  memberId: string,
): Promise<void> {
  await sql`INSERT INTO notice_recipients (class_id, member_id, notice_id)
    SELECT n.class_id, m.id, n.id
    FROM notices n JOIN class_members m ON m.class_id = n.class_id
    WHERE n.class_id = ${classId} AND m.id = ${memberId} AND n.audience_mode = 'all_snapshot'
      AND NOT EXISTS (
        SELECT 1 FROM notice_recipients r WHERE r.notice_id = n.id AND r.member_id = m.id
      )`.execute(transaction);
  await sql`INSERT INTO supply_recipients (class_id, member_id, supply_id)
    SELECT s.class_id, m.id, s.id
    FROM supplies s JOIN class_members m ON m.class_id = s.class_id
    WHERE s.class_id = ${classId} AND m.id = ${memberId} AND s.audience_mode = 'all_snapshot'
      AND NOT EXISTS (
        SELECT 1 FROM supply_recipients r WHERE r.supply_id = s.id AND r.member_id = m.id
      )`.execute(transaction);
}
