import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ActorFixture } from "./supplies-test-harness.js";
import {
  app,
  createClassFixture,
  database,
  publicOrigin,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

function profileRequest(
  actor: ActorFixture,
  displayName: unknown,
  headers: Record<string, string> = actor.headers,
) {
  return app.inject({
    method: "PATCH",
    url: "/api/v1/account/profile",
    headers,
    payload: { display_name: displayName },
  });
}

async function accountState(userId: string) {
  return database
    .selectFrom("users")
    .select(["display_name", "updated_at"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
}

async function currentSessionId(userId: string): Promise<string> {
  const session = await database
    .selectFrom("sessions")
    .select("id")
    .where("user_id", "=", userId)
    .orderBy("id", "desc")
    .executeTakeFirstOrThrow();
  return session.id;
}

beforeAll(async () => {
  await setupSuppliesHarness();
}, 90_000);

afterAll(async () => {
  await teardownSuppliesHarness();
});

describe.sequential("PATCH /account/profile", () => {
  it("updates only the account name, exposes both name scopes in bootstrap, and preserves exact no-op metadata", async () => {
    const fixture = await createClassFixture();
    const actor = fixture.students[0];
    const originalUpdatedAt = new Date("2026-01-02T03:04:05.678Z");
    await database
      .updateTable("users")
      .set({ display_name: "기존 계정 이름", updated_at: originalUpdatedAt })
      .where("id", "=", actor.userId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("class_members")
      .set({ display_name_in_class: "반에서 쓰는 이름" })
      .where("id", "=", actor.memberId!)
      .executeTakeFirstOrThrow();

    const membershipBefore = await database
      .selectFrom("class_members")
      .select(["display_name_in_class", "row_version", "updated_at"])
      .where("id", "=", actor.memberId!)
      .executeTakeFirstOrThrow();
    const auditBefore = await database
      .selectFrom("audit_logs")
      .select("id")
      .where("actor_user_id", "=", actor.userId)
      .execute();

    const response = await profileRequest(actor, "  새 계정 이름  ");
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      display_name: string;
      profile_updated: boolean;
      updated_at: string;
    }>();
    expect(body).toMatchObject({
      display_name: "새 계정 이름",
      profile_updated: true,
    });
    expect(new Date(body.updated_at).toISOString()).toBe(body.updated_at);

    const changedAccount = await accountState(actor.userId);
    expect(changedAccount.display_name).toBe("새 계정 이름");
    expect(changedAccount.updated_at.toISOString()).toBe(body.updated_at);
    expect(changedAccount.updated_at.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());

    const membershipAfter = await database
      .selectFrom("class_members")
      .select(["display_name_in_class", "row_version", "updated_at"])
      .where("id", "=", actor.memberId!)
      .executeTakeFirstOrThrow();
    expect(membershipAfter).toEqual(membershipBefore);
    expect(
      await database
        .selectFrom("audit_logs")
        .select("id")
        .where("actor_user_id", "=", actor.userId)
        .execute(),
    ).toEqual(auditBefore);

    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: actor.headers,
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    expect(bootstrap.json()).toMatchObject({
      account: { display_name: "새 계정 이름" },
      current_membership: { display_name_in_class: "반에서 쓰는 이름", student_number: 1 },
    });

    const noOp = await profileRequest(actor, "  새 계정 이름  ");
    expect(noOp.statusCode, noOp.body).toBe(200);
    expect(noOp.json()).toEqual({
      display_name: "새 계정 이름",
      profile_updated: false,
      updated_at: body.updated_at,
    });
    expect((await accountState(actor.userId)).updated_at.toISOString()).toBe(body.updated_at);
    expect(
      await database
        .selectFrom("class_members")
        .select(["display_name_in_class", "row_version", "updated_at"])
        .where("id", "=", actor.memberId!)
        .executeTakeFirstOrThrow(),
    ).toEqual(membershipBefore);
  });

  it("rejects invalid text, Origin, CSRF, unverified email, and inactive accounts without mutation", async () => {
    const fixture = await createClassFixture();
    const actor = fixture.students[1];
    const before = await accountState(actor.userId);
    const inactiveBefore = await accountState(fixture.inactive.userId);

    for (const displayName of [
      "가",
      "😀".repeat(21),
      "<b>학생</b>",
      "학생\n이름",
      "학생\u0000이름",
    ]) {
      const response = await profileRequest(actor, displayName);
      expect(response.statusCode, response.body).toBe(400);
    }

    const { cookie, "x-csrf-token": csrf } = actor.headers;
    const noOrigin = await profileRequest(actor, "바꿀 이름", {
      cookie: cookie!,
      "x-csrf-token": csrf!,
    });
    expect(noOrigin.statusCode, noOrigin.body).toBe(403);
    const wrongOrigin = await profileRequest(actor, "바꿀 이름", {
      ...actor.headers,
      origin: "https://attacker.invalid",
    });
    expect(wrongOrigin.statusCode, wrongOrigin.body).toBe(403);
    const wrongCsrf = await profileRequest(actor, "바꿀 이름", {
      ...actor.headers,
      "x-csrf-token": "wrong-csrf-token",
    });
    expect(wrongCsrf.statusCode, wrongCsrf.body).toBe(403);

    await database
      .updateTable("users")
      .set({ email_verified_at: null })
      .where("id", "=", actor.userId)
      .executeTakeFirstOrThrow();
    const unverified = await profileRequest(actor, "바꿀 이름");
    expect(unverified.statusCode, unverified.body).toBe(403);
    const unverifiedBootstrap = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: actor.headers,
    });
    expect(unverifiedBootstrap.statusCode, unverifiedBootstrap.body).toBe(200);
    expect(unverifiedBootstrap.json()).toMatchObject({
      allowed_actions: ["CONFIRM_SIGNUP_APPROVAL", "LOGOUT", "DELETE_ACCOUNT"],
      destination: "SIGNUP_APPROVAL_REQUIRED",
    });

    const inactive = await profileRequest(fixture.inactive, "바꿀 이름");
    expect(inactive.statusCode, inactive.body).toBe(401);
    expect(await accountState(fixture.inactive.userId)).toEqual(inactiveBefore);
    expect(await accountState(actor.userId)).toEqual(before);
  });

  it("updates an active teacher but blocks temporary-password and revoked teacher policy states", async () => {
    const fixture = await createClassFixture();
    const actor = fixture.teacher;
    const membershipBefore = await database
      .selectFrom("class_members")
      .select(["display_name_in_class", "row_version", "updated_at"])
      .where("id", "=", actor.memberId!)
      .executeTakeFirstOrThrow();
    const auditBefore = await database
      .selectFrom("audit_logs")
      .select("id")
      .where("actor_user_id", "=", actor.userId)
      .execute();

    const updated = await profileRequest(actor, "새 교사 계정 이름");
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      display_name: "새 교사 계정 이름",
      profile_updated: true,
    });
    expect(
      await database
        .selectFrom("class_members")
        .select(["display_name_in_class", "row_version", "updated_at"])
        .where("id", "=", actor.memberId!)
        .executeTakeFirstOrThrow(),
    ).toEqual(membershipBefore);
    expect(
      await database
        .selectFrom("audit_logs")
        .select("id")
        .where("actor_user_id", "=", actor.userId)
        .execute(),
    ).toEqual(auditBefore);

    await database
      .updateTable("teacher_profiles")
      .set({
        temporary_password_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000),
        temporary_password_must_change: true,
      })
      .where("user_id", "=", actor.userId)
      .executeTakeFirstOrThrow();
    const policyBlockedBefore = await accountState(actor.userId);
    const temporaryPassword = await profileRequest(actor, "차단되어야 할 이름");
    expect(temporaryPassword.statusCode, temporaryPassword.body).toBe(403);
    expect(await accountState(actor.userId)).toEqual(policyBlockedBefore);
    const temporaryBootstrap = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: actor.headers,
    });
    expect(temporaryBootstrap.json()).toMatchObject({
      allowed_actions: ["CHANGE_PASSWORD", "LOGOUT"],
      destination: "CHANGE_TEMPORARY_PASSWORD",
    });

    await database.transaction().execute(async (transaction) => {
      const now = new Date();
      await transaction
        .updateTable("class_members")
        .set({
          status: "archived",
          status_changed_at: now,
          student_number: null,
          updated_at: now,
        })
        .where("class_id", "=", fixture.classId)
        .execute();
      await transaction
        .updateTable("classes")
        .set({
          archived_at: now,
          archived_by_user_id: actor.userId,
          status: "archived",
          updated_at: now,
        })
        .where("id", "=", fixture.classId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("teacher_profiles")
        .set({
          revoke_reason: "프로필 정책 격리 테스트",
          revoked_at: now,
          revoked_by_operator_id: fixture.operatorId,
          status: "revoked",
          temporary_password_expires_at: null,
          temporary_password_must_change: false,
        })
        .where("user_id", "=", actor.userId)
        .executeTakeFirstOrThrow();
    });
    const revoked = await profileRequest(actor, "역시 차단될 이름");
    expect(revoked.statusCode, revoked.body).toBe(403);
    expect(await accountState(actor.userId)).toEqual(policyBlockedBefore);
    const revokedBootstrap = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: actor.headers,
    });
    expect(revokedBootstrap.json()).toMatchObject({
      allowed_actions: ["CHANGE_PASSWORD", "LOGOUT"],
      destination: "TEACHER_REVOKED",
    });
  });

  it("fails closed on revoked or expired sessions and leaves users unchanged", async () => {
    const revokedFixture = await createClassFixture();
    const revokedActor = revokedFixture.students[0];
    const revokedBefore = await accountState(revokedActor.userId);
    await database
      .updateTable("sessions")
      .set({ revoked_at: new Date() })
      .where("id", "=", await currentSessionId(revokedActor.userId))
      .executeTakeFirstOrThrow();
    const revoked = await profileRequest(revokedActor, "새 표시명");
    expect(revoked.statusCode, revoked.body).toBe(401);
    expect(await accountState(revokedActor.userId)).toEqual(revokedBefore);

    const expiredFixture = await createClassFixture();
    const expiredActor = expiredFixture.students[0];
    const expiredBefore = await accountState(expiredActor.userId);
    await database
      .updateTable("sessions")
      .set({
        expires_at: new Date("2000-01-02T00:00:00.000Z"),
        issued_at: new Date("2000-01-01T00:00:00.000Z"),
      })
      .where("id", "=", await currentSessionId(expiredActor.userId))
      .executeTakeFirstOrThrow();
    const expired = await profileRequest(expiredActor, "새 표시명");
    expect(expired.statusCode, expired.body).toBe(401);
    expect(await accountState(expiredActor.userId)).toEqual(expiredBefore);
  });

  it("rechecks a session revoked while the user row is locked and returns 401 without a stale write", async () => {
    const fixture = await createClassFixture();
    const actor = fixture.students[2];
    const before = await accountState(actor.userId);
    const sessionId = await currentSessionId(actor.userId);

    let releaseUserLock = (): void => undefined;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseUserLock = resolve;
    });
    let announceUserLock = (): void => undefined;
    const userLocked = new Promise<void>((resolve) => {
      announceUserLock = resolve;
    });
    const blocker = database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", actor.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      announceUserLock();
      await waitForRelease;
    });
    await userLocked;

    const request = profileRequest(actor, "경쟁 중 표시명");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await database
      .updateTable("sessions")
      .set({ revoked_at: new Date() })
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    releaseUserLock();
    await blocker;

    const response = await request;
    expect(response.statusCode, response.body).toBe(401);
    expect(await accountState(actor.userId)).toEqual(before);
  });

  it("documents the same-origin target used by every mutation fixture", () => {
    expect(publicOrigin).toBe("https://classhub.test");
  });
});
