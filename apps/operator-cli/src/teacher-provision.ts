import { operatorInsertedId, operatorJson, operatorTimestamp } from "./operator-query.js";
import { lockOperatorTransaction } from "./operator-lock.js";
import { randomBytes, randomUUID } from "node:crypto";

import { hashPassword, matchesDatabaseConstraint, NFC_PASSWORD_INPUT_VERSION } from "@classhub/db";
import { parseFragment } from "parse5";

import { authenticateOperator, lockAndRevalidateOperator } from "./operator-auth.js";
import { openOperatorDatabase } from "./operator-database.js";

const TEMPORARY_PASSWORD_LIFETIME_MS = 72 * 60 * 60 * 1_000;
/*
 * 같은 문의를 두 운영자가 동시에 처리하면 재발급이 직렬화되어 둘 다 성공하고
 * 나중 것이 이긴다. 먼저 처리한 운영자는 이미 무효가 된 비밀번호를 교사에게
 * 알려주게 되고, 교사는 로그인에 실패한 뒤 다시 문의한다. 짧은 쿨다운으로
 * 두 번째 시도를 세워 서로 확인하게 한다. 의도적 재발급은 force로 통과한다.
 */
const REISSUE_COOLDOWN_MS = 5 * 60 * 1_000;
const TEACHER_PROVISION_LOCK_NAME = "classhub:teacher-provision";

interface HtmlNode {
  childNodes?: HtmlNode[];
  tagName?: string;
}

interface CreatedTeacherResult {
  created: true;
  displayName: string;
  email: string;
  rawTemporaryPassword: string;
  runId: string;
  temporaryPasswordExpiresAt: Date;
  userId: string;
}

interface ExistingTeacherResult {
  created: false;
  displayName: string;
  email: string;
  rawTemporaryPassword: null;
  runId: null;
  temporaryPasswordExpiresAt: null;
  userId: string;
}

export type ProvisionTeacherResult = CreatedTeacherResult | ExistingTeacherResult;

export interface ProvisionTeacherInput {
  displayName: string;
  email: string;
  operatorDatabaseUrl: string | undefined;
  operatorToken: string;
}

export interface ResetTeacherPasswordInput {
  email: string;
  force?: boolean | undefined;
  operatorDatabaseUrl: string | undefined;
  operatorToken: string;
}

export interface ResetTeacherPasswordResult {
  email: string;
  rawTemporaryPassword: string;
  revokedSessionCount: number;
  runId: string;
  temporaryPasswordExpiresAt: Date;
  userId: string;
}

function hasHtmlElement(value: string): boolean {
  const root = parseFragment(value) as unknown as HtmlNode;
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node?.tagName !== undefined) return true;
    if (node?.childNodes !== undefined) pending.push(...node.childNodes);
  }
  return false;
}

export function normalizeTeacherEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new Error("교사 이메일 형식이 올바르지 않습니다.");
  }
  return email;
}

export function normalizeTeacherDisplayName(value: string): string {
  const displayName = value.trim();
  const forbiddenControl = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/u;
  if (
    Array.from(displayName).length < 2 ||
    Array.from(displayName).length > 20 ||
    forbiddenControl.test(displayName) ||
    hasHtmlElement(displayName)
  ) {
    throw new Error("교사 표시명은 제어문자·HTML 없는 2~20자여야 합니다.");
  }
  return displayName;
}

export function generateTemporaryPassword(): string {
  return `A1-${randomBytes(24).toString("base64url")}`;
}

function isUniqueViolation(error: unknown): boolean {
  return matchesDatabaseConstraint(error, { kind: "unique_violation" });
}

export async function provisionTeacher(
  input: ProvisionTeacherInput,
): Promise<ProvisionTeacherResult> {
  const email = normalizeTeacherEmail(input.email);
  const displayName = normalizeTeacherDisplayName(input.displayName);
  const database = await openOperatorDatabase(input.operatorDatabaseUrl);

  try {
    const authenticatedOperator = await authenticateOperator(database, input.operatorToken);

    try {
      const result = await database.transaction().execute(async (transaction) => {
        await lockAndRevalidateOperator(transaction, authenticatedOperator);
        await lockOperatorTransaction(transaction, TEACHER_PROVISION_LOCK_NAME);

        const matchingUsers = await transaction
          .selectFrom("users")
          .select(["deleted_at", "id", "is_active"])
          .where("email_normalized", "=", email)
          .orderBy("id", "asc")
          .execute();
        const activeUsers = matchingUsers.filter((user) => user.deleted_at === null);

        if (activeUsers.length === 1) {
          const existingUser = activeUsers[0]!;
          if (!existingUser.is_active) {
            throw new Error("동일 이메일의 비활성 사용자 계정이 있어 교사를 생성할 수 없습니다.");
          }
          const teacherProfile = await transaction
            .selectFrom("teacher_profiles")
            .select("status")
            .where("user_id", "=", existingUser.id)
            .executeTakeFirst();
          if (teacherProfile?.status === "active") {
            return { created: false as const, userId: existingUser.id };
          }
          if (teacherProfile?.status === "revoked") {
            throw new Error("동일 이메일의 revoked 교사 계정은 다시 개통할 수 없습니다.");
          }
          throw new Error("동일 이메일의 학생 계정이 있어 교사를 생성할 수 없습니다.");
        }

        if (activeUsers.length > 1 || matchingUsers.length > 0) {
          throw new Error("동일 이메일의 기존 또는 삭제 계정이 있어 교사를 생성할 수 없습니다.");
        }

        const rawTemporaryPassword = generateTemporaryPassword();
        const passwordHash = await hashPassword(rawTemporaryPassword);
        const runId = randomUUID();
        const createdAt = new Date();
        const temporaryPasswordExpiresAt = new Date(
          createdAt.getTime() + TEMPORARY_PASSWORD_LIFETIME_MS,
        );
        const insert = transaction.insertInto("users").values({
          display_name: displayName,
          email_normalized: email,
          email_verified_at: createdAt,
          password_hash: passwordHash,
          password_input_version: NFC_PASSWORD_INPUT_VERSION,
        });
        const user = { id: await operatorInsertedId(transaction, insert) };
        await transaction
          .insertInto("teacher_profiles")
          .values({
            created_by_operator_id: authenticatedOperator.operatorId,
            temporary_password_expires_at: temporaryPasswordExpiresAt,
            temporary_password_must_change: true,
            user_id: user.id,
          })
          .execute();
        await transaction
          .insertInto("operator_audit_logs")
          .values({
            action: "teacher.created",
            actor_type: "operator",
            after_json: operatorJson(transaction, {
              teacher_profile_status: "active",
              teacher_user_id: user.id,
            }),
            before_json: null,
            operator_id: authenticatedOperator.operatorId,
            run_id: runId,
            target_id: user.id,
            target_type: "teacher_user",
          })
          .execute();
        return {
          created: true as const,
          rawTemporaryPassword,
          runId,
          temporaryPasswordExpiresAt,
          userId: user.id,
        };
      });

      if (!result.created) {
        return {
          created: false,
          displayName,
          email,
          rawTemporaryPassword: null,
          runId: null,
          temporaryPasswordExpiresAt: null,
          userId: result.userId,
        };
      }
      return {
        created: true,
        displayName,
        email,
        rawTemporaryPassword: result.rawTemporaryPassword,
        runId: result.runId,
        temporaryPasswordExpiresAt: result.temporaryPasswordExpiresAt,
        userId: result.userId,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error("동일 이메일 계정이 동시에 생성되어 교사 개통을 중단했습니다.");
      }
      throw error;
    }
  } finally {
    await database.destroy();
  }
}

/*
 * 교사가 학교 이메일 접근을 잃으면 계정과 학급 데이터에 영구히 닿을 수 없다.
 * PASSWORD_RESET_ENABLED가 기본 false이고 provision-teacher는 멱등 no-op이라
 * 재발급 경로가 없었다(2026-08-05 DEC-BLK-04). 운영자가 문의를 확인한 뒤
 * 실행하는 수동 절차이며, 웹에 노출하지 않아 공격 표면을 늘리지 않는다.
 */
export async function resetTeacherPassword(
  input: ResetTeacherPasswordInput,
): Promise<ResetTeacherPasswordResult> {
  const email = normalizeTeacherEmail(input.email);
  const database = await openOperatorDatabase(input.operatorDatabaseUrl);

  try {
    const authenticatedOperator = await authenticateOperator(database, input.operatorToken);

    return await database.transaction().execute(async (transaction) => {
      await lockAndRevalidateOperator(transaction, authenticatedOperator);
      await lockOperatorTransaction(transaction, TEACHER_PROVISION_LOCK_NAME);

      const matchingUsers = await transaction
        .selectFrom("users")
        .select(["deleted_at", "id", "is_active"])
        .where("email_normalized", "=", email)
        .orderBy("id", "asc")
        .execute();
      const activeUsers = matchingUsers.filter((user) => user.deleted_at === null);
      if (activeUsers.length === 0) {
        throw new Error(
          "해당 이메일의 활성 계정을 찾지 못해 임시 비밀번호를 재발급하지 않았습니다.",
        );
      }
      if (activeUsers.length > 1) {
        throw new Error("동일 이메일의 활성 계정이 여러 건이라 재발급을 중단했습니다.");
      }

      const existingUser = activeUsers[0]!;
      if (!existingUser.is_active) {
        throw new Error("비활성 계정은 임시 비밀번호를 재발급할 수 없습니다.");
      }

      const teacherProfile = await transaction
        .selectFrom("teacher_profiles")
        .select(["status", "temporary_password_expires_at"])
        .where("user_id", "=", existingUser.id)
        .executeTakeFirst();
      if (teacherProfile === undefined) {
        throw new Error("교사 계정이 아니어서 임시 비밀번호를 재발급할 수 없습니다.");
      }
      if (teacherProfile.status !== "active") {
        throw new Error(
          `교사 상태가 ${teacherProfile.status}이라 임시 비밀번호를 재발급할 수 없습니다.`,
        );
      }

      // 발급 시각을 따로 저장하지 않으므로 만료 시각에서 되돌려 구한다. 수명이
      // 고정 상수라 정확하고, 이것 하나 때문에 컬럼을 늘리지 않는다.
      if (!input.force && teacherProfile.temporary_password_expires_at !== null) {
        const issuedAt =
          operatorTimestamp(teacherProfile.temporary_password_expires_at).getTime() -
          TEMPORARY_PASSWORD_LIFETIME_MS;
        if (Date.now() - issuedAt < REISSUE_COOLDOWN_MS) {
          throw new Error(
            "이 교사는 방금 임시 비밀번호를 받았습니다. 다른 운영자가 이미 처리했는지 확인하세요. " +
              "그래도 새로 발급해야 하면 --force로 실행하세요.",
          );
        }
      }

      const rawTemporaryPassword = generateTemporaryPassword();
      const passwordHash = await hashPassword(rawTemporaryPassword);
      const runId = randomUUID();
      const resetAt = new Date();
      const temporaryPasswordExpiresAt = new Date(
        resetAt.getTime() + TEMPORARY_PASSWORD_LIFETIME_MS,
      );

      await transaction
        .updateTable("users")
        .set({
          password_hash: passwordHash,
          password_input_version: NFC_PASSWORD_INPUT_VERSION,
        })
        .where("id", "=", existingUser.id)
        .execute();
      await transaction
        .updateTable("teacher_profiles")
        .set({
          temporary_password_expires_at: temporaryPasswordExpiresAt,
          temporary_password_must_change: true,
        })
        .where("user_id", "=", existingUser.id)
        .execute();

      // 재설정은 계정 탈취 대응이기도 하므로 살아 있는 세션을 모두 끊는다.
      const revoked = await transaction
        .updateTable("sessions")
        .set({ revoked_at: resetAt })
        .where("user_id", "=", existingUser.id)
        .where("revoked_at", "is", null)
        .executeTakeFirst();

      await transaction
        .insertInto("operator_audit_logs")
        .values({
          action: "teacher.password_reset",
          actor_type: "operator",
          // json allowlist가 teacher.% 에 허용하는 키만 쓴다. 임시 비밀번호
          // 관련 상태는 teacher_profiles가 이미 들고 있어 중복 기록하지 않는다.
          after_json: operatorJson(transaction, {
            teacher_profile_status: "active",
            teacher_user_id: existingUser.id,
          }),
          before_json: null,
          operator_id: authenticatedOperator.operatorId,
          run_id: runId,
          target_id: existingUser.id,
          target_type: "teacher_user",
        })
        .execute();

      return {
        email,
        rawTemporaryPassword,
        revokedSessionCount: Number(revoked.numUpdatedRows),
        runId,
        temporaryPasswordExpiresAt,
        userId: existingUser.id,
      };
    });
  } finally {
    await database.destroy();
  }
}
