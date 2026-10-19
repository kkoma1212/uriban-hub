import { createIdempotencyRequestHash, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import type { AppEnvironment } from "../../config/environment.js";
import { ElectionsAccessService } from "../elections.access.service.js";
import { ElectionsService } from "../elections.service.js";
import { electionDatabase } from "./elections-database.js";

const actorId = "9007199254940001",
  classId = "9007199254940002",
  memberId = "9007199254940003";
const electionId = "9007199254940004",
  candidateId = "9007199254940005",
  secondId = "9007199254940006";
const nativeTime = "2026-09-07 04:05:06.123987",
  publicTime = "2026-09-07T04:05:06.123Z";
const config = new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" });
type Row = Record<string, unknown>;
type Step = { sql: RegExp; rows?: Row[]; count?: bigint; insertId?: bigint; error?: Error };
const select = (table: string, rows: Row[] = []): Step => ({
  sql: new RegExp("^select .* from `" + table + "`", "iu"),
  rows,
});
const write = (verb: string, table: string, insertId?: bigint): Step => ({
  sql: new RegExp("^" + verb + " `" + table + "`", "iu"),
  count: 1n,
  ...(insertId === undefined ? {} : { insertId }),
});
const clock = (): Step => ({
  sql: /^SELECT UTC_TIMESTAMP\(6\) AS election_now$/u,
  rows: [{ election_now: nativeTime }],
});
const context = (role = "teacher", extra: Row = {}) => ({
  class_id: classId,
  class_status: "active",
  member_id: memberId,
  role,
  profile_status: role === "teacher" ? "active" : null,
  temporary_password_must_change: role === "teacher" ? 0 : null,
  is_active: 1,
  deleted_at: null,
  display_name: "Teacher",
  ...extra,
});
const election = (extra: Row = {}) => ({
  id: electionId,
  class_id: classId,
  created_by_member_id: memberId,
  created_at: nativeTime,
  opened_at: null,
  closed_at: null,
  published_at: null,
  row_version: "1",
  status: "draft",
  tie_break: "revote",
  tie_break_applied: 0,
  results_visibility: "with_counts",
  winner_candidate_id: null,
  title: "Class election",
  ...extra,
});
const candidates = [
  { id: candidateId, display_name_snapshot: "Student", student_number_snapshot: null },
];
const item = (rows = candidates, total = "0"): Step[] => [
  select("election_candidates", rows),
  select("election_participants", [{ total }]),
];
const actorLock = (role = "teacher"): Step[] => [
  select("users", [{ is_active: 1, deleted_at: null, display_name: "Teacher" }]),
  select("classes", [{ id: classId, status: "active" }]),
  select("class_members", [{ id: memberId, user_id: actorId, role, status: "approved" }]),
  ...(role === "teacher"
    ? [select("teacher_profiles", [{ status: "active", temporary_password_must_change: 0 }])]
    : []),
];
const command = {
  actorUserId: actorId,
  electionId,
  ifMatch: '"1"',
  requestId: "22222222-2222-4222-8222-222222222222",
};
const createCommand = {
  actorUserId: actorId,
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  requestId: command.requestId,
  resultsVisibility: "with_counts" as const,
  tieBreak: "revote" as const,
  title: "Class election",
};

// Native-shaped results through the actual MySQL compiler. These are not live
// database concurrency, constraints or HTTP/session tests.
const opened: { database: Kysely<DB>; steps: Step[] }[] = [];
function harness(steps: Step[], commitError?: Error) {
  const queries: CompiledQuery[] = [],
    events: string[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
          queries.push(query);
          const step = steps.shift();
          expect(step, "unexpected SQL").toBeDefined();
          expect(query.sql).toMatch(step!.sql);
          expect(query.sql).not.toMatch(/::|\bRETURNING\b|\bNULLS LAST\b|\badvisory\b/iu);
          if (step!.error) throw step!.error;
          return {
            rows: step!.rows ?? [],
            ...(step!.count === undefined ? {} : { numAffectedRows: step!.count }),
            ...(step!.insertId === undefined ? {} : { insertId: step!.insertId }),
          } as QueryResult<R>;
        },
        streamQuery: async function* <R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("unused");
        },
      };
    }
    override async beginTransaction(
      _connection?: DatabaseConnection,
      settings: { isolationLevel?: string } = {},
    ) {
      expect([undefined, "read committed"]).toContain(settings.isolationLevel);
      events.push("begin");
    }
    override async commitTransaction() {
      events.push("commit");
      if (commitError) throw commitError;
    }
    override async rollbackTransaction() {
      events.push("rollback");
    }
  }
  const database = new Kysely<DB>({
    dialect: {
      createDriver: () => new Driver(),
      createAdapter: () => new MysqlAdapter(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  });
  const access = new ElectionsAccessService(database, config);
  const result = {
    database,
    access,
    service: new ElectionsService(database, access, config),
    queries,
    events,
    steps,
  };
  opened.push(result);
  return result;
}
afterEach(async () => {
  for (const h of opened.splice(0)) {
    expect(h.steps).toEqual([]);
    await h.database.destroy();
  }
});

function assertPrivateAudit(h: ReturnType<typeof harness>, action: string) {
  const query = h.queries.find((q) => q.sql.startsWith("insert into `audit_logs`"))!;
  expect(query).toBeDefined();
  expect(query.parameters).toEqual([
    action,
    "Teacher",
    memberId,
    "teacher",
    actorId,
    null,
    null,
    classId,
    null,
    command.requestId,
    electionId,
    null,
    "election",
  ]);
  expect(query.sql).not.toContain("created_at");
}

describe("MariaDB election dialect and secrecy", () => {
  it("keeps PG as constructor default and rejects an unknown engine", () => {
    const h = harness([]);
    expect(electionDatabase(h.database)).toEqual({ database: h.database, engine: "postgres" });
    expect(
      () =>
        new ElectionsService(
          h.database,
          h.access,
          new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "unknown" }),
        ),
    ).toThrow("Unsupported database engine");
  });

  it("decodes teacher flags, large IDs, summary dates and native counts; sorts absent student numbers last", async () => {
    const h = harness([
      select("class_members", [context()]),
      select("elections", [election()]),
      ...item(),
    ]);
    const result = await h.service.get({ actorUserId: actorId, electionId });
    expect(result).toMatchObject({
      id: electionId,
      row_version: "1",
      created_at: publicTime,
      closed_at: null,
      participant_count: 0,
    });
    expect(result.candidates).toEqual([
      { id: candidateId, display_name: "Student", student_number: null },
    ]);
    expect(h.queries[2]!.sql).toContain(
      "order by student_number_snapshot IS NULL asc, `student_number_snapshot` asc, `id` asc",
    );
  });

  it.each([
    [{ class_status: "suspended", temporary_password_must_change: 1 }, 423],
    [{ temporary_password_must_change: 1 }, 403],
  ])("preserves access rejection precedence for %j", async (extra, status) => {
    const h = harness([select("class_members", [context("teacher", extra)])]);
    await expect(h.service.list({ actorUserId: actorId })).rejects.toMatchObject({ status });
  });

  it("creates atomically with native insertId, class-scoped idempotency and payload-free audit", async () => {
    const h = harness([
      select("class_members", [context()]),
      { sql: /^SELECT id, request_hash/u },
      { sql: /^INSERT INTO api_idempotency_keys/u, insertId: 9n },
      ...actorLock(),
      write("insert into", "elections", BigInt(electionId)),
      select("elections", [election()]),
      write("insert into", "audit_logs"),
      ...item([], "0"),
      { sql: /^DELETE FROM api_idempotency_keys/u, count: 1n },
      { sql: /^INSERT INTO api_idempotency_keys/u, count: 1n },
    ]);
    const result = await h.service.create(createCommand);
    expect(result.created_at).toBe(publicTime);
    const stored = h.queries.at(-1)!;
    expect(stored.parameters[1]).toContain(classId);
    expect(stored.parameters[4]).toBe(201);
    expect(JSON.parse(stored.parameters[5] as string)).toEqual(result);
    assertPrivateAudit(h, "election.created");
    expect(h.events).toEqual(["begin", "commit"]);
  });

  it("rechecks actor before a Maria idempotency replay without writes or a second authorization transaction", async () => {
    const body = { id: electionId, row_version: "1", created_at: publicTime };
    const hash = createIdempotencyRequestHash({
      body: { results_visibility: "with_counts", tie_break: "revote", title: "Class election" },
      effectiveClassId: classId,
    });
    const h = harness([
      select("class_members", [context()]),
      {
        sql: /^SELECT id, request_hash/u,
        rows: [
          {
            id: "9",
            request_hash: hash,
            response_body_json: JSON.stringify(body),
            response_status: 201,
          },
        ],
      },
      { sql: /^SELECT expires_at > UTC_TIMESTAMP/u, rows: [{ unexpired: 1 }] },
    ]);
    expect(await h.service.create(createCommand)).toEqual(body);
    expect(h.queries.every((q) => /^select/iu.test(q.sql))).toBe(true);
  });

  it("registers a snapshot candidate and initial tally before the version reread and audit", async () => {
    const h = harness([
      select("class_members", [context()]),
      ...actorLock(),
      select("elections", [election()]),
      select("class_members", [
        {
          id: secondId,
          display_name_in_class: "In class",
          display_name: "Account",
          student_number: null,
          is_active: 1,
          deleted_at: null,
        },
      ]),
      select("election_candidates"),
      select("election_candidates", [{ total: "0" }]),
      write("insert into", "election_candidates", BigInt(candidateId)),
      write("insert into", "election_tallies"),
      write("update", "elections"),
      select("elections", [election({ row_version: "2" })]),
      write("insert into", "audit_logs"),
      ...item(),
    ]);
    expect(
      (await h.service.registerCandidate({ ...command, memberId: secondId })).row_version,
    ).toBe("2");
    const insertion = h.queries.find((q) => q.sql.startsWith("insert into `election_candidates`"))!;
    expect(insertion.parameters).toEqual([classId, "In class", electionId, secondId, null]);
    expect(h.queries.slice(1, 4).every((q) => q.sql.endsWith("for update"))).toBe(true);
    assertPrivateAudit(h, "election.candidate_registered");
  });

  it.each(["open", "close"] as const)(
    "%s keeps DB6 from before lock waits and exposes ISO3",
    async (action) => {
      const source = action === "open" ? "draft" : "open",
        target = action === "open" ? "open" : "closed";
      const field = action === "open" ? "opened_at" : "closed_at";
      const h = harness([
        select("class_members", [context()]),
        clock(),
        ...actorLock(),
        select("elections", [election({ status: source })]),
        ...(action === "open" ? [select("election_candidates", [{ total: "2" }])] : []),
        write("update", "elections"),
        select("elections", [election({ status: target, [field]: nativeTime, row_version: "2" })]),
        write("insert into", "audit_logs"),
        ...item(),
      ]);
      const result = await h.service[action](command);
      expect(result[field]).toBe(publicTime);
      expect(h.queries.find((q) => q.sql.startsWith("update `elections`"))!.parameters).toContain(
        nativeTime,
      );
      assertPrivateAudit(h, "election." + (action === "open" ? "opened" : "closed"));
    },
  );

  it("publishes only an eligible tied winner, decoding counts and the applied flag", async () => {
    const counts = [
      { candidate_id: candidateId, vote_count: 2 },
      { candidate_id: secondId, vote_count: 2 },
    ];
    const h = harness([
      select("class_members", [context()]),
      clock(),
      ...actorLock(),
      select("elections", [election({ status: "closed", tie_break: "teacher_decides" })]),
      select("election_tallies", counts),
      write("update", "elections"),
      select("elections", [
        election({
          status: "published",
          published_at: nativeTime,
          tie_break: "teacher_decides",
          tie_break_applied: 1,
          winner_candidate_id: candidateId,
        }),
      ]),
      write("insert into", "audit_logs"),
      ...item(candidates, "4"),
      select("election_tallies", counts),
      select("election_tallies", counts),
    ]);
    const result = await h.service.publish({ ...command, winnerCandidateId: candidateId });
    expect(result).toMatchObject({
      tie_break_applied: true,
      participant_count: 4,
      leading_candidate_ids: [candidateId, secondId],
      winner: { id: candidateId },
    });
    assertPrivateAudit(h, "election.published");
  });

  it("refuses a tied revote rule before any write", async () => {
    const h = harness([
      select("class_members", [context()]),
      clock(),
      ...actorLock(),
      select("elections", [election({ status: "closed" })]),
      select("election_tallies", [
        { candidate_id: candidateId, vote_count: 1 },
        { candidate_id: secondId, vote_count: 1 },
      ]),
    ]);
    await expect(
      h.service.publish({ ...command, winnerCandidateId: candidateId }),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.events).toEqual(["begin", "rollback"]);
  });

  it.each([
    ["teacher", "open", "with_counts"],
    ["student", "published", "winner_only"],
  ])("keeps counts private for %s/%s/%s", async (role, status, visibility) => {
    const counts = [{ candidate_id: candidateId, vote_count: 1 }];
    const h = harness([
      select("class_members", [context(role)]),
      select("elections", [election({ status, results_visibility: visibility })]),
      ...item(candidates, "1"),
      select("election_tallies", counts),
      ...(status === "published" ? [select("election_tallies", counts)] : []),
    ]);
    const result = await h.service.results({ actorUserId: actorId, electionId });
    expect(result.tallies).toBeNull();
    expect(result.leading_candidate_ids).toEqual(status === "published" ? [candidateId] : []);
    expect(typeof result.tie_break_applied).toBe("boolean");
  });

  it("votes with only participation and tally writes, then returns no choice", async () => {
    const h = harness([
      select("class_members", [context("student")]),
      ...actorLock("student"),
      select("elections", [election({ status: "open" })]),
      select("election_candidates", [{ id: candidateId }]),
      select("election_participants"),
      write("insert into", "election_participants"),
      write("update", "election_tallies"),
      select("class_members", [context("student")]),
      select("elections", [election({ status: "open" })]),
      ...item(candidates, "1"),
      select("election_participants", [{ member_id: memberId }]),
    ]);
    const result = await h.service.vote({ actorUserId: actorId, electionId, candidateId });
    expect(Object.keys(result.item!).sort()).toEqual([
      "candidates",
      "has_voted",
      "id",
      "participant_count",
      "status",
      "title",
    ]);
    expect(result.item?.has_voted).toBe(true);
    const writes = h.queries.filter((q) => /^(insert|update)/u.test(q.sql));
    expect(writes).toHaveLength(2);
    expect(writes[0]!.sql).not.toMatch(/candidate|created_at|updated_at/u);
    expect(writes[0]!.parameters).toEqual([classId, electionId, memberId]);
    expect(writes[1]!.parameters).toEqual([electionId, candidateId]);
    expect(h.queries.every((q) => !/audit_logs|idempotency/u.test(q.sql))).toBe(true);
  });

  it("rolls the whole state change back on an injected audit CHECK error without retry", async () => {
    const fault = Object.assign(new Error("synthetic CHECK error"), {
      errno: 4025,
      sqlState: "23000",
    });
    const h = harness([
      select("class_members", [context()]),
      clock(),
      ...actorLock(),
      select("elections", [election({ status: "open" })]),
      write("update", "elections"),
      select("elections", [election({ status: "closed", closed_at: nativeTime })]),
      { ...write("insert into", "audit_logs"), error: fault },
    ]);
    await expect(h.service.close(command)).rejects.toBe(fault);
    expect(h.events).toEqual(["begin", "rollback"]);
  });
});
