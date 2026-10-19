import { createIdempotencyRequestHash, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../../config/environment.js";
import { SuppliesAccessService } from "../supplies-access.service.js";
import { SuppliesCommandService } from "../supplies-command.service.js";
import { SuppliesQueryService } from "../supplies-query.service.js";
import {
  decodeSupplyChecksCursor,
  decodeSupplyListCursor,
  encodeSupplyChecksCursor,
  encodeSupplyListCursor,
} from "../supplies.cursor.js";
import type { CreateSupplyCommand, UpdateSupplyCommand } from "../supplies.types.js";
import { supplyDatabase } from "./supplies-database.js";
import { InvalidCursorException, SupplyRoleInsufficientException } from "../supplies.errors.js";

const actorId = "9007199255740001",
  memberId = "9007199255740002";
const classId = "9007199255740003",
  supplyId = "9007199255740004";
const revision = "9007199254740993";
const now = "2026-09-07T04:05:06.123Z";
const nativeTime = "2026-09-07 04:05:06.123987";
const config = new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" });
const context = (role = "teacher") => ({
  class_id: classId,
  class_status: "active",
  member_id: memberId,
  role,
  profile_status: role === "teacher" ? "active" : null,
  temporary_password_must_change: role === "teacher" ? 0 : null,
});
const supply = (extra: Record<string, unknown> = {}) => ({
  id: supplyId,
  class_id: classId,
  audience_mode: "legacy_class",
  category: "general",
  content_revision: revision,
  row_version: revision,
  description: null,
  title: "준비물",
  needed_on: "2026-09-07",
  ...extra,
});
type Row = Record<string, unknown>;
type Step = { sql: RegExp; rows?: Row[]; count?: bigint; insertId?: bigint; error?: unknown };
const select = (table: string, rows: Row[] = []): Step => ({
  sql: new RegExp("^select .* from `" + table + "`", "u"),
  rows,
});
const write = (verb: string, table: string, count = 1n, insertId?: bigint): Step => ({
  sql: new RegExp("^" + verb + " `" + table + "`", "u"),
  count,
  ...(insertId === undefined ? {} : { insertId }),
});
const clock = (): Step => ({
  sql: /^select DATE_FORMAT\(UTC_TIMESTAMP\(6\)/u,
  rows: [{ server_today: "2026-09-07" }],
});
const resource = (role = "teacher", row = supply()): Step[] => [
  select("class_members", [context(role)]),
  select("supplies", [row]),
];
const actorLock = (role = "teacher"): Step[] => [
  select("users", [{ is_active: 1, deleted_at: null, display_name: "선생님" }]),
  select("classes", [{ id: classId, status: "active" }]),
  select("class_members", [{ id: memberId, user_id: actorId, role, status: "approved" }]),
  ...(role === "teacher"
    ? [select("teacher_profiles", [{ status: "active", temporary_password_must_change: 0 }])]
    : []),
];
const command = (): CreateSupplyCommand => ({
  actorUserId: actorId,
  audience: { mode: "all", memberIds: [], storedMode: "all_snapshot" },
  category: "general",
  description: null,
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  neededOn: "2026-09-07",
  requestId: "22222222-2222-4222-8222-222222222222",
  title: "준비물",
});
const updateCommand = (extra: Partial<UpdateSupplyCommand> = {}): UpdateSupplyCommand => ({
  actorUserId: actorId,
  supplyId,
  ifMatch: `"${revision}"`,
  title: undefined,
  category: undefined,
  description: undefined,
  neededOn: undefined,
  requestId: command().requestId,
  ...extra,
});

// Real MySQL compiler and result codecs; scripted driver observations prove SQL/order,
// not actual database persistence, row locking, SMTP, or server-side concurrency.
function harness(steps: Step[], commitError?: Error, engine: "mariadb" | "postgres" = "mariadb") {
  const queries: CompiledQuery[] = [],
    events: string[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
          queries.push(query);
          events.push(query.sql.split(/\s/u)[0]!.toLowerCase());
          const next = steps.shift();
          expect(next, "unexpected SQL statement").toBeDefined();
          expect(query.sql).toMatch(next!.sql);
          if (engine === "mariadb")
            expect(query.sql).not.toMatch(/::|\bILIKE\b|\bFILTER\b|NULLS LAST|\bRETURNING\b/iu);
          if (next!.error) throw next!.error;
          return {
            rows: next!.rows ?? [],
            ...(next!.count === undefined ? {} : { numAffectedRows: next!.count }),
            ...(next!.insertId === undefined ? {} : { insertId: next!.insertId }),
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
      expect(
        settings.isolationLevel === undefined || settings.isolationLevel === "read committed",
      ).toBe(true);
      events.push("begin");
    }
    override async commitTransaction() {
      events.push("commit");
      if (commitError) throw commitError;
    }
    override async rollbackTransaction() {
      events.push("rollback");
    }
    override async releaseConnection() {
      events.push("release");
    }
  }
  const database = new Kysely<DB>({
    dialect: {
      createDriver: () => new Driver(),
      createAdapter: () => (engine === "mariadb" ? new MysqlAdapter() : new PostgresAdapter()),
      createIntrospector: (db) =>
        engine === "mariadb" ? new MysqlIntrospector(db) : new PostgresIntrospector(db),
      createQueryCompiler: () =>
        engine === "mariadb" ? new MysqlQueryCompiler() : new PostgresQueryCompiler(),
    },
  });
  const engineConfig = engine === "mariadb" ? config : undefined;
  const access = new SuppliesAccessService(database, engineConfig);
  const audiences = {
    selectedAudienceEnabled: () => true,
    resolveRecipientIds: vi.fn(async () => {
      events.push("resolve_audience");
      return [memberId];
    }),
  };
  const reminders = {
    resolve: vi.fn(async () => {
      events.push("resolve_reminder");
    }),
    create: vi.fn(),
  };
  const query = new SuppliesQueryService(database, access, audiences as never, engineConfig);
  const writeService = new SuppliesCommandService(
    database,
    access,
    audiences as never,
    reminders as never,
    engineConfig,
  );
  return { database, access, audiences, reminders, query, writeService, queries, events, steps };
}

afterEach(() => vi.useRealTimers());

describe("MariaDB supplies access and query", () => {
  describe.each(["mariadb", "postgres"] as const)("personal list states on %s", (engine) => {
    it.each(["unchecked", "modified_unconfirmed", "checked"] as const)(
      "filters %s before pagination while keeping own membership, audience, dates and search",
      async (checkState) => {
        const range = { start_date: "2026-09-07", end_date: "2026-09-13" };
        const checked = checkState !== "unchecked";
        const rows = Array.from({ length: 21 }, (_, index) =>
          supply({
            id: String(BigInt(supplyId) + BigInt(index)),
            category: "homework",
            is_checked: engine === "mariadb" ? Number(checked) : checked,
            confirmed_revision: !checked
              ? null
              : checkState === "checked"
                ? revision
                : String(BigInt(revision) - 1n),
          }),
        );
        const steps: Step[] = [
          { sql: /^select /u, rows: [{ server_today: "2026-09-07" }] },
          { sql: /^select .*class_members/u, rows: [context("student")] },
          { sql: /^select .*supplies/u, rows },
        ];
        const h = harness(steps, undefined, engine);
        const result = await h.query.list({
          actorUserId: actorId,
          scope: "this_week",
          category: "homework",
          search: "수학",
          checkState,
        });
        expect(result.items).toHaveLength(20);
        expect(result.items.every((item) => item.check_state === checkState)).toBe(true);
        expect(
          decodeSupplyListCursor(
            result.next_cursor!,
            "this_week",
            "수학",
            range,
            "homework",
            checkState,
          ).id,
        ).toBe(rows[19]!.id);
        const list = h.queries.at(-1)!;
        const statement = list.sql.replaceAll('"', "").replaceAll("`", "");
        expect(statement).toContain("supply_check.member_id =");
        expect(statement).toContain("supply.deleted_at is null");
        expect(statement).toContain("supply.audience_mode = 'legacy_class'");
        expect(statement).toContain("audience_recipient.class_id = supply.class_id");
        expect(statement).toContain("audience_recipient.member_id =");
        expect(statement).toContain("order by supply.needed_on asc, supply.id asc");
        expect(statement).toContain(
          checkState === "unchecked"
            ? "supply_check.confirmed_revision IS NULL"
            : `supply_check.confirmed_revision ${checkState === "checked" ? "=" : "<>"} supply.content_revision`,
        );
        if (checkState === "unchecked")
          expect(statement).toContain(
            "supply_check.is_checked IS NULL OR supply_check.is_checked = FALSE",
          );
        else expect(statement).toContain("supply_check.is_checked = TRUE");
        expect(list.parameters).toEqual([
          memberId,
          classId,
          "homework",
          "%수학%",
          "%수학%",
          memberId,
          range.start_date,
          range.end_date,
          21,
        ]);
        steps.push(
          { sql: /^select /u, rows: [{ server_today: "2026-09-07" }] },
          { sql: /^select .*class_members/u, rows: [context("student")] },
          { sql: /^select .*supplies/u, rows: [rows[20]!] },
        );
        const continued = await h.query.list({
          actorUserId: actorId,
          scope: "this_week",
          category: "homework",
          search: "수학",
          checkState,
          cursor: result.next_cursor!,
        });
        expect(continued.items.map((item) => item.id)).toEqual([rows[20]!.id]);
        expect(continued.next_cursor).toBeNull();
        expect(h.queries.at(-1)!.parameters.slice(-4)).toEqual([
          range.start_date,
          range.start_date,
          rows[19]!.id,
          21,
        ]);
      },
    );
    it("rejects teacher personal filters before querying supply rows", async () => {
      const h = harness(
        [
          { sql: /^select /u, rows: [{ server_today: "2026-09-07" }] },
          { sql: /^select .*class_members/u, rows: [context()] },
        ],
        undefined,
        engine,
      );
      await expect(
        h.query.list({ actorUserId: actorId, scope: "upcoming", checkState: "unchecked" }),
      ).rejects.toBeInstanceOf(SupplyRoleInsufficientException);
      expect(h.queries).toHaveLength(2);
    });
    it("rejects a cursor from another personal state before querying supply rows", async () => {
      const h = harness(
        [
          { sql: /^select /u, rows: [{ server_today: "2026-09-07" }] },
          { sql: /^select .*class_members/u, rows: [context("student")] },
        ],
        undefined,
        engine,
      );
      const cursor = encodeSupplyListCursor({
        id: "25",
        neededOn: "2026-09-07",
        scope: "upcoming",
        checkState: "checked",
      });
      await expect(
        h.query.list({ actorUserId: actorId, scope: "upcoming", cursor, checkState: "unchecked" }),
      ).rejects.toBeInstanceOf(InvalidCursorException);
      expect(h.queries).toHaveLength(2);
    });
  });

  describe.each(["mariadb", "postgres"] as const)("relative list periods on %s", (engine) => {
    it.each([
      { scope: "today", today: "2026-09-22", start: "2026-09-22", end: "2026-09-22" },
      { scope: "today", today: "2028-02-29", start: "2028-02-29", end: "2028-02-29" },
      { scope: "this_week", today: "2026-09-21", start: "2026-09-21", end: "2026-09-27" },
      { scope: "this_week", today: "2026-09-27", start: "2026-09-21", end: "2026-09-27" },
      { scope: "this_week", today: "2027-01-01", start: "2026-12-28", end: "2027-01-03" },
      { scope: "this_week", today: "2028-02-29", start: "2028-02-28", end: "2028-03-05" },
    ] as const)(
      "combines $scope bounds on $today with student visibility, category and search",
      async ({ scope, today, start, end }) => {
        const h = harness(
          [
            { sql: /^select /u, rows: [{ server_today: today }] },
            { sql: /^select .*class_members/u, rows: [context("student")] },
            {
              sql: /^select .*supplies/u,
              rows: Array.from({ length: 21 }, (_, i) =>
                supply({
                  id: String(BigInt(supplyId) + BigInt(i)),
                  needed_on: start,
                  category: "homework",
                  is_checked: engine === "mariadb" ? (i === 0 ? 1 : 0) : i === 0,
                  confirmed_revision: i === 0 ? revision : null,
                }),
              ),
            },
          ],
          undefined,
          engine,
        );
        const result = await h.query.list({
          actorUserId: actorId,
          scope,
          category: "homework",
          search: " 수학 ",
        });
        const range = { start_date: start, end_date: end };
        expect(result.date_range).toEqual(range);
        expect(result.server_today).toBe(today);
        expect(result.items).toHaveLength(20);
        expect(result.items[0]?.check_state).toBe("checked");
        expect(result.items[1]?.check_state).toBe("unchecked");
        expect(result.selected_audience_enabled).toBe(true);
        const list = h.queries.at(-1)!;
        expect(list.parameters).toEqual([
          memberId,
          classId,
          "homework",
          "%수학%",
          "%수학%",
          memberId,
          start,
          end,
          21,
        ]);
        const statement = list.sql.replaceAll('"', "").replaceAll("`", "");
        expect(statement).toContain("supply.needed_on >=");
        expect(statement).toContain("supply.needed_on <=");
        expect(statement).toContain("supply.deleted_at is null");
        expect(statement).toContain("supply.audience_mode = 'legacy_class'");
        expect(statement).toContain("audience_recipient.class_id = supply.class_id");
        expect(statement).toContain("audience_recipient.member_id =");
        expect(statement).toContain("supply_check.member_id =");
        expect(statement).toContain("order by supply.needed_on asc, supply.id asc");
        expect(
          decodeSupplyListCursor(result.next_cursor!, scope, "수학", range, "homework"),
        ).toMatchObject({
          id: String(BigInt(supplyId) + 19n),
          dateRange: range,
          category: "homework",
        });
      },
    );
  });

  it.each([
    {
      scope: "today",
      today: "2026-09-22",
      range: { start_date: "2026-09-21", end_date: "2026-09-21" },
    },
    {
      scope: "this_week",
      today: "2026-09-28",
      range: { start_date: "2026-09-21", end_date: "2026-09-27" },
    },
  ] as const)(
    "rejects a stale $scope cursor before querying supply rows",
    async ({ scope, today, range }) => {
      const cursor = encodeSupplyListCursor({
        id: "20",
        neededOn: range.start_date,
        scope,
        dateRange: range,
      });
      const h = harness([
        { ...clock(), rows: [{ server_today: today }] },
        select("class_members", [context()]),
      ]);
      await expect(h.query.list({ actorUserId: actorId, scope, cursor })).rejects.toBeInstanceOf(
        InvalidCursorException,
      );
      expect(h.queries).toHaveLength(2);
    },
  );

  it("keeps this-week continuation valid within the week and preserves teacher output", async () => {
    const range = { start_date: "2026-09-21", end_date: "2026-09-27" };
    const cursor = encodeSupplyListCursor({
      id: "20",
      neededOn: range.start_date,
      scope: "this_week",
      dateRange: range,
      category: "homework",
      search: "수학",
    });
    const h = harness([
      { ...clock(), rows: [{ server_today: "2026-09-22" }] },
      select("class_members", [context()]),
      select("supplies", [supply()]),
    ]);
    const result = await h.query.list({
      actorUserId: actorId,
      scope: "this_week",
      cursor,
      category: "homework",
      search: "수학",
    });
    expect(h.queries.at(-1)!.parameters).toEqual([
      memberId,
      classId,
      "homework",
      "%수학%",
      "%수학%",
      range.start_date,
      range.end_date,
      range.start_date,
      range.start_date,
      "20",
      21,
    ]);
    expect(h.queries.at(-1)!.sql).toContain("supply.id >");
    expect(h.queries.at(-1)!.sql).not.toContain("audience_recipient");
    expect(result.items[0]).not.toHaveProperty("check_state");
  });

  it("keeps the default PostgreSQL executor and rejects an unknown engine", () => {
    const h = harness([]);
    expect(supplyDatabase(h.database)).toEqual({ database: h.database, engine: "postgres" });
    expect(
      () =>
        new SuppliesAccessService(
          h.database,
          new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "unknown" }),
        ),
    ).toThrow("Unsupported database engine");
  });
  it("decodes native teacher flags without losing large identity precision", async () => {
    const h = harness([select("class_members", [context()])]);
    expect(await h.access.getCollectionContext(actorId)).toEqual({
      classId,
      memberId,
      role: "teacher",
    });
    expect(h.queries[0]!.parameters).toContain(actorId);
  });
  it.each([
    [{ class_status: "suspended" }, 423],
    [{ class_status: "archived" }, 404],
    [{ temporary_password_must_change: 1 }, 403],
    [{ profile_status: "inactive" }, 403],
  ])("preserves context rejection before resource writes %j", async (change, status) => {
    const h = harness([select("class_members", [{ ...context(), ...change }])]);
    await expect(h.access.getCollectionContext(actorId)).rejects.toMatchObject({ status });
    expect(h.events).not.toContain("begin");
  });
  it("rejects a student outside the captured audience before its history check", async () => {
    const h = harness([
      ...resource("student", supply({ audience_mode: "all_snapshot" })),
      select("supply_recipients"),
    ]);
    await expect(
      h.access.getResourceContext(actorId, supplyId, "2026-09-07"),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.queries.at(-1)!.parameters).toEqual([supplyId, classId, memberId]);
  });
  it("keeps the inclusive 90-day student history boundary with native DATE strings", async () => {
    const h = harness(resource("student", supply({ needed_on: "2026-06-09" })));
    await h.access.getResourceContext(actorId, supplyId, "2026-09-07");
    expect(() =>
      h.access.assertWithinStudentHistoryWindow({ needed_on: "2026-06-08" }, "2026-09-07"),
    ).toThrow();
  });
  it("queries escaped case-insensitive search and produces a lossless list cursor", async () => {
    const rows = Array.from({ length: 21 }, (_, i) =>
      supply({
        id: String(BigInt(supplyId) + BigInt(i)),
        is_checked: i === 0 ? 1 : 0,
        confirmed_revision: i === 0 ? revision : null,
      }),
    );
    const h = harness([
      clock(),
      select("class_members", [context("student")]),
      select("supplies", rows),
    ]);
    const result = await h.query.list({
      actorUserId: actorId,
      scope: "upcoming",
      search: "a%_!\\",
      category: "homework",
    });
    expect(result.items).toHaveLength(20);
    expect(result.items[0]?.check_state).toBe("checked");
    expect(result.items[1]?.check_state).toBe("unchecked");
    expect(decodeSupplyListCursor(result.next_cursor!, "upcoming", "a%_!\\").id).toBe(rows[19]!.id);
    expect(h.queries.at(-1)!.sql).toContain("COLLATE utf8mb4_nopad_bin LIKE LOWER(?) ESCAPE '!'");
    expect(h.queries.at(-1)!.sql).toContain("CAST(? AS DATE)");
    expect(h.queries.at(-1)!.parameters).toContain("%a!%!_!!\\%");
    expect(h.queries.at(-1)!.parameters).toContain("homework");
  });
  it("reads modified-unconfirmed state by exact revision strings", async () => {
    const h = harness([
      clock(),
      ...resource("student"),
      select("supply_checks", [
        { is_checked: 1, confirmed_revision: String(BigInt(revision) - 1n) },
      ]),
    ]);
    expect((await h.query.get({ actorUserId: actorId, supplyId })).check_state).toBe(
      "modified_unconfirmed",
    );
  });
  it("rejects a student checks listing without querying private member details", async () => {
    const h = harness([clock(), ...resource("student")]);
    await expect(
      h.query.listChecks({ actorUserId: actorId, supplyId, state: "unchecked" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(h.steps).toHaveLength(0);
  });
  it("reads revision, counts, page and reminder DB6 in one RC-compatible statement", async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({
      content_revision: revision,
      checked: "2",
      unchecked: "21",
      modified_unconfirmed: "1",
      reconfirmed: "1",
      excluded_member_count: "4",
      requested_at: nativeTime,
      page_member_id: String(BigInt(memberId) + BigInt(i)),
      display_name: `이름${i}`,
      student_number: i === 20 ? null : i + 1,
    }));
    const h = harness([clock(), ...resource(), { sql: /^\s*WITH snapshot_supply/u, rows }]);
    const result = await h.query.listChecks({ actorUserId: actorId, supplyId, state: "unchecked" });
    expect(result.counts).toEqual({
      checked: 2,
      unchecked: 21,
      modified_unconfirmed: 1,
      reconfirmed: 1,
      excluded_member_count: 4,
    });
    expect(result.items).toHaveLength(20);
    expect(result.last_reminder_requested_at).toBe(now);
    expect(decodeSupplyChecksCursor(result.next_cursor!, supplyId, "unchecked").memberId).toBe(
      rows[19]!.page_member_id,
    );
    expect(h.events).not.toContain("begin");
    expect(h.queries.at(-1)!.sql).toContain("LEFT JOIN paged_members");
  });
  it("keeps excluded counts and an empty page using the one-row null sentinel", async () => {
    const h = harness([
      clock(),
      ...resource(),
      {
        sql: /^\s*WITH snapshot_supply/u,
        rows: [
          {
            content_revision: revision,
            checked: "0",
            unchecked: "0",
            modified_unconfirmed: "0",
            reconfirmed: "0",
            excluded_member_count: "3",
            requested_at: null,
            page_member_id: null,
            student_number: null,
            display_name: null,
          },
        ],
      },
    ]);
    const result = await h.query.listChecks({
      actorUserId: actorId,
      supplyId,
      state: "checked",
      cursor: encodeSupplyChecksCursor({
        memberId,
        supplyId,
        state: "checked",
        displayName: "마지막",
        studentNumber: null,
      }),
    });
    expect(result.items).toEqual([]);
    expect(result.counts.excluded_member_count).toBe(3);
    expect(result.next_cursor).toBeNull();
    expect(h.queries.at(-1)!.sql).toContain("student_number IS NULL AND");
  });
  it("returns 404 if the resource disappears before the snapshot SELECT", async () => {
    const h = harness([clock(), ...resource(), { sql: /^\s*WITH snapshot_supply/u, rows: [] }]);
    await expect(
      h.query.listChecks({ actorUserId: actorId, supplyId, state: "checked" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

const reservation = (): Step[] => [
  { sql: /^SELECT id, request_hash/u, rows: [] },
  { sql: /^INSERT INTO api_idempotency_keys/u, count: 1n, insertId: 77n },
];
function createSteps(fault?: Error): Step[] {
  return [
    select("class_members", [context()]),
    ...reservation(),
    ...actorLock(),
    write("insert into", "supplies", 1n, BigInt(supplyId)),
    select("supplies", [supply({ audience_mode: "all_snapshot" })]),
    write("insert into", "supply_recipients"),
    { ...write("insert into", "audit_logs"), ...(fault ? { error: fault } : {}) },
    ...(fault
      ? []
      : [
          { sql: /^DELETE FROM api_idempotency_keys/u, count: 1n },
          { sql: /^INSERT INTO api_idempotency_keys/u, count: 1n },
        ]),
  ];
}

describe("MariaDB supplies transactions", () => {
  it("rechecks an inactive actor under its user lock before recipient resolution or writes", async () => {
    const h = harness([
      select("class_members", [context()]),
      ...reservation(),
      select("users", [{ is_active: 0, deleted_at: null, display_name: "선생님" }]),
    ]);
    await expect(h.writeService.create(command())).rejects.toMatchObject({ status: 401 });
    expect(h.audiences.resolveRecipientIds).not.toHaveBeenCalled();
    expect(h.events).toContain("rollback");
  });
  it("creates with recipient snapshot and JSON audit before the final idempotency row", async () => {
    const h = harness(createSteps());
    const result = await h.writeService.create(command());
    expect(result.id).toBe(supplyId);
    expect(result.needed_on).toBe("2026-09-07");
    expect(h.steps).toHaveLength(0);
    expect(h.events.indexOf("resolve_audience")).toBeLessThan(h.events.lastIndexOf("insert"));
    const audit = h.queries.find((query) => query.sql.startsWith("insert into `audit_logs`"))!;
    const payload = audit.parameters.find(
      (value) => typeof value === "string" && value.startsWith('{"audience_mode"'),
    ) as string;
    expect(JSON.parse(payload)).toEqual({
      audience_mode: "all_snapshot",
      content_revision: revision,
      deleted_at: null,
      needed_on: "2026-09-07",
      recipient_count: 1,
      supply_id: supplyId,
      title: "준비물",
    });
    expect(h.queries.at(-1)!.sql).toMatch(/^INSERT INTO api_idempotency_keys/u);
    expect(h.events).toContain("commit");
    expect(h.events).not.toContain("rollback");
  });
  it("rolls back an audit failure without reaching the final response reservation", async () => {
    const fault = Object.assign(new Error("private SQL payload"), {
      errno: 4025,
      sqlState: "23000",
    });
    const h = harness(createSteps(fault));
    await expect(h.writeService.create(command())).rejects.toBe(fault);
    expect(h.events).toContain("rollback");
    expect(h.events).not.toContain("commit");
    expect(
      h.queries.filter((query) => query.sql.startsWith("INSERT INTO api_idempotency_keys")),
    ).toHaveLength(1);
  });
  it("does not replay the business callback after uncertain COMMIT acknowledgement", async () => {
    const fault = new Error("synthetic commit acknowledgement loss");
    const h = harness(createSteps(), fault);
    await expect(h.writeService.create(command())).rejects.toBe(fault);
    expect(h.audiences.resolveRecipientIds).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event === "begin")).toHaveLength(1);
    expect(h.events.filter((event) => event === "commit")).toHaveLength(1);
  });
  it.each([false, true])(
    "replays or rejects the same key by its full class/category hash (%s)",
    async (mismatch) => {
      const c = command();
      const requestHash = createIdempotencyRequestHash({
        body: {
          audience: { member_ids: [], mode: "all" },
          category: mismatch ? "homework" : c.category,
          description: c.description,
          needed_on: c.neededOn,
          title: c.title,
        },
        effectiveClassId: classId,
      });
      const body = { id: supplyId, row_version: revision };
      const h = harness([
        select("class_members", [context()]),
        {
          sql: /^SELECT id, request_hash/u,
          rows: [
            {
              id: "77",
              request_hash: requestHash,
              response_body_json: JSON.stringify(body),
              response_status: 201,
            },
          ],
        },
        { sql: /^SELECT expires_at > UTC_TIMESTAMP/u, rows: [{ unexpired: 1 }] },
      ]);
      if (mismatch)
        await expect(h.writeService.create(c)).rejects.toMatchObject({
          status: 409,
          response: { code: "IDEMPOTENCY_KEY_REUSED" },
        });
      else expect(await h.writeService.create(c)).toEqual(body);
      expect(h.audiences.resolveRecipientIds).not.toHaveBeenCalled();
      expect(h.queries.every((query) => /^select/iu.test(query.sql))).toBe(true);
    },
  );
  it.each(["stale", "noop"])("preserves version-before-noop ordering (%s)", async (kind) => {
    const h = harness([...resource(), ...actorLock(), select("supplies", [supply()])]);
    const c = updateCommand(kind === "stale" ? { ifMatch: '"1"' } : {});
    if (kind === "stale")
      await expect(h.writeService.update(c)).rejects.toMatchObject({ status: 409 });
    else expect((await h.writeService.update(c)).row_version).toBe(revision);
    expect(h.queries.every((query) => /^select/iu.test(query.sql))).toBe(true);
  });
  it("changes category with exact revisions and app UTC3+000 while omitting private description/category audit keys", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const next = String(BigInt(revision) + 1n);
    const h = harness([
      ...resource(),
      ...actorLock(),
      select("supplies", [supply()]),
      write("update", "supplies"),
      select("supplies", [
        supply({ category: "homework", content_revision: next, row_version: next }),
      ]),
      write("insert into", "audit_logs"),
    ]);
    const result = await h.writeService.update(updateCommand({ category: "homework" }));
    expect(result.content_revision).toBe(next);
    expect(h.queries.find((query) => query.sql.startsWith("update"))!.parameters).toContain(
      "2026-09-07 04:05:06.123000",
    );
    const json = h.queries
      .at(-1)!
      .parameters.filter(
        (value) => typeof value === "string" && value.startsWith('{"content_revision"'),
      );
    expect(json.map((value) => JSON.parse(value as string))).toEqual([
      { content_revision: next },
      { content_revision: revision },
    ]);
  });
  it("treats zero affected CAS rows as a conflict before audit", async () => {
    const h = harness([
      ...resource(),
      ...actorLock(),
      select("supplies", [supply()]),
      write("update", "supplies", 0n),
    ]);
    await expect(h.writeService.update(updateCommand({ title: "변경" }))).rejects.toMatchObject({
      status: 409,
    });
    expect(h.events).toContain("rollback");
  });
  it("soft-deletes with one CAS update and an exact original JSON snapshot", async () => {
    const h = harness([
      ...resource(),
      ...actorLock(),
      select("supplies", [supply()]),
      write("update", "supplies"),
      write("insert into", "audit_logs"),
    ]);
    await h.writeService.delete({
      actorUserId: actorId,
      supplyId,
      ifMatch: `"${revision}"`,
      reason: "취소",
      requestId: command().requestId,
    });
    const audit = h.queries.at(-1)!;
    expect(audit.parameters).toContain("supply.deleted");
    const payload = audit.parameters.find(
      (value) => typeof value === "string" && value.startsWith('{"audience_mode"'),
    ) as string;
    expect(JSON.parse(payload)).toEqual({
      audience_mode: "legacy_class",
      content_revision: revision,
      deleted_at: null,
      needed_on: "2026-09-07",
      supply_id: supplyId,
      title: "준비물",
    });
    expect(h.queries.some((query) => /^delete/iu.test(query.sql))).toBe(false);
  });
  it("rejects a stale content revision even when the requested check state looks unchanged", async () => {
    const h = harness([
      clock(),
      ...resource("student"),
      ...actorLock("student"),
      select("supplies", [supply()]),
      select("supply_checks", [{ id: "8", is_checked: 0, confirmed_revision: null }]),
    ]);
    await expect(
      h.writeService.setCheck({
        actorUserId: actorId,
        supplyId,
        isChecked: false,
        contentRevision: "1",
      }),
    ).rejects.toMatchObject({ status: 409, response: { code: "CONTENT_REVISION_CHANGED" } });
    expect(h.reminders.resolve).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "checks once and resolves reminders even for an unchanged checked state (%s)",
    async (alreadyChecked) => {
      const h = harness([
        clock(),
        ...resource("student"),
        ...actorLock("student"),
        select("supplies", [supply()]),
        select("supply_checks", [
          {
            id: "8",
            is_checked: alreadyChecked ? 1 : 0,
            confirmed_revision: alreadyChecked ? revision : null,
          },
        ]),
        ...(alreadyChecked ? [] : [write("update", "supply_checks")]),
      ]);
      expect(
        await h.writeService.setCheck(
          { actorUserId: actorId, supplyId, isChecked: true, contentRevision: revision },
          new Date(now),
        ),
      ).toEqual({ check_state: "checked", content_revision: revision, supply_id: supplyId });
      expect(h.reminders.resolve).toHaveBeenCalledTimes(1);
      expect(h.events.indexOf("resolve_reminder")).toBeLessThan(h.events.indexOf("commit"));
      if (!alreadyChecked)
        expect(h.queries.at(-1)!.parameters).toContain("2026-09-07 04:05:06.123000");
      expect(h.queries.some((query) => query.sql.includes("api_idempotency_keys"))).toBe(false);
    },
  );
  it("records an initially unchecked state with a UTC timestamp and no reminder resolution", async () => {
    const h = harness([
      clock(),
      ...resource("student"),
      ...actorLock("student"),
      select("supplies", [supply()]),
      select("supply_checks"),
      write("insert into", "supply_checks"),
    ]);
    const result = await h.writeService.setCheck(
      { actorUserId: actorId, supplyId, isChecked: false, contentRevision: revision },
      new Date(now),
    );
    expect(result.check_state).toBe("unchecked");
    expect(h.queries.at(-1)!.parameters).toContain("2026-09-07 04:05:06.123000");
    expect(h.queries.at(-1)!.parameters).toContain(false);
    expect(h.reminders.resolve).not.toHaveBeenCalled();
  });
});
