import { createHash, randomUUID } from "node:crypto";

import { sql } from "kysely";
import { createClient } from "redis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readDatabaseKstToday } from "../src/common/date/database-kst-clock.js";
import { addCalendarDays } from "../src/common/date/kst-date.js";
import {
  app,
  type ActorFixture,
  type ClassFixture,
  createClassFixture,
  database,
  getSuppliesHarnessRedisUrl,
  seedSupply,
  setupSuppliesHarnessWithRedis,
  stopSuppliesHarnessRedis,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

interface ReminderResult {
  batch_id: string;
  cooldown_suppressed_count: number;
  created_at: string;
  created_count: number;
  current_unresolved_count: number;
  next_available_at: string | null;
}

interface HomeReminder {
  /* 준비물일 때만 온다 — 공지에는 분류가 없다(BLUE-10). */
  category?: "general" | "homework";
  reminder_type: "notice" | "supply";
  requested_at: string;
  resource_id: string;
  title: string;
}

interface HomeResult {
  notices: { data: unknown[]; status: string };
  reminders: {
    data: HomeReminder[];
    error_code?: string;
    status: "empty" | "error" | "ok";
  };
  supplies: { data: unknown[]; status: string };
}

let fixture: ClassFixture;
let noticeSequence = 0;
let redisObserver: ReturnType<typeof createClient>;

async function seedNotice(
  owner: ClassFixture,
  values: Partial<{ content_revision: number; title: string }> = {},
) {
  return database
    .insertInto("notices")
    .values({
      class_id: owner.classId,
      content: "재알림 통합 테스트 공지 내용",
      content_revision: values.content_revision,
      created_by_member_id: owner.teacher.memberId!,
      title: values.title ?? `재알림 공지 ${++noticeSequence}`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

function reminderRateLimitKey(actorUserId: string): string {
  const digest = createHash("sha256").update(actorUserId, "utf8").digest("base64url");
  return `in-app-reminder:v1:actor:${digest}:policy:30:60`;
}

async function requestReminder(
  type: "notice" | "supply",
  resourceId: string,
  actor: ActorFixture,
  contentRevision: number,
  idempotencyKey = randomUUID(),
) {
  return app.inject({
    headers: { ...actor.headers, "idempotency-key": idempotencyKey },
    method: "POST",
    payload: { content_revision: contentRevision },
    url: `/api/v1/${type === "notice" ? "notices" : "supplies"}/${resourceId}/reminders`,
  });
}

async function getHome(actor: ActorFixture) {
  return app.inject({
    headers: actor.headers,
    method: "GET",
    url: "/api/v1/home",
  });
}

function expectError(
  response: {
    json(): { error: { code: string; details?: Record<string, unknown> } };
    statusCode: number;
  },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json().error.code).toBe(code);
}

beforeAll(async () => {
  await setupSuppliesHarnessWithRedis();
  redisObserver = createClient({ url: getSuppliesHarnessRedisUrl() });
  redisObserver.on("error", () => undefined);
  await redisObserver.connect();
}, 120_000);

beforeEach(async () => {
  fixture = await createClassFixture();
});

afterAll(async () => {
  if (redisObserver?.isReady) await redisObserver.quit();
  else if (redisObserver?.isOpen) redisObserver.destroy();
  await teardownSuppliesHarness();
}, 120_000);

describe("in-app reminder HTTP contract", () => {
  it("targets only active approved unresolved notice students and exposes only each recipient's live card", async () => {
    const notice = await seedNotice(fixture, { content_revision: 2, title: "수학 준비 공지" });
    const now = new Date();
    await database
      .insertInto("class_members")
      .values({
        class_id: fixture.classId,
        role: "student",
        status: "pending",
        user_id: fixture.outsider.userId,
      })
      .execute();
    await database
      .insertInto("notice_reads")
      .values([
        {
          class_id: fixture.classId,
          confirmed_at: now,
          confirmed_revision: "2",
          first_confirmed_at: now,
          member_id: fixture.students[0].memberId!,
          notice_id: notice.id,
        },
        {
          class_id: fixture.classId,
          confirmed_at: now,
          confirmed_revision: "1",
          first_confirmed_at: now,
          member_id: fixture.students[1].memberId!,
          notice_id: notice.id,
        },
      ])
      .execute();

    const response = await requestReminder("notice", notice.id, fixture.teacher, 2);
    expect(response.statusCode).toBe(201);
    const body = response.json() as ReminderResult;
    expect(body).toMatchObject({
      cooldown_suppressed_count: 0,
      created_count: 2,
      current_unresolved_count: 2,
      next_available_at: null,
    });
    expect(body.batch_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );

    const recipients = await database
      .selectFrom("in_app_reminder_recipients")
      .select(["member_id", "resolved_at"])
      .where("batch_id", "=", body.batch_id)
      .orderBy("member_id", "asc")
      .execute();
    expect(recipients.map((row) => row.member_id)).toEqual(
      [fixture.students[1].memberId, fixture.students[2].memberId].sort(),
    );
    expect(recipients.every((row) => row.resolved_at === null)).toBe(true);

    const audit = await database
      .selectFrom("audit_logs")
      .select(["action", "after_json", "target_id", "target_type"])
      .where("action", "=", "notice.reminder_created")
      .where("target_id", "=", notice.id)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      action: "notice.reminder_created",
      target_id: notice.id,
      target_type: "notice",
    });
    expect(audit.after_json).toEqual({
      content_revision: "2",
      cooldown_suppressed_count: 0,
      created_count: 2,
      current_unresolved_count: 2,
      reminder_batch_id: body.batch_id,
    });

    const teacherHome = await getHome(fixture.teacher);
    expect(teacherHome.statusCode).toBe(200);
    expect((teacherHome.json() as HomeResult).reminders).toEqual({ data: [], status: "empty" });

    const resolvedStudentHome = await getHome(fixture.students[0]);
    expect((resolvedStudentHome.json() as HomeResult).reminders).toEqual({
      data: [],
      status: "empty",
    });
    const recipientHome = await getHome(fixture.students[1]);
    const reminderCard = (recipientHome.json() as HomeResult).reminders;
    expect(reminderCard.status).toBe("ok");
    expect(reminderCard.data).toEqual([
      {
        reminder_type: "notice",
        requested_at: body.created_at,
        resource_id: notice.id,
        title: "수학 준비 공지",
      },
    ]);
    expect(Object.keys(reminderCard.data[0]!).sort()).toEqual([
      "reminder_type",
      "requested_at",
      "resource_id",
      "title",
    ]);

    const confirmations = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: `/api/v1/notices/${notice.id}/confirmations?state=modified_unconfirmed`,
    });
    expect(confirmations.statusCode).toBe(200);
    expect(confirmations.json()).toMatchObject({
      last_reminder_requested_at: body.created_at,
    });

    const confirm = await app.inject({
      headers: fixture.students[1].headers,
      method: "PUT",
      payload: { content_revision: 2 },
      url: `/api/v1/notices/${notice.id}/confirmation`,
    });
    expect(confirm.statusCode).toBe(200);
    const resolvedRecipient = await database
      .selectFrom("in_app_reminder_recipients")
      .select("resolved_at")
      .where("batch_id", "=", body.batch_id)
      .where("member_id", "=", fixture.students[1].memberId!)
      .executeTakeFirstOrThrow();
    expect(resolvedRecipient.resolved_at).toBeInstanceOf(Date);
    expect((await getHome(fixture.students[1])).json()).toMatchObject({
      reminders: { data: [], status: "empty" },
    });
  });

  /*
   * 숙제는 준비물과 **같은 표**를 쓰고 링크도 같지만 학생이 할 행동이 다르다 —
   * "가져올 것"과 "할 것". 재알림이 분류를 안 실어 보내서 화면이 숙제도 "준비물"이라고
   * 부르고 있었다(2026-08-22 감사 BLUE-10). 공지에는 분류가 없어야 한다.
   */
  it("carries the supply category so homework is not called a supply", async () => {
    const homework = await seedSupply(fixture, {
      category: "homework",
      title: "수학 익힘책 3쪽",
    });
    expect((await requestReminder("supply", homework.id, fixture.teacher, 1)).statusCode).toBe(201);

    const homeworkCard = (await getHome(fixture.students[0])).json() as HomeResult;
    expect(homeworkCard.reminders.data).toEqual([
      {
        category: "homework",
        reminder_type: "supply",
        requested_at: expect.any(String),
        resource_id: homework.id,
        title: "수학 익힘책 3쪽",
      },
    ]);

    /* 공지는 분류 칸 자체가 없어야 한다 — 있으면 화면이 엉뚱한 말을 고른다. */
    const notice = await seedNotice(fixture, { title: "현장학습 안내" });
    expect((await requestReminder("notice", notice.id, fixture.teacher, 1)).statusCode).toBe(201);
    const bothCards = (await getHome(fixture.students[0])).json() as HomeResult;
    const noticeReminder = bothCards.reminders.data.find((item) => item.reminder_type === "notice");
    expect(noticeReminder).toBeDefined();
    expect(Object.keys(noticeReminder!)).not.toContain("category");
  });

  it("resolves a supply reminder on checked=true and never resurrects it after checked=false", async () => {
    const supply = await seedSupply(fixture, { title: "미술 준비물" });
    const created = await requestReminder("supply", supply.id, fixture.teacher, 1);
    expect(created.statusCode).toBe(201);
    const body = created.json() as ReminderResult;
    expect(body.created_count).toBe(3);
    expect((await getHome(fixture.students[0])).json()).toMatchObject({
      reminders: {
        data: [{ reminder_type: "supply", resource_id: supply.id, title: "미술 준비물" }],
        status: "ok",
      },
    });

    const checked = await app.inject({
      headers: fixture.students[0].headers,
      method: "PUT",
      payload: { content_revision: 1, is_checked: true },
      url: `/api/v1/supplies/${supply.id}/check`,
    });
    expect(checked.statusCode).toBe(200);
    const resolved = await database
      .selectFrom("in_app_reminder_recipients")
      .select("resolved_at")
      .where("batch_id", "=", body.batch_id)
      .where("member_id", "=", fixture.students[0].memberId!)
      .executeTakeFirstOrThrow();
    expect(resolved.resolved_at).toBeInstanceOf(Date);

    const unchecked = await app.inject({
      headers: fixture.students[0].headers,
      method: "PUT",
      payload: { content_revision: 1, is_checked: false },
      url: `/api/v1/supplies/${supply.id}/check`,
    });
    expect(unchecked.statusCode).toBe(200);
    expect((await getHome(fixture.students[0])).json()).toMatchObject({
      reminders: { data: [], status: "empty" },
    });
    const stillResolved = await database
      .selectFrom("in_app_reminder_recipients")
      .select("resolved_at")
      .where("batch_id", "=", body.batch_id)
      .where("member_id", "=", fixture.students[0].memberId!)
      .executeTakeFirstOrThrow();
    expect(stillResolved.resolved_at?.toISOString()).toBe(resolved.resolved_at?.toISOString());

    const checks = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: `/api/v1/supplies/${supply.id}/checks?state=unchecked`,
    });
    expect(checks.statusCode).toBe(200);
    expect(checks.json()).toMatchObject({ last_reminder_requested_at: body.created_at });
  });

  it("serializes same-key requests, consumes Redis once, and replays safely after revision change", async () => {
    const notice = await seedNotice(fixture);
    const key = randomUUID();
    const [first, second] = await Promise.all([
      requestReminder("notice", notice.id, fixture.teacher, 1, key),
      requestReminder("notice", notice.id, fixture.teacher, 1, key),
    ]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((first.json() as ReminderResult).batch_id).toBe(
      (second.json() as ReminderResult).batch_id,
    );
    expect(await redisObserver.get(reminderRateLimitKey(fixture.teacher.userId))).toBe("1");

    const batchCount = await database
      .selectFrom("in_app_reminder_batches")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("notice_id", "=", notice.id)
      .executeTakeFirstOrThrow();
    expect(Number(batchCount.count)).toBe(1);

    await database
      .updateTable("notices")
      .set({ content_revision: sql`content_revision + 1` })
      .where("id", "=", notice.id)
      .execute();
    const replayAfterEdit = await requestReminder("notice", notice.id, fixture.teacher, 1, key);
    expect(replayAfterEdit.statusCode).toBe(201);
    expect((replayAfterEdit.json() as ReminderResult).batch_id).toBe(
      (first.json() as ReminderResult).batch_id,
    );
    expect(await redisObserver.get(reminderRateLimitKey(fixture.teacher.userId))).toBe("1");

    expectError(
      await requestReminder("notice", notice.id, fixture.teacher, 2, key),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    expectError(
      await requestReminder("notice", notice.id, fixture.teacher, 1),
      409,
      "CONTENT_REVISION_CHANGED",
    );
  });

  it("enforces teacher/current-class access before replay and excludes inactive students", async () => {
    const own = await seedNotice(fixture);
    const other = await createClassFixture();
    const foreign = await seedNotice(other);

    expectError(
      await requestReminder("notice", own.id, fixture.students[0], 1),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(await requestReminder("notice", foreign.id, fixture.teacher, 1), 404, "NOT_FOUND");

    const key = randomUUID();
    const success = await requestReminder("notice", own.id, fixture.teacher, 1, key);
    expect(success.statusCode).toBe(201);
    await database
      .updateTable("classes")
      .set({
        status: "suspended",
        suspended_at: new Date(),
        suspended_by_operator_id: fixture.operatorId,
        suspended_reason: "재생 전 권한 검증 테스트",
      })
      .where("id", "=", fixture.classId)
      .execute();
    const replayWithoutAccess = await requestReminder("notice", own.id, fixture.teacher, 1, key);
    expect(replayWithoutAccess.statusCode).toBe(423);
    expect(replayWithoutAccess.json().error.code).toBe("CLASS_SUSPENDED");
  });

  it("serializes different keys and applies per-recipient cooldown with partial and all-suppressed results", async () => {
    const notice = await seedNotice(fixture);
    const concurrent = await Promise.all([
      requestReminder("notice", notice.id, fixture.teacher, 1),
      requestReminder("notice", notice.id, fixture.teacher, 1),
    ]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([201, 429]);
    const first = concurrent.find((response) => response.statusCode === 201)!;
    const firstBody = first.json() as ReminderResult;
    expect(firstBody.created_count).toBe(3);
    const cooldown = concurrent.find((response) => response.statusCode === 429)!;
    expect(cooldown.headers["retry-after"]).toMatch(/^[1-9][0-9]*$/u);
    expect(cooldown.json()).toMatchObject({
      error: {
        code: "REMINDER_COOLDOWN_ACTIVE",
        details: { next_available_at: expect.any(String) },
      },
    });

    await database
      .updateTable("in_app_reminder_recipients")
      .set({ created_at: sql<Date>`clock_timestamp() - interval '25 hours'` })
      .where("batch_id", "=", firstBody.batch_id)
      .where("member_id", "=", fixture.students[0].memberId!)
      .execute();
    const partial = await requestReminder("notice", notice.id, fixture.teacher, 1);
    expect(partial.statusCode).toBe(201);
    expect(partial.json()).toMatchObject({
      cooldown_suppressed_count: 2,
      created_count: 1,
      current_unresolved_count: 3,
      next_available_at: expect.any(String),
    });
    const partialRecipients = await database
      .selectFrom("in_app_reminder_recipients")
      .select("member_id")
      .where("batch_id", "=", (partial.json() as ReminderResult).batch_id)
      .execute();
    expect(partialRecipients.map((row) => row.member_id)).toEqual([fixture.students[0].memberId]);

    expectError(
      await requestReminder("notice", notice.id, fixture.teacher, 1),
      429,
      "REMINDER_COOLDOWN_ACTIVE",
    );
  });

  it("rejects zero unresolved recipients and rolls back every write when audit insert fails", async () => {
    const resolvedNotice = await seedNotice(fixture);
    const now = new Date();
    await database
      .insertInto("notice_reads")
      .values(
        fixture.students.map((student) => ({
          class_id: fixture.classId,
          confirmed_at: now,
          confirmed_revision: "1",
          first_confirmed_at: now,
          member_id: student.memberId!,
          notice_id: resolvedNotice.id,
        })),
      )
      .execute();
    expectError(
      await requestReminder("notice", resolvedNotice.id, fixture.teacher, 1),
      409,
      "REMINDER_NO_UNRESOLVED_RECIPIENTS",
    );

    const rollbackNotice = await seedNotice(fixture);
    const key = randomUUID();
    await sql`REVOKE INSERT ON audit_logs FROM classhub_app`.execute(database);
    try {
      const failed = await requestReminder("notice", rollbackNotice.id, fixture.teacher, 1, key);
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe("INTERNAL_ERROR");
    } finally {
      await sql`GRANT INSERT ON audit_logs TO classhub_app`.execute(database);
    }

    const [batchCount, recipientCount, idempotencyCount] = await Promise.all([
      database
        .selectFrom("in_app_reminder_batches")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("notice_id", "=", rollbackNotice.id)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("in_app_reminder_recipients as recipient")
        .innerJoin("in_app_reminder_batches as batch", "batch.id", "recipient.batch_id")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("batch.notice_id", "=", rollbackNotice.id)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("api_idempotency_keys")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("actor_user_id", "=", fixture.teacher.userId)
        .where("idempotency_key", "=", key)
        .executeTakeFirstOrThrow(),
    ]);
    expect([batchCount, recipientCount, idempotencyCount].map((row) => Number(row.count))).toEqual([
      0, 0, 0,
    ]);
    const retry = await requestReminder("notice", rollbackNotice.id, fixture.teacher, 1, key);
    expect(retry.statusCode).toBe(201);
  });

  it("isolates reminder query failure while preserving the other Home cards", async () => {
    const notice = await seedNotice(fixture);
    expect((await requestReminder("notice", notice.id, fixture.teacher, 1)).statusCode).toBe(201);

    await sql`
      REVOKE SELECT ON in_app_reminder_batches, in_app_reminder_recipients FROM classhub_app
    `.execute(database);
    let response;
    try {
      response = await getHome(fixture.students[0]);
    } finally {
      await sql`
        GRANT SELECT ON in_app_reminder_batches, in_app_reminder_recipients TO classhub_app
      `.execute(database);
    }
    expect(response.statusCode).toBe(200);
    const home = response.json() as HomeResult;
    expect(home.reminders).toEqual({
      data: [],
      error_code: "REMINDER_QUERY_FAILED",
      message: "재알림을 불러오지 못했습니다.",
      status: "error",
    });
    expect(home.notices.status).not.toBe("error");
    expect(home.supplies.status).not.toBe("error");
  });

  it("live-hides stale, deleted, and inactive-recipient reminders", async () => {
    const notice = await seedNotice(fixture, { title: "수정 전 공지" });
    expect((await requestReminder("notice", notice.id, fixture.teacher, 1)).statusCode).toBe(201);
    expect((await getHome(fixture.students[0])).json()).toMatchObject({
      reminders: {
        data: [{ reminder_type: "notice", resource_id: notice.id }],
        status: "ok",
      },
    });

    await database
      .updateTable("notices")
      .set({ content_revision: sql`content_revision + 1` })
      .where("id", "=", notice.id)
      .execute();
    expect((await getHome(fixture.students[0])).json()).toMatchObject({
      reminders: { data: [], status: "empty" },
    });

    const supply = await seedSupply(fixture, { title: "삭제 전 준비물" });
    expect((await requestReminder("supply", supply.id, fixture.teacher, 1)).statusCode).toBe(201);
    await database
      .updateTable("supplies")
      .set({
        deleted_at: new Date(),
        deleted_by_member_id: fixture.teacher.memberId,
        delete_reason: "live-hide 테스트",
      })
      .where("id", "=", supply.id)
      .execute();
    expect((await getHome(fixture.students[0])).json()).toMatchObject({
      reminders: { data: [], status: "empty" },
    });

    await database
      .updateTable("users")
      .set({ is_active: false })
      .where("id", "=", fixture.students[0].userId)
      .execute();
    expectError(await getHome(fixture.students[0]), 401, "UNAUTHENTICATED");
  });

  it("keeps notices and notice reminders on Home for 7 days after publishing", async () => {
    const notice = await seedNotice(fixture, { title: "일주일 공지" });
    expect((await requestReminder("notice", notice.id, fixture.teacher, 1)).statusCode).toBe(201);
    const home = (await getHome(fixture.students[0])).json();
    expect(JSON.stringify(home.notices)).toContain(notice.id);
    expect(home.reminders.data).toEqual([
      expect.objectContaining({ reminder_type: "notice", resource_id: notice.id }),
    ]);

    // 올린 지 7일이 지나면 홈(소식·칠판)에서 빠지고 소식 탭에만 남는다(2026-10-01 사용자 결정).
    await database
      .updateTable("notices")
      .set({ published_at: sql<Date>`CURRENT_TIMESTAMP - INTERVAL '7 days 1 minute'` })
      .where("id", "=", notice.id)
      .execute();
    const later = (await getHome(fixture.students[0])).json();
    expect(JSON.stringify(later.notices)).not.toContain(`"id":"${notice.id}"`);
    expect(later.reminders).toMatchObject({ data: [], status: "empty" });
  });

  it("accepts reminders up to 90 days back but shows them on Home only until the needed day", async () => {
    const serverToday = await readDatabaseKstToday(database);
    const hiddenSupply = await seedSupply(fixture, {
      needed_on: addCalendarDays(serverToday, -91),
      title: "학생 상세 비노출 준비물",
    });
    expectError(
      await requestReminder("supply", hiddenSupply.id, fixture.teacher, 1),
      404,
      "NOT_FOUND",
    );

    // 보내기는 90일 전 글까지 된다(상세 공개 범위). 홈은 필요한 날이 지난 것을 빼므로 보이지 않는다(2026-10-01 결정).
    const pastSupply = await seedSupply(fixture, {
      needed_on: addCalendarDays(serverToday, -90),
      title: "90일 경계 준비물",
    });
    expect((await requestReminder("supply", pastSupply.id, fixture.teacher, 1)).statusCode).toBe(
      201,
    );
    expect((await getHome(fixture.students[0])).json()).toMatchObject({
      reminders: { data: [], status: "empty" },
    });

    const todaySupply = await seedSupply(fixture, {
      needed_on: serverToday,
      title: "오늘 필요한 준비물",
    });
    expect((await requestReminder("supply", todaySupply.id, fixture.teacher, 1)).statusCode).toBe(
      201,
    );
    expect((await getHome(fixture.students[0])).json()).toMatchObject({
      reminders: {
        data: [{ reminder_type: "supply", resource_id: todaySupply.id }],
        status: "ok",
      },
    });

    await database
      .updateTable("supplies")
      .set({ needed_on: sql<Date>`${addCalendarDays(serverToday, -1)}::date` })
      .where("id", "=", todaySupply.id)
      .execute();
    expect((await getHome(fixture.students[0])).json()).toMatchObject({
      reminders: { data: [], status: "empty" },
    });
  });

  it("shares 30 attempts across notice and supply routes, then starts a 60-second cooldown", async () => {
    const actorKey = reminderRateLimitKey(fixture.teacher.userId);
    const blockedNotice = await seedNotice(fixture);
    const blockedKey = randomUUID();
    await redisObserver.set(actorKey, "30", { EX: 60 });
    expectError(
      await requestReminder("notice", blockedNotice.id, fixture.teacher, 1, blockedKey),
      429,
      "RATE_LIMITED",
    );
    expect(await redisObserver.ttl(actorKey)).toBeGreaterThan(0);
    const blockedNoticeBatches = await database
      .selectFrom("in_app_reminder_batches")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("notice_id", "=", blockedNotice.id)
      .executeTakeFirstOrThrow();
    const blockedNoticeIdempotency = await database
      .selectFrom("api_idempotency_keys")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("actor_user_id", "=", fixture.teacher.userId)
      .where("idempotency_key", "=", blockedKey)
      .executeTakeFirstOrThrow();
    expect(Number(blockedNoticeBatches.count)).toBe(0);
    expect(Number(blockedNoticeIdempotency.count)).toBe(0);

    const allowedNotice = await seedNotice(fixture);
    await redisObserver.set(actorKey, "29", { EX: 15 });
    const thirtieth = await requestReminder("notice", allowedNotice.id, fixture.teacher, 1);
    expect(thirtieth.statusCode).toBe(201);
    expect(thirtieth.headers).toMatchObject({
      "x-ratelimit-limit": "30",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-cooldown": "60",
    });
    expect(await redisObserver.ttl(actorKey)).toBeGreaterThan(50);
    expect(await redisObserver.ttl(actorKey)).toBeLessThanOrEqual(60);
    expect(Number(thirtieth.headers["x-ratelimit-reset-after"])).toBe(60);
    expect(await redisObserver.get(actorKey)).toBe("30");

    const blockedSupply = await seedSupply(fixture);
    const supplyKey = randomUUID();
    const blocked = await requestReminder(
      "supply",
      blockedSupply.id,
      fixture.teacher,
      1,
      supplyKey,
    );
    expectError(blocked, 429, "RATE_LIMITED");
    expect(blocked.json().error.details).toMatchObject({
      attempts: 30,
      max_attempts: 30,
      remaining_attempts: 0,
    });
    const blockedSupplyBatches = await database
      .selectFrom("in_app_reminder_batches")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("supply_id", "=", blockedSupply.id)
      .executeTakeFirstOrThrow();
    const blockedSupplyIdempotency = await database
      .selectFrom("api_idempotency_keys")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("actor_user_id", "=", fixture.teacher.userId)
      .where("idempotency_key", "=", supplyKey)
      .executeTakeFirstOrThrow();
    expect(Number(blockedSupplyBatches.count)).toBe(0);
    expect(Number(blockedSupplyIdempotency.count)).toBe(0);

    // Expire only this isolated actor's counter to exercise retry after the verified cooldown.
    await redisObserver.pExpire(actorKey, 1);
    await expect.poll(() => redisObserver.exists(actorKey)).toBe(0);
    const afterCooldown = await requestReminder(
      "supply",
      blockedSupply.id,
      fixture.teacher,
      1,
      supplyKey,
    );
    expect(afterCooldown.statusCode).toBe(201);
    expect(await redisObserver.get(actorKey)).toBe("1");
    expect(afterCooldown.headers["x-ratelimit-remaining"]).toBe("29");
  });

  it("fails closed before mutation when Redis becomes unavailable", async () => {
    const notice = await seedNotice(fixture);
    const key = randomUUID();
    await redisObserver.quit();
    await stopSuppliesHarnessRedis();

    const failed = await requestReminder("notice", notice.id, fixture.teacher, 1, key);
    expectError(failed, 503, "RATE_LIMIT_SERVICE_UNAVAILABLE");
    const [batches, idempotency] = await Promise.all([
      database
        .selectFrom("in_app_reminder_batches")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("notice_id", "=", notice.id)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("api_idempotency_keys")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("actor_user_id", "=", fixture.teacher.userId)
        .where("idempotency_key", "=", key)
        .executeTakeFirstOrThrow(),
    ]);
    expect(Number(batches.count)).toBe(0);
    expect(Number(idempotency.count)).toBe(0);
  });
});
