import type { DB } from "@classhub/db";
import { sql, type Transaction } from "kysely";

/*
 * 2026-10-03 사용자 결정(보관기간 ①, 총검수 A2-03·D1-02): 처리방침은 '알림 구독 정보는 계정 삭제 시
 * 즉시 삭제'라고 약속한다. 탈퇴 트랜잭션 안에서 지우고, 뒤 단계가 실패하면 함께 되돌린다.
 * 알림 표가 없는 환경(기능 미설치)에서는 아무것도 하지 않는다(프로필 사진 삭제와 같은 방식).
 */
export async function deleteAccountPushSubscriptionsIfInstalled(
  transaction: Transaction<DB>,
  mariaDb: boolean,
  userId: string,
): Promise<void> {
  const installed = await sql
    .raw<{ installed: number }>(
      mariaDb
        ? "SELECT 1 AS installed FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'push_subscriptions' AND table_type = 'BASE TABLE'"
        : "SELECT 1 AS installed FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'push_subscriptions' AND table_type = 'BASE TABLE'",
    )
    .execute(transaction);
  if (installed.rows.length === 0) return;
  await transaction.deleteFrom("push_subscriptions").where("user_id", "=", userId).execute();
}
