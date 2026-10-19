import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { hashPassword } from "../src/auth/password-hasher.js";
import type {
  PollBallotVisibility,
  PollItem,
  PollListResult,
  PollParticipationResult,
  PollResultsPolicy,
} from "../src/polls/polls.types.js";
import {
  app,
  type ClassFixture,
  createClassFixture,
  database,
  setupPollsHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

let fixture: ClassFixture;
let idempotencySequence = 0;

function idempotencyKey(): string {
  idempotencySequence += 1;
  return `30000000-0000-4000-8000-${String(idempotencySequence).padStart(12, "0")}`;
}

function expectError(
  response: { json(): { error: { code: string } }; statusCode: number },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json().error.code).toBe(code);
}

async function createPoll(
  owner: ClassFixture = fixture,
  settings: {
    ballotVisibility?: PollBallotVisibility;
    resultsPolicy?: PollResultsPolicy;
  } = {},
): Promise<PollItem> {
  const response = await app.inject({
    headers: { ...owner.teacher.headers, "idempotency-key": idempotencyKey() },
    method: "POST",
    payload: {
      ...(settings.ballotVisibility === undefined
        ? {}
        : { ballot_visibility: settings.ballotVisibility }),
      closes_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      description: "학생 관계나 인기 평가가 아닌 학급 운영 선택입니다.",
      options: ["창가부터", "복도부터"],
      ...(settings.resultsPolicy === undefined ? {} : { results_policy: settings.resultsPolicy }),
      title: "이번 자리 이동 순서를 골라 주세요",
    },
    url: "/api/v1/polls",
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as PollItem;
}

// polls_closes_at_check는 closes_at을 created_at 기준으로 검사하므로(5분~30일),
// 이미 마감된 투표를 심으려면 created_at도 함께 과거로 둬야 한다.
async function insertClosedPolls(
  count: number,
  minutesAgoFor: (index: number) => number,
): Promise<void> {
  const base = Date.now() - 60 * 60 * 1_000;
  await database
    .insertInto("polls")
    .values(
      Array.from({ length: count }, (_, index) => {
        const closesAt = base - minutesAgoFor(index) * 60_000;
        return {
          class_id: fixture.classId,
          closes_at: new Date(closesAt),
          created_at: new Date(closesAt - 10 * 60_000),
          created_by_member_id: fixture.teacher.memberId!,
          option_count: 2,
          title: `지난 투표 ${String(index).padStart(2, "0")}`,
        };
      }),
    )
    .execute();
}

beforeAll(setupPollsHarness, 120_000);

beforeEach(async () => {
  fixture = await createClassFixture();
});

afterAll(teardownSuppliesHarness, 120_000);

describe.sequential("class polls", () => {
  it("lets the teacher immediately close a new poll, retaining responses and its scheduled deadline", async () => {
    const poll = await createPoll(fixture, { resultsPolicy: "after_close" });
    const vote = await app.inject({
      headers: { ...fixture.students[0].headers, "idempotency-key": idempotencyKey() },
      method: "POST",
      payload: { option_id: poll.options[0]!.id },
      url: `/api/v1/polls/${poll.id}/votes`,
    });
    expect(vote.statusCode, vote.body).toBe(201);
    const closed = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      method: "POST",
      url: `/api/v1/polls/${poll.id}/close`,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.headers.etag).toBe('"2"');
    const result = closed.json() as PollItem;
    expect(result).toMatchObject({
      status: "closed",
      row_version: "2",
      closes_at: poll.closes_at,
      total_vote_count: 1,
    });
    expect(result.closed_at).not.toBeNull();
    expect(
      new Date(result.closed_at!).getTime() - new Date(poll.created_at).getTime(),
    ).toBeLessThan(5 * 60_000);
    expect(result.options.map(({ vote_count }) => vote_count)).toEqual([1, 0]);
    const lateVote = await app.inject({
      headers: { ...fixture.students[1].headers, "idempotency-key": idempotencyKey() },
      method: "POST",
      payload: { option_id: poll.options[1]!.id },
      url: `/api/v1/polls/${poll.id}/votes`,
    });
    expectError(lateVote, 409, "POLL_CLOSED");
    const studentResult = await app.inject({
      headers: fixture.students[1].headers,
      method: "GET",
      url: `/api/v1/polls/${poll.id}`,
    });
    expect(studentResult.json()).toMatchObject({
      status: "closed",
      has_voted: false,
      results_visible: true,
      total_vote_count: 1,
    });
    for (const actor of [fixture.teacher, fixture.students[1]]) {
      const open = await app.inject({
        headers: actor.headers,
        method: "GET",
        url: "/api/v1/polls?scope=open",
      });
      expect(open.json().items.map((item: PollItem) => item.id)).not.toContain(poll.id);
      const past = await app.inject({
        headers: actor.headers,
        method: "GET",
        url: "/api/v1/polls?scope=closed",
      });
      expect(past.json().items.map((item: PollItem) => item.id)).toContain(poll.id);
      const home = await app.inject({ headers: actor.headers, method: "GET", url: "/api/v1/home" });
      expect(home.statusCode, home.body).toBe(200);
      expect(home.json().polls.data.map((item: { id: string }) => item.id)).not.toContain(poll.id);
    }
    const audits = await database
      .selectFrom("audit_logs")
      .select(["action", "before_json", "after_json"])
      .where("target_id", "=", poll.id)
      .where("action", "=", "poll.closed")
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after_json).toMatchObject({ closes_at: result.closed_at, vote_count: 1 });
    expect(JSON.stringify(audits)).not.toMatch(/member_id|option_id/u);
    const participation = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: `/api/v1/polls/${poll.id}/participation`,
    });
    expect(participation.json()).toMatchObject({ voted_count: 1, unvoted_count: 2 });
  });

  it("denies student closure and cross-class teachers without changing the poll or audit", async () => {
    const poll = await createPoll();
    const beforeStudentClose = await database
      .selectFrom("polls")
      .selectAll()
      .where("id", "=", poll.id)
      .executeTakeFirstOrThrow();
    const studentClose = await app.inject({
      headers: { ...fixture.students[0].headers, "if-match": '"1"' },
      method: "POST",
      url: `/api/v1/polls/${poll.id}/close`,
    });
    expectError(studentClose, 403, "ROLE_INSUFFICIENT");
    const foreign = await createClassFixture();
    expectError(
      await app.inject({
        headers: { ...foreign.teacher.headers, "if-match": '"1"' },
        method: "POST",
        url: `/api/v1/polls/${poll.id}/close`,
      }),
      404,
      "NOT_FOUND",
    );
    expect(
      await database
        .selectFrom("polls")
        .selectAll()
        .where("id", "=", poll.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeStudentClose);
    expect(
      await database
        .selectFrom("audit_logs")
        .select("id")
        .where("action", "=", "poll.closed")
        .where("target_id", "=", poll.id)
        .execute(),
    ).toEqual([]);
  });

  it("requires authentication, CSRF and a current strong ETag to close", async () => {
    const poll = await createPoll();
    const url = `/api/v1/polls/${poll.id}/close`;
    expectError(
      await app.inject({
        headers: { origin: fixture.teacher.headers.origin! },
        method: "POST",
        url,
      }),
      401,
      "UNAUTHENTICATED",
    );
    const noCsrf = {
      cookie: fixture.teacher.headers.cookie!,
      origin: fixture.teacher.headers.origin!,
      "if-match": '"1"',
    };
    expect((await app.inject({ headers: noCsrf, method: "POST", url })).statusCode).toBe(403);
    expectError(
      await app.inject({ headers: fixture.teacher.headers, method: "POST", url }),
      428,
      "IF_MATCH_REQUIRED",
    );
    expectError(
      await app.inject({
        headers: { ...fixture.teacher.headers, "if-match": 'W/"1"' },
        method: "POST",
        url,
      }),
      400,
      "INVALID_IF_MATCH",
    );
    expectError(
      await app.inject({
        headers: { ...fixture.teacher.headers, "if-match": '"2"' },
        method: "POST",
        url,
      }),
      409,
      "RESOURCE_VERSION_CHANGED",
    );
    expect(
      (
        await database
          .selectFrom("polls")
          .select("closed_at")
          .where("id", "=", poll.id)
          .executeTakeFirstOrThrow()
      ).closed_at,
    ).toBeNull();
  });

  it("closes once during duplicate requests and treats an already closed current version as a no-op", async () => {
    const poll = await createPoll();
    const request = {
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      method: "POST" as const,
      url: `/api/v1/polls/${poll.id}/close`,
    };
    const responses = await Promise.all([app.inject(request), app.inject(request)]);
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    const noop = await app.inject({
      ...request,
      headers: { ...fixture.teacher.headers, "if-match": '"2"' },
    });
    expect(noop.statusCode, noop.body).toBe(200);
    expect(noop.json().closed_at).toBe(
      responses.find(({ statusCode }) => statusCode === 200)!.json().closed_at,
    );
    expect(
      await database
        .selectFrom("audit_logs")
        .select("id")
        .where("action", "=", "poll.closed")
        .where("target_id", "=", poll.id)
        .execute(),
    ).toHaveLength(1);
  });

  it("serializes voting and closure, preserving any vote committed before closure", async () => {
    const poll = await createPoll();
    const [vote, close] = await Promise.all([
      app.inject({
        headers: { ...fixture.students[0].headers, "idempotency-key": idempotencyKey() },
        method: "POST",
        payload: { option_id: poll.options[0]!.id },
        url: `/api/v1/polls/${poll.id}/votes`,
      }),
      app.inject({
        headers: { ...fixture.teacher.headers, "if-match": '"1"' },
        method: "POST",
        url: `/api/v1/polls/${poll.id}/close`,
      }),
    ]);
    expect(close.statusCode, close.body).toBe(200);
    expect([201, 409]).toContain(vote.statusCode);
    if (vote.statusCode === 409) expectError(vote, 409, "POLL_CLOSED");
    expect(close.json().total_vote_count).toBe(vote.statusCode === 201 ? 1 : 0);
    const rows = await database
      .selectFrom("poll_votes")
      .select(["created_at"])
      .where("poll_id", "=", poll.id)
      .execute();
    expect(rows).toHaveLength(vote.statusCode === 201 ? 1 : 0);
  });

  it("rolls closure back when the audit insert fails", async () => {
    const poll = await createPoll();
    await sql`ALTER TABLE audit_logs ADD CONSTRAINT poll_close_qa_fault CHECK (action <> 'poll.closed') NOT VALID`.execute(
      database,
    );
    try {
      const response = await app.inject({
        headers: { ...fixture.teacher.headers, "if-match": '"1"' },
        method: "POST",
        url: `/api/v1/polls/${poll.id}/close`,
      });
      expect(response.statusCode).toBe(500);
      expect(
        await database
          .selectFrom("polls")
          .select(["closed_at", "row_version"])
          .where("id", "=", poll.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ closed_at: null, row_version: "1" });
    } finally {
      await sql`ALTER TABLE audit_logs DROP CONSTRAINT poll_close_qa_fault`.execute(database);
    }
  });

  it("keeps teacher-only results private after manual closure", async () => {
    const poll = await createPoll(fixture, {
      resultsPolicy: "teacher_only",
      ballotVisibility: "private",
    });
    const response = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      method: "POST",
      url: `/api/v1/polls/${poll.id}/close`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = await app.inject({
      headers: fixture.students[0].headers,
      method: "GET",
      url: `/api/v1/polls/${poll.id}`,
    });
    expect(result.json()).toMatchObject({
      status: "closed",
      results_visible: false,
      total_vote_count: null,
    });
    expect((result.json() as PollItem).options.every(({ vote_count }) => vote_count === null)).toBe(
      true,
    );
  });

  it("pages manually closed polls by actual end time with microsecond ties", async () => {
    await insertClosedPolls(3, (i) => i);
    for (let i = 0; i < 53; i++) {
      await database
        .insertInto("polls")
        .values({
          class_id: fixture.classId,
          created_by_member_id: fixture.teacher.memberId!,
          option_count: 2,
          title: `직접 종료 ${i}`,
          created_at: sql<Date>`clock_timestamp() - interval '20 minutes'`,
          closes_at: sql<Date>`clock_timestamp() + interval '1 day'`,
          closed_at: sql<Date>`date_trunc('milliseconds', clock_timestamp() - interval '1 minute') + ${i % 2} * interval '1 microsecond'`,
        })
        .execute();
    }
    const expected = await database
      .selectFrom("polls")
      .select("id")
      .where("class_id", "=", fixture.classId)
      .orderBy(sql`COALESCE(closed_at, closes_at)`, "desc")
      .orderBy("id", "desc")
      .execute();
    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: `/api/v1/polls?scope=closed${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json() as PollListResult;
      collected.push(...page.items.map(({ id }) => id));
      cursor = page.next_cursor;
    } while (cursor !== null && collected.length <= 60);
    expect(collected).toEqual(expected.map(({ id }) => id));
  });

  it("keeps routes authenticated and advertises separate enabled role actions", async () => {
    expectError(
      await app.inject({ method: "GET", url: "/api/v1/polls?scope=open" }),
      401,
      "UNAUTHENTICATED",
    );
    const teacherBootstrap = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/bootstrap",
    });
    const studentBootstrap = await app.inject({
      headers: fixture.students[0].headers,
      method: "GET",
      url: "/api/v1/bootstrap",
    });
    expect(teacherBootstrap.statusCode).toBe(200);
    expect(teacherBootstrap.json().allowed_actions).toContain("MANAGE_POLLS");
    expect(teacherBootstrap.json().allowed_actions).not.toContain("VOTE_IN_POLLS");
    expect(studentBootstrap.statusCode).toBe(200);
    expect(studentBootstrap.json().allowed_actions).toContain("VOTE_IN_POLLS");
    expect(studentBootstrap.json().allowed_actions).not.toContain("MANAGE_POLLS");
  });

  it("allows only the teacher to create and preserves idempotent creation constraints", async () => {
    const studentCreate = await app.inject({
      headers: { ...fixture.students[0].headers, "idempotency-key": idempotencyKey() },
      method: "POST",
      payload: {
        closes_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        options: ["예", "아니요"],
        title: "학생 생성 시도",
      },
      url: "/api/v1/polls",
    });
    expectError(studentCreate, 403, "ROLE_INSUFFICIENT");

    const key = idempotencyKey();
    const payload = {
      closes_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      options: ["첫 번째", "두 번째"],
      title: "학급 행사 시간",
    };
    const first = await app.inject({
      headers: { ...fixture.teacher.headers, "idempotency-key": key },
      method: "POST",
      payload,
      url: "/api/v1/polls",
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.headers.etag).toBe('"1"');
    expect(first.json()).toMatchObject({
      ballot_visibility: "private",
      results_policy: "after_vote",
    });
    const replay = await app.inject({
      headers: { ...fixture.teacher.headers, "idempotency-key": key },
      method: "POST",
      payload,
      url: "/api/v1/polls",
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const explicitDefaultReplay = await app.inject({
      headers: { ...fixture.teacher.headers, "idempotency-key": key },
      method: "POST",
      payload: {
        ...payload,
        ballot_visibility: "private",
        results_policy: "after_vote",
      },
      url: "/api/v1/polls",
    });
    expect(explicitDefaultReplay.statusCode).toBe(201);
    expect(explicitDefaultReplay.json()).toEqual(first.json());

    expectError(
      await app.inject({
        headers: { ...fixture.teacher.headers, "idempotency-key": key },
        method: "POST",
        payload: { ...payload, results_policy: "after_close" },
        url: "/api/v1/polls",
      }),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );

    const duplicate = await app.inject({
      headers: { ...fixture.teacher.headers, "idempotency-key": idempotencyKey() },
      method: "POST",
      payload: {
        closes_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        options: ["같은 선택지", "  같은   선택지  "],
        title: "중복 선택지",
      },
      url: "/api/v1/polls",
    });
    expectError(duplicate, 400, "VALIDATION_FAILED");

    const invalidPolicy = await app.inject({
      headers: { ...fixture.teacher.headers, "idempotency-key": idempotencyKey() },
      method: "POST",
      payload: {
        ...payload,
        ballot_visibility: "student_visible",
        results_policy: "immediate",
      },
      url: "/api/v1/polls",
    });
    expectError(invalidPolicy, 400, "VALIDATION_FAILED");

    const tooSoon = await app.inject({
      headers: { ...fixture.teacher.headers, "idempotency-key": idempotencyKey() },
      method: "POST",
      payload: {
        closes_at: new Date(Date.now() + 4 * 60 * 1_000).toISOString(),
        options: ["예", "아니요"],
        title: "너무 빠른 마감",
      },
      url: "/api/v1/polls",
    });
    expectError(tooSoon, 400, "VALIDATION_FAILED");
  });

  it("hides private live results until closure, keeps one immutable choice, and separates participation", async () => {
    const poll = await createPoll();
    const studentA = fixture.students[0];
    const studentB = fixture.students[1];

    const hiddenResponse = await app.inject({
      headers: studentA.headers,
      method: "GET",
      url: `/api/v1/polls/${poll.id}`,
    });
    expect(hiddenResponse.statusCode).toBe(200);
    const hidden = hiddenResponse.json() as PollItem;
    expect(hidden).toMatchObject({
      ballot_visibility: "private",
      has_voted: false,
      my_option_id: null,
      results_policy: "after_vote",
      results_visible: false,
      total_vote_count: null,
    });
    expect(hidden.options.every(({ vote_count }) => vote_count === null)).toBe(true);

    const voteKey = idempotencyKey();
    const voteResponse = await app.inject({
      headers: { ...studentA.headers, "idempotency-key": voteKey },
      method: "POST",
      payload: { option_id: poll.options[0]!.id },
      url: `/api/v1/polls/${poll.id}/votes`,
    });
    expect(voteResponse.statusCode, voteResponse.body).toBe(201);
    const voted = voteResponse.json() as PollItem;
    expect(voted).toMatchObject({
      has_voted: true,
      my_option_id: poll.options[0]!.id,
      results_visible: false,
      total_vote_count: null,
    });
    expect(voted.options.map(({ vote_count }) => vote_count)).toEqual([null, null]);

    const replay = await app.inject({
      headers: { ...studentA.headers, "idempotency-key": voteKey },
      method: "POST",
      payload: { option_id: poll.options[0]!.id },
      url: `/api/v1/polls/${poll.id}/votes`,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(voted);

    const changedChoice = await app.inject({
      headers: { ...studentA.headers, "idempotency-key": idempotencyKey() },
      method: "POST",
      payload: { option_id: poll.options[1]!.id },
      url: `/api/v1/polls/${poll.id}/votes`,
    });
    expectError(changedChoice, 409, "POLL_ALREADY_VOTED");

    const otherStudentLive = await app.inject({
      headers: studentB.headers,
      method: "GET",
      url: `/api/v1/polls/${poll.id}`,
    });
    expect(otherStudentLive.statusCode).toBe(200);
    expect(otherStudentLive.json()).toMatchObject({
      results_visible: false,
      total_vote_count: null,
    });

    const studentParticipation = await app.inject({
      headers: studentA.headers,
      method: "GET",
      url: `/api/v1/polls/${poll.id}/participation`,
    });
    expectError(studentParticipation, 403, "ROLE_INSUFFICIENT");
    const teacherParticipation = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: `/api/v1/polls/${poll.id}/participation`,
    });
    expect(teacherParticipation.statusCode).toBe(200);
    const participation = teacherParticipation.json() as PollParticipationResult;
    expect(participation).toMatchObject({
      ballot_visibility: "private",
      poll_id: poll.id,
      total_students: 3,
      unvoted_count: 2,
      voted_count: 1,
    });
    expect(participation.voted_students.map(({ member_id }) => member_id)).toEqual([
      studentA.memberId,
    ]);
    expect(teacherParticipation.body).not.toContain("option_id");

    await database
      .updateTable("polls")
      .set({
        closes_at: sql<Date>`clock_timestamp() - interval '1 minute'`,
        created_at: sql<Date>`clock_timestamp() - interval '10 minutes'`,
      })
      .where("id", "=", poll.id)
      .execute();
    const closedForUnvoted = await app.inject({
      headers: studentB.headers,
      method: "GET",
      url: `/api/v1/polls/${poll.id}`,
    });
    expect(closedForUnvoted.statusCode).toBe(200);
    expect(closedForUnvoted.json()).toMatchObject({
      has_voted: false,
      results_visible: true,
      status: "closed",
      total_vote_count: 1,
    });
    const closedListResponse = await app.inject({
      headers: studentB.headers,
      method: "GET",
      url: "/api/v1/polls?scope=closed",
    });
    expect(closedListResponse.statusCode).toBe(200);
    const closedList = closedListResponse.json() as PollListResult;
    expect(closedList.items.map(({ id }) => id)).toContain(poll.id);
  });

  it("enforces independent ballot visibility and aggregate result policies", async () => {
    const studentA = fixture.students[0];
    const studentB = fixture.students[1];
    const afterClose = await createPoll(fixture, {
      ballotVisibility: "private",
      resultsPolicy: "after_close",
    });
    const teacherOnly = await createPoll(fixture, {
      ballotVisibility: "private",
      resultsPolicy: "teacher_only",
    });
    const named = await createPoll(fixture, {
      ballotVisibility: "teacher_visible",
      resultsPolicy: "after_vote",
    });

    for (const poll of [afterClose, teacherOnly, named]) {
      const vote = await app.inject({
        headers: { ...studentA.headers, "idempotency-key": idempotencyKey() },
        method: "POST",
        payload: { option_id: poll.options[0]!.id },
        url: `/api/v1/polls/${poll.id}/votes`,
      });
      expect(vote.statusCode, vote.body).toBe(201);
    }

    const afterCloseOpen = await app.inject({
      headers: studentA.headers,
      method: "GET",
      url: `/api/v1/polls/${afterClose.id}`,
    });
    expect(afterCloseOpen.json()).toMatchObject({
      has_voted: true,
      results_policy: "after_close",
      results_visible: false,
      total_vote_count: null,
    });
    expect(
      (afterCloseOpen.json() as PollItem).options.every(({ vote_count }) => vote_count === null),
    ).toBe(true);

    const teacherOnlyOpen = await app.inject({
      headers: studentA.headers,
      method: "GET",
      url: `/api/v1/polls/${teacherOnly.id}`,
    });
    expect(teacherOnlyOpen.json()).toMatchObject({
      results_policy: "teacher_only",
      results_visible: false,
      total_vote_count: null,
    });

    await database
      .updateTable("polls")
      .set({
        closes_at: sql<Date>`clock_timestamp() - interval '1 minute'`,
        created_at: sql<Date>`clock_timestamp() - interval '10 minutes'`,
      })
      .where("id", "in", [afterClose.id, teacherOnly.id])
      .execute();

    const [afterCloseClosed, teacherOnlyClosed, teacherOnlyForTeacher] = await Promise.all([
      app.inject({
        headers: studentB.headers,
        method: "GET",
        url: `/api/v1/polls/${afterClose.id}`,
      }),
      app.inject({
        headers: studentB.headers,
        method: "GET",
        url: `/api/v1/polls/${teacherOnly.id}`,
      }),
      app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: `/api/v1/polls/${teacherOnly.id}`,
      }),
    ]);
    expect(afterCloseClosed.json()).toMatchObject({
      results_visible: true,
      status: "closed",
      total_vote_count: 1,
    });
    expect(teacherOnlyClosed.json()).toMatchObject({
      results_visible: false,
      status: "closed",
      total_vote_count: null,
    });
    expect(teacherOnlyForTeacher.json()).toMatchObject({
      results_visible: true,
      total_vote_count: 1,
    });

    const privateParticipation = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: `/api/v1/polls/${afterClose.id}/participation`,
    });
    expect(privateParticipation.statusCode).toBe(200);
    expect(privateParticipation.body).not.toContain("selected_option");
    expect(privateParticipation.body).not.toContain("option_id");

    const namedParticipation = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: `/api/v1/polls/${named.id}/participation`,
    });
    expect(namedParticipation.statusCode).toBe(200);
    expect(namedParticipation.json()).toMatchObject({
      ballot_visibility: "teacher_visible",
      voted_students: [
        {
          member_id: studentA.memberId,
          selected_option_id: named.options[0]!.id,
          selected_option_label: named.options[0]!.label,
        },
      ],
    });

    const namedForStudent = await app.inject({
      headers: studentB.headers,
      method: "GET",
      url: `/api/v1/polls/${named.id}`,
    });
    expect(namedForStudent.statusCode).toBe(200);
    expect(namedForStudent.body).not.toContain("member_id");
    expect(namedForStudent.body).not.toContain("selected_option");
  });

  it("exposes only open polls on home and keeps them out of the integrated feed", async () => {
    const first = await createPoll();
    const second = await createPoll();
    const third = await createPoll();
    const student = fixture.students[0];
    const vote = await app.inject({
      headers: { ...student.headers, "idempotency-key": idempotencyKey() },
      method: "POST",
      payload: { option_id: first.options[0]!.id },
      url: `/api/v1/polls/${first.id}/votes`,
    });
    expect(vote.statusCode, vote.body).toBe(201);

    const homeResponse = await app.inject({
      headers: student.headers,
      method: "GET",
      url: "/api/v1/home",
    });
    expect(homeResponse.statusCode, homeResponse.body).toBe(200);
    expect(homeResponse.json().polls).toMatchObject({ status: "ok" });
    const homePollIds = (homeResponse.json().polls.data as Array<{ id: string }>).map(
      ({ id }) => id,
    );
    expect(homePollIds).toHaveLength(2);
    expect(homePollIds).toEqual(expect.arrayContaining([second.id, third.id]));
    expect(homePollIds).not.toContain(first.id);

    const teacherHomeResponse = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/home",
    });
    expect(teacherHomeResponse.statusCode, teacherHomeResponse.body).toBe(200);
    expect(teacherHomeResponse.json().polls).toMatchObject({ status: "ok" });
    expect(
      (teacherHomeResponse.json().polls.data as Array<{ id: string }>).map(({ id }) => id),
    ).toEqual([first.id, second.id]);

    /*
     * 통합 알림은 투표를 싣지 않는다(2026-08-18 Hex 결정 — 투표는 투표 화면 한 곳).
     * 아래 둘이 되돌아오는 것을 잡는 덫이다: 「투표」 필터 자체가 사라졌고, 전체
     * 목록에도 투표가 섞이지 않는다.
     */
    const pollFilterResponse = await app.inject({
      headers: student.headers,
      method: "GET",
      url: "/api/v1/updates?filter=polls",
    });
    expect(pollFilterResponse.statusCode, pollFilterResponse.body).toBe(400);

    const allFeedResponse = await app.inject({
      headers: student.headers,
      method: "GET",
      url: "/api/v1/updates?filter=all",
    });
    expect(allFeedResponse.statusCode, allFeedResponse.body).toBe(200);
    const feedItems = allFeedResponse.json().items as Array<{ category: string; kind: string }>;
    expect(feedItems.some(({ kind }) => kind === "poll")).toBe(false);
    expect(feedItems.some(({ category }) => category === "poll")).toBe(false);

    /* 마감한 투표가 사라지는 것은 이제 홈에서 잰다 — 전에는 통합 피드로 재던 계약이다. */
    await database
      .updateTable("polls")
      .set({
        closes_at: sql<Date>`clock_timestamp() - interval '1 minute'`,
        created_at: sql<Date>`clock_timestamp() - interval '10 minutes'`,
      })
      .where("id", "=", second.id)
      .execute();
    const refreshedHome = await app.inject({
      headers: student.headers,
      method: "GET",
      url: "/api/v1/home",
    });
    expect(refreshedHome.statusCode, refreshedHome.body).toBe(200);
    expect(
      (refreshedHome.json().polls.data as Array<{ id: string }>).map(({ id }) => id),
    ).not.toContain(second.id);
  });

  it("returns an empty poll card on teacher home before a poll exists", async () => {
    const response = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/home",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().polls).toEqual({ data: [], status: "empty" });
  });

  it("hard-deletes atomically and account deletion removes a student's vote", async () => {
    const poll = await createPoll();
    const student = fixture.students[0];
    await app.inject({
      headers: { ...student.headers, "idempotency-key": idempotencyKey() },
      method: "POST",
      payload: { option_id: poll.options[0]!.id },
      url: `/api/v1/polls/${poll.id}/votes`,
    });

    const studentDelete = await app.inject({
      headers: { ...student.headers, "if-match": '"1"' },
      method: "DELETE",
      url: `/api/v1/polls/${poll.id}`,
    });
    expectError(studentDelete, 403, "ROLE_INSUFFICIENT");
    const missingIfMatch = await app.inject({
      headers: fixture.teacher.headers,
      method: "DELETE",
      url: `/api/v1/polls/${poll.id}`,
    });
    expectError(missingIfMatch, 428, "IF_MATCH_REQUIRED");
    const deleted = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      method: "DELETE",
      url: `/api/v1/polls/${poll.id}`,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);

    const remaining = await Promise.all([
      database
        .selectFrom("polls")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("id", "=", poll.id)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("poll_options")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("poll_id", "=", poll.id)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("poll_votes")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("poll_id", "=", poll.id)
        .executeTakeFirstOrThrow(),
    ]);
    expect(remaining.map(({ count }) => count)).toEqual(["0", "0", "0"]);
    const audit = await database
      .selectFrom("audit_logs")
      .select(["action", "after_json", "before_json"])
      .where("action", "=", "poll.deleted")
      .where("target_id", "=", poll.id)
      .executeTakeFirstOrThrow();
    expect(audit.action).toBe("poll.deleted");
    expect(JSON.stringify(audit)).not.toMatch(/member_id|option_id/u);

    const retainedPoll = await createPoll();
    const password = "PollPass123";
    await database
      .updateTable("users")
      .set({ password_hash: await hashPassword(password) })
      .where("id", "=", student.userId)
      .execute();
    const retainedVote = await app.inject({
      headers: { ...student.headers, "idempotency-key": idempotencyKey() },
      method: "POST",
      payload: { option_id: retainedPoll.options[0]!.id },
      url: `/api/v1/polls/${retainedPoll.id}/votes`,
    });
    expect(retainedVote.statusCode, retainedVote.body).toBe(201);
    const accountDeletion = await app.inject({
      headers: student.headers,
      method: "POST",
      payload: { confirmation: "탈퇴", current_password: password },
      url: "/api/v1/account/deletion",
    });
    expect(accountDeletion.statusCode, accountDeletion.body).toBe(200);
    const votesAfterDeletion = await database
      .selectFrom("poll_votes")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("member_id", "=", student.memberId!)
      .executeTakeFirstOrThrow();
    expect(votesAfterDeletion.count).toBe("0");
  });

  it("pages through every closed poll instead of stopping at the first fifty", async () => {
    // 50번째 뒤로 잘려 나가던 것이 T-HUB-09다. 마감 시각이 겹치는 구간이 쪽 경계를
    // 가로지르도록 심어 둔다 — 커서가 id 동점 처리를 놓치면 여기서 건너뛰거나 중복된다.
    await insertClosedPolls(55, (index) => (index >= 47 && index <= 53 ? 47 : index));

    // 쪽을 나누지 않은 같은 정렬의 결과가 정답이다. 쪽 나눔이 이것과 어긋나면 실패한다.
    const expected = await database
      .selectFrom("polls")
      .select("id")
      .where("class_id", "=", fixture.classId)
      .where("closes_at", "<=", sql<Date>`clock_timestamp()`)
      .orderBy("closes_at", "desc")
      .orderBy("id", "desc")
      .execute();
    expect(expected.length).toBe(55);

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: `/api/v1/polls?scope=closed${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json() as PollListResult;
      expect(page.items.length).toBeLessThanOrEqual(50);
      collected.push(...page.items.map(({ id }) => id));
      cursor = page.next_cursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 5);

    expect(pages).toBe(2);
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).toEqual(expected.map(({ id }) => id));
  });

  it("refuses a cursor issued for the other scope", async () => {
    await insertClosedPolls(51, (index) => index);
    const closedPage = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/polls?scope=closed",
    });
    const cursor = (closedPage.json() as PollListResult).next_cursor;
    expect(cursor).not.toBeNull();

    // open은 정렬 방향이 반대라 이 커서를 그대로 쓰면 조용히 엉뚱한 쪽을 준다.
    expectError(
      await app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: `/api/v1/polls?scope=open&cursor=${encodeURIComponent(cursor!)}`,
      }),
      400,
      "INVALID_CURSOR",
    );
  });
});
