import { createMariaDbDatabase, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../config/environment.js";
import { decodePollListCursor, encodePollListCursor } from "./polls.cursor.js";
import { isMariaDbPollDuplicate, pollDatabaseEngine } from "./polls.database.js";
import { PollsService } from "./polls.service.js";
import type { CreatePollCommand } from "./polls.types.js";

const actorId = "9007199254741101",
  classId = "9007199254741102",
  memberId = "9007199254741103";
const pollId = "9007199254741200",
  optionId = "9007199254741300";
const now = "2026-09-07 12:00:00.123456",
  closes = "2026-09-07 13:00:00.987654";
const config = new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" });
const command: CreatePollCommand = {
  actorUserId: actorId,
  ballotVisibility: "private",
  closesAt: "2026-09-07T13:00:00.987Z",
  description: "합성 설명",
  idempotencyKey: "b0a9b567-b4de-4f1e-a0c1-696c6c15b080",
  options: ["첫 선택", "둘째 선택"],
  requestId: "00000000-0000-4000-8000-000000000001",
  resultsPolicy: "after_vote",
  title: "합성 투표",
};
type Call = { sql: string; parameters: readonly unknown[] };
type Row = Record<string, unknown>;
const databases: ReturnType<typeof createMariaDbDatabase<DB>>[] = [];

// Real MysqlQueryCompiler + production rollback-only driver. Only wire responses
// are scripted; no database state engine, actual socket, ACL or concurrency claim.
function boundary(role: "teacher" | "student" = "student") {
  const calls: Call[] = [];
  const fixture = {
    role,
    existingVote: false,
    ownVote: false,
    poll: {
      id: pollId,
      class_id: classId,
      ballot_visibility: "private",
      results_policy: "after_vote",
      closed_at: null,
      closes_at: closes,
      created_at: now,
      description: "합성 설명",
      option_count: 2,
      row_version: "1",
      title: "합성 투표",
    } as Row,
    list: undefined as Row[] | undefined,
    participantRows: [] as Row[],
    fail: undefined as ((call: Call) => unknown) | undefined,
  };
  const options = () =>
    [0, 1].map((index) => ({
      id: String(BigInt(optionId) + BigInt(index)),
      label: command.options[index],
      position: index + 1,
      poll_id: pollId,
      vote_count: String(index + 1),
    }));
  const database = createMariaDbDatabase<DB>(
    () => ({
      getConnection(callback) {
        callback(null, {
          query(statement, parameters, reply) {
            const call = { sql: statement, parameters };
            calls.push(call);
            const failure = fixture.fail?.(call);
            if (failure !== undefined) return reply(failure, undefined);
            if (/^(?:SET |ROLLBACK|COMMIT|START TRANSACTION)/u.test(statement))
              return reply(null, { affectedRows: 0, insertId: 0 });
            if (statement.startsWith("update `polls`")) {
              fixture.poll.closed_at = now;
              fixture.poll.row_version = "2";
              return reply(null, { affectedRows: 1, changedRows: 1, insertId: 0 });
            }
            if (/^\s*(?:insert|delete)\b/iu.test(statement))
              return reply(null, {
                affectedRows: 1,
                insertId: statement.includes("`polls`") ? pollId : "9007199254741400",
              });
            if (statement.includes("FROM api_idempotency_keys")) return reply(null, []);
            if (statement.includes("UTC_TIMESTAMP(6) AS now")) return reply(null, [{ now }]);
            if (statement.includes("`profile`.`temporary_password_must_change`"))
              return reply(null, [
                {
                  class_id: classId,
                  class_status: "active",
                  deleted_at: null,
                  display_name: "합성 계정",
                  is_active: 1,
                  member_id: memberId,
                  profile_status: role === "teacher" ? "active" : null,
                  role,
                  temporary_password_must_change: role === "teacher" ? 0 : null,
                },
              ]);
            if (statement.includes("from `users`"))
              return reply(null, [{ deleted_at: null, display_name: "합성 계정", is_active: 1 }]);
            if (statement.includes("from `classes`"))
              return reply(null, [{ id: classId, status: "active" }]);
            if (statement.includes("from `class_members` as `member`"))
              return reply(null, fixture.participantRows);
            if (statement.includes("from `class_members`"))
              return reply(null, [{ id: memberId, role, status: "approved", user_id: actorId }]);
            if (statement.includes("from `teacher_profiles`"))
              return reply(null, [{ status: "active", temporary_password_must_change: 0 }]);
            if (statement.includes("from `polls`"))
              return reply(
                null,
                statement.includes("cursor_closes_at")
                  ? (fixture.list ?? [
                      { ...fixture.poll, cursor_closes_at: "2026-09-07T13:00:00.987654Z" },
                    ])
                  : [fixture.poll],
              );
            if (statement.includes("from `poll_options`")) return reply(null, options());
            if (statement.includes("from `poll_votes`")) {
              if (statement.includes("count(")) return reply(null, [{ vote_count: "3" }]);
              if (statement.includes("select `id`"))
                return reply(null, fixture.existingVote ? [{ id: "91" }] : []);
              return reply(null, fixture.ownVote ? [{ option_id: optionId, poll_id: pollId }] : []);
            }
            reply(new Error("Unexpected synthetic poll SQL"), undefined);
          },
          release: vi.fn(),
          destroy: vi.fn(),
        });
      },
      end: (callback) => callback(null),
    }),
    {
      host: "polls.test.invalid",
      database: "synthetic",
      user: "synthetic_app",
      password: "synthetic",
      sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic",
    },
  );
  databases.push(database);
  return { database, service: new PollsService(database, config), fixture, calls };
}
const business = (calls: Call[]) =>
  calls.filter(({ sql }) => /^(?:\s*SELECT|\s*INSERT|\s*DELETE)/iu.test(sql));
function assertMariaSql(calls: Call[]) {
  for (const call of business(calls)) {
    expect(call.sql).not.toMatch(/::|\breturning\b|pg_advisory|clock_timestamp|to_char/iu);
    expect(call.parameters.some((value) => value instanceof Date)).toBe(false);
  }
}
const duplicate = () =>
  Object.assign(new Error("private SQL diagnostics"), { errno: 1062, sqlState: "23000" });

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

describe("PollsService MariaDB caller", () => {
  it("defaults to PostgreSQL and rejects an invalid engine before acquisition", () => {
    expect(pollDatabaseEngine()).toBe("postgres");
    const h = boundary();
    expect(
      () =>
        new PollsService(
          h.database,
          new ConfigService({ DATABASE_ENGINE: "sqlite" }) as ConfigService<AppEnvironment, true>,
        ),
    ).toThrow("Invalid polls database engine");
    expect(h.calls).toHaveLength(0);
  });

  it("creates with native insert IDs, ordered options, JSON audit and shared Maria idempotency", async () => {
    const h = boundary("teacher");
    h.fixture.poll.closes_at = "2026-09-07 13:00:00.987000";
    const item = await h.service.create(command);
    expect(item).toMatchObject({
      id: pollId,
      ballot_visibility: "private",
      results_policy: "after_vote",
      status: "open",
      row_version: "1",
      results_visible: false,
      total_vote_count: null,
    });
    expect(item.options.map((option) => [option.id, option.position, option.vote_count])).toEqual([
      [optionId, 1, null],
      [String(BigInt(optionId) + 1n), 2, null],
    ]);
    const insert = h.calls.find(({ sql }) => sql.startsWith("insert into `polls`"))!;
    expect(insert.parameters).toContain("2026-09-07 12:00:00.123000");
    expect(insert.parameters).toContain("2026-09-07 13:00:00.987000");
    const audit = h.calls.find(({ sql }) => sql.startsWith("insert into `audit_logs`"))!;
    const encoded = audit.parameters.find(
      (value) => typeof value === "string" && value.startsWith("{"),
    );
    expect(JSON.parse(encoded as string)).toEqual({
      closes_at: "2026-09-07T13:00:00.987Z",
      deleted_at: null,
      option_count: 2,
      poll_id: pollId,
      title: "합성 투표",
      vote_count: 0,
    });
    expect(h.calls.some(({ sql }) => sql.includes("INSERT INTO api_idempotency_keys"))).toBe(true);
    expect(h.calls.some(({ sql }) => sql === "COMMIT")).toBe(true);
    const lockOrder = h.calls.filter(({ sql }) => sql.includes("for update")).map(({ sql }) => sql);
    expect(lockOrder[0]).toContain("from `users`");
    expect(lockOrder[1]).toContain("from `classes`");
    expect(lockOrder[2]).toContain("from `class_members`");
    expect(lockOrder[3]).toContain("from `teacher_profiles`");
    assertMariaSql(h.calls);
  });

  it.each(["open", "closed"] as const)(
    "preserves the %s list cursor microseconds and native counts",
    async (scope) => {
      const h = boundary();
      const cursor = encodePollListCursor({
        closesAt: "2026-09-07T13:00:00.987321Z",
        id: pollId,
        scope,
      });
      h.fixture.list = Array.from({ length: 51 }, (_, i) => ({
        ...h.fixture.poll,
        id: String(BigInt(pollId) + BigInt(i)),
        cursor_closes_at: "2026-09-07T13:00:00.987654Z",
      }));
      const result = await h.service.list({ actorUserId: actorId, scope, cursor });
      expect(result.items).toHaveLength(50);
      expect(result.server_now).toBe("2026-09-07T12:00:00.123Z");
      expect(decodePollListCursor(result.next_cursor!, scope)).toEqual({
        closesAt: "2026-09-07T13:00:00.987654Z",
        id: String(BigInt(pollId) + 49n),
        scope,
      });
      const query = h.calls.find(({ sql }) => sql.includes("cursor_closes_at"))!;
      expect(query.sql).toContain("AS DATETIME(6)");
      expect(query.sql).toContain(
        scope === "open"
          ? "order by `closes_at` asc"
          : "order by COALESCE(closed_at, closes_at) desc",
      );
      expect(
        query.parameters.filter((value) => value === "2026-09-07 13:00:00.987321"),
      ).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        results_visible: false,
        total_vote_count: null,
        my_option_id: null,
      });
      expect(result.items[0]!.options.every((option) => option.vote_count === null)).toBe(true);
      assertMariaSql(h.calls);
    },
  );

  it("keeps after-close student results hidden despite an own vote and reveals closed results", async () => {
    const h = boundary();
    h.fixture.ownVote = true;
    h.fixture.poll.results_policy = "after_close";
    const hidden = await h.service.get({ actorUserId: actorId, pollId });
    expect(hidden).toMatchObject({
      has_voted: true,
      my_option_id: optionId,
      results_visible: false,
      total_vote_count: null,
    });
    h.fixture.poll.closes_at = "2026-09-07 11:00:00.123000";
    const closed = await h.service.get({ actorUserId: actorId, pollId });
    expect(closed).toMatchObject({ status: "closed", results_visible: true, total_vote_count: 3 });
    expect(closed.options.map((option) => option.vote_count)).toEqual([1, 2]);
    assertMariaSql(h.calls);
  });

  it.each(["private", "teacher_visible"])(
    "participation keeps %s ballot disclosure and PG null-last order",
    async (visibility) => {
      const h = boundary("teacher");
      h.fixture.poll.ballot_visibility = visibility;
      h.fixture.participantRows = [
        {
          display_name: "계정",
          display_name_in_class: "학생",
          member_id: memberId,
          student_number: null,
          vote_id: "91",
          ...(visibility === "teacher_visible"
            ? { selected_option_id: optionId, selected_option_label: "첫 선택" }
            : {}),
        },
      ];
      const result = await h.service.participation({ actorUserId: actorId, pollId });
      expect(result.voted_students).toEqual([
        {
          display_name: "학생",
          member_id: memberId,
          student_number: null,
          ...(visibility === "teacher_visible"
            ? { selected_option_id: optionId, selected_option_label: "첫 선택" }
            : {}),
        },
      ]);
      const query = h.calls.find(({ sql }) => sql.includes("`vote`.`id` as `vote_id`"))!;
      expect(query.sql).toContain("order by member.student_number IS NULL asc");
      expect(query.sql.includes("selected_option")).toBe(visibility === "teacher_visible");
      assertMariaSql(h.calls);
    },
  );

  it("votes under users/class/member/poll locks without writing ballot data into audits", async () => {
    const h = boundary();
    h.fixture.ownVote = true;
    const item = await h.service.vote({
      actorUserId: actorId,
      pollId,
      optionId,
      idempotencyKey: command.idempotencyKey,
    });
    expect(item).toMatchObject({
      has_voted: true,
      my_option_id: optionId,
      total_vote_count: null,
      results_visible: false,
    });
    const locks = h.calls.filter(({ sql }) => sql.endsWith("for update")).map(({ sql }) => sql);
    expect(locks.at(-1)).toContain("from `polls`");
    expect(locks.at(-1)).toContain("`class_id` = ?");
    expect(h.calls.filter(({ sql }) => sql.startsWith("insert into `poll_votes`"))).toHaveLength(1);
    expect(h.calls.some(({ sql }) => sql.includes("audit_logs"))).toBe(false);
    assertMariaSql(h.calls);
  });

  it.each(["options", "votes"] as const)(
    "only a native duplicate from the %s INSERT maps to the existing public error",
    async (kind) => {
      const h = boundary(kind === "options" ? "teacher" : "student");
      h.fixture.fail = ({ sql }) =>
        sql.startsWith(`insert into \`poll_${kind}\``) ? duplicate() : undefined;
      const operation =
        kind === "options"
          ? h.service.create(command)
          : h.service.vote({
              actorUserId: actorId,
              pollId,
              optionId,
              idempotencyKey: command.idempotencyKey,
            });
      await expect(operation).rejects.toMatchObject({ status: kind === "options" ? 400 : 409 });
      expect(h.calls.filter(({ sql }) => sql === "START TRANSACTION READ WRITE")).toHaveLength(1);
      expect(h.calls.some(({ sql }) => sql === "COMMIT")).toBe(false);
      expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
    },
  );

  it("deletes votes then options then poll and writes count-only audit JSON in the same transaction", async () => {
    const h = boundary("teacher");
    await h.service.delete({
      actorUserId: actorId,
      pollId,
      ifMatch: '"1"',
      requestId: command.requestId,
    });
    const deletions = h.calls
      .filter(({ sql }) => sql.startsWith("delete from"))
      .map(({ sql }) => sql);
    expect(deletions.map((statement) => statement.match(/delete from `(\w+)`/u)?.[1])).toEqual([
      "poll_votes",
      "poll_options",
      "polls",
    ]);
    const audit = h.calls.find(({ sql }) => sql.startsWith("insert into `audit_logs`"))!;
    const bodies = audit.parameters
      .filter((value) => typeof value === "string" && value.startsWith("{"))
      .map((value) => JSON.parse(value as string) as Row);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.vote_count).toBe(3);
      expect(Object.keys(body).sort()).toEqual([
        "closes_at",
        "deleted_at",
        "option_count",
        "poll_id",
        "title",
        "vote_count",
      ]);
    }
    expect(h.calls.some(({ sql }) => sql === "COMMIT")).toBe(true);
    assertMariaSql(h.calls);
  });

  it("rolls back a failed audit instead of committing a partially created poll or final replay", async () => {
    const h = boundary("teacher"),
      fault = Object.assign(new Error("private diagnostic"), { errno: 4025, sqlState: "23000" });
    h.fixture.fail = ({ sql }) => (sql.startsWith("insert into `audit_logs`") ? fault : undefined);
    await expect(h.service.create(command)).rejects.toBe(fault);
    expect(h.calls.some(({ sql }) => sql === "COMMIT")).toBe(false);
    expect(
      h.calls.filter(({ sql }) => sql.includes("INSERT INTO api_idempotency_keys")),
    ).toHaveLength(1);
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("uses the shared row lock, narrow update and atomic audit for manual closure", async () => {
    const h = boundary("teacher");
    const result = await h.service.close({
      actorUserId: actorId,
      pollId,
      ifMatch: '"1"',
      requestId: command.requestId,
    });
    expect(result).toMatchObject({
      status: "closed",
      row_version: "2",
      closed_at: "2026-09-07T12:00:00.123Z",
      closes_at: "2026-09-07T13:00:00.987Z",
      total_vote_count: 3,
    });
    const updateIndex = h.calls.findIndex(({ sql }) => sql.startsWith("update `polls`"));
    expect(
      h.calls
        .slice(0, updateIndex)
        .some(({ sql }) => sql.includes("from `polls`") && sql.includes("for update")),
    ).toBe(true);
    expect(h.calls[updateIndex]!.sql).toContain(
      "LEAST(closes_at, GREATEST(created_at, UTC_TIMESTAMP(6)))",
    );
    expect(h.calls.some(({ sql }) => sql.startsWith("delete from"))).toBe(false);
    expect(h.calls.some(({ parameters }) => parameters.includes("poll.closed"))).toBe(true);
    expect(h.calls.some(({ sql }) => sql === "COMMIT")).toBe(true);
    assertMariaSql(h.calls);
  });

  it("rolls back failed close auditing and rejects subsequent votes on manually closed polls", async () => {
    const h = boundary("teacher"),
      fault = new Error("synthetic audit failure");
    h.fixture.fail = ({ sql }) => (sql.startsWith("insert into `audit_logs`") ? fault : undefined);
    await expect(
      h.service.close({
        actorUserId: actorId,
        pollId,
        ifMatch: '"1"',
        requestId: command.requestId,
      }),
    ).rejects.toBe(fault);
    expect(h.calls.some(({ sql }) => sql === "COMMIT")).toBe(false);
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
    const student = boundary();
    student.fixture.poll.closed_at = now;
    await expect(
      student.service.vote({
        actorUserId: actorId,
        pollId,
        optionId,
        idempotencyKey: command.idempotencyKey,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(student.calls.some(({ sql }) => sql.startsWith("insert into `poll_votes`"))).toBe(false);
  });

  it("keeps deadline, duplicate-vote and stale-version failures ahead of writes", async () => {
    const creator = boundary("teacher");
    await expect(
      creator.service.create({ ...command, closesAt: "2026-09-07T12:04:00.000Z" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(creator.calls.some(({ sql }) => sql.startsWith("insert into `polls`"))).toBe(false);
    const voter = boundary();
    voter.fixture.existingVote = true;
    await expect(
      voter.service.vote({
        actorUserId: actorId,
        pollId,
        optionId,
        idempotencyKey: command.idempotencyKey,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(voter.calls.some(({ sql }) => sql.startsWith("insert into `poll_votes`"))).toBe(false);
    const remover = boundary("teacher");
    await expect(
      remover.service.delete({
        actorUserId: actorId,
        pollId,
        ifMatch: '"2"',
        requestId: command.requestId,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(remover.calls.some(({ sql }) => sql.startsWith("delete from"))).toBe(false);
  });

  it("rejects numeric BIGINT rows and untrusted duplicate diagnostics without evaluating accessors", async () => {
    const h = boundary();
    h.fixture.poll.id = Number(pollId);
    await expect(h.service.get({ actorUserId: actorId, pollId })).rejects.toThrow(
      "Invalid MariaDB application value",
    );
    const getter = vi.fn(() => 1062);
    expect(
      isMariaDbPollDuplicate(
        Object.defineProperty({ sqlState: "23000" }, "errno", { get: getter }),
      ),
    ).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    const revoked = Proxy.revocable(duplicate(), {});
    revoked.revoke();
    for (const value of [
      Object.create(duplicate()),
      new Proxy(duplicate(), {}),
      revoked.proxy,
      { errno: "1062", sqlState: "23000" },
      { errno: 1062, sqlState: "45000" },
    ])
      expect(isMariaDbPollDuplicate(value)).toBe(false);
  });
});
