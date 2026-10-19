import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addCalendarDays, kstDate } from "../src/common/date/kst-date.js";
import {
  app,
  type ActorFixture,
  type ClassFixture,
  createClassFixture,
  database,
  setupSuppliesHarnessWithRedis,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

interface ContentItem {
  audience_mode: "all_snapshot" | "legacy_class" | "selected_snapshot";
  category?: "general" | "performance";
  content_revision: string;
  id: string;
  row_version: string;
}

interface UpdatesItem {
  category: "general" | "performance" | "homework";
  id: string;
  is_important: boolean;
  kind: "notice" | "supply";
  published_at: string;
}

interface UpdatesList {
  items: UpdatesItem[];
  next_cursor: null | string;
  selected_audience_enabled: boolean;
  server_today: string;
  unresolved_count?: number | null;
}

interface HomeResult {
  notices: { data: Array<{ id: string }>; status: string };
  reminders: {
    data: Array<{ reminder_type: "notice" | "supply"; resource_id: string }>;
    status: string;
  };
  supplies: { data: Array<{ id: string }>; status: string };
  teacher_followups: {
    data: Array<{
      counts: Record<string, number>;
      resource_id: string;
      resource_type: "notice" | "supply";
    }>;
    status: string;
  } | null;
}

let fixture: ClassFixture;

function expectError(
  response: {
    json(): { error: { code: string } };
    statusCode: number;
  },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json().error.code).toBe(code);
}

function databaseIdOrder(left: string, right: string): number {
  return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
}

async function createNotice(
  owner: ClassFixture,
  values: {
    audience?: { member_ids?: string[]; mode: "all" | "selected" };
    category?: "general" | "performance";
    content?: string;
    is_important?: boolean;
    title?: string;
  } = {},
) {
  return app.inject({
    headers: { ...owner.teacher.headers, "idempotency-key": randomUUID() },
    method: "POST",
    payload: {
      ...(values.audience === undefined ? {} : { audience: values.audience }),
      ...(values.category === undefined ? {} : { category: values.category }),
      content: values.content ?? "지정 대상 공지 내용",
      is_important: values.is_important ?? false,
      title: values.title ?? "지정 대상 공지",
    },
    url: "/api/v1/notices",
  });
}

async function createSupply(
  owner: ClassFixture,
  values: {
    audience?: { member_ids?: string[]; mode: "all" | "selected" };
    needed_on?: string;
    category?: "general" | "homework";
    title?: string;
  } = {},
) {
  return app.inject({
    headers: { ...owner.teacher.headers, "idempotency-key": randomUUID() },
    method: "POST",
    payload: {
      ...(values.audience === undefined ? {} : { audience: values.audience }),
      needed_on: values.needed_on ?? kstDate(new Date()),
      ...(values.category === undefined ? {} : { category: values.category }),
      title: values.title ?? "지정 대상 준비물",
    },
    url: "/api/v1/supplies",
  });
}

async function getHome(actor: ActorFixture) {
  const response = await app.inject({
    headers: actor.headers,
    method: "GET",
    url: "/api/v1/home",
  });
  expect(response.statusCode).toBe(200);
  return response.json() as HomeResult;
}

beforeAll(setupSuppliesHarnessWithRedis, 120_000);

beforeEach(async () => {
  fixture = await createClassFixture();
});

afterAll(teardownSuppliesHarness, 120_000);

describe("content audience authoring contract", () => {
  it("shows earlier class-wide notices and supplies to a student approved later, but not selected ones (P-025)", async () => {
    const pending = await database
      .insertInto("class_members")
      .values({
        class_id: fixture.classId,
        role: "student",
        status: "pending",
        user_id: fixture.outsider.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const wide = (await createNotice(fixture, { title: "늦게 와도 보는 공지" }).then((r) =>
      r.json(),
    )) as ContentItem;
    const homework = (await createSupply(fixture, {
      category: "homework",
      title: "늦게 와도 보는 숙제",
    }).then((r) => r.json())) as ContentItem;
    const selected = (await createNotice(fixture, {
      audience: { member_ids: [fixture.students[0].memberId!], mode: "selected" },
      title: "고른 학생만 보는 공지",
    }).then((r) => r.json())) as ContentItem;

    const approval = await app.inject({
      headers: fixture.teacher.headers,
      method: "POST",
      payload: { display_name_in_class: null, student_number: null },
      url: `/api/v1/members/${pending.id}/approve`,
    });
    expect(approval.statusCode, approval.body).toBe(200);

    const see = (url: string) =>
      app.inject({ headers: fixture.outsider.headers, method: "GET", url });
    expect((await see(`/api/v1/notices/${wide.id}`)).statusCode).toBe(200);
    expect((await see(`/api/v1/supplies/${homework.id}`)).statusCode).toBe(200);
    expect((await see(`/api/v1/notices/${selected.id}`)).statusCode).toBe(404);
    const recipients = await database
      .selectFrom("notice_recipients")
      .select("member_id")
      .where("notice_id", "=", wide.id)
      .execute();
    expect(recipients.map((row) => row.member_id)).toContain(pending.id);
    expect(recipients).toHaveLength(fixture.students.length + 1);
  });

  it("snapshots active students, normalizes selected ids, hides PII from audits, and keeps targeting immutable", async () => {
    const pending = await database
      .insertInto("class_members")
      .values({
        class_id: fixture.classId,
        role: "student",
        status: "pending",
        user_id: fixture.outsider.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const other = await createClassFixture();

    const allResponse = await createNotice(fixture, { title: "전체 스냅샷 공지" });
    expect(allResponse.statusCode).toBe(201);
    const allNotice = allResponse.json() as ContentItem;
    expect(allNotice).toMatchObject({
      audience_mode: "all_snapshot",
      category: "general",
      content_revision: "1",
      row_version: "1",
    });
    const allRecipients = await database
      .selectFrom("notice_recipients")
      .select("member_id")
      .where("notice_id", "=", allNotice.id)
      .orderBy("member_id", "asc")
      .execute();
    expect(allRecipients.map((row) => row.member_id)).toEqual(
      fixture.students.map((student) => student.memberId!).sort(databaseIdOrder),
    );

    const selectedIds = [
      fixture.students[2].memberId!,
      fixture.students[0].memberId!,
      fixture.students[2].memberId!,
    ];
    const selectedResponse = await createNotice(fixture, {
      audience: { member_ids: selectedIds, mode: "selected" },
      category: "performance",
      title: "수행평가 지정 공지",
    });
    expect(selectedResponse.statusCode).toBe(201);
    const selectedNotice = selectedResponse.json() as ContentItem;
    expect(selectedNotice).toMatchObject({
      audience_mode: "selected_snapshot",
      category: "performance",
    });
    const selectedRecipients = await database
      .selectFrom("notice_recipients")
      .select("member_id")
      .where("notice_id", "=", selectedNotice.id)
      .orderBy("member_id", "asc")
      .execute();
    expect(selectedRecipients.map((row) => row.member_id)).toEqual(
      [fixture.students[0].memberId!, fixture.students[2].memberId!].sort(databaseIdOrder),
    );

    const audit = await database
      .selectFrom("audit_logs")
      .select("after_json")
      .where("action", "=", "notice.created")
      .where("target_id", "=", selectedNotice.id)
      .executeTakeFirstOrThrow();
    expect(audit.after_json).toMatchObject({
      audience_mode: "selected_snapshot",
      category: "performance",
      recipient_count: 2,
    });
    expect(Object.keys(audit.after_json ?? {})).not.toEqual(
      expect.arrayContaining(["member_id", "member_ids", "recipient_ids", "recipients"]),
    );

    for (const memberId of [fixture.inactive.memberId!, pending.id, other.students[0].memberId!]) {
      expectError(
        await createSupply(fixture, {
          audience: { member_ids: [memberId], mode: "selected" },
        }),
        400,
        "VALIDATION_FAILED",
      );
    }

    expectError(
      await app.inject({
        headers: { ...fixture.teacher.headers, "if-match": '"1"' },
        method: "PATCH",
        payload: { audience: { mode: "all" } },
        url: `/api/v1/notices/${selectedNotice.id}`,
      }),
      400,
      "VALIDATION_FAILED",
    );

    const categoryUpdate = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      method: "PATCH",
      payload: { category: "performance" },
      url: `/api/v1/notices/${allNotice.id}`,
    });
    expect(categoryUpdate.statusCode).toBe(200);
    expect(categoryUpdate.json()).toMatchObject({
      audience_mode: "all_snapshot",
      category: "performance",
      content_revision: "1",
      row_version: "2",
    });

    const list = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/notices",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ selected_audience_enabled: true });
  });
});

describe("selected audience read-path isolation", () => {
  it("limits notice, supply, home, confirmations, checks, reminders, and updates to A and C", async () => {
    const targetIds = [fixture.students[0].memberId!, fixture.students[2].memberId!];
    const noticeResponse = await createNotice(fixture, {
      audience: { member_ids: targetIds, mode: "selected" },
      is_important: true,
      title: "A와 C 공지",
    });
    const supplyResponse = await createSupply(fixture, {
      audience: { member_ids: targetIds, mode: "selected" },
      title: "A와 C 준비물",
    });
    expect(noticeResponse.statusCode).toBe(201);
    expect(supplyResponse.statusCode).toBe(201);
    const notice = noticeResponse.json() as ContentItem;
    const supply = supplyResponse.json() as ContentItem;

    for (const target of [fixture.students[0], fixture.students[2]]) {
      const [notices, supplies, updates, home] = await Promise.all([
        app.inject({ headers: target.headers, method: "GET", url: "/api/v1/notices" }),
        app.inject({
          headers: target.headers,
          method: "GET",
          url: "/api/v1/supplies?scope=upcoming",
        }),
        app.inject({ headers: target.headers, method: "GET", url: "/api/v1/updates" }),
        getHome(target),
      ]);
      expect((notices.json() as { items: Array<{ id: string }> }).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: notice.id })]),
      );
      expect((supplies.json() as { items: Array<{ id: string }> }).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: supply.id })]),
      );
      expect((updates.json() as UpdatesList).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: notice.id, kind: "notice" }),
          expect.objectContaining({ id: supply.id, kind: "supply" }),
        ]),
      );
      expect(home.notices.data.map((item) => item.id)).toContain(notice.id);
      expect(home.supplies.data.map((item) => item.id)).toContain(supply.id);
    }

    const studentB = fixture.students[1];
    for (const [url, method, payload] of [
      [`/api/v1/notices/${notice.id}`, "GET", undefined],
      [
        `/api/v1/notices/${notice.id}/confirmation`,
        "PUT",
        { content_revision: Number(notice.content_revision) },
      ],
      [`/api/v1/supplies/${supply.id}`, "GET", undefined],
      [
        `/api/v1/supplies/${supply.id}/check`,
        "PUT",
        { content_revision: Number(supply.content_revision), is_checked: true },
      ],
    ] as const) {
      expectError(
        await app.inject({
          headers: studentB.headers,
          method,
          ...(payload === undefined ? {} : { payload }),
          url,
        }),
        404,
        "NOT_FOUND",
      );
    }
    const studentBHome = await getHome(studentB);
    expect(studentBHome.notices.data.map((item) => item.id)).not.toContain(notice.id);
    expect(studentBHome.supplies.data.map((item) => item.id)).not.toContain(supply.id);
    const studentBUpdates = await app.inject({
      headers: studentB.headers,
      method: "GET",
      url: "/api/v1/updates",
    });
    expect((studentBUpdates.json() as UpdatesList).items.map((item) => item.id)).not.toContain(
      notice.id,
    );
    expect((studentBUpdates.json() as UpdatesList).items.map((item) => item.id)).not.toContain(
      supply.id,
    );

    const confirmed = await app.inject({
      headers: fixture.students[0].headers,
      method: "PUT",
      payload: { content_revision: Number(notice.content_revision) },
      url: `/api/v1/notices/${notice.id}/confirmation`,
    });
    const checked = await app.inject({
      headers: fixture.students[0].headers,
      method: "PUT",
      payload: { content_revision: Number(supply.content_revision), is_checked: true },
      url: `/api/v1/supplies/${supply.id}/check`,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(checked.statusCode).toBe(200);

    const [confirmations, checks] = await Promise.all([
      app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: `/api/v1/notices/${notice.id}/confirmations?state=unread`,
      }),
      app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: `/api/v1/supplies/${supply.id}/checks?state=unchecked`,
      }),
    ]);
    expect(confirmations.json()).toMatchObject({
      counts: { confirmed: 1, modified_unconfirmed: 0, unread: 1 },
      items: [{ member_id: fixture.students[2].memberId }],
    });
    expect(checks.json()).toMatchObject({
      counts: { checked: 1, modified_unconfirmed: 0, unchecked: 1 },
      items: [{ member_id: fixture.students[2].memberId }],
    });

    const [noticeReminder, supplyReminder] = await Promise.all([
      app.inject({
        headers: { ...fixture.teacher.headers, "idempotency-key": randomUUID() },
        method: "POST",
        payload: { content_revision: Number(notice.content_revision) },
        url: `/api/v1/notices/${notice.id}/reminders`,
      }),
      app.inject({
        headers: { ...fixture.teacher.headers, "idempotency-key": randomUUID() },
        method: "POST",
        payload: { content_revision: Number(supply.content_revision) },
        url: `/api/v1/supplies/${supply.id}/reminders`,
      }),
    ]);
    expect(noticeReminder.statusCode).toBe(201);
    expect(supplyReminder.statusCode).toBe(201);
    expect(noticeReminder.json()).toMatchObject({ created_count: 1, current_unresolved_count: 1 });
    expect(supplyReminder.json()).toMatchObject({ created_count: 1, current_unresolved_count: 1 });

    for (const response of [noticeReminder, supplyReminder]) {
      const recipients = await database
        .selectFrom("in_app_reminder_recipients")
        .select("member_id")
        .where("batch_id", "=", response.json().batch_id as string)
        .execute();
      expect(recipients.map((row) => row.member_id)).toEqual([fixture.students[2].memberId]);
    }

    const [studentAHome, studentBHomeAfter, studentCHome, teacherHome] = await Promise.all([
      getHome(fixture.students[0]),
      getHome(fixture.students[1]),
      getHome(fixture.students[2]),
      getHome(fixture.teacher),
    ]);
    expect(studentAHome.reminders.data).toEqual([]);
    expect(studentBHomeAfter.reminders.data).toEqual([]);
    expect(studentCHome.reminders.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reminder_type: "notice", resource_id: notice.id }),
        expect.objectContaining({ reminder_type: "supply", resource_id: supply.id }),
      ]),
    );
    const noticeFollowup = teacherHome.teacher_followups?.data.find(
      (item) => item.resource_type === "notice" && item.resource_id === notice.id,
    );
    const supplyFollowup = teacherHome.teacher_followups?.data.find(
      (item) => item.resource_type === "supply" && item.resource_id === supply.id,
    );
    // 지정 대상이 A와 C뿐이므로 B는 대상 밖 1명으로 잡힌다. 이 수를 노출하지
    // 않으면 교사는 B가 이 게시물을 못 받았다는 사실을 알 길이 없다(P1-07).
    expect(noticeFollowup?.counts).toEqual({
      confirmed: 1,
      excluded_member_count: 1,
      modified_unconfirmed: 0,
      unread: 1,
    });
    expect(supplyFollowup?.counts).toEqual({
      checked: 1,
      excluded_member_count: 1,
      modified_unconfirmed: 0,
      unchecked: 1,
    });
  });
});

describe("unified updates feed", () => {
  it("counts only the student's latest unresolved recipients across filters, search and the existing supply age range", async () => {
    const student = fixture.students[0];
    const today = kstDate(new Date());
    const noticeResponse = await createNotice(fixture, { title: "확인할 일반 공지" });
    const performanceResponse = await createNotice(fixture, {
      category: "performance",
      title: "본인 수행평가",
      audience: { mode: "selected", member_ids: [student.memberId!] },
    });
    const hiddenResponse = await createNotice(fixture, {
      title: "다른 학생 안내",
      audience: { mode: "selected", member_ids: [fixture.students[1].memberId!] },
    });
    const supplyResponse = await createSupply(fixture, { title: "오늘 준비물" });
    const homeworkResponse = await createSupply(fixture, {
      title: "오늘 숙제",
      category: "homework",
    });
    for (const response of [
      noticeResponse,
      performanceResponse,
      hiddenResponse,
      supplyResponse,
      homeworkResponse,
    ])
      expect(response.statusCode).toBe(201);
    const notice = noticeResponse.json() as ContentItem;
    const performance = performanceResponse.json() as ContentItem;
    const supply = supplyResponse.json() as ContentItem;
    const homework = homeworkResponse.json() as ContentItem;
    const past = await database
      .insertInto("supplies")
      .values({
        class_id: fixture.classId,
        created_by_member_id: fixture.teacher.memberId!,
        needed_on: addCalendarDays(today, -90),
        title: "범위 안 지난 준비물",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await database
      .insertInto("supplies")
      .values({
        class_id: fixture.classId,
        created_by_member_id: fixture.teacher.memberId!,
        needed_on: addCalendarDays(today, -91),
        title: "범위 밖 준비물",
      })
      .execute();
    for (const [url, payload] of [
      [`/api/v1/notices/${notice.id}/confirmation`, { content_revision: 1 }],
      [`/api/v1/supplies/${supply.id}/check`, { content_revision: 1, is_checked: true }],
      [`/api/v1/supplies/${homework.id}/check`, { content_revision: 1, is_checked: false }],
    ] as const) {
      const response = await app.inject({ method: "PUT", headers: student.headers, url, payload });
      expect(response.statusCode).toBe(200);
    }
    const readUpdates = async (query: string) => {
      const response = await app.inject({
        method: "GET",
        headers: student.headers,
        url: "/api/v1/updates?" + query,
      });
      expect(response.statusCode).toBe(200);
      return response.json() as UpdatesList;
    };
    const unresolved = await readUpdates("filter=unresolved");
    expect(unresolved.unresolved_count).toBe(3);
    expect(unresolved.items.map((item) => item.kind + ":" + item.id).sort()).toEqual(
      ["notice:" + performance.id, "supply:" + homework.id, "supply:" + past.id].sort(),
    );
    const emptySearch = await readUpdates("filter=materials&q=" + encodeURIComponent("없는 단어"));
    expect(emptySearch.items).toEqual([]);
    expect(emptySearch.unresolved_count).toBe(3);
    const materials = await readUpdates("filter=materials");
    expect(materials.items.map((item) => item.id).sort()).toEqual([supply.id, past.id].sort());
    expect(materials.unresolved_count).toBe(3);
    const notices = await readUpdates("filter=notices");
    expect(notices.items.map((item) => item.id)).toEqual([notice.id]);
    const combined = await readUpdates("filter=supplies");
    expect(combined.items.map((item) => item.id).sort()).toEqual(
      [supply.id, homework.id, past.id].sort(),
    );

    await database
      .updateTable("notices")
      .set({ content_revision: "2" })
      .where("id", "=", notice.id)
      .execute();
    await database
      .updateTable("supplies")
      .set({ content_revision: "2" })
      .where("id", "=", supply.id)
      .execute();
    const changed = await readUpdates("filter=unresolved");
    expect(changed.unresolved_count).toBe(5);
    expect(changed.items.map((item) => item.kind + ":" + item.id)).toEqual(
      expect.arrayContaining(["notice:" + notice.id, "supply:" + supply.id]),
    );
    const teacher = await app.inject({
      method: "GET",
      headers: fixture.teacher.headers,
      url: "/api/v1/updates",
    });
    expect((teacher.json() as UpdatesList).unresolved_count).toBeNull();
    expectError(
      await app.inject({
        method: "GET",
        headers: fixture.teacher.headers,
        url: "/api/v1/updates?filter=unresolved",
      }),
      400,
      "VALIDATION_FAILED",
    );
  });

  it("paginates searched homework before limiting and preserves student audience boundaries", async () => {
    const ids: string[] = [];
    const stamp = Date.now() - 60_000;
    for (let index = 0; index < 21; index += 1) {
      const row = await database
        .insertInto("supplies")
        .values({
          category: "homework",
          class_id: fixture.classId,
          created_by_member_id: fixture.teacher.memberId!,
          created_at: new Date(stamp - index * 1000),
          needed_on: kstDate(new Date()),
          title: `찾을 숙제 ${index}`,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      ids.push(row.id);
    }
    for (const category of ["general", "homework"] as const) {
      const row = await database
        .insertInto("supplies")
        .values({
          audience_mode: category === "homework" ? "selected_snapshot" : "legacy_class",
          category,
          class_id: fixture.classId,
          created_by_member_id: fixture.teacher.memberId!,
          created_at: new Date(stamp + 1000),
          needed_on: kstDate(new Date()),
          title: "찾을 숙제 제외 항목",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (category === "homework")
        await database
          .insertInto("supply_recipients")
          .values({
            supply_id: row.id,
            class_id: fixture.classId,
            member_id: fixture.students[1].memberId!,
          })
          .execute();
    }
    const url = "/api/v1/updates?filter=homework&q=" + encodeURIComponent("찾을 숙제");
    const first = await app.inject({ method: "GET", url, headers: fixture.students[0].headers });
    expect(first.statusCode).toBe(200);
    const page = first.json() as UpdatesList;
    expect(page.items.map((item) => item.id)).toEqual(ids.slice(0, 20));
    expect(page.items.every((item) => item.kind === "supply" && item.category === "homework")).toBe(
      true,
    );
    expect(page.next_cursor).not.toBeNull();
    const second = await app.inject({
      method: "GET",
      url: `${url}&cursor=${page.next_cursor}`,
      headers: fixture.students[0].headers,
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as UpdatesList).items.map((item) => item.id)).toEqual(ids.slice(20));
    expect((second.json() as UpdatesList).next_cursor).toBeNull();
    expectError(
      await app.inject({
        method: "GET",
        url: `${url.replace("filter=homework", "filter=supplies")}&cursor=${page.next_cursor}`,
        headers: fixture.students[0].headers,
      }),
      400,
      "INVALID_CURSOR",
    );
    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/updates?filter=homework&q=other&cursor=${page.next_cursor}`,
        headers: fixture.students[0].headers,
      }),
      400,
      "INVALID_CURSOR",
    );
  });

  it("globally orders both kinds, paginates without gaps, binds cursors, and applies filters", async () => {
    expectError(
      await app.inject({ method: "GET", url: "/api/v1/updates" }),
      401,
      "UNAUTHENTICATED",
    );
    expectError(
      await app.inject({
        headers: fixture.outsider.headers,
        method: "GET",
        url: "/api/v1/updates",
      }),
      404,
      "NOT_FOUND",
    );

    const baseTime = new Date(Date.now() - 60 * 60 * 1_000);
    const expected: Array<{
      category: "general" | "homework" | "performance";
      id: string;
      important: boolean;
      kind: "notice" | "supply";
      publishedAt: Date;
    }> = [];
    for (let index = 0; index < 21; index += 1) {
      const publishedAt = new Date(baseTime.getTime() - index * 60_000);
      const category = index % 3 === 0 ? "performance" : "general";
      const important = index % 4 === 0;
      const notice = await database
        .insertInto("notices")
        .values({
          category,
          class_id: fixture.classId,
          content: `통합 피드 공지 ${index}`,
          created_by_member_id: fixture.teacher.memberId!,
          is_important: important,
          published_at: publishedAt,
          title: `통합 피드 공지 ${index}`,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      expected.push({
        category,
        id: notice.id,
        important,
        kind: "notice",
        publishedAt,
      });
    }
    for (const [index, tiedNoticeIndex] of [0, 20].entries()) {
      const publishedAt = new Date(baseTime.getTime() - tiedNoticeIndex * 60_000);
      const supply = await database
        .insertInto("supplies")
        .values({
          // 둘째 항목만 숙제로 심는다 — 통합 피드가 종류를 그대로 실어 나르는지 본다.
          category: index === 1 ? "homework" : "general",
          class_id: fixture.classId,
          created_at: publishedAt,
          created_by_member_id: fixture.teacher.memberId!,
          needed_on: kstDate(new Date()),
          title: `통합 피드 준비물 ${index}`,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      expected.push({
        // 자리표시자 'supply' 를 내려보내던 시절에는 이 둘이 같은 값이었다.
        category: index === 1 ? "homework" : "general",
        id: supply.id,
        important: false,
        kind: "supply",
        publishedAt,
      });
    }

    expected.sort((left, right) => {
      const timeOrder = right.publishedAt.getTime() - left.publishedAt.getTime();
      if (timeOrder !== 0) return timeOrder;
      const kindOrder = left.kind.localeCompare(right.kind);
      if (kindOrder !== 0) return kindOrder;
      return BigInt(left.id) > BigInt(right.id) ? -1 : BigInt(left.id) < BigInt(right.id) ? 1 : 0;
    });

    const first = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/updates?filter=all",
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as UpdatesList;
    expect(firstBody).toMatchObject({
      selected_audience_enabled: true,
      server_today: kstDate(new Date()),
    });
    expect(firstBody.items).toHaveLength(20);
    expect(firstBody.next_cursor).toEqual(expect.any(String));
    expect(firstBody.items.map((item) => `${item.kind}:${item.id}`)).toEqual(
      expected.slice(0, 20).map((item) => `${item.kind}:${item.id}`),
    );

    const second = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: `/api/v1/updates?filter=all&cursor=${firstBody.next_cursor}`,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as UpdatesList;
    expect(
      [...firstBody.items, ...secondBody.items].map((item) => `${item.kind}:${item.id}`),
    ).toEqual(expected.map((item) => `${item.kind}:${item.id}`));
    expect(secondBody.next_cursor).toBeNull();

    // 위 단언들은 순서만 본다. 종류는 값으로 따로 확인해야 한다 —
    // 자리표시자 'supply' 를 내려보내면 숙제와 준비물이 같은 값이 된다.
    expect(
      [...firstBody.items, ...secondBody.items]
        .filter((item) => item.kind === "supply")
        .map((item) => item.category)
        .sort(),
    ).toEqual(["general", "homework"]);

    expectError(
      await app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: `/api/v1/updates?filter=important&cursor=${firstBody.next_cursor}`,
      }),
      400,
      "INVALID_CURSOR",
    );

    for (const [filter, predicate] of [
      ["notices", (item: UpdatesItem) => item.kind === "notice" && item.category === "general"],
      ["materials", (item: UpdatesItem) => item.kind === "supply" && item.category === "general"],
      ["important", (item: UpdatesItem) => item.kind === "notice" && item.is_important],
      ["performance", (item: UpdatesItem) => item.category === "performance"],
      ["supplies", (item: UpdatesItem) => item.kind === "supply"],
      ["homework", (item: UpdatesItem) => item.kind === "supply" && item.category === "homework"],
    ] as const) {
      const filtered = await app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: `/api/v1/updates?filter=${filter}`,
      });
      expect(filtered.statusCode).toBe(200);
      const items = (filtered.json() as UpdatesList).items;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every(predicate)).toBe(true);
    }
  });
});
