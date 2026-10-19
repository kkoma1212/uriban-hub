import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readDatabaseKstToday } from "../src/common/date/database-kst-clock.js";
import { kstDate } from "../src/common/date/kst-date.js";
import {
  app,
  type ActorFixture,
  type ClassFixture,
  createClassFixture,
  database,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

interface NoticeItem {
  confirmation_state?: "confirmed" | "modified_unconfirmed" | "unread";
  content: string;
  content_revision: string;
  id: string;
  is_important: boolean;
  published_at: string;
  row_version: string;
  title: string;
}

interface NoticeList {
  items: NoticeItem[];
  next_cursor: null | string;
  server_today: string;
}

let fixture: ClassFixture;
let noticeSequence = 0;
const DAY_MS = 24 * 60 * 60 * 1_000;

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

async function seedNotice(
  owner: ClassFixture,
  values: Partial<{
    content: string;
    content_revision: number;
    is_important: boolean;
    published_at: Date;
    row_version: number;
    title: string;
  }> = {},
) {
  return database
    .insertInto("notices")
    .values({
      class_id: owner.classId,
      content: values.content ?? "공지 내용을 확인해 주세요.",
      content_revision: values.content_revision,
      created_by_member_id: owner.teacher.memberId!,
      is_important: values.is_important,
      published_at: values.published_at,
      row_version: values.row_version,
      title: values.title ?? `공지 ${++noticeSequence}`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function extendFixtureSessions(...owners: ClassFixture[]): Promise<void> {
  const userIds = owners.flatMap((owner) => [
    owner.teacher.userId,
    ...owner.students.map((student) => student.userId),
  ]);
  await database
    .updateTable("sessions")
    .set({ expires_at: sql<Date>`CURRENT_TIMESTAMP + INTERVAL '48 hours'` })
    .where("user_id", "in", userIds)
    .execute();
}

beforeAll(setupSuppliesHarness, 120_000);

beforeEach(async () => {
  fixture = await createClassFixture();
});

afterEach(() => vi.useRealTimers());

afterAll(teardownSuppliesHarness, 120_000);

describe("notices HTTP contract", () => {
  it("enforces authentication, current class, role, cross-class hiding, and suspension", async () => {
    expectError(
      await app.inject({ method: "GET", url: "/api/v1/notices" }),
      401,
      "UNAUTHENTICATED",
    );
    expectError(
      await app.inject({
        method: "POST",
        url: "/api/v1/notices",
        headers: { ...fixture.students[0].headers, "idempotency-key": randomUUID() },
        payload: { content: "학생 등록 시도", title: "학생 공지" },
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(
      await app.inject({
        method: "GET",
        url: "/api/v1/notices",
        headers: fixture.outsider.headers,
      }),
      404,
      "NOT_FOUND",
    );

    const other = await createClassFixture();
    const otherNotice = await seedNotice(other);
    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/notices/${otherNotice.id}`,
        headers: fixture.teacher.headers,
      }),
      404,
      "NOT_FOUND",
    );
    expectError(
      await app.inject({
        method: "PATCH",
        url: `/api/v1/notices/${otherNotice.id}`,
        headers: fixture.teacher.headers,
        payload: { title: "타 반 수정 시도" },
      }),
      404,
      "NOT_FOUND",
    );

    const ownNotice = await seedNotice(fixture);
    const beforeStudentDelete = await database
      .selectFrom("notices")
      .selectAll()
      .where("id", "=", ownNotice.id)
      .executeTakeFirstOrThrow();
    expectError(
      await app.inject({
        method: "PATCH",
        url: `/api/v1/notices/${ownNotice.id}`,
        headers: fixture.students[0].headers,
        payload: { title: "학생 수정 시도" },
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(
      await app.inject({
        method: "DELETE",
        url: `/api/v1/notices/${ownNotice.id}`,
        headers: { ...fixture.students[0].headers, "if-match": '"1"' },
        payload: { reason: null },
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expect(
      await database
        .selectFrom("notices")
        .selectAll()
        .where("id", "=", ownNotice.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeStudentDelete);
    expect(
      await database
        .selectFrom("audit_logs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("action", "=", "notice.deleted")
        .where("target_id", "=", ownNotice.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/notices/${ownNotice.id}/confirmations?state=confirmed`,
        headers: fixture.students[0].headers,
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(
      await app.inject({
        method: "PUT",
        url: `/api/v1/notices/${ownNotice.id}/confirmation`,
        headers: fixture.teacher.headers,
        payload: { content_revision: 1 },
      }),
      403,
      "ROLE_INSUFFICIENT",
    );

    await database
      .updateTable("classes")
      .set({
        status: "suspended",
        suspended_at: new Date(),
        suspended_by_operator_id: fixture.operatorId,
        suspended_reason: "통합 테스트 정지",
      })
      .where("id", "=", fixture.classId)
      .execute();
    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/notices/${ownNotice.id}`,
        headers: fixture.teacher.headers,
      }),
      423,
      "CLASS_SUSPENDED",
    );
  });

  it("creates once with default importance, ETag, and a create-shaped audit record", async () => {
    const key = randomUUID();
    const payload = { content: "금요일까지 제출해 주세요.", title: "수행평가 안내" };
    expectError(
      await app.inject({
        method: "POST",
        url: "/api/v1/notices",
        headers: fixture.teacher.headers,
        payload,
      }),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/notices",
      headers: { ...fixture.teacher.headers, "idempotency-key": key },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers.etag).toBe('"1"');
    const item = first.json() as NoticeItem;
    expect(item).toMatchObject({
      content: payload.content,
      content_revision: "1",
      is_important: false,
      row_version: "1",
      title: payload.title,
    });

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/notices",
      headers: { ...fixture.teacher.headers, "idempotency-key": key },
      payload: { ...payload, is_important: false },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(item);
    expectError(
      await app.inject({
        method: "POST",
        url: "/api/v1/notices",
        headers: { ...fixture.teacher.headers, "idempotency-key": key },
        payload: { ...payload, is_important: true },
      }),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );

    const [rows, audits] = await Promise.all([
      database.selectFrom("notices").selectAll().where("id", "=", item.id).execute(),
      database
        .selectFrom("audit_logs")
        .selectAll()
        .where("action", "=", "notice.created")
        .where("target_id", "=", item.id)
        .execute(),
    ]);
    expect(rows).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_member_id: fixture.teacher.memberId,
      actor_user_id: fixture.teacher.userId,
      before_json: null,
      target_snapshot: null,
    });
    expect(audits[0]!.after_json).toMatchObject({
      content_revision: "1",
      is_important: false,
      notice_id: item.id,
      title: payload.title,
    });
    expect(JSON.stringify(audits[0]!.after_json)).not.toContain(payload.content);
  });

  it("keeps DB-default notices usable when the application clock is 24 hours behind", async () => {
    const updateFixture = await createClassFixture();
    const deleteFixture = await createClassFixture();
    const [notice, updateNotice, deleteNotice] = await Promise.all([
      seedNotice(fixture, { title: "DB 게시 기준 공지" }),
      seedNotice(updateFixture, { content: "수정 전 내용", title: "DB 게시 수정 공지" }),
      seedNotice(deleteFixture, { title: "DB 게시 삭제 공지" }),
    ]);
    await extendFixtureSessions(fixture, updateFixture, deleteFixture);

    const databaseToday = await readDatabaseKstToday(database);
    const laggingApplicationClock = new Date(Date.now() - DAY_MS);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(laggingApplicationClock);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/notices",
      headers: fixture.students[0].headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      items: [{ id: notice.id }],
      server_today: databaseToday,
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/notices/${notice.id}`,
      headers: fixture.students[0].headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ confirmation_state: "unread", id: notice.id });

    const home = await app.inject({
      method: "GET",
      url: "/api/v1/home",
      headers: fixture.students[0].headers,
    });
    expect(home.statusCode).toBe(200);
    expect(home.json()).toMatchObject({
      notices: { data: [{ id: notice.id }], status: "ok" },
      server_today: databaseToday,
    });
    expect(home.json().server_today).toBe(list.json().server_today);

    const confirmation = await app.inject({
      method: "PUT",
      url: `/api/v1/notices/${notice.id}/confirmation`,
      headers: fixture.students[0].headers,
      payload: { content_revision: 1 },
    });
    expect(confirmation.statusCode).toBe(200);
    expect(
      await database
        .selectFrom("notice_reads")
        .selectAll()
        .where("notice_id", "=", notice.id)
        .where("member_id", "=", fixture.students[0].memberId!)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ confirmed_revision: "1", notice_id: notice.id });
    const confirmations = await app.inject({
      method: "GET",
      url: `/api/v1/notices/${notice.id}/confirmations?state=confirmed`,
      headers: fixture.teacher.headers,
    });
    expect(confirmations.statusCode).toBe(200);
    expect(confirmations.json()).toMatchObject({
      content_revision: "1",
      server_today: databaseToday,
    });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/notices/${updateNotice.id}`,
      headers: { ...updateFixture.teacher.headers, "if-match": '"1"' },
      payload: { content: "수정 후 내용" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      content: "수정 후 내용",
      id: updateNotice.id,
      row_version: "2",
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/notices/${deleteNotice.id}`,
      headers: { ...deleteFixture.teacher.headers, "if-match": '"1"' },
      payload: { reason: "DB 시계 삭제 검증" },
    });
    expect(deleted.statusCode).toBe(204);

    const [updatedRow, deletedRow] = await Promise.all([
      database
        .selectFrom("notices")
        .selectAll()
        .where("id", "=", updateNotice.id)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("notices")
        .selectAll()
        .where("id", "=", deleteNotice.id)
        .executeTakeFirstOrThrow(),
    ]);
    expect(updatedRow).toMatchObject({
      content: "수정 후 내용",
      deleted_at: null,
      row_version: "2",
    });
    expect(deletedRow.deleted_at).not.toBeNull();
  }, 20_000);

  it("keeps DB-future notices hidden when the application clock is 24 hours ahead", async () => {
    const updateFixture = await createClassFixture();
    const deleteFixture = await createClassFixture();
    const [notice, updateNotice, deleteNotice] = await Promise.all([
      seedNotice(fixture, { title: "DB 미래 공지" }),
      seedNotice(updateFixture, { content: "미래 수정 전 내용", title: "DB 미래 수정 공지" }),
      seedNotice(deleteFixture, { title: "DB 미래 삭제 공지" }),
    ]);
    await extendFixtureSessions(fixture, updateFixture, deleteFixture);

    // CURRENT_TIMESTAMP is transaction-start scoped; each short visibility query or lock
    // transaction intentionally evaluates publication against a stable PostgreSQL snapshot.
    await database
      .updateTable("notices")
      .set({ published_at: sql<Date>`CURRENT_TIMESTAMP + INTERVAL '1 hour'` })
      .where("id", "in", [notice.id, updateNotice.id, deleteNotice.id])
      .execute();
    const [beforeUpdate, beforeDelete] = await Promise.all([
      database
        .selectFrom("notices")
        .selectAll()
        .where("id", "=", updateNotice.id)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("notices")
        .selectAll()
        .where("id", "=", deleteNotice.id)
        .executeTakeFirstOrThrow(),
    ]);

    const databaseToday = await readDatabaseKstToday(database);
    const leadingApplicationClock = new Date(Date.now() + DAY_MS);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(leadingApplicationClock);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/notices",
      headers: fixture.students[0].headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      items: [],
      next_cursor: null,
      server_today: databaseToday,
    });

    const home = await app.inject({
      method: "GET",
      url: "/api/v1/home",
      headers: fixture.students[0].headers,
    });
    expect(home.statusCode).toBe(200);
    expect(home.json()).toMatchObject({
      notices: { data: [], status: "empty" },
      server_today: databaseToday,
    });
    expect(home.json().server_today).toBe(list.json().server_today);

    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/notices/${notice.id}`,
        headers: fixture.students[0].headers,
      }),
      404,
      "NOT_FOUND",
    );
    expectError(
      await app.inject({
        method: "PUT",
        url: `/api/v1/notices/${notice.id}/confirmation`,
        headers: fixture.students[0].headers,
        payload: { content_revision: 1 },
      }),
      404,
      "NOT_FOUND",
    );
    expect(
      await database
        .selectFrom("notice_reads")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("notice_id", "=", notice.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });

    expectError(
      await app.inject({
        method: "PATCH",
        url: `/api/v1/notices/${updateNotice.id}`,
        headers: { ...updateFixture.teacher.headers, "if-match": '"1"' },
        payload: { content: "미래 수정 시도" },
      }),
      404,
      "NOT_FOUND",
    );
    expectError(
      await app.inject({
        method: "DELETE",
        url: `/api/v1/notices/${deleteNotice.id}`,
        headers: { ...deleteFixture.teacher.headers, "if-match": '"1"' },
        payload: { reason: "미래 삭제 시도" },
      }),
      404,
      "NOT_FOUND",
    );

    const [afterUpdate, afterDelete] = await Promise.all([
      database
        .selectFrom("notices")
        .selectAll()
        .where("id", "=", updateNotice.id)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("notices")
        .selectAll()
        .where("id", "=", deleteNotice.id)
        .executeTakeFirstOrThrow(),
    ]);
    expect(afterUpdate).toEqual(beforeUpdate);
    expect(afterDelete).toEqual(beforeDelete);
  }, 20_000);

  it("filters and paginates published notices with opaque filter-bound cursors", async () => {
    const expectedIds: string[] = [];
    const base = Date.now() - 60_000;
    for (let index = 0; index < 22; index += 1) {
      const row = await seedNotice(fixture, {
        is_important: true,
        published_at: new Date(base - index * 1_000),
        title: `중요 공지 ${index}`,
      });
      expectedIds.push(row.id);
    }
    const regular = await seedNotice(fixture, { is_important: false, title: "일반 공지" });

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/notices?importance=important",
      headers: fixture.teacher.headers,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as NoticeList;
    expect(firstBody.items).toHaveLength(20);
    expect(firstBody.next_cursor).toEqual(expect.any(String));
    expect(firstBody.server_today).toBe(kstDate(new Date()));
    expect(
      firstBody.items.every((item) => item.is_important && !("confirmation_state" in item)),
    ).toBe(true);

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/notices?importance=important&cursor=${encodeURIComponent(firstBody.next_cursor!)}`,
      headers: fixture.teacher.headers,
    });
    const secondBody = second.json() as NoticeList;
    expect(secondBody.items).toHaveLength(2);
    expect(secondBody.next_cursor).toBeNull();
    expect([...firstBody.items, ...secondBody.items].map((item) => item.id)).toEqual(expectedIds);

    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/notices?importance=regular&cursor=${encodeURIComponent(firstBody.next_cursor!)}`,
        headers: fixture.teacher.headers,
      }),
      400,
      "INVALID_CURSOR",
    );

    const firstAll = await app.inject({
      method: "GET",
      url: "/api/v1/notices?importance=all",
      headers: fixture.teacher.headers,
    });
    const firstAllBody = firstAll.json() as NoticeList;
    expect(firstAll.statusCode).toBe(200);
    expect(firstAllBody.items.map((item) => item.id)).toEqual(expectedIds.slice(0, 20));

    const secondAll = await app.inject({
      method: "GET",
      url: `/api/v1/notices?importance=all&cursor=${encodeURIComponent(firstAllBody.next_cursor!)}`,
      headers: fixture.teacher.headers,
    });
    const secondAllBody = secondAll.json() as NoticeList;
    expect(secondAll.statusCode).toBe(200);
    expect(secondAllBody.items.map((item) => item.id)).toEqual([
      ...expectedIds.slice(20),
      regular.id,
    ]);
    expect(secondAllBody.next_cursor).toBeNull();
  });

  it("paginates without gaps across PostgreSQL microsecond timestamp boundaries", async () => {
    const boundaryMilliseconds = Math.floor((Date.now() - 120_000) / 1_000) * 1_000;
    const newerIds: string[] = [];
    for (let index = 0; index < 19; index += 1) {
      const row = await seedNotice(fixture, {
        is_important: true,
        published_at: new Date(boundaryMilliseconds + (19 - index) * 1_000),
        title: `마이크로초 경계 이전 공지 ${index}`,
      });
      newerIds.push(row.id);
    }

    const sameTimestampLowId = await seedNotice(fixture, {
      is_important: true,
      title: "같은 마이크로초 낮은 ID",
    });
    const sameTimestampHighId = await seedNotice(fixture, {
      is_important: true,
      title: "같은 마이크로초 높은 ID",
    });
    const precedingMicrosecond = await seedNotice(fixture, {
      is_important: true,
      title: "바로 이전 마이크로초",
    });
    const boundarySecond = new Date(boundaryMilliseconds).toISOString().replace(/\.000Z$/u, "");
    const exactBoundary = `${boundarySecond}.123456Z`;
    const exactPrecedingMicrosecond = `${boundarySecond}.123455Z`;

    await Promise.all([
      sql`UPDATE notices
          SET published_at = ${exactBoundary}::timestamptz
          WHERE id = ${sameTimestampLowId.id}::bigint`.execute(database),
      sql`UPDATE notices
          SET published_at = ${exactBoundary}::timestamptz
          WHERE id = ${sameTimestampHighId.id}::bigint`.execute(database),
      sql`UPDATE notices
          SET published_at = ${exactPrecedingMicrosecond}::timestamptz
          WHERE id = ${precedingMicrosecond.id}::bigint`.execute(database),
    ]);

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/notices?importance=important",
      headers: fixture.teacher.headers,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as NoticeList;
    expect(firstBody.items).toHaveLength(20);
    expect(firstBody.next_cursor).toEqual(expect.any(String));

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/notices?importance=important&cursor=${encodeURIComponent(firstBody.next_cursor!)}`,
      headers: fixture.teacher.headers,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as NoticeList;
    expect(secondBody.items.map((item) => item.id)).toEqual([
      sameTimestampLowId.id,
      precedingMicrosecond.id,
    ]);
    expect(secondBody.next_cursor).toBeNull();
    expect([...firstBody.items, ...secondBody.items].map((item) => item.id)).toEqual([
      ...newerIds,
      sameTimestampHighId.id,
      sameTimestampLowId.id,
      precedingMicrosecond.id,
    ]);
  });

  it("returns detail ETags and student state without marking a view as confirmed", async () => {
    const notice = await seedNotice(fixture, { is_important: true });
    const teacherDetail = await app.inject({
      method: "GET",
      url: `/api/v1/notices/${notice.id}`,
      headers: { ...fixture.teacher.headers, "if-none-match": '"1"' },
    });
    expect(teacherDetail.statusCode).toBe(200);
    expect(teacherDetail.headers.etag).toBe('"1"');
    expect(teacherDetail.json()).not.toHaveProperty("confirmation_state");

    const studentDetail = await app.inject({
      method: "GET",
      url: `/api/v1/notices/${notice.id}`,
      headers: fixture.students[0].headers,
    });
    expect(studentDetail.statusCode).toBe(200);
    expect(studentDetail.headers.etag).toBe('"1"');
    expect(studentDetail.json()).toMatchObject({ id: notice.id, confirmation_state: "unread" });
    expect(
      await database
        .selectFrom("notice_reads")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("notice_id", "=", notice.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
  });

  it("keeps no-op immutable, preserves revision for importance-only changes, and serializes updates", async () => {
    const notice = await seedNotice(fixture, {
      content: "원본 내용",
      is_important: true,
      title: "원본 제목",
    });
    const before = await database
      .selectFrom("notices")
      .selectAll()
      .where("id", "=", notice.id)
      .executeTakeFirstOrThrow();
    expectError(
      await app.inject({
        method: "PATCH",
        url: `/api/v1/notices/${notice.id}`,
        headers: fixture.teacher.headers,
        payload: { title: "If-Match 없는 수정" },
      }),
      428,
      "IF_MATCH_REQUIRED",
    );
    expectError(
      await app.inject({
        method: "PATCH",
        url: `/api/v1/notices/${notice.id}`,
        headers: { ...fixture.teacher.headers, "if-match": 'W/"1"' },
        payload: { title: "weak ETag 수정" },
      }),
      400,
      "INVALID_IF_MATCH",
    );
    const noOp = await app.inject({
      method: "PATCH",
      url: `/api/v1/notices/${notice.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: { content: "원본 내용", is_important: true, title: "원본 제목" },
    });
    expect(noOp.statusCode).toBe(200);
    expect(noOp.headers.etag).toBe('"1"');
    expect(
      await database
        .selectFrom("notices")
        .selectAll()
        .where("id", "=", notice.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);

    const importanceOnly = await app.inject({
      method: "PATCH",
      url: `/api/v1/notices/${notice.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: { is_important: false },
    });
    expect(importanceOnly.statusCode).toBe(200);
    expect(importanceOnly.json()).toMatchObject({
      content_revision: "1",
      is_important: false,
      row_version: "2",
    });
    const importanceAudit = await database
      .selectFrom("audit_logs")
      .selectAll()
      .where("action", "=", "notice.updated")
      .where("target_id", "=", notice.id)
      .executeTakeFirstOrThrow();
    expect(importanceAudit.before_json).toEqual({ is_important: true });
    expect(importanceAudit.after_json).toEqual({ is_important: false });

    const concurrentNotice = await seedNotice(fixture, { title: "동시 수정 공지" });
    const updates = await Promise.all(
      ["첫 번째 수정", "두 번째 수정"].map((title) =>
        app.inject({
          method: "PATCH",
          url: `/api/v1/notices/${concurrentNotice.id}`,
          headers: { ...fixture.teacher.headers, "if-match": '"1"' },
          payload: { title },
        }),
      ),
    );
    expect(updates.map((response) => response.statusCode).toSorted()).toEqual([200, 409]);
    const winner = updates.find((response) => response.statusCode === 200)!;
    expect(winner.json()).toMatchObject({ content_revision: "2", row_version: "2" });
    expect(updates.find((response) => response.statusCode === 409)!.json().error).toMatchObject({
      code: "RESOURCE_VERSION_CHANGED",
      details: { current_row_version: "2" },
    });
  });

  it("confirms explicitly, keeps timestamps on repeat and importance change, then requires reconfirmation", async () => {
    const notice = await seedNotice(fixture, { is_important: true });
    const student = fixture.students[0];
    const put = (actor: ActorFixture, revision: number) =>
      app.inject({
        method: "PUT",
        url: `/api/v1/notices/${notice.id}/confirmation`,
        headers: actor.headers,
        payload: { content_revision: revision },
      });

    const confirmed = await put(student, 1);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({
      confirmation_state: "confirmed",
      content_revision: "1",
      notice_id: notice.id,
    });
    const firstRead = await database
      .selectFrom("notice_reads")
      .selectAll()
      .where("notice_id", "=", notice.id)
      .where("member_id", "=", student.memberId!)
      .executeTakeFirstOrThrow();
    expect((await put(student, 1)).statusCode).toBe(200);
    expect(
      await database
        .selectFrom("notice_reads")
        .selectAll()
        .where("id", "=", firstRead.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(firstRead);

    const importanceOnly = await app.inject({
      method: "PATCH",
      url: `/api/v1/notices/${notice.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: { is_important: false },
    });
    expect(importanceOnly.json()).toMatchObject({ content_revision: "1", row_version: "2" });
    const stillConfirmed = await app.inject({
      method: "GET",
      url: `/api/v1/notices/${notice.id}`,
      headers: student.headers,
    });
    expect(stillConfirmed.json()).toMatchObject({ confirmation_state: "confirmed" });

    const contentUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/notices/${notice.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"2"' },
      payload: { content: "수정된 공지 내용" },
    });
    expect(contentUpdate.json()).toMatchObject({ content_revision: "2", row_version: "3" });
    const modified = await app.inject({
      method: "GET",
      url: `/api/v1/notices/${notice.id}`,
      headers: student.headers,
    });
    expect(modified.json()).toMatchObject({ confirmation_state: "modified_unconfirmed" });

    const stale = await put(student, 1);
    expectError(stale, 409, "CONTENT_REVISION_CHANGED");
    expect(stale.json().error.details).toEqual({ current_revision: "2" });
    expect(
      await database
        .selectFrom("notice_reads")
        .selectAll()
        .where("id", "=", firstRead.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(firstRead);

    expect((await put(student, 2)).statusCode).toBe(200);
    const reconfirmed = await database
      .selectFrom("notice_reads")
      .selectAll()
      .where("id", "=", firstRead.id)
      .executeTakeFirstOrThrow();
    expect(reconfirmed.confirmed_revision).toBe("2");
    expect(reconfirmed.first_confirmed_at).toEqual(firstRead.first_confirmed_at);
    expect(reconfirmed.confirmed_at.getTime()).toBeGreaterThanOrEqual(
      firstRead.confirmed_at.getTime(),
    );
  });

  it("returns global confirmation counts, excludes inactive students, and preserves reads on soft delete", async () => {
    const notice = await seedNotice(fixture, { content_revision: 2, is_important: true });
    const now = new Date();
    await database
      .insertInto("notice_reads")
      .values([
        {
          class_id: fixture.classId,
          confirmed_at: now,
          confirmed_revision: 2,
          first_confirmed_at: now,
          member_id: fixture.students[0].memberId!,
          notice_id: notice.id,
        },
        {
          class_id: fixture.classId,
          confirmed_at: now,
          confirmed_revision: 1,
          first_confirmed_at: now,
          member_id: fixture.students[2].memberId!,
          notice_id: notice.id,
        },
        {
          class_id: fixture.classId,
          confirmed_at: now,
          confirmed_revision: 2,
          first_confirmed_at: now,
          member_id: fixture.inactive.memberId!,
          notice_id: notice.id,
        },
      ])
      .execute();

    const expectations = [
      ["confirmed", fixture.students[0].memberId],
      ["unread", fixture.students[1].memberId],
      ["modified_unconfirmed", fixture.students[2].memberId],
    ] as const;
    for (const [state, memberId] of expectations) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/notices/${notice.id}/confirmations?state=${state}`,
        headers: fixture.teacher.headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        content_revision: "2",
        counts: { confirmed: 1, modified_unconfirmed: 1, unread: 1 },
        items: [{ confirmation_state: state, member_id: memberId }],
        next_cursor: null,
        server_today: kstDate(new Date()),
      });
      expect(JSON.stringify(response.json())).not.toContain(fixture.inactive.memberId!);
    }

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/notices/${notice.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: { reason: "중복 등록" },
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
    expect(
      await database
        .selectFrom("notice_reads")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("notice_id", "=", notice.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "3" });
    const audit = await database
      .selectFrom("audit_logs")
      .selectAll()
      .where("action", "=", "notice.deleted")
      .where("target_id", "=", notice.id)
      .executeTakeFirstOrThrow();
    expect(audit.before_json).toBeNull();
    expect(audit.after_json).toBeNull();
    expect(audit.reason).toBe("중복 등록");
    expect(audit.target_snapshot).toMatchObject({
      content_revision: "2",
      deleted_at: null,
      is_important: true,
      notice_id: notice.id,
      title: notice.title,
    });
    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/notices/${notice.id}`,
        headers: fixture.teacher.headers,
      }),
      404,
      "NOT_FOUND",
    );
  });
});
