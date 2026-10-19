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
import { UnauthenticatedException } from "../auth/auth.errors.js";
import { ResourceVersionChangedException } from "../common/http/if-match.js";
import type { AppEnvironment } from "../config/environment.js";
import { StudentAssessmentsAccessService } from "./student-assessments-access.service.js";
import { StudentAssessmentNotFoundException } from "./student-assessments.errors.js";
import { StudentAssessmentsService } from "./student-assessments.service.js";

const actor = "9007199254740993",
  id = "9007199254740995";
const clock = "2026-09-07 12:00:00.123987";
type Row = Record<string, unknown>;
const record = (extra: Row = {}): Row => ({
  id,
  row_version: "1",
  academic_year: 2026,
  semester: 2,
  assessment_date: "2026-09-07",
  assessment_type: "written",
  subject: "수학",
  title: "평가",
  score_hundredths: 8000,
  max_score_hundredths: 10000,
  memo: null,
  weight_basis_points: null,
  created_at: "2026-09-06 12:00:00.654321",
  updated_at: clock,
  expires_at: "2026-10-07 12:00:00.123987",
  recorded_at: null,
  status: "draft",
  ...extra,
});
const access = (): QueryResult<Row>[] => [
  {
    rows: [{ is_active: 1, deleted_at: null, email_verified_at: null, signup_approved_at: clock }],
  },
  { rows: [{ id: "9007199254740994" }] },
];
const read = (rows: Row[] = [record()]): QueryResult<Row> => ({ rows });
const write = (insertId?: bigint): QueryResult<Row> => ({
  rows: [],
  numAffectedRows: 1n,
  ...(insertId === undefined ? {} : { insertId }),
});
const opened: Kysely<DB>[] = [];

// Actual MySQL compiler and native-shaped rows; no live DB/HTTP claim.
function harness(
  steps: QueryResult<Row>[],
  options: { candidate?: boolean; enabled?: boolean } = {},
) {
  let transactionOpen = false;
  const queries: CompiledQuery[] = [],
    events: string[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
          // Existing native-shaped cases model the uninstalled candidate schema.
          if (query.sql.startsWith("SELECT class_id")) {
            expect(
              transactionOpen,
              "Optional schema probes must precede BEGIN on guarded drivers",
            ).toBe(false);
            if (options.candidate) return { rows: [] };
            throw Object.assign(new Error("Candidate absent"), { code: "ER_BAD_FIELD_ERROR" });
          }
          if (query.sql.startsWith("SELECT retention_purged_at")) {
            expect(transactionOpen, "Retention metadata probes must precede BEGIN").toBe(false);
            return { rows: [] };
          }
          queries.push(query);
          expect(query.sql).not.toMatch(
            /::|\breturning\b|\bclock_timestamp\b|\btransaction_timestamp\b|for update of/iu,
          );
          const result = steps.shift();
          expect(result, query.sql).toBeDefined();
          return result as QueryResult<R>;
        },
        streamQuery: async function* <R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("unused");
        },
      };
    }
    override async beginTransaction() {
      transactionOpen = true;
      events.push("begin");
    }
    override async commitTransaction() {
      transactionOpen = false;
      events.push("commit");
    }
    override async rollbackTransaction() {
      transactionOpen = false;
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
  opened.push(database);
  const selectedConfig = new ConfigService<AppEnvironment, true>({
    DATABASE_ENGINE: "mariadb",
    STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED: options.enabled ?? false,
  });
  const authorization = new StudentAssessmentsAccessService(database, selectedConfig);
  return {
    service: new StudentAssessmentsService(database, authorization, selectedConfig),
    authorization,
    queries,
    events,
    steps,
  };
}
afterEach(async () => {
  for (const database of opened.splice(0)) await database.destroy();
});

describe("MariaDB private student assessments", () => {
  it.each(["class ended", "membership withdrawn"])(
    "rejects a new binding after preliminary authorization when %s wins the lock",
    async (reason) => {
      const h = harness(
        [
          ...access(),
          read([]),
          write(20n),
          ...access(),
          ...(reason === "class ended" ? [read([])] : [read([{ id: "11", name: "반" }]), read([])]),
        ],
        { candidate: true, enabled: true },
      );
      await expect(
        h.service.create({
          actorUserId: actor,
          idempotencyKey: "11111111-1111-4111-8111-111111111111",
          connectionScope: "current_class",
          currentClassId: "11",
          expectedClassId: "11",
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(
        h.queries.some((q) => q.sql.startsWith("insert into `student_assessment_records`")),
      ).toBe(false);
      expect(h.events).toContain("rollback");
      expect(h.steps).toEqual([]);
    },
  );
  it("rejects PATCH when the linked class deadline passes although the personal row is still alive", async () => {
    const h = harness(
      [
        ...access(),
        read(),
        read(),
        read([
          {
            id,
            class_id: "11",
            class_name: "종료 반",
            effective_expires_at: clock,
            alive: 0,
          },
        ]),
      ],
      { candidate: true },
    );
    await expect(
      h.service.update({ actorUserId: actor, assessmentId: id, ifMatch: '\"1\"', memo: "attack" }),
    ).rejects.toBeInstanceOf(StudentAssessmentNotFoundException);
    expect(h.queries.some((q) => q.sql.startsWith("update `student_assessment_records`"))).toBe(
      false,
    );
    expect(h.events).toEqual(["begin", "rollback"]);
    expect(h.steps).toEqual([]);
  });
  it("omits a class-expired record and an absent owner-scoped binding from export", async () => {
    const h = harness(
      [
        ...access(),
        read([
          record({ status: "recorded", title: "expired-secret" }),
          record({ id: "9007199254740996", status: "recorded", title: "missing-secret" }),
        ]),
        read([
          { id, class_id: "11", class_name: "종료 반", effective_expires_at: clock, alive: 0 },
        ]),
      ],
      { candidate: true },
    );
    const csv = await h.service.exportCsv({ actorUserId: actor });
    expect(csv).not.toContain("expired-secret");
    expect(csv).not.toContain("missing-secret");
    expect(h.queries.filter((q) => q.sql.startsWith("SELECT CAST(a.id"))).toHaveLength(1);
    expect(h.steps).toEqual([]);
  });
  it("filters expired class-linked records in one owner-scoped batch before returning the list", async () => {
    const other = "9007199254740996";
    const scope = (recordId: string, alive: number) => ({
      id: recordId,
      class_id: "11",
      class_name: "연결 반",
      effective_expires_at: "2026-09-08 12:00:00.000000",
      alive,
    });
    const h = harness(
      [
        ...access(),
        read([{ server_today: "2026-09-07" }]),
        read([record(), record({ id: other })]),
        read([scope(id, 0), scope(other, 1)]),
      ],
      { candidate: true },
    );
    expect((await h.service.list({ actorUserId: actor })).items.map((row) => row.id)).toEqual([
      other,
    ]);
    const batches = h.queries.filter((q) => q.sql.startsWith("SELECT CAST(a.id"));
    expect(batches).toHaveLength(1);
    expect(batches[0]?.parameters).toEqual([id, other, actor]);
  });
  it("replays the original class binding after the session class and registration flag change", async () => {
    const original = {
      id,
      connection_scope: "current_class",
      class_id: "11",
      class_name: "원래 반",
    };
    const requestHash = createIdempotencyRequestHash({
      body: { connection_scope: "current_class", expected_class_id: "11" },
      effectiveClassId: null,
      optionalFields: [
        "academic_year",
        "assessment_date",
        "assessment_type",
        "max_score_hundredths",
        "memo",
        "score_hundredths",
        "semester",
        "subject",
        "title",
        "weight_basis_points",
      ],
    });
    const h = harness([
      ...access(),
      read([
        {
          id: "55",
          request_hash: requestHash,
          response_body_json: JSON.stringify(original),
          response_status: 201,
        },
      ]),
      read([{ unexpired: 1 }]),
    ]);
    expect(
      await h.service.create({
        actorUserId: actor,
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        connectionScope: "current_class",
        currentClassId: "12",
        expectedClassId: "11",
      }),
    ).toEqual(original);
    expect(h.queries.some((q) => q.sql.includes("insert into"))).toBe(false);
    expect(h.steps).toEqual([]);
  });
  it.each([undefined, "personal"] as const)(
    "preserves the legacy personal request hash for %s",
    async (connectionScope) => {
      const original = { id };
      const requestHash = createIdempotencyRequestHash({
        body: {},
        effectiveClassId: null,
        optionalFields: [
          "academic_year",
          "assessment_date",
          "assessment_type",
          "max_score_hundredths",
          "memo",
          "score_hundredths",
          "semester",
          "subject",
          "title",
          "weight_basis_points",
        ],
      });
      const h = harness([
        ...access(),
        read([
          {
            id: "55",
            request_hash: requestHash,
            response_body_json: JSON.stringify(original),
            response_status: 201,
          },
        ]),
        read([{ unexpired: 1 }]),
      ]);
      expect(
        await h.service.create({
          actorUserId: actor,
          idempotencyKey: "11111111-1111-4111-8111-111111111111",
          ...(connectionScope === undefined ? {} : { connectionScope }),
        }),
      ).toEqual(original);
    },
  );
  it("keeps installed class binding and effective expiry while registration is disabled", async () => {
    const h = harness(
      [
        ...access(),
        read(),
        read([
          {
            id,
            class_id: "11",
            class_name: "연결 반",
            effective_expires_at: "2026-09-08 12:00:00.000000",
            alive: 1,
          },
        ]),
      ],
      { candidate: true },
    );
    expect(await h.service.get(actor, id)).toMatchObject({
      connection_scope: "current_class",
      class_id: "11",
      class_name: "연결 반",
      expires_at: "2026-09-08T12:00:00.000Z",
    });
    expect(h.steps).toEqual([]);
  });
  it("rejects a stale expected class before inserting any assessment", async () => {
    const h = harness([...access(), read([]), write(20n), ...access()], {
      candidate: true,
      enabled: true,
    });
    await expect(
      h.service.create({
        actorUserId: actor,
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        connectionScope: "current_class",
        currentClassId: "12",
        expectedClassId: "11",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      h.queries.some((q) => q.sql.startsWith("insert into `student_assessment_records`")),
    ).toBe(false);
    expect(h.events).toContain("rollback");
  });
  it("creates only the verified session class binding", async () => {
    const scope = {
      id,
      class_id: "11",
      class_name: "연결 반",
      effective_expires_at: "2026-10-07 12:00:00.123987",
      alive: 1,
    };
    const h = harness(
      [
        ...access(),
        read([]),
        write(20n),
        ...access(),
        read([{ id: "11", name: "연결 반" }]),
        read([{ id: "44" }]),
        write(BigInt(id)),
        read(),
        read([scope]),
        write(),
        write(21n),
      ],
      { candidate: true, enabled: true },
    );
    expect(
      await h.service.create({
        actorUserId: actor,
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        connectionScope: "current_class",
        currentClassId: "11",
        expectedClassId: "11",
      }),
    ).toMatchObject({ connection_scope: "current_class", class_id: "11" });
    const insertion = h.queries.find((q) =>
      q.sql.startsWith("insert into `student_assessment_records`"),
    );
    expect(insertion?.sql).toContain("`class_id`");
    expect(insertion?.parameters).toContain("11");
    expect(h.steps).toEqual([]);
  });
  it("reads native dates and 64-bit IDs while filtering every record query by owner and expiry", async () => {
    const h = harness([...access(), read([{ server_today: "2026-09-07" }]), read()]);
    const result = await h.service.list({ actorUserId: actor });
    expect(result.server_today).toBe("2026-09-07");
    expect(result.items[0]).toMatchObject({
      id,
      row_version: "1",
      assessment_date: "2026-09-07",
      updated_at: "2026-09-07T12:00:00.123Z",
      memo: null,
    });
    expect(h.queries.at(-1)!.sql).toContain(
      "`owner_user_id` = ? and `expires_at` > UTC_TIMESTAMP(6)",
    );
    expect(h.queries.at(-1)!.parameters).toEqual([actor]);
    expect(h.steps).toEqual([]);
  });

  it("creates a private record and commits the shared idempotency response without losing insertId", async () => {
    const h = harness([
      ...access(),
      read([]),
      write(20n),
      ...access(),
      write(BigInt(id)),
      read(),
      write(),
      write(21n),
    ]);
    const result = await h.service.create({
      actorUserId: actor,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.id).toBe(id);
    expect(h.events).toEqual(["begin", "commit"]);
    expect(h.queries.at(-1)!.parameters).toContain(JSON.stringify(result));
    expect(h.queries.map((q) => q.sql).join("\n")).not.toContain("audit_logs");
    expect(h.steps).toEqual([]);
  });

  it("uses one DB6 time before locks for completion and its exact 365-day expiry", async () => {
    const recorded = record({
      status: "recorded",
      recorded_at: clock,
      expires_at: "2027-09-07 12:00:00.123987",
      row_version: "2",
    });
    const h = harness([
      read([{ assessment_clock: clock }]),
      ...access(),
      read(),
      read(),
      write(),
      read([recorded]),
    ]);
    const result = await h.service.complete(actor, id, '"1"');
    expect(h.queries[0]!.sql).toBe("SELECT UTC_TIMESTAMP(6) AS assessment_clock");
    expect(h.queries[1]!.sql).toContain("for update");
    expect(h.queries[2]!.sql).toContain("exists (select");
    const update = h.queries.find((q) => q.sql.startsWith("update "))!;
    expect(update.sql).toContain("? + INTERVAL 365 DAY");
    expect(update.parameters.filter((p) => p === clock)).toHaveLength(3);
    expect(result).toMatchObject({
      status: "recorded",
      row_version: "2",
      recorded_at: "2026-09-07T12:00:00.123Z",
      expires_at: "2027-09-07T12:00:00.123Z",
    });
    expect(h.events).toEqual(["begin", "commit"]);
    expect(h.steps).toEqual([]);
  });

  it("rejects a record that expired while waiting for its row lock", async () => {
    const h = harness([...access(), read(), read([])]);
    await expect(
      h.service.update({ actorUserId: actor, assessmentId: id, ifMatch: '"1"', memo: "changed" }),
    ).rejects.toBeInstanceOf(StudentAssessmentNotFoundException);
    expect(h.queries.at(-1)!.sql).toContain("`expires_at` > UTC_TIMESTAMP(6)");
    expect(h.events).toEqual(["begin", "rollback"]);
    expect(h.steps).toEqual([]);
  });

  it("keeps version conflicts and private ownership checks on mutations", async () => {
    const h = harness([...access(), read(), read()]);
    await expect(h.service.delete(actor, id, '"2"')).rejects.toBeInstanceOf(
      ResourceVersionChangedException,
    );
    expect(h.queries.at(-1)!.parameters).toEqual([id, actor]);
    expect(h.events).toEqual(["begin", "rollback"]);
    expect(h.steps).toEqual([]);
  });

  it("updates drafts and deletes them with checked affected-row results", async () => {
    const h = harness([
      ...access(),
      read(),
      read(),
      write(),
      read([record({ row_version: "2", memo: "changed" })]),
      ...access(),
      read([record({ row_version: "2" })]),
      read([record({ row_version: "2" })]),
      write(),
    ]);
    expect(
      await h.service.update({
        actorUserId: actor,
        assessmentId: id,
        ifMatch: '"1"',
        memo: "changed",
      }),
    ).toMatchObject({ row_version: "2", memo: "changed" });
    await h.service.delete(actor, id, '"2"');
    expect(h.queries.find((q) => q.sql.startsWith("update "))!.sql).toContain(
      "UTC_TIMESTAMP(6) + INTERVAL 30 DAY",
    );
    expect(h.events).toEqual(["begin", "commit", "begin", "commit"]);
    expect(h.steps).toEqual([]);
  });

  it("rejects a native inactive account before reading private records", async () => {
    const h = harness([
      read([
        { is_active: 0, deleted_at: null, email_verified_at: clock, signup_approved_at: null },
      ]),
    ]);
    await expect(h.service.get(actor, id)).rejects.toBeInstanceOf(UnauthenticatedException);
    expect(h.queries).toHaveLength(1);
    expect(h.steps).toEqual([]);
  });
});
