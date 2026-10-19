import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { authenticateOperator, lockAndRevalidateOperator } from "./operator-auth.js";
import { openOperatorDatabase } from "./operator-database.js";
import { isMariaDbOperatorDatabase } from "./operator-engine.js";
import { transferClassTeacherMariaDb } from "./mariadb/class-transfer.js";
import { normalizeTeacherEmail } from "./teacher-provision.js";

const CLASS_TRANSFER_LOCK_NAME = "classhub:class-transfer";
// 학급 감사의 actor_display_name_snapshot은 NOT NULL이다. 운영자는 학급 구성원이
// 아니라 표시명이 없으므로 역할을 그대로 적는다(PRD_FINAL 679).
const OPERATOR_DISPLAY_NAME = "운영자";

export interface TransferClassTeacherInput {
  classId: string;
  operatorDatabaseUrl: string | undefined;
  operatorToken: string;
  reason?: string | undefined;
  toEmail: string;
}

export interface TransferClassTeacherResult {
  classId: string;
  fromUserId: string;
  runId: string;
  toEmail: string;
  toUserId: string;
}

/*
 * 반을 맡은 교사는 이관 없이는 revoke도 계정 삭제도 되지 않는다(PRD_FINAL 285·287·309).
 * 그 탈출구가 구현되지 않아 지금은 DB를 직접 손대는 수밖에 없다 — 2026-08-01 감사가
 * P0로 지목한 지점이다. self-service가 아니라 운영자 명령이므로 DEC-BLK-04와 무관하다.
 *
 * 활성 학급은 활성 담임이 정확히 한 명이어야 한다는 불변식이 있고, 그 검사는 지연
 * 트리거라 COMMIT 시점에 돈다. 그래서 한 트랜잭션 안에서 넘기고 받으면 중간에 0명이
 * 되는 순간이 있어도 통과한다 — 스키마가 이 교체를 염두에 두고 만들어졌다.
 */
export async function transferClassTeacher(
  input: TransferClassTeacherInput,
): Promise<TransferClassTeacherResult> {
  const toEmail = normalizeTeacherEmail(input.toEmail);
  const database = await openOperatorDatabase(input.operatorDatabaseUrl);

  try {
    if (isMariaDbOperatorDatabase(database))
      return await transferClassTeacherMariaDb(database, input);
    const authenticatedOperator = await authenticateOperator(database, input.operatorToken);

    return await database.transaction().execute(async (transaction) => {
      await lockAndRevalidateOperator(transaction, authenticatedOperator);
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${CLASS_TRANSFER_LOCK_NAME}, 0)
        )
      `.execute(transaction);

      const targetClass = await transaction
        .selectFrom("classes")
        .select(["id", "row_version", "status"])
        .where("id", "=", input.classId)
        .executeTakeFirst();
      if (targetClass === undefined) {
        throw new Error("해당 학급을 찾지 못해 이관하지 않았습니다.");
      }
      // 아카이브된 반은 담임이 없는 것이 정상이므로 이관할 대상이 아니다.
      if (!["active", "suspended"].includes(targetClass.status)) {
        throw new Error(`학급 상태가 ${targetClass.status}이라 이관할 수 없습니다.`);
      }
      const reactivated = targetClass.status === "suspended";
      if (reactivated) {
        // 함수가 classes row를 FOR UPDATE하고 optimistic version을 재검증한다.
        // 이후 멤버십·감사 중 하나라도 실패하면 이 재활성화도 같이 rollback된다.
        const reactivation = await sql<{ row_version: string }>`
          SELECT public.reactivate_suspended_class_for_teacher_transfer(
            ${input.classId}::bigint,
            ${targetClass.row_version}::bigint
          ) AS row_version
        `.execute(transaction);
        if (reactivation.rows.length !== 1) {
          throw new Error("일시 중지 학급 재활성화 결과를 확인하지 못해 이관하지 않았습니다.");
        }
      }

      const outgoing = await transaction
        .selectFrom("class_members")
        .select(["id", "user_id"])
        .where("class_id", "=", input.classId)
        .where("role", "=", "teacher")
        .where("status", "=", "approved")
        .executeTakeFirst();
      if (outgoing === undefined) {
        throw new Error("이 학급에 현재 담임이 없어 이관하지 않았습니다.");
      }

      const incomingUser = await transaction
        .selectFrom("users")
        .select(["id", "is_active"])
        .where("email_normalized", "=", toEmail)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (incomingUser === undefined) {
        throw new Error("받을 교사의 활성 계정을 찾지 못해 이관하지 않았습니다.");
      }
      if (!incomingUser.is_active) {
        throw new Error("비활성 계정으로는 이관할 수 없습니다.");
      }
      if (incomingUser.id === outgoing.user_id) {
        throw new Error("현재 담임과 같은 교사로는 이관할 수 없습니다.");
      }

      const incomingProfile = await transaction
        .selectFrom("teacher_profiles")
        .select(["status", "temporary_password_expires_at"])
        .where("user_id", "=", incomingUser.id)
        .forUpdate()
        .executeTakeFirst();
      if (incomingProfile === undefined) {
        throw new Error("받을 대상이 교사 계정이 아니어서 이관하지 않았습니다.");
      }
      if (incomingProfile.status !== "active") {
        throw new Error(`받을 교사의 상태가 ${incomingProfile.status}이라 이관할 수 없습니다.`);
      }
      // classhub_operator는 만료 시각만 읽을 수 있다. 프로필 CHECK 제약이
      // must_change=false와 expires_at=NULL을 동치로 강제하므로 NULL만 통과시킨다.
      if (incomingProfile.temporary_password_expires_at !== null) {
        throw new Error("임시 비밀번호를 변경하지 않은 교사로는 이관할 수 없습니다.");
      }

      // PRD_FINAL 5.6은 대상 반에 과거 row도 없어야 한다. 되살리면 교사 이관의
      // NULL -> approved 이력 계약이 깨지고, 운영자가 별도 계정을 쓰라는 경계도
      // 조용히 우회된다. 어떤 상태·역할이든 한 행이라도 있으면 쓰기 전에 멈춘다.
      const existingMembership = await transaction
        .selectFrom("class_members")
        .select("id")
        .where("class_id", "=", input.classId)
        .where("user_id", "=", incomingUser.id)
        .executeTakeFirst();
      if (existingMembership !== undefined) {
        throw new Error(
          "받을 교사는 이 학급의 과거 구성원이어서 이관할 수 없습니다. 별도 교사 계정을 사용하세요.",
        );
      }

      const transferredAt = new Date();
      const runId = randomUUID();

      await transaction
        .updateTable("class_members")
        .set({
          row_version: sql<string>`row_version + 1`,
          status: "transferred",
          status_changed_at: transferredAt,
          updated_at: transferredAt,
        })
        .where("id", "=", outgoing.id)
        .execute();
      await transaction
        .insertInto("class_member_status_history")
        .values({
          actor_operator_id: authenticatedOperator.operatorId,
          class_id: input.classId,
          from_status: "approved",
          member_id: outgoing.id,
          reason: input.reason ?? null,
          to_status: "transferred",
        })
        .execute();

      const incomingMember = await transaction
        .insertInto("class_members")
        .values({
          class_id: input.classId,
          role: "teacher",
          status: "approved",
          user_id: incomingUser.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const incomingMemberId = incomingMember.id;

      await transaction
        .insertInto("class_member_status_history")
        .values({
          actor_operator_id: authenticatedOperator.operatorId,
          class_id: input.classId,
          from_status: null,
          member_id: incomingMemberId,
          reason: input.reason ?? null,
          to_status: "approved",
        })
        .execute();

      // 학급 감사에도 남긴다(PRD_FINAL 679). 운영자 감사에만 남기면 교사는 앱에서
      // 담임이 언제 누구에게 넘어갔는지 볼 수 없다 — 그 반 전원의 개인정보에 대한
      // 관리자가 바뀌는 사건인데도.
      //
      // 표시명 스냅샷은 넣지 않는다. 이 표는 append-only라 나중에 익명화가 불가능한데,
      // member_id만으로 누가 넘겼고 누가 받았는지 추적된다.
      if (reactivated) {
        await transaction
          .insertInto("audit_logs")
          .values({
            action: "class.reactivated",
            actor_display_name_snapshot: OPERATOR_DISPLAY_NAME,
            actor_role_snapshot: "operator",
            after_json: {
              class_id: input.classId,
              status: "active",
              suspended_reason: null,
            },
            before_json: { class_id: input.classId, status: "suspended" },
            class_id: input.classId,
            reason: input.reason ?? null,
            request_id: runId,
            target_id: input.classId,
            target_type: "class",
          })
          .execute();
      }

      await transaction
        .insertInto("audit_logs")
        .values({
          action: "class.teacher_transferred",
          // 운영자는 학급 구성원이 아니다. actor_user_id·actor_member_id는 NULL로 두고
          // 행위 주체는 역할로만 표시한다(권한도 그 두 열에는 열려 있지 않다).
          actor_display_name_snapshot: OPERATOR_DISPLAY_NAME,
          actor_role_snapshot: "operator",
          after_json: {
            member_id: incomingMemberId,
            role: "teacher",
            status: "approved",
          },
          before_json: {
            member_id: outgoing.id,
            role: "teacher",
            status: "transferred",
          },
          class_id: input.classId,
          reason: input.reason ?? null,
          // CLI에는 HTTP 요청이 없다. 같은 이관을 운영자 감사와 잇는 run_id를 쓴다.
          request_id: runId,
          target_id: incomingMemberId,
          target_type: "member",
        })
        .execute();

      await transaction
        .insertInto("operator_audit_logs")
        .values([
          ...(reactivated
            ? [
                {
                  action: "class.reactivated",
                  actor_type: "operator",
                  after_json: {
                    class_id: input.classId,
                    status: "active",
                    teacher_user_id: incomingUser.id,
                  },
                  before_json: {
                    class_id: input.classId,
                    status: "suspended",
                    teacher_user_id: outgoing.user_id,
                  },
                  operator_id: authenticatedOperator.operatorId,
                  run_id: runId,
                  target_id: input.classId,
                  target_type: "class",
                },
              ]
            : []),
          {
            action: "teacher.transferred",
            actor_type: "operator",
            // teacher.% 허용 키만 쓴다. 이메일은 넣지 않는다 — 감사 로그로 개인정보가
            // 새지 않아야 하고, user_id로 충분히 추적된다.
            after_json: {
              class_id: input.classId,
              teacher_user_id: incomingUser.id,
            },
            before_json: {
              class_id: input.classId,
              teacher_user_id: outgoing.user_id,
            },
            operator_id: authenticatedOperator.operatorId,
            run_id: runId,
            target_id: input.classId,
            target_type: "class",
          },
        ])
        .execute();

      return {
        classId: input.classId,
        fromUserId: outgoing.user_id,
        runId,
        toEmail,
        toUserId: incomingUser.id,
      };
    });
  } finally {
    await database.destroy();
  }
}
