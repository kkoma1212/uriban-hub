import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readDatabaseKstToday } from "../src/common/date/database-kst-clock.js";
import { addCalendarDays, databaseDate, kstDate } from "../src/common/date/kst-date.js";
import {
  app,
  type ActorFixture,
  type ClassFixture,
  createClassFixture,
  database,
  seedSupply,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

interface SupplyItem {
  check_state?: "checked" | "modified_unconfirmed" | "unchecked";
  content_revision: string;
  description: null | string;
  id: string;
  needed_on: string;
  row_version: string;
  title: string;
}

interface SupplyList {
  items: SupplyItem[];
  next_cursor: null | string;
  server_today: string;
}

let fixture: ClassFixture;
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

beforeAll(setupSuppliesHarness, 120_000);

beforeEach(async () => {
  fixture = await createClassFixture();
});
afterEach(() => vi.useRealTimers());

afterAll(teardownSuppliesHarness, 120_000);

describe("supplies HTTP contract", () => {
  it("enforces authentication, current class, role, cross-class hiding, and suspension", async () => {
    expectError(
      await app.inject({ method: "GET", url: "/api/v1/supplies?scope=upcoming" }),
      401,
      "UNAUTHENTICATED",
    );
    expectError(
      await app.inject({
        method: "POST",
        url: "/api/v1/supplies",
        headers: { ...fixture.students[0].headers, "idempotency-key": randomUUID() },
        payload: { needed_on: kstDate(new Date()), title: "학생 등록 시도" },
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(
      await app.inject({
        method: "GET",
        url: "/api/v1/supplies?scope=upcoming",
        headers: fixture.outsider.headers,
      }),
      404,
      "NOT_FOUND",
    );
    const other = await createClassFixture();
    const otherSupply = await seedSupply(other);
    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/supplies/${otherSupply.id}`,
        headers: fixture.teacher.headers,
      }),
      404,
      "NOT_FOUND",
    );
    expectError(
      await app.inject({
        method: "PATCH",
        url: `/api/v1/supplies/${otherSupply.id}`,
        headers: fixture.teacher.headers,
        payload: { title: "타 반 수정 시도" },
      }),
      404,
      "NOT_FOUND",
    );
    expectError(
      await app.inject({
        method: "DELETE",
        url: `/api/v1/supplies/${otherSupply.id}`,
        headers: fixture.teacher.headers,
        payload: { reason: null },
      }),
      404,
      "NOT_FOUND",
    );
    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/supplies/${otherSupply.id}/checks?state=checked`,
        headers: other.students[0].headers,
      }),
      403,
      "ROLE_INSUFFICIENT",
    );

    const ownSupply = await seedSupply(fixture);
    const beforeStudentDelete = await database
      .selectFrom("supplies")
      .selectAll()
      .where("id", "=", ownSupply.id)
      .executeTakeFirstOrThrow();
    expectError(
      await app.inject({
        method: "PATCH",
        url: `/api/v1/supplies/${ownSupply.id}`,
        headers: fixture.students[0].headers,
        payload: { title: "학생 수정 시도" },
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(
      await app.inject({
        method: "DELETE",
        url: `/api/v1/supplies/${ownSupply.id}`,
        headers: { ...fixture.students[0].headers, "if-match": '"1"' },
        payload: { reason: null },
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expect(
      await database
        .selectFrom("supplies")
        .selectAll()
        .where("id", "=", ownSupply.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeStudentDelete);
    expect(
      await database
        .selectFrom("audit_logs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("action", "=", "supply.deleted")
        .where("target_id", "=", ownSupply.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
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
        url: `/api/v1/supplies/${ownSupply.id}`,
        headers: fixture.teacher.headers,
      }),
      423,
      "CLASS_SUSPENDED",
    );
    expectError(
      await app.inject({
        method: "PATCH",
        url: `/api/v1/supplies/${ownSupply.id}`,
        headers: fixture.teacher.headers,
        payload: { title: "중지 반 수정 시도" },
      }),
      423,
      "CLASS_SUSPENDED",
    );
  });

  it("creates once with idempotency and a create-shaped audit record", async () => {
    const key = randomUUID();
    const payload = { needed_on: addCalendarDays(kstDate(new Date()), 1), title: "미술 준비물" };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/supplies",
      headers: { ...fixture.teacher.headers, "idempotency-key": key },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers.etag).toBe('"1"');
    const item = first.json() as SupplyItem;
    expect(item).toMatchObject({
      content_revision: "1",
      description: null,
      needed_on: payload.needed_on,
      row_version: "1",
      title: payload.title,
    });

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/supplies",
      headers: { ...fixture.teacher.headers, "idempotency-key": key },
      payload: { ...payload, description: null },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(item);
    expectError(
      await app.inject({
        method: "POST",
        url: "/api/v1/supplies",
        headers: { ...fixture.teacher.headers, "idempotency-key": key },
        payload: { ...payload, title: "다른 준비물" },
      }),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    // 종류만 다른 요청도 다른 요청이다. 해시에서 빠지면 숙제로 보냈는데
    // 준비물로 만든 첫 응답이 replay 되고 교사는 그것을 알 길이 없다.
    expectError(
      await app.inject({
        method: "POST",
        url: "/api/v1/supplies",
        headers: { ...fixture.teacher.headers, "idempotency-key": key },
        payload: { ...payload, category: "homework" },
      }),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );

    const [rows, keys, audits] = await Promise.all([
      database.selectFrom("supplies").selectAll().where("id", "=", item.id).execute(),
      database
        .selectFrom("api_idempotency_keys")
        .selectAll()
        .where("actor_user_id", "=", fixture.teacher.userId)
        .where("idempotency_key", "=", key)
        .execute(),
      database
        .selectFrom("audit_logs")
        .selectAll()
        .where("action", "=", "supply.created")
        .where("target_id", "=", item.id)
        .execute(),
    ]);
    expect(rows).toHaveLength(1);
    expect(keys).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_member_id: fixture.teacher.memberId,
      actor_user_id: fixture.teacher.userId,
      before_json: null,
      target_snapshot: null,
    });
    expect(audits[0]!.after_json).toMatchObject({
      content_revision: "1",
      needed_on: payload.needed_on,
      supply_id: item.id,
      title: payload.title,
    });
    expect(audits[0]!.request_id).toBe(first.headers["x-request-id"]);
  });

  it("paginates upcoming and recent-past lists with opaque cursors", async () => {
    const today = kstDate(new Date());
    const upcoming: Array<{ date: string; id: string }> = [];
    const past: Array<{ date: string; id: string }> = [];
    for (let index = 0; index < 22; index += 1) {
      const date = addCalendarDays(today, Math.floor(index / 2));
      upcoming.push({ date, id: (await seedSupply(fixture, { needed_on: date })).id });
      const pastDate = addCalendarDays(today, -(Math.floor(index / 2) + 1));
      past.push({ date: pastDate, id: (await seedSupply(fixture, { needed_on: pastDate })).id });
    }
    const dayNinety = await seedSupply(fixture, { needed_on: addCalendarDays(today, -90) });
    await seedSupply(fixture, { needed_on: addCalendarDays(today, -91) });
    past.push({ date: addCalendarDays(today, -90), id: dayNinety.id });

    const readPages = async (scope: "past" | "upcoming") => {
      const first = await app.inject({
        method: "GET",
        url: `/api/v1/supplies?scope=${scope}`,
        headers: fixture.teacher.headers,
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as SupplyList;
      expect(firstBody.items).toHaveLength(20);
      expect(firstBody.next_cursor).toEqual(expect.any(String));
      expect(firstBody.server_today).toBe(today);
      expect(firstBody.items.every((item) => !("check_state" in item))).toBe(true);
      const second = await app.inject({
        method: "GET",
        url: `/api/v1/supplies?scope=${scope}&cursor=${encodeURIComponent(firstBody.next_cursor!)}`,
        headers: fixture.teacher.headers,
      });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as SupplyList;
      expect(secondBody.next_cursor).toBeNull();
      return [...firstBody.items, ...secondBody.items].map((item) => item.id);
    };

    await expect(readPages("upcoming")).resolves.toEqual(upcoming.map((item) => item.id));
    const expectedPast = past
      .toSorted((left, right) => {
        const dateOrder = right.date.localeCompare(left.date);
        if (dateOrder !== 0) return dateOrder;
        const leftId = BigInt(left.id);
        const rightId = BigInt(right.id);
        if (leftId === rightId) return 0;
        return leftId > rightId ? -1 : 1;
      })
      .map((item) => item.id);
    await expect(readPages("past")).resolves.toEqual(expectedPast);
    expectError(
      await app.inject({
        method: "GET",
        url: "/api/v1/supplies?scope=upcoming&cursor=not-a-valid-cursor",
        headers: fixture.teacher.headers,
      }),
      400,
      "INVALID_CURSOR",
    );
  });

  it("returns detail ETags and student check state while ignoring If-None-Match", async () => {
    const supply = await seedSupply(fixture);
    const teacherDetail = await app.inject({
      method: "GET",
      url: `/api/v1/supplies/${supply.id}`,
      headers: { ...fixture.teacher.headers, "if-none-match": '"1"' },
    });
    expect(teacherDetail.statusCode).toBe(200);
    expect(teacherDetail.headers.etag).toBe('"1"');
    expect(teacherDetail.json()).not.toHaveProperty("check_state");
    const studentDetail = await app.inject({
      method: "GET",
      url: `/api/v1/supplies/${supply.id}`,
      headers: fixture.students[0].headers,
    });
    expect(studentDetail.statusCode).toBe(200);
    expect(studentDetail.headers.etag).toBe('"1"');
    expect(studentDetail.json()).toMatchObject({ id: supply.id, check_state: "unchecked" });
  });

  it("hides items older than 90 days from students while preserving teacher management", async () => {
    const oldSupply = await seedSupply(fixture, {
      needed_on: addCalendarDays(kstDate(new Date()), -91),
      title: "오래된 준비물",
    });
    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/supplies/${oldSupply.id}`,
        headers: fixture.students[0].headers,
      }),
      404,
      "NOT_FOUND",
    );

    const teacherDetail = await app.inject({
      method: "GET",
      url: `/api/v1/supplies/${oldSupply.id}`,
      headers: fixture.teacher.headers,
    });
    expect(teacherDetail.statusCode).toBe(200);
    expect(teacherDetail.headers.etag).toBe('"1"');

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/supplies/${oldSupply.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: { title: "오래된 준비물 수정" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.headers.etag).toBe('"2"');

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/supplies/${oldSupply.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"2"' },
      payload: { reason: null },
    });
    expect(deleted.statusCode).toBe(204);
  });

  it("keeps list, detail, and student checks on the DB 90-day boundary across Node clock drift", async () => {
    const serverToday = await readDatabaseKstToday(database);
    const realNow = Date.now();
    await database
      .updateTable("sessions")
      .set({ expires_at: new Date(realNow + 3 * DAY_MS) })
      .where("user_id", "in", [fixture.students[0].userId, fixture.teacher.userId])
      .execute();
    const boundary = await seedSupply(fixture, {
      needed_on: addCalendarDays(serverToday, -90),
      title: "90일 경계 준비물",
    });
    const hidden = await seedSupply(fixture, {
      needed_on: addCalendarDays(serverToday, -91),
      title: "91일 지난 준비물",
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(realNow + DAY_MS));
    const boundaryDetail = await app.inject({
      method: "GET",
      url: `/api/v1/supplies/${boundary.id}`,
      headers: fixture.students[0].headers,
    });
    expect(boundaryDetail.statusCode).toBe(200);
    const past = await app.inject({
      method: "GET",
      url: "/api/v1/supplies?scope=past",
      headers: fixture.students[0].headers,
    });
    expect(past.statusCode).toBe(200);
    expect(past.json().server_today).toBe(serverToday);
    expect(past.json().items.map((item: SupplyItem) => item.id)).toContain(boundary.id);
    expect(past.json().items.map((item: SupplyItem) => item.id)).not.toContain(hidden.id);
    const checks = await app.inject({
      method: "GET",
      url: `/api/v1/supplies/${boundary.id}/checks?state=unchecked`,
      headers: fixture.teacher.headers,
    });
    expect(checks.statusCode).toBe(200);
    expect(checks.json().content_revision).toBe("1");
    expect(checks.json().server_today).toBe(serverToday);

    vi.setSystemTime(new Date(realNow - DAY_MS));
    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/supplies/${hidden.id}`,
        headers: fixture.students[0].headers,
      }),
      404,
      "NOT_FOUND",
    );
    expectError(
      await app.inject({
        method: "PUT",
        url: `/api/v1/supplies/${hidden.id}/check`,
        headers: fixture.students[0].headers,
        payload: { content_revision: 1, is_checked: true },
      }),
      404,
      "NOT_FOUND",
    );
  });

  it("keeps no-op PATCH immutable and allows one winner for a shared row version", async () => {
    const supply = await seedSupply(fixture, { description: "원본 설명", title: "원본 제목" });
    const before = await database
      .selectFrom("supplies")
      .selectAll()
      .where("id", "=", supply.id)
      .executeTakeFirstOrThrow();
    const noOp = await app.inject({
      method: "PATCH",
      url: `/api/v1/supplies/${supply.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: {
        description: "원본 설명",
        needed_on: databaseDate(supply.needed_on),
        title: "원본 제목",
      },
    });
    expect(noOp.statusCode).toBe(200);
    expect(noOp.headers.etag).toBe('"1"');
    expect(
      await database
        .selectFrom("supplies")
        .selectAll()
        .where("id", "=", supply.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(
      await database
        .selectFrom("audit_logs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("action", "=", "supply.updated")
        .where("target_id", "=", supply.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });

    const updates = await Promise.all(
      ["첫 번째 수정", "두 번째 수정"].map((title) =>
        app.inject({
          method: "PATCH",
          url: `/api/v1/supplies/${supply.id}`,
          headers: { ...fixture.teacher.headers, "if-match": '"1"' },
          payload: { title },
        }),
      ),
    );
    expect(updates.map((response) => response.statusCode).toSorted()).toEqual([200, 409]);
    const winner = updates.find((response) => response.statusCode === 200)!;
    const loser = updates.find((response) => response.statusCode === 409)!;
    expect(winner.headers.etag).toBe('"2"');
    expect(winner.json()).toMatchObject({ content_revision: "2", row_version: "2" });
    expect(loser.json().error).toMatchObject({
      code: "RESOURCE_VERSION_CHANGED",
      details: { current_row_version: "2" },
    });
    const current = await database
      .selectFrom("supplies")
      .selectAll()
      .where("id", "=", supply.id)
      .executeTakeFirstOrThrow();
    expect(current).toMatchObject({ content_revision: "2", row_version: "2" });
    const audits = await database
      .selectFrom("audit_logs")
      .selectAll()
      .where("action", "=", "supply.updated")
      .where("target_id", "=", supply.id)
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.target_snapshot).toBeNull();
    expect(audits[0]!.before_json).toMatchObject({ title: "원본 제목" });
    expect(audits[0]!.after_json).toMatchObject({ title: current.title });
  });

  it("soft deletes with a delete-shaped audit and preserves existing checks", async () => {
    const supply = await seedSupply(fixture);
    await database
      .insertInto("supply_checks")
      .values({
        checked_at: new Date(),
        class_id: fixture.classId,
        confirmed_revision: 1,
        is_checked: true,
        member_id: fixture.students[0].memberId!,
        supply_id: supply.id,
        unchecked_at: null,
      })
      .execute();
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/supplies/${supply.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: { reason: "중복 등록" },
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
    const row = await database
      .selectFrom("supplies")
      .selectAll()
      .where("id", "=", supply.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      content_revision: "1",
      delete_reason: "중복 등록",
      deleted_by_member_id: fixture.teacher.memberId,
      row_version: "2",
    });
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(
      await database
        .selectFrom("supply_checks")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("supply_id", "=", supply.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "1" });
    const audit = await database
      .selectFrom("audit_logs")
      .selectAll()
      .where("action", "=", "supply.deleted")
      .where("target_id", "=", supply.id)
      .executeTakeFirstOrThrow();
    expect(audit.before_json).toBeNull();
    expect(audit.after_json).toBeNull();
    expect(audit.reason).toBe("중복 등록");
    expect(audit.target_snapshot).toMatchObject({
      content_revision: "1",
      deleted_at: null,
      supply_id: supply.id,
      title: supply.title,
    });
    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/supplies/${supply.id}`,
        headers: fixture.teacher.headers,
      }),
      404,
      "NOT_FOUND",
    );
  });

  it("sets, repeats, unsets, and revision-checks the desired student state", async () => {
    const supply = await seedSupply(fixture);
    const student = fixture.students[0];
    const put = (actor: ActorFixture, isChecked: boolean, revision: number) =>
      app.inject({
        method: "PUT",
        url: `/api/v1/supplies/${supply.id}/check`,
        headers: actor.headers,
        payload: { content_revision: revision, is_checked: isChecked },
      });
    const checked = await put(student, true, 1);
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toEqual({
      check_state: "checked",
      content_revision: "1",
      supply_id: supply.id,
    });
    const first = await database
      .selectFrom("supply_checks")
      .selectAll()
      .where("supply_id", "=", supply.id)
      .where("member_id", "=", student.memberId!)
      .executeTakeFirstOrThrow();
    expect((await put(student, true, 1)).statusCode).toBe(200);
    expect(
      await database
        .selectFrom("supply_checks")
        .selectAll()
        .where("id", "=", first.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(first);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/supplies/${supply.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: { title: "수정된 준비물" },
    });
    expect(updated.statusCode).toBe(200);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/supplies/${supply.id}`,
      headers: student.headers,
    });
    expect(detail.json()).toMatchObject({
      check_state: "modified_unconfirmed",
      content_revision: "2",
    });
    const stale = await put(student, false, 1);
    expectError(stale, 409, "CONTENT_REVISION_CHANGED");
    expect(stale.json().error.details).toEqual({ current_revision: "2" });
    expect(
      await database
        .selectFrom("supply_checks")
        .selectAll()
        .where("id", "=", first.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(first);

    const unchecked = await put(student, false, 2);
    expect(unchecked.statusCode).toBe(200);
    expect(unchecked.json()).toMatchObject({ check_state: "unchecked", content_revision: "2" });
    const falseState = await database
      .selectFrom("supply_checks")
      .selectAll()
      .where("id", "=", first.id)
      .executeTakeFirstOrThrow();
    expect(falseState).toMatchObject({
      checked_at: null,
      confirmed_revision: null,
      is_checked: false,
    });
    expect(falseState.unchecked_at).toBeInstanceOf(Date);
    expect((await put(student, false, 2)).statusCode).toBe(200);
    expect(
      await database
        .selectFrom("supply_checks")
        .selectAll()
        .where("id", "=", first.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(falseState);
    expect((await put(fixture.students[1], false, 2)).statusCode).toBe(200);
    expect(
      await database
        .selectFrom("supply_checks")
        .selectAll()
        .where("supply_id", "=", supply.id)
        .where("member_id", "=", fixture.students[1].memberId!)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ checked_at: null, confirmed_revision: null, is_checked: false });
  });

  it("filters teacher check status, returns global counts, and excludes inactive students", async () => {
    const supply = await seedSupply(fixture, { content_revision: 2 });
    const now = new Date();
    await database
      .insertInto("supply_checks")
      .values([
        {
          checked_at: now,
          class_id: fixture.classId,
          confirmed_revision: 2,
          is_checked: true,
          member_id: fixture.students[0].memberId!,
          supply_id: supply.id,
          unchecked_at: null,
        },
        {
          checked_at: null,
          class_id: fixture.classId,
          confirmed_revision: null,
          is_checked: false,
          member_id: fixture.students[1].memberId!,
          supply_id: supply.id,
          unchecked_at: now,
        },
        {
          checked_at: now,
          class_id: fixture.classId,
          confirmed_revision: 1,
          is_checked: true,
          member_id: fixture.students[2].memberId!,
          supply_id: supply.id,
          unchecked_at: null,
        },
        {
          checked_at: now,
          class_id: fixture.classId,
          confirmed_revision: 2,
          is_checked: true,
          member_id: fixture.inactive.memberId!,
          supply_id: supply.id,
          unchecked_at: null,
        },
      ])
      .execute();

    const expectations = [
      ["checked", fixture.students[0].memberId],
      ["unchecked", fixture.students[1].memberId],
      ["modified_unconfirmed", fixture.students[2].memberId],
    ] as const;
    for (const [state, memberId] of expectations) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/supplies/${supply.id}/checks?state=${state}`,
        headers: fixture.teacher.headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        content_revision: "2",
        counts: { checked: 1, modified_unconfirmed: 1, unchecked: 1 },
        items: [{ check_state: state, member_id: memberId }],
        next_cursor: null,
        server_today: kstDate(new Date()),
      });
      expect(JSON.stringify(response.json())).not.toContain(fixture.inactive.memberId!);
    }

    const invalidDisplayNameCursor = Buffer.from(
      JSON.stringify({
        display_name: "앞\u0000뒤",
        kind: "supply_checks",
        member_id: fixture.students[0].memberId,
        state: "checked",
        student_number: 1,
        supply_id: supply.id,
        v: 1,
      }),
      "utf8",
    ).toString("base64url");
    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/supplies/${supply.id}/checks?state=checked&cursor=${encodeURIComponent(invalidDisplayNameCursor)}`,
        headers: fixture.teacher.headers,
      }),
      400,
      "INVALID_CURSOR",
    );
  });
});
