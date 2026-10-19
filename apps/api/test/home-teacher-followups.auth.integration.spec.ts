import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../src/app.factory.js";
import { readDatabaseKstToday } from "../src/common/date/database-kst-clock.js";
import { addCalendarDays } from "../src/common/date/kst-date.js";
import { DATABASE, type ClassHubDatabase } from "../src/database/database.module.js";
import { HomeService } from "../src/home/home.service.js";
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

const NOTICE_KEYS = [
  "content_revision",
  "counts",
  "is_important",
  "last_reminder_requested_at",
  "published_at",
  "resource_id",
  "resource_type",
  "title",
];
const SUPPLY_KEYS = [
  /* 2026-08-22 추가: "가져올 것"과 "할 것"을 갈라 부르려면 교사 줄도 분류를 알아야 한다(BLUE-10). */
  "category",
  "content_revision",
  "counts",
  "last_reminder_requested_at",
  "needed_on",
  "resource_id",
  "resource_type",
  "title",
];

let applicationDatabase: ClassHubDatabase;
let fixture: ClassFixture;
let noticeSequence = 0;

async function getHome(actor: ActorFixture) {
  return app.inject({
    headers: actor.headers,
    method: "GET",
    url: "/api/v1/home",
  });
}

async function seedNotice(
  owner: ClassFixture,
  values: Partial<{
    content_revision: number;
    is_important: boolean;
    published_at: Date;
    title: string;
  }> = {},
) {
  return database
    .insertInto("notices")
    .values({
      class_id: owner.classId,
      content: "Synthetic notice content",
      content_revision: values.content_revision,
      created_by_member_id: owner.teacher.memberId!,
      is_important: values.is_important,
      published_at: values.published_at,
      title: values.title ?? `Synthetic notice ${++noticeSequence}`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function seedReminder(
  owner: ClassFixture,
  values: {
    contentRevision: number;
    createdAt: Date;
    noticeId?: string;
    supplyId?: string;
  },
): Promise<void> {
  await database
    .insertInto("in_app_reminder_batches")
    .values({
      class_id: owner.classId,
      content_revision: values.contentRevision,
      created_at: values.createdAt,
      created_by_member_id: owner.teacher.memberId!,
      id: randomUUID(),
      notice_id: values.noticeId,
      supply_id: values.supplyId,
    })
    .execute();
}

function databaseProxy(onSelect: (table: unknown) => void): ClassHubDatabase {
  return new Proxy(applicationDatabase, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === "selectFrom" && typeof value === "function") {
        return (...arguments_: unknown[]) => {
          onSelect(arguments_[0]);
          return Reflect.apply(value, target, arguments_);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ClassHubDatabase;
}

beforeAll(async () => {
  await setupSuppliesHarness();
  applicationDatabase = app.get<ClassHubDatabase>(DATABASE);
}, 120_000);

beforeEach(async () => {
  fixture = await createClassFixture();
});

afterAll(teardownSuppliesHarness, 120_000);

describe("teacher Home follow-up card", () => {
  it("returns only unresolved aggregate counts in the approved priority order without student data", async () => {
    const today = await readDatabaseKstToday(database);
    const tomorrow = addCalendarDays(today, 1);
    const baseTime = Date.now() - 60 * 60 * 1_000;
    const important = await seedNotice(fixture, {
      content_revision: 2,
      is_important: true,
      published_at: new Date(baseTime),
      title: "Important notice",
    });
    const resolved = await seedNotice(fixture, {
      is_important: true,
      published_at: new Date(baseTime + 1_000),
      title: "Resolved important notice",
    });
    const regular = await seedNotice(fixture, {
      published_at: new Date(baseTime + 2_000),
      title: "Regular notice",
    });
    const todaySupply = await seedSupply(fixture, {
      content_revision: 2,
      needed_on: today,
      title: "Today supply",
    });
    const tomorrowSupply = await seedSupply(fixture, {
      needed_on: tomorrow,
      title: "Tomorrow supply",
    });
    const resolvedSupply = await seedSupply(fixture, {
      needed_on: today,
      title: "Resolved today supply",
    });
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
          confirmed_revision: 2,
          first_confirmed_at: now,
          member_id: fixture.students[0].memberId!,
          notice_id: important.id,
        },
        {
          class_id: fixture.classId,
          confirmed_at: now,
          confirmed_revision: 1,
          first_confirmed_at: now,
          member_id: fixture.students[1].memberId!,
          notice_id: important.id,
        },
        ...fixture.students.map((student) => ({
          class_id: fixture.classId,
          confirmed_at: now,
          confirmed_revision: 1,
          first_confirmed_at: now,
          member_id: student.memberId!,
          notice_id: resolved.id,
        })),
      ])
      .execute();
    await database
      .insertInto("supply_checks")
      .values([
        {
          checked_at: now,
          class_id: fixture.classId,
          confirmed_revision: 2,
          is_checked: true,
          member_id: fixture.students[0].memberId!,
          supply_id: todaySupply.id,
          unchecked_at: null,
        },
        {
          checked_at: now,
          class_id: fixture.classId,
          confirmed_revision: 1,
          is_checked: true,
          member_id: fixture.students[1].memberId!,
          supply_id: todaySupply.id,
          unchecked_at: null,
        },
        {
          checked_at: null,
          class_id: fixture.classId,
          confirmed_revision: null,
          is_checked: false,
          member_id: fixture.students[2].memberId!,
          supply_id: todaySupply.id,
          unchecked_at: now,
        },
        ...fixture.students.map((student) => ({
          checked_at: now,
          class_id: fixture.classId,
          confirmed_revision: 1,
          is_checked: true,
          member_id: student.memberId!,
          supply_id: resolvedSupply.id,
          unchecked_at: null,
        })),
      ])
      .execute();

    const currentReminder = new Date("2026-07-24T07:00:00.000Z");
    const supplyReminder = new Date("2026-07-24T07:30:00.000Z");
    await seedReminder(fixture, {
      contentRevision: 2,
      createdAt: new Date("2026-07-24T06:00:00.000Z"),
      noticeId: important.id,
    });
    await seedReminder(fixture, {
      contentRevision: 2,
      createdAt: currentReminder,
      noticeId: important.id,
    });
    await seedReminder(fixture, {
      contentRevision: 1,
      createdAt: new Date("2026-07-24T08:00:00.000Z"),
      noticeId: important.id,
    });
    await seedReminder(fixture, {
      contentRevision: 2,
      createdAt: supplyReminder,
      supplyId: todaySupply.id,
    });

    const response = await getHome(fixture.teacher);
    expect(response.statusCode).toBe(200);
    const home = response.json();
    expect(home.teacher_followups.status).toBe("ok");
    expect(home.teacher_followups.data).toHaveLength(3);
    expect(home.teacher_followups.data.map((item: { title: string }) => item.title)).toEqual([
      "Important notice",
      "Today supply",
      "Tomorrow supply",
    ]);

    const [noticeFollowup, todayFollowup, tomorrowFollowup] = home.teacher_followups.data;
    expect(Object.keys(noticeFollowup).sort()).toEqual([...NOTICE_KEYS].sort());
    expect(noticeFollowup).toMatchObject({
      content_revision: "2",
      counts: {
        confirmed: 1,
        modified_unconfirmed: 1,
        unread: 1,
      },
      is_important: true,
      last_reminder_requested_at: currentReminder.toISOString(),
      resource_id: important.id,
      resource_type: "notice",
    });
    expect(Object.keys(todayFollowup).sort()).toEqual([...SUPPLY_KEYS].sort());
    expect(todayFollowup).toMatchObject({
      content_revision: "2",
      counts: {
        checked: 1,
        modified_unconfirmed: 1,
        unchecked: 1,
      },
      last_reminder_requested_at: supplyReminder.toISOString(),
      needed_on: today,
      resource_id: todaySupply.id,
      resource_type: "supply",
    });
    expect(Object.keys(tomorrowFollowup).sort()).toEqual([...SUPPLY_KEYS].sort());
    expect(tomorrowFollowup).toMatchObject({
      counts: {
        checked: 0,
        modified_unconfirmed: 0,
        unchecked: 3,
      },
      needed_on: tomorrow,
      resource_id: tomorrowSupply.id,
      resource_type: "supply",
    });
    expect(home.teacher_followups.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource_id: regular.id }),
        expect.objectContaining({ resource_id: resolved.id }),
        expect.objectContaining({ resource_id: resolvedSupply.id }),
      ]),
    );
    expect(JSON.stringify(home.teacher_followups)).not.toMatch(
      /display_name|member_id|student_number/u,
    );

    const [noticeDetailResponse, supplyDetailResponse] = await Promise.all([
      app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: `/api/v1/notices/${important.id}/confirmations?state=unread`,
      }),
      app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: `/api/v1/supplies/${todaySupply.id}/checks?state=unchecked`,
      }),
    ]);
    expect(noticeDetailResponse.statusCode).toBe(200);
    expect(supplyDetailResponse.statusCode).toBe(200);
    // 확인 현황 응답에만 '수정 후 재확인' 수가 있다(5167e05). 이 시나리오에는 재확인이 없다.
    expect(noticeDetailResponse.json().counts).toEqual({
      ...noticeFollowup.counts,
      reconfirmed: 0,
    });
    expect(supplyDetailResponse.json().counts).toEqual({ ...todayFollowup.counts, reconfirmed: 0 });

    const studentResponse = await getHome(fixture.students[0]);
    expect(studentResponse.statusCode).toBe(200);
    expect(studentResponse.json().teacher_followups).toBeNull();
  });

  /*
   * 숙제는 준비물과 **같은 표**를 쓰지만 교사가 쫓는 행동이 다르다 — "가져올 것"과
   * "할 것". 후속확인 줄이 분류를 안 실어 보내서 교사 화면이 숙제도 "준비물"이라고
   * 부르고 있었다(2026-08-22 감사 BLUE-10).
   */
  it("tells homework apart from supplies in the teacher followup row", async () => {
    const today = await readDatabaseKstToday(database);
    const homework = await seedSupply(fixture, {
      category: "homework",
      needed_on: today,
      title: "수학 익힘책 3쪽",
    });
    const supply = await seedSupply(fixture, {
      category: "general",
      needed_on: today,
      title: "물감",
    });

    const response = await getHome(fixture.teacher);
    expect(response.statusCode).toBe(200);
    const followups: { category?: string; resource_id: string }[] =
      response.json().teacher_followups?.data ?? [];
    const homeworkRow = followups.find((item) => item.resource_id === String(homework.id));
    const supplyRow = followups.find((item) => item.resource_id === String(supply.id));

    expect(homeworkRow, "숙제가 후속확인에 안 실렸다").toBeDefined();
    expect(supplyRow, "준비물이 후속확인에 안 실렸다").toBeDefined();
    expect(homeworkRow).toMatchObject({ category: "homework", resource_type: "supply" });
    expect(supplyRow).toMatchObject({ category: "general", resource_type: "supply" });
  });

  it("uses a stable published-at then id tie-break and caps the card at three items", async () => {
    const publishedAt = new Date(Date.now() - 60 * 1_000);
    const notices = [];
    for (let index = 0; index < 4; index += 1) {
      notices.push(
        await seedNotice(fixture, {
          is_important: true,
          published_at: publishedAt,
          title: `Tied important ${index}`,
        }),
      );
    }

    const response = await getHome(fixture.teacher);
    expect(response.statusCode).toBe(200);
    const followups = response.json().teacher_followups;
    expect(followups.status).toBe("ok");
    expect(followups.data.map((item: { resource_id: string }) => item.resource_id)).toEqual(
      notices
        .slice(1)
        .reverse()
        .map((notice) => notice.id),
    );
  });

  it("isolates query failure and never runs the teacher aggregate for students", async () => {
    const failingDatabase = databaseProxy((table) => {
      if (table === "notices as followup_notice") {
        throw new Error("simulated follow-up query failure");
      }
    });
    const teacherHome = await new HomeService(failingDatabase, false).getForUser(
      fixture.teacher.userId,
    );
    expect(teacherHome.teacher_followups).toMatchObject({
      data: [],
      error_code: "FOLLOWUP_QUERY_FAILED",
      status: "error",
    });
    expect(teacherHome.notices.status).not.toBe("error");
    expect(teacherHome.supplies.status).not.toBe("error");

    const studentTables: string[] = [];
    const studentHome = await new HomeService(
      databaseProxy((table) => {
        studentTables.push(String(table));
      }),
      false,
    ).getForUser(fixture.students[0].userId);
    expect(studentHome.teacher_followups).toBeNull();
    expect(studentTables.some((table) => table.includes("followup_"))).toBe(false);
  });

  it("publishes the nullable discriminated union without student identity fields", () => {
    const document = createOpenApiDocument(app);
    const schemas = document.components?.schemas;
    const homeSchema = schemas?.HomeResponseDto;
    const noticeSchema = schemas?.TeacherHomeNoticeFollowupResponseDto;
    const supplySchema = schemas?.TeacherHomeSupplyFollowupResponseDto;

    expect(homeSchema).toMatchObject({
      properties: {
        teacher_followups: {
          oneOf: [
            {
              nullable: true,
              properties: {
                data: {
                  items: {
                    discriminator: { propertyName: "resource_type" },
                    oneOf: expect.any(Array),
                  },
                  maxItems: 3,
                },
                status: { enum: ["empty", "ok"] },
              },
            },
            {
              properties: {
                error_code: { enum: ["FOLLOWUP_QUERY_FAILED"] },
                status: { enum: ["error"] },
              },
            },
          ],
        },
      },
      required: expect.arrayContaining(["teacher_followups"]),
    });
    expect(noticeSchema).toMatchObject({
      properties: {
        counts: { $ref: "#/components/schemas/NoticeConfirmationCountsResponseDto" },
        resource_id: { pattern: "^[1-9][0-9]*$" },
        resource_type: { enum: ["notice"] },
      },
      required: expect.arrayContaining(NOTICE_KEYS),
    });
    expect(supplySchema).toMatchObject({
      properties: {
        counts: { $ref: "#/components/schemas/SupplyCheckCountsResponseDto" },
        resource_id: { pattern: "^[1-9][0-9]*$" },
        resource_type: { enum: ["supply"] },
      },
      required: expect.arrayContaining(SUPPLY_KEYS),
    });
    expect(JSON.stringify({ noticeSchema, supplySchema })).not.toMatch(
      /display_name|member_id|student_number/u,
    );
  });
});
