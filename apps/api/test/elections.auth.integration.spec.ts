/*
 * T-HUB-18 2-a — 선거 만들기·조회·후보 등록.
 *
 * 이 스펙이 지키는 것 중 가장 중요한 하나는 **응답이 개인의 선택을 흘리지 않는
 * 것**이다. 스키마가 막아 주더라도 응답에 그런 값을 실으면 클라이언트 로그와
 * 브라우저 기록에 남는다. 그래서 응답 본문의 칸까지 단언한다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  ElectionCurrentResult,
  ElectionItem,
  ElectionListResult,
  ElectionResults,
} from "../src/elections/elections.types.js";
import type { HomeResult as HomeSurface } from "../src/home/home.types.js";
import {
  app,
  createClassFixture,
  database,
  setupElectionsHarness,
  teardownSuppliesHarness,
  type ClassFixture,
} from "./supplies-test-harness.js";

let fixture: ClassFixture;
let keySequence = 4000;

function nextIdempotencyKey(): string {
  keySequence += 1;
  return `40000000-0000-4000-8000-${String(keySequence).padStart(12, "0")}`;
}

function expectError(
  response: { json(): { error: { code: string } }; statusCode: number },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json().error.code).toBe(code);
}

async function createElection(headers: Record<string, string>): Promise<{
  json(): ElectionItem;
  statusCode: number;
  headers: Record<string, unknown>;
}> {
  return app.inject({
    headers: { ...headers, "idempotency-key": nextIdempotencyKey() },
    method: "POST",
    payload: {
      results_visibility: "with_counts",
      tie_break: "revote",
      title: "2학기 반장 선거",
    },
    url: "/api/v1/elections",
  }) as never;
}

beforeAll(async () => {
  await setupElectionsHarness();
  fixture = await createClassFixture();
}, 180_000);

afterAll(async () => {
  await teardownSuppliesHarness();
}, 120_000);

describe("elections HTTP contract", () => {
  it("lets the teacher open an election and never leaks who chose whom", async () => {
    const created = await createElection(fixture.teacher.headers);
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.status).toBe("draft");
    expect(body.tie_break).toBe("revote");
    expect(body.results_visibility).toBe("with_counts");
    expect(body.candidates).toEqual([]);
    expect(body.participant_count).toBe(0);
    expect(created.headers.etag).toBe(`"${body.row_version}"`);

    /*
     * 응답 어디에도 "누가 무엇을" 형태의 칸이 없어야 한다. 칸 이름을 통째로
     * 단언해서, 나중에 누가 편의로 member_id 나 vote 를 얹으면 여기서 걸리게 한다.
     */
    expect(Object.keys(body).sort()).toEqual([
      "candidates",
      "closed_at",
      "created_at",
      "id",
      "opened_at",
      "participant_count",
      "published_at",
      "results_visibility",
      "row_version",
      "status",
      "tie_break",
      "title",
    ]);
  });

  it("keeps students out of the teacher surface", async () => {
    const listed = await app.inject({
      headers: fixture.students[0].headers,
      method: "GET",
      url: "/api/v1/elections",
    });
    expectError(listed as never, 403, "ROLE_INSUFFICIENT");

    const attempted = await createElection(fixture.students[0].headers);
    expectError(attempted as never, 403, "ROLE_INSUFFICIENT");
  });

  it("registers a candidate and bumps the version", async () => {
    const created = await createElection(fixture.teacher.headers);
    const election = created.json();

    const registered = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${election.row_version}"` },
      method: "POST",
      payload: { member_id: fixture.students[0].memberId },
      url: `/api/v1/elections/${election.id}/candidates`,
    });
    expect(registered.statusCode).toBe(201);
    const withCandidate = registered.json() as ElectionItem;
    expect(withCandidate.candidates).toHaveLength(1);
    expect(withCandidate.candidates[0]?.display_name).toBe("학생가");
    expect(withCandidate.row_version).not.toBe(election.row_version);

    // 후보가 생기는 순간 득표 칸도 만들어 둔다 — 투표 때 만들면 그때 경합이 생긴다.
    const tallies = await database
      .selectFrom("election_tallies")
      .select(["vote_count"])
      .where("election_id", "=", election.id)
      .execute();
    expect(tallies).toEqual([{ vote_count: 0 }]);
  });

  it("refuses the same student twice and refuses a stale version", async () => {
    const created = await createElection(fixture.teacher.headers);
    const election = created.json();

    const first = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${election.row_version}"` },
      method: "POST",
      payload: { member_id: fixture.students[1].memberId },
      url: `/api/v1/elections/${election.id}/candidates`,
    });
    expect(first.statusCode).toBe(201);
    const current = first.json() as ElectionItem;

    const duplicate = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${current.row_version}"` },
      method: "POST",
      payload: { member_id: fixture.students[1].memberId },
      url: `/api/v1/elections/${election.id}/candidates`,
    });
    expectError(duplicate as never, 409, "CONFLICT");

    /*
     * 같은 409라도 뜻이 다르다. 중복 후보는 CONFLICT, 낡은 버전은
     * RESOURCE_VERSION_CHANGED다 — 코드까지 봐야 둘을 구분한다.
     */
    const stale = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${election.row_version}"` },
      method: "POST",
      payload: { member_id: fixture.students[2].memberId },
      url: `/api/v1/elections/${election.id}/candidates`,
    });
    expectError(stale as never, 409, "RESOURCE_VERSION_CHANGED");
  });

  it("rejects an outsider as a candidate", async () => {
    const created = await createElection(fixture.teacher.headers);
    const election = created.json();
    const rejected = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${election.row_version}"` },
      method: "POST",
      payload: { member_id: fixture.outsider.memberId },
      url: `/api/v1/elections/${election.id}/candidates`,
    });
    expectError(rejected as never, 400, "VALIDATION_FAILED");
  });

  it("records who ran the election and nothing more", async () => {
    const logged = await database
      .selectFrom("audit_logs")
      .select(["action", "after_json", "before_json", "target_snapshot", "target_type"])
      .where("action", "like", "election.%")
      .orderBy("id", "asc")
      .execute();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.every((row) => row.target_type === "election")).toBe(true);
    // 선거 감사에는 어떤 JSON 도 싣지 않는다 — 개별 선택이 새어 나갈 통로를 막는다.
    expect(
      logged.every(
        (row) =>
          row.after_json === null && row.before_json === null && row.target_snapshot === null,
      ),
    ).toBe(true);
  });

  it("lets students vote once and leaves no trace of the choice", async () => {
    const created = await createElection(fixture.teacher.headers);
    const election = created.json();

    let version = election.row_version;
    const candidateIds: string[] = [];
    for (const student of [fixture.students[0], fixture.students[1]]) {
      const registered = await app.inject({
        headers: { ...fixture.teacher.headers, "if-match": `"${version}"` },
        method: "POST",
        payload: { member_id: student.memberId },
        url: `/api/v1/elections/${election.id}/candidates`,
      });
      const body = registered.json() as ElectionItem;
      version = body.row_version;
      candidateIds.push(body.candidates.at(-1)!.id);
    }

    const opened = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${version}"` },
      method: "POST",
      url: `/api/v1/elections/${election.id}/open`,
    });
    expect(opened.statusCode).toBe(200);

    // 학생이 보는 화면에는 득표 수가 없다 — 진행 중에 보이면 뒤에 찍는 학생이 끌린다.
    const before = await app.inject({
      headers: fixture.students[2].headers,
      method: "GET",
      url: "/api/v1/elections/current",
    });
    const beforeItem = (before.json() as ElectionCurrentResult).item;
    expect(beforeItem?.has_voted).toBe(false);
    expect(Object.keys(beforeItem ?? {}).sort()).toEqual([
      "candidates",
      "has_voted",
      "id",
      "participant_count",
      "status",
      "title",
    ]);

    const voted = await app.inject({
      headers: fixture.students[2].headers,
      method: "POST",
      payload: { candidate_id: candidateIds[0] },
      url: `/api/v1/elections/${election.id}/vote`,
    });
    expect(voted.statusCode).toBe(200);
    expect((voted.json() as ElectionCurrentResult).item?.has_voted).toBe(true);

    const again = await app.inject({
      headers: fixture.students[2].headers,
      method: "POST",
      payload: { candidate_id: candidateIds[1] },
      url: `/api/v1/elections/${election.id}/vote`,
    });
    expectError(again as never, 409, "CONFLICT");

    const tallies = await database
      .selectFrom("election_tallies")
      .select(["candidate_id", "vote_count"])
      .where("election_id", "=", election.id)
      .orderBy("candidate_id", "asc")
      .execute();
    expect(tallies.map((row) => row.vote_count)).toEqual([1, 0]);

    /*
     * 여기가 이 기능의 핵심 계약이다. 표를 던진 학생과 그 학생이 고른 후보를
     * 잇는 값이 DB 어디에도 없어야 한다. 참여 기록에는 후보 칸이 아예 없고,
     * 멱등성 저장소에도 이 투표의 흔적이 없어야 한다(본문 해시로 복원되므로).
     */
    const participants = await database
      .selectFrom("election_participants")
      .selectAll()
      .where("election_id", "=", election.id)
      .execute();
    expect(participants).toEqual([
      {
        class_id: fixture.classId,
        election_id: election.id,
        member_id: fixture.students[2].memberId,
      },
    ]);

    const idempotencyRows = await database
      .selectFrom("api_idempotency_keys")
      .select(["route_key"])
      .where("route_key", "like", "%/elections/%")
      .execute();
    expect(idempotencyRows).toEqual([]);
  });

  it("keeps the teacher out of the ballot box", async () => {
    const listed = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/elections/current",
    });
    expect(listed.statusCode).toBe(200);

    const attempted = await app.inject({
      headers: fixture.teacher.headers,
      method: "POST",
      payload: { candidate_id: "1" },
      url: "/api/v1/elections/1/vote",
    });
    expectError(attempted as never, 403, "ROLE_INSUFFICIENT");
  });

  /** 후보 둘을 세우고 투표까지 열어 둔 선거를 만든다. */
  async function runElectionTo(
    tieBreak: "elder" | "revote" | "teacher_decides",
    visibility: "winner_only" | "with_counts",
  ): Promise<{ candidateIds: string[]; electionId: string; version: string }> {
    const created = await app.inject({
      headers: { ...fixture.teacher.headers, "idempotency-key": nextIdempotencyKey() },
      method: "POST",
      payload: { results_visibility: visibility, tie_break: tieBreak, title: "개표 확인 선거" },
      url: "/api/v1/elections",
    });
    const election = created.json() as ElectionItem;
    let version = election.row_version;
    const candidateIds: string[] = [];
    for (const student of [fixture.students[0], fixture.students[1]]) {
      const registered = await app.inject({
        headers: { ...fixture.teacher.headers, "if-match": `"${version}"` },
        method: "POST",
        payload: { member_id: student.memberId },
        url: `/api/v1/elections/${election.id}/candidates`,
      });
      const body = registered.json() as ElectionItem;
      version = body.row_version;
      candidateIds.push(body.candidates.at(-1)!.id);
    }
    const opened = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${version}"` },
      method: "POST",
      url: `/api/v1/elections/${election.id}/open`,
    });
    return {
      candidateIds,
      electionId: election.id,
      version: (opened.json() as ElectionItem).row_version,
    };
  }

  async function closeElection(electionId: string, version: string): Promise<string> {
    const closed = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${version}"` },
      method: "POST",
      url: `/api/v1/elections/${electionId}/close`,
    });
    expect(closed.statusCode).toBe(200);
    return (closed.json() as ElectionItem).row_version;
  }

  it("shows the published result to a student who opens the page later", async () => {
    /*
     * `current` 는 투표할 수 있는 것을 먼저 준다. 앞 시험들이 열어 둔 선거가 남아 있으면
     * 그게 잡히므로 "지금 열린 것이 없는 교실"을 실제로 만든 뒤에 잰다.
     */
    const listed = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/elections",
    });
    for (const summary of (listed.json() as ElectionListResult).items) {
      if (summary.status === "open") await closeElection(summary.id, summary.row_version);
    }

    const { candidateIds, electionId, version } = await runElectionTo("revote", "with_counts");
    await app.inject({
      headers: fixture.students[2].headers,
      method: "POST",
      payload: { candidate_id: candidateIds[0] },
      url: `/api/v1/elections/${electionId}/vote`,
    });
    const closedVersion = await closeElection(electionId, version);
    const published = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${closedVersion}"` },
      method: "POST",
      payload: {},
      url: `/api/v1/elections/${electionId}/publish`,
    });
    expect(published.statusCode).toBe(200);

    /*
     * 진행 중인 선거가 없다고 학생 화면이 빈손이면 안 된다 — 교사가 "학생에게 공개"를
     * 골랐는데 학생이 볼 길이 없으면 그 설정이 빈말이 된다(2026-08-22 감사 BLUE-09).
     */
    const current = await app.inject({
      headers: fixture.students[2].headers,
      method: "GET",
      url: "/api/v1/elections/current",
    });
    const item = (current.json() as ElectionCurrentResult).item;
    expect(item?.id).toBe(electionId);
    expect(item?.status).toBe("published");

    const seen = await app.inject({
      headers: fixture.students[2].headers,
      method: "GET",
      url: `/api/v1/elections/${electionId}/results`,
    });
    const body = seen.json() as ElectionResults;
    expect(body.winner?.id).toBe(candidateIds[0]);
    expect(body.tallies).not.toBeNull();
  });

  it("keeps mid-vote tallies hidden from the teacher so one vote cannot be traced", async () => {
    const { candidateIds, electionId, version } = await runElectionTo("revote", "with_counts");

    /*
     * 교실은 누가 방금 투표했는지 다 보이는 곳이다. 그래서 진행 중 집계를 한 번이라도
     * 주면 **전후로 두 번 부르는 것만으로** 그 학생의 선택을 알 수 있다. 학생에게
     * "누구를 뽑았는지는 아무도 알 수 없어요. 선생님도"라고 약속했으므로 전후가 같아야 한다.
     * (2026-08-22 감사 BLUE-01 — 이 시험이 없어서 결함이 안 잡혔다.)
     */
    async function readTeacherResults(): Promise<ElectionResults> {
      const response = await app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: `/api/v1/elections/${electionId}/results`,
      });
      expect(response.statusCode).toBe(200);
      return response.json() as ElectionResults;
    }

    const before = await readTeacherResults();
    expect(before.tallies).toBeNull();
    expect(before.leading_candidate_ids).toEqual([]);
    expect(before.participant_count).toBe(0);

    await app.inject({
      headers: fixture.students[2].headers,
      method: "POST",
      payload: { candidate_id: candidateIds[0] },
      url: `/api/v1/elections/${electionId}/vote`,
    });

    const after = await readTeacherResults();
    expect(after.tallies).toBeNull();
    expect(after.leading_candidate_ids).toEqual([]);
    /* 참여자 수는 늘어도 된다 — 학생에게도 보이는 값이고 그것만으로는 선택을 못 알아낸다. */
    expect(after.participant_count).toBe(1);

    /* 마감해야 비로소 개표한다. 여기서도 안 보이면 교사가 일을 못 한다. */
    await closeElection(electionId, version);
    const counted = await readTeacherResults();
    expect(
      counted.tallies?.find((tally) => tally.candidate_id === candidateIds[0])?.vote_count,
    ).toBe(1);
    expect(counted.leading_candidate_ids).toEqual([candidateIds[0]]);
  });

  it("publishes a clear winner and hides counts when the teacher chose winner_only", async () => {
    const { candidateIds, electionId, version } = await runElectionTo("revote", "winner_only");
    await app.inject({
      headers: fixture.students[2].headers,
      method: "POST",
      payload: { candidate_id: candidateIds[0] },
      url: `/api/v1/elections/${electionId}/vote`,
    });
    const closedVersion = await closeElection(electionId, version);

    const published = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${closedVersion}"` },
      method: "POST",
      payload: {},
      url: `/api/v1/elections/${electionId}/publish`,
    });
    expect(published.statusCode).toBe(200);
    const results = published.json() as ElectionResults;
    expect(results.winner?.id).toBe(candidateIds[0]);
    expect(results.tie_break_applied).toBe(false);
    expect(results.tallies).not.toBeNull();

    // 교사는 개표를 위해 득표 수를 보지만, "당선자만 공개"면 학생에게는 안 보인다.
    const studentView = await app.inject({
      headers: fixture.students[2].headers,
      method: "GET",
      url: `/api/v1/elections/${electionId}/results`,
    });
    const studentResults = studentView.json() as ElectionResults;
    expect(studentResults.winner?.id).toBe(candidateIds[0]);
    expect(studentResults.tallies).toBeNull();
  });

  it("refuses to break a tie when the rule says re-vote", async () => {
    const { candidateIds, electionId, version } = await runElectionTo("revote", "with_counts");
    for (const [index, student] of [fixture.students[0], fixture.students[1]].entries()) {
      await app.inject({
        headers: student.headers,
        method: "POST",
        payload: { candidate_id: candidateIds[index] },
        url: `/api/v1/elections/${electionId}/vote`,
      });
    }
    const closedVersion = await closeElection(electionId, version);

    /*
     * 동표인데 재투표 규칙이면 개표로 끝낼 수 없다. 여기서 한 명을 억지로 고르면
     * 선거 만들 때 정한 규칙을 개표하면서 뒤집는 셈이다.
     */
    const published = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${closedVersion}"` },
      method: "POST",
      payload: { winner_candidate_id: candidateIds[0] },
      url: `/api/v1/elections/${electionId}/publish`,
    });
    expectError(published as never, 409, "CONFLICT");
  });

  it("asks the teacher to pick only among the tied candidates", async () => {
    const { candidateIds, electionId, version } = await runElectionTo("elder", "with_counts");
    for (const [index, student] of [fixture.students[0], fixture.students[1]].entries()) {
      await app.inject({
        headers: student.headers,
        method: "POST",
        payload: { candidate_id: candidateIds[index] },
        url: `/api/v1/elections/${electionId}/vote`,
      });
    }
    const closedVersion = await closeElection(electionId, version);

    const withoutChoice = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${closedVersion}"` },
      method: "POST",
      payload: {},
      url: `/api/v1/elections/${electionId}/publish`,
    });
    expectError(withoutChoice as never, 400, "VALIDATION_FAILED");

    const chosen = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${closedVersion}"` },
      method: "POST",
      payload: { winner_candidate_id: candidateIds[1] },
      url: `/api/v1/elections/${electionId}/publish`,
    });
    expect(chosen.statusCode).toBe(200);
    const results = chosen.json() as ElectionResults;
    expect(results.winner?.id).toBe(candidateIds[1]);
    // 동표 절차를 거쳐 정해졌다는 사실이 남아야 한다 — 그래야 결과를 설명할 수 있다.
    expect(results.tie_break_applied).toBe(true);
    expect(results.leading_candidate_ids).toHaveLength(2);
  });

  it("hides results from students until they are published", async () => {
    const { electionId } = await runElectionTo("revote", "with_counts");
    const peeked = await app.inject({
      headers: fixture.students[2].headers,
      method: "GET",
      url: `/api/v1/elections/${electionId}/results`,
    });
    expectError(peeked as never, 404, "NOT_FOUND");
  });

  it("lists the elections it created", async () => {
    const listed = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/elections",
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as ElectionListResult;
    expect(body.items.length).toBeGreaterThanOrEqual(4);
    // 최신이 먼저 온다. 목록에 제목을 고정하지 않는다 — 시험이 늘 때마다 깨진다.
    expect(new Set(body.items.map((item) => item.title))).toEqual(
      new Set(["2학기 반장 선거", "개표 확인 선거"]),
    );
    expect(body.items[0]?.title).toBe("개표 확인 선거");
  });

  /*
   * 2026-08-12: 선거는 API·QA를 다 통과했는데 Hex 는 홈에서 찾지 못했다. 홈의
   * "진행 중인 투표" 칸이 polls 표만 읽고 있었기 때문이다. 기능이 도는 것과
   * 사용자가 찾을 수 있는 것은 다르다 — 그 사이를 이 시험이 지킨다.
   *
   * 투표 중인 것만 싣는다. 발표까지 끝난 선거가 "진행 중"에 남아 있으면 거짓말이다.
   */
  it("puts an open election on the home screen where people look for it", async () => {
    const created = await createElection(fixture.teacher.headers);
    const election = created.json();

    let version = election.row_version;
    for (const student of [fixture.students[0], fixture.students[1]]) {
      const registered = await app.inject({
        headers: { ...fixture.teacher.headers, "if-match": `"${version}"` },
        method: "POST",
        payload: { member_id: student.memberId },
        url: `/api/v1/elections/${election.id}/candidates`,
      });
      version = (registered.json() as ElectionItem).row_version;
    }

    const beforeOpening = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/home",
    });
    const draftEntries = (beforeOpening.json() as HomeSurface).polls?.data ?? [];
    expect(draftEntries.some((entry) => entry.id === election.id)).toBe(false);

    const opened = await app.inject({
      headers: { ...fixture.teacher.headers, "if-match": `"${version}"` },
      method: "POST",
      url: `/api/v1/elections/${election.id}/open`,
    });
    expect(opened.statusCode).toBe(200);

    for (const viewer of [fixture.teacher, fixture.students[2]]) {
      const home = await app.inject({
        headers: viewer.headers,
        method: "GET",
        url: "/api/v1/home",
      });
      expect(home.statusCode).toBe(200);
      const entries = (home.json() as HomeSurface).polls?.data ?? [];
      const mine = entries.find((entry) => entry.id === election.id);
      expect(mine).toBeDefined();
      expect(mine?.kind).toBe("election");
      expect(mine?.title).toBe("2학기 반장 선거");
      /* 선거는 마감 시각이 없다 — 교사가 닫을 때까지 열려 있다. */
      expect(mine?.closes_at).toBeNull();
    }

    /* 아직 아무도 안 찍었으므로 학생은 "참여 필요"로 보여야 한다. */
    const studentHome = await app.inject({
      headers: fixture.students[2].headers,
      method: "GET",
      url: "/api/v1/home",
    });
    const studentEntry = ((studentHome.json() as HomeSurface).polls?.data ?? []).find(
      (entry) => entry.id === election.id,
    );
    expect(studentEntry?.has_voted).toBe(false);
  });
});
