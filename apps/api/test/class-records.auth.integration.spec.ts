import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  app,
  type ClassFixture,
  createClassFixture,
  database,
  setupPollsHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

let fixture: ClassFixture;

function expectError(
  response: { json(): { error: { code: string } }; statusCode: number },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json().error.code).toBe(code);
}

function csvRows(body: string): string[] {
  expect(body.startsWith("\uFEFF")).toBe(true);
  return body.slice(1).trimEnd().split("\r\n");
}

/*
 * 합성 반 하나에 선생님이 쓴 글 종류마다 하나씩 + 지운 공지 + 다른 반 공지를 넣는다.
 * 시각은 UTC로 고정해 한국 시각 변환(+9시간)을 확인한다.
 */
async function seedTeacherContent(owner: ClassFixture): Promise<void> {
  const teacher = owner.teacher.memberId!;
  await database
    .insertInto("notices")
    .values([
      {
        category: "performance",
        class_id: owner.classId,
        content: "1단원 발표",
        created_by_member_id: teacher,
        is_important: true,
        published_at: new Date("2026-10-01T00:30:00Z"),
        title: "=수행평가 안내",
      },
      {
        class_id: owner.classId,
        // 본문 서식 기호(T-RICHTEXT)는 CSV에 넣지 않고 글자만 남긴다 — 아래 기대값은 "내용 안내".
        content: "**내용** ==안내==",
        created_by_member_id: teacher,
        published_at: new Date("2026-10-02T00:00:00Z"),
        title: "고친 공지",
        updated_at: new Date("2026-10-03T05:15:00Z"),
        updated_by_member_id: teacher,
      },
      {
        class_id: owner.classId,
        content: "내용",
        created_by_member_id: teacher,
        deleted_at: new Date(),
        deleted_by_member_id: teacher,
        title: "지운 공지",
      },
      {
        // 지금은 학생이 공지를 쓸 수 없지만, 그런 행이 생겨도 '선생님이 쓴 글만' 원칙이 지켜지는지.
        class_id: owner.classId,
        content: "내용",
        created_by_member_id: owner.students[0].memberId!,
        title: "학생이 쓴 글",
      },
    ])
    .execute();
  await database
    .insertInto("supplies")
    .values({
      category: "homework",
      class_id: owner.classId,
      created_by_member_id: teacher,
      // 준비물·숙제 설명의 서식 기호도 CSV에서 빠진다.
      description: "**3쪽**까지",
      needed_on: "2026-10-24",
      title: "수학 익힘책",
    })
    .execute();
  await database
    .insertInto("schedules")
    .values({
      class_id: owner.classId,
      created_by_member_id: teacher,
      due_date: "2026-10-30",
      schedule_type: "exam",
      subject: "국어",
      title: "중간고사",
    })
    .execute();
  const poll = await database
    .insertInto("polls")
    .values({
      class_id: owner.classId,
      closes_at: new Date("2026-10-02T03:00:00Z"),
      created_at: new Date("2026-10-01T03:00:00Z"),
      created_by_member_id: teacher,
      option_count: 2,
      title: "체험학습 장소",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const options = await database
    .insertInto("poll_options")
    .values([
      { label: "과학관", poll_id: poll.id, position: 1 },
      { label: "미술관", poll_id: poll.id, position: 2 },
    ])
    .returning(["id", "position"])
    .execute();
  const optionAt = (position: number) => options.find((row) => row.position === position)!.id;
  await database
    .insertInto("poll_votes")
    .values([
      {
        class_id: owner.classId,
        member_id: owner.students[0].memberId!,
        option_id: optionAt(1),
        poll_id: poll.id,
      },
      {
        class_id: owner.classId,
        member_id: owner.students[1].memberId!,
        option_id: optionAt(2),
        poll_id: poll.id,
      },
      {
        class_id: owner.classId,
        member_id: owner.students[2].memberId!,
        option_id: optionAt(2),
        poll_id: poll.id,
      },
    ])
    .execute();
}

function expectTeacherRecords(body: string): void {
  const rows = csvRows(body);
  expect(rows[0]).toBe('"종류","제목","내용","날짜","대상","올린 시각","마지막 수정 시각","비고"');
  expect(rows.slice(1)).toEqual([
    `"공지(수행평가)","'=수행평가 안내","1단원 발표","","반 전체","2026-10-01 09:30","","중요"`,
    '"공지","고친 공지","내용 안내","","반 전체","2026-10-02 09:00","2026-10-03 14:15",""',
    expect.stringMatching(
      /^"숙제","수학 익힘책","3쪽까지","2026-10-24","반 전체","\d{4}-\d{2}-\d{2} \d{2}:\d{2}","",""$/u,
    ),
    expect.stringMatching(
      /^"일정\(시험\)","중간고사","","2026-10-30","반 전체","\d{4}-\d{2}-\d{2} \d{2}:\d{2}","","과목: 국어"$/u,
    ),
    '"투표","체험학습 장소","","2026-10-02 12:00","반 전체","2026-10-01 12:00","","1) 과학관 1표 / 2) 미술관 2표 · 참여 3명"',
  ]);
  // 학생 이름·지운 글·다른 반 글은 들어가지 않는다.
  expect(body).not.toMatch(/학생가|학생나|학생다|지운 공지|다른 반 공지|학생이 쓴 글/u);
}

beforeAll(setupPollsHarness, 120_000);

beforeEach(async () => {
  fixture = await createClassFixture();
  await seedTeacherContent(fixture);
  const other = await createClassFixture();
  await database
    .insertInto("notices")
    .values({
      class_id: other.classId,
      content: "내용",
      created_by_member_id: other.teacher.memberId!,
      title: "다른 반 공지",
    })
    .execute();
});

afterAll(teardownSuppliesHarness, 120_000);

describe.sequential("class records CSV (teacher-written content only)", () => {
  it("담임은 지금 반 기록을 받고, 학생·로그인 안 한 사람은 받지 못한다", async () => {
    expectError(
      await app.inject({ method: "GET", url: "/api/v1/classes/current/records.csv" }),
      401,
      "UNAUTHENTICATED",
    );
    expectError(
      await app.inject({
        headers: fixture.students[0].headers,
        method: "GET",
        url: "/api/v1/classes/current/records.csv",
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(
      await app.inject({
        headers: fixture.outsider.headers,
        method: "GET",
        url: "/api/v1/classes/current/records.csv",
      }),
      404,
      "NOT_FOUND",
    );

    const response = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/classes/current/records.csv",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-disposition"]).toMatch(
      /^attachment; filename="class-records\.csv"; filename\*=UTF-8''%EB%B0%98-%EA%B8%B0%EB%A1%9D-\d{4}-\d{2}-\d{2}\.csv$/u,
    );
    expectTeacherRecords(response.body);
  });

  it("반을 끝낸 뒤에는 지난 반 주소로 같은 기록을 받고, 그 반 담임만 받는다", async () => {
    const other = await createClassFixture();
    await database.transaction().execute(async (transaction) => {
      const now = new Date();
      await transaction
        .updateTable("class_members")
        .set({ status: "archived", status_changed_at: now, student_number: null, updated_at: now })
        .where("class_id", "=", fixture.classId)
        .execute();
      await transaction
        .updateTable("classes")
        .set({
          archived_at: sql<Date>`clock_timestamp() - interval '10 days'`,
          archived_by_user_id: fixture.teacher.userId,
          status: "archived",
          updated_at: now,
        })
        .where("id", "=", fixture.classId)
        .executeTakeFirstOrThrow();
    });
    const pastUrl = `/api/v1/past-classes/${fixture.classId}/records.csv`;

    expectError(
      await app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: "/api/v1/classes/current/records.csv",
      }),
      404,
      "NOT_FOUND",
    );
    const response = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: pastUrl,
    });
    expect(response.statusCode, response.body).toBe(200);
    expectTeacherRecords(response.body);

    expectError(
      await app.inject({ headers: fixture.students[0].headers, method: "GET", url: pastUrl }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(
      await app.inject({ headers: other.teacher.headers, method: "GET", url: pastUrl }),
      404,
      "NOT_FOUND",
    );
    expectError(
      await app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: "/api/v1/past-classes/not-a-number/records.csv",
      }),
      404,
      "NOT_FOUND",
    );
  });
});
