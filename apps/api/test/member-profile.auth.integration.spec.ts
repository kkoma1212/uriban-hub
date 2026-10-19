import { setImmediate as waitForImmediate } from "node:timers/promises";

import type { DB } from "@classhub/db";
import { sql, type Transaction } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ActorFixture, ClassFixture } from "./supplies-test-harness.js";
import {
  app,
  createClassFixture,
  database,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

type ProfilePayload = Partial<{
  display_name_in_class: unknown;
  student_number: unknown;
}>;

function getProfileRequest(actor: ActorFixture, memberId: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/members/${memberId}/profile`,
    headers: actor.headers,
  });
}

function profileRequest(
  actor: ActorFixture,
  memberId: string,
  payload: ProfilePayload,
  ifMatch: string | null = '"1"',
) {
  return app.inject({
    method: "PATCH",
    url: `/api/v1/members/${memberId}/profile`,
    headers: {
      ...actor.headers,
      ...(ifMatch === null ? {} : { "if-match": ifMatch }),
    },
    payload,
  });
}

async function memberState(memberId: string) {
  return database
    .selectFrom("class_members")
    .select(["display_name_in_class", "row_version", "status", "student_number", "updated_at"])
    .where("id", "=", memberId)
    .executeTakeFirstOrThrow();
}

async function profileAudits(memberId: string) {
  return database
    .selectFrom("audit_logs")
    .select(["after_json", "before_json", "created_at", "target_id"])
    .where("action", "=", "member.profile_updated")
    .where("target_id", "=", memberId)
    .orderBy("id")
    .execute();
}

async function lockProfileRows(
  transaction: Transaction<DB>,
  fixture: ClassFixture,
  target: ActorFixture,
): Promise<void> {
  await transaction
    .selectFrom("users")
    .select("id")
    .where("id", "in", [fixture.teacher.userId, target.userId])
    .orderBy("id")
    .forUpdate()
    .execute();
  await transaction
    .selectFrom("classes")
    .select("id")
    .where("id", "=", fixture.classId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  await transaction
    .selectFrom("class_members")
    .select("id")
    .where("id", "in", [fixture.teacher.memberId!, target.memberId!])
    .orderBy("id")
    .forUpdate()
    .execute();
}

beforeAll(async () => {
  await setupSuppliesHarness();
}, 90_000);

afterAll(async () => {
  await teardownSuppliesHarness();
});

describe.sequential("teacher-only member management role boundary", () => {
  it("denies all five routes to a student without changing rows, history, or audit", async () => {
    const fixture = await createClassFixture();
    const actor = fixture.students[0];
    const pendingMemberId = fixture.students[1].memberId!;
    const approvedMemberId = fixture.students[2].memberId!;
    await database
      .updateTable("class_members")
      .set({ status: "pending", student_number: null })
      .where("id", "=", pendingMemberId)
      .execute();
    const removedMember = await database
      .insertInto("class_members")
      .values({
        class_id: fixture.classId,
        role: "student",
        status: "removed",
        user_id: fixture.outsider.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const targetIds = [pendingMemberId, approvedMemberId, removedMember.id];
    const beforeMembers = await database
      .selectFrom("class_members")
      .selectAll()
      .where("id", "in", targetIds)
      .orderBy("id")
      .execute();
    const [beforeHistory, beforeAudit] = await Promise.all([
      database
        .selectFrom("class_member_status_history")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("member_id", "in", targetIds)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("audit_logs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("target_id", "in", targetIds)
        .executeTakeFirstOrThrow(),
    ]);

    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/members", headers: actor.headers }),
      app.inject({
        method: "POST",
        url: `/api/v1/members/${pendingMemberId}/approve`,
        headers: actor.headers,
        payload: { display_name_in_class: null, student_number: 20 },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/members/${pendingMemberId}/reject`,
        headers: actor.headers,
        payload: { reason: null },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/members/${approvedMemberId}/remove`,
        headers: actor.headers,
        payload: { reason: null },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/members/${removedMember.id}/allow-rejoin`,
        headers: actor.headers,
      }),
    ]);
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "ROLE_INSUFFICIENT" } });
    }

    const [afterMembers, afterHistory, afterAudit] = await Promise.all([
      database
        .selectFrom("class_members")
        .selectAll()
        .where("id", "in", targetIds)
        .orderBy("id")
        .execute(),
      database
        .selectFrom("class_member_status_history")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("member_id", "in", targetIds)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("audit_logs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("target_id", "in", targetIds)
        .executeTakeFirstOrThrow(),
    ]);
    expect(afterMembers).toEqual(beforeMembers);
    expect(afterHistory).toEqual(beforeHistory);
    expect(afterAudit).toEqual(beforeAudit);
  });
});

describe.sequential("GET /members/:id/profile", () => {
  it("returns only the approved student's safe class fields with an ETag and makes no write", async () => {
    const fixture = await createClassFixture();
    const target = fixture.students[0];
    const before = await memberState(target.memberId!);

    const response = await getProfileRequest(fixture.teacher, target.memberId!);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers.etag).toBe('"1"');
    const body = response.json<{
      member: Record<string, unknown>;
    }>();
    expect(Object.keys(body)).toEqual(["member"]);
    expect(Object.keys(body.member).sort()).toEqual(
      [
        "account_state",
        "display_name",
        "display_name_in_class",
        "id",
        "requested_at",
        "row_version",
        "status",
        "status_changed_at",
        "student_number",
      ].sort(),
    );
    expect(body.member).toMatchObject({
      account_state: "active",
      display_name: "학생가",
      display_name_in_class: null,
      id: target.memberId,
      requested_at: null,
      row_version: "1",
      status: "approved",
      student_number: 1,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /email|phone|address|guardian|birth|gender|password|token/iu,
    );
    expect(await memberState(target.memberId!)).toEqual(before);
    expect(await profileAudits(target.memberId!)).toEqual([]);
  });

  it("fails closed for students, another class, non-approved members, and invalid identifiers", async () => {
    const fixture = await createClassFixture();
    const other = await createClassFixture();
    const target = fixture.students[0];

    const studentAttempt = await getProfileRequest(target, target.memberId!);
    expect(studentAttempt.statusCode).toBe(403);
    expect(studentAttempt.json()).toMatchObject({ error: { code: "ROLE_INSUFFICIENT" } });

    const otherClass = await getProfileRequest(fixture.teacher, other.students[0].memberId!);
    expect(otherClass.statusCode).toBe(404);
    expect(otherClass.json()).toMatchObject({ error: { code: "MEMBER_NOT_FOUND" } });

    await database
      .updateTable("class_members")
      .set({ status: "removed", student_number: null })
      .where("id", "=", target.memberId!)
      .executeTakeFirstOrThrow();
    const removed = await getProfileRequest(fixture.teacher, target.memberId!);
    expect(removed.statusCode).toBe(404);
    expect(removed.json()).toMatchObject({ error: { code: "MEMBER_NOT_FOUND" } });

    for (const invalidId of ["0", "-1", "abc", "999999999999999999999999999999999999"]) {
      const invalid = await getProfileRequest(fixture.teacher, invalidId);
      expect(invalid.statusCode, invalidId).toBe(404);
    }
  });
});

describe.sequential("PATCH /members/:id/profile", () => {
  it("updates sent fields with a DB timestamp, returns ETag, and never audits a student number", async () => {
    const fixture = await createClassFixture();
    const target = fixture.students[0];
    const originalUpdatedAt = new Date("2026-01-02T03:04:05.678Z");
    await database
      .updateTable("class_members")
      .set({ updated_at: originalUpdatedAt })
      .where("id", "=", target.memberId!)
      .executeTakeFirstOrThrow();

    const changed = await profileRequest(
      fixture.teacher,
      target.memberId!,
      { display_name_in_class: "  반 별명  ", student_number: 9 },
      '"1"',
    );
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.headers.etag).toBe('"2"');
    expect(changed.json()).toMatchObject({
      member: {
        account_state: "active",
        display_name: "반 별명",
        display_name_in_class: "반 별명",
        id: target.memberId,
        row_version: "2",
        status: "approved",
        student_number: 9,
      },
      profile_updated: true,
    });

    const stored = await memberState(target.memberId!);
    expect(stored).toMatchObject({
      display_name_in_class: "반 별명",
      row_version: "2",
      status: "approved",
      student_number: 9,
    });
    expect(stored.updated_at.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());

    const audits = await profileAudits(target.memberId!);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      before_json: { display_name_snapshot: "학생가" },
      after_json: { display_name_snapshot: "반 별명" },
      target_id: target.memberId,
    });
    expect(audits[0]!.created_at.toISOString()).toBe(stored.updated_at.toISOString());
    expect(JSON.stringify(audits)).not.toContain("student_number");
    expect(JSON.stringify(audits)).not.toContain('"9"');

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/members?status=approved",
      headers: fixture.teacher.headers,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(
      list.json<{ members: Array<{ display_name_in_class: string | null; id: string }> }>().members,
    ).toContainEqual(
      expect.objectContaining({
        display_name_in_class: "반 별명",
        id: target.memberId,
      }),
    );
  });

  it("keeps row metadata and audit exactly unchanged for no-op, then uses empty safe audit JSON for number-only change", async () => {
    const fixture = await createClassFixture();
    const target = fixture.students[1];
    const before = await memberState(target.memberId!);

    const noOp = await profileRequest(
      fixture.teacher,
      target.memberId!,
      { display_name_in_class: null, student_number: before.student_number },
      '"1"',
    );
    expect(noOp.statusCode, noOp.body).toBe(200);
    expect(noOp.headers.etag).toBe('"1"');
    expect(noOp.json()).toMatchObject({ profile_updated: false });
    expect(await memberState(target.memberId!)).toEqual(before);
    expect(await profileAudits(target.memberId!)).toEqual([]);

    const numberOnly = await profileRequest(
      fixture.teacher,
      target.memberId!,
      { student_number: 8 },
      '"1"',
    );
    expect(numberOnly.statusCode, numberOnly.body).toBe(200);
    expect(numberOnly.headers.etag).toBe('"2"');
    expect(numberOnly.json()).toMatchObject({
      member: {
        display_name: "학생나",
        display_name_in_class: null,
        row_version: "2",
        student_number: 8,
      },
      profile_updated: true,
    });
    const audits = await profileAudits(target.memberId!);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ after_json: {}, before_json: {} });
    expect(JSON.stringify(audits)).not.toContain("student_number");
  });

  it("requires one valid field and an exact quoted strong If-Match", async () => {
    const fixture = await createClassFixture();
    const targetId = fixture.students[0].memberId!;

    const missing = await profileRequest(
      fixture.teacher,
      targetId,
      { display_name_in_class: "새 이름" },
      null,
    );
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ error: { code: "IF_MATCH_REQUIRED" } });

    for (const invalid of ["1", 'W/"1"', "*", '"0"', '"1", "2"']) {
      const response = await profileRequest(
        fixture.teacher,
        targetId,
        { display_name_in_class: "새 이름" },
        invalid,
      );
      expect(response.statusCode, invalid).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "INVALID_IF_MATCH" } });
    }

    const empty = await profileRequest(fixture.teacher, targetId, {}, '"1"');
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    for (const payload of [
      { display_name_in_class: "가" },
      { display_name_in_class: "" },
      { display_name_in_class: "<b>학생</b>" },
      { display_name_in_class: "학생\n이름" },
      { display_name_in_class: "😀".repeat(21) },
      { student_number: 0 },
      { student_number: 100 },
      { student_number: 1.5 },
      { student_number: "7" },
      { unknown: true },
    ]) {
      const response = await profileRequest(fixture.teacher, targetId, payload, '"1"');
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    }
    expect(await memberState(targetId)).toMatchObject({ row_version: "1", student_number: 1 });
    expect(await profileAudits(targetId)).toEqual([]);
  });

  it("enforces teacher/class privacy, allows an inactive approved target, and rejects duplicate numbers", async () => {
    const fixture = await createClassFixture();
    const other = await createClassFixture();
    const target = fixture.students[0];

    const studentAttempt = await profileRequest(
      target,
      target.memberId!,
      { display_name_in_class: "학생 수정" },
      '"1"',
    );
    expect(studentAttempt.statusCode).toBe(403);
    expect(studentAttempt.json()).toMatchObject({ error: { code: "ROLE_INSUFFICIENT" } });

    const studentOtherClassAttempt = await profileRequest(
      target,
      other.students[0].memberId!,
      { display_name_in_class: "타 반 조회 시도" },
      '"1"',
    );
    expect(studentOtherClassAttempt.statusCode).toBe(403);
    expect(studentOtherClassAttempt.json()).toMatchObject({
      error: { code: "ROLE_INSUFFICIENT" },
    });

    const studentMissingAttempt = await profileRequest(
      target,
      "9223372036854775807",
      { display_name_in_class: "없는 학생 조회 시도" },
      '"1"',
    );
    expect(studentMissingAttempt.statusCode).toBe(403);
    expect(studentMissingAttempt.json()).toMatchObject({
      error: { code: "ROLE_INSUFFICIENT" },
    });

    const otherClass = await profileRequest(
      fixture.teacher,
      other.students[0].memberId!,
      { display_name_in_class: "타 반 수정" },
      '"1"',
    );
    expect(otherClass.statusCode).toBe(404);
    expect(otherClass.json()).toMatchObject({ error: { code: "MEMBER_NOT_FOUND" } });

    const hugeId = await profileRequest(
      fixture.teacher,
      "999999999999999999999999999999999999999999",
      { display_name_in_class: "큰 식별자" },
      '"1"',
    );
    expect(hugeId.statusCode).toBe(404);

    const inactive = await profileRequest(
      fixture.teacher,
      fixture.inactive.memberId!,
      { display_name_in_class: "휴면 학생" },
      '"1"',
    );
    expect(inactive.statusCode, inactive.body).toBe(200);
    expect(inactive.json()).toMatchObject({
      member: { account_state: "inactive", display_name: "휴면 학생", row_version: "2" },
    });

    const duplicate = await profileRequest(
      fixture.teacher,
      fixture.inactive.memberId!,
      { student_number: 1 },
      '"2"',
    );
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: { code: "STUDENT_NUMBER_ALREADY_IN_USE" },
    });
    expect(await memberState(fixture.inactive.memberId!)).toMatchObject({
      display_name_in_class: "휴면 학생",
      row_version: "2",
      student_number: 4,
    });
  });

  it("lets exactly one same-version concurrent PATCH commit", async () => {
    const fixture = await createClassFixture();
    const target = fixture.students[2];
    const responses = await Promise.all([
      profileRequest(
        fixture.teacher,
        target.memberId!,
        { display_name_in_class: "첫 번째 이름" },
        '"1"',
      ),
      profileRequest(
        fixture.teacher,
        target.memberId!,
        { display_name_in_class: "두 번째 이름" },
        '"1"',
      ),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const stale = responses.find((response) => response.statusCode === 409)!;
    expect(stale.json()).toMatchObject({
      error: { code: "RESOURCE_VERSION_CHANGED", details: { current_row_version: "2" } },
    });
    expect(await memberState(target.memberId!)).toMatchObject({
      row_version: "2",
      status: "approved",
    });
    expect(await profileAudits(target.memberId!)).toHaveLength(1);
  });

  it("fails closed when removal or account deletion wins the user-class-member lock race", async () => {
    for (const outcome of ["removed", "account_deleted"] as const) {
      const fixture = await createClassFixture();
      const target = fixture.students[0];
      let request: ReturnType<typeof profileRequest> | undefined;

      await database.transaction().execute(async (transaction) => {
        await lockProfileRows(transaction, fixture, target);
        request = profileRequest(
          fixture.teacher,
          target.memberId!,
          { display_name_in_class: `경쟁 ${outcome}` },
          '"1"',
        );
        await waitForImmediate();
        const now = sql<Date>`transaction_timestamp()`;
        await transaction
          .updateTable("class_members")
          .set({
            ...(outcome === "account_deleted" ? { display_name_in_class: null } : {}),
            row_version: sql`row_version + 1`,
            status: outcome,
            status_changed_at: now,
            student_number: null,
            updated_at: now,
          })
          .where("id", "=", target.memberId!)
          .executeTakeFirstOrThrow();
        if (outcome === "account_deleted") {
          await transaction
            .updateTable("users")
            .set({
              anonymized_at: now,
              deleted_at: now,
              display_name: "탈퇴한 사용자",
              email_normalized: `deleted-member-profile-${target.userId}@invalid.local`,
              is_active: false,
              password_hash: `deleted-member-profile-${target.userId}`,
              updated_at: now,
            })
            .where("id", "=", target.userId)
            .executeTakeFirstOrThrow();
        }
      });

      expect(request).toBeDefined();
      const response = await request!;
      expect(response.statusCode, `${outcome}: ${response.body}`).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "RESOURCE_VERSION_CHANGED", details: { current_row_version: "2" } },
      });
      expect(await profileAudits(target.memberId!)).toEqual([]);
      expect(await memberState(target.memberId!)).toMatchObject({
        row_version: "2",
        status: outcome,
      });
    }
  });

  it("does not write a profile or audit when class archive wins the lock race", async () => {
    const fixture = await createClassFixture();
    const target = fixture.students[1];
    let request: ReturnType<typeof profileRequest> | undefined;

    await database.transaction().execute(async (transaction) => {
      await lockProfileRows(transaction, fixture, target);
      request = profileRequest(
        fixture.teacher,
        target.memberId!,
        { display_name_in_class: "아카이브 경쟁" },
        '"1"',
      );
      await waitForImmediate();
      const now = sql<Date>`transaction_timestamp()`;
      await transaction
        .updateTable("class_members")
        .set({
          row_version: sql`row_version + 1`,
          status: "archived",
          status_changed_at: now,
          student_number: null,
          updated_at: now,
        })
        .where("class_id", "=", fixture.classId)
        .where("status", "in", ["pending", "approved"])
        .execute();
      await transaction
        .updateTable("classes")
        .set({
          archived_at: now,
          archived_by_user_id: fixture.teacher.userId,
          row_version: sql`row_version + 1`,
          status: "archived",
          updated_at: now,
        })
        .where("id", "=", fixture.classId)
        .executeTakeFirstOrThrow();
    });

    expect(request).toBeDefined();
    const response = await request!;
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "MEMBER_NOT_FOUND" } });
    expect(await profileAudits(target.memberId!)).toEqual([]);
    expect(await memberState(target.memberId!)).toMatchObject({
      display_name_in_class: null,
      row_version: "2",
      status: "archived",
    });
  });
});
