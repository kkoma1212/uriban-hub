import { createMariaDbDatabase, createIdempotencyRequestHash, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, PostgresDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../../config/environment.js";
import { UnauthenticatedException } from "../../auth/auth.errors.js";
import { ResourceVersionChangedException } from "../../common/http/if-match.js";
import { SchedulesAccessService } from "../schedules-access.service.js";
import { SchedulesQueryService } from "../schedules-query.service.js";
import { SchedulesCommandService } from "../schedules-command.service.js";
import {
  InvalidScheduleCursorException,
  ScheduleNotFoundException,
  ScheduleRoleInsufficientException,
} from "../schedules.errors.js";
import { decodeScheduleListCursor, encodeScheduleListCursor } from "../schedules.cursor.js";
import type { UpdateScheduleCommand } from "../schedules.types.js";

type Step = {
  rows?: Record<string, unknown>[];
  affectedRows?: number;
  insertId?: string;
  error?: unknown;
};
const actorUserId = "9007199254740993",
  classId = "9007199254740995",
  memberId = "9007199254740997",
  scheduleId = "9007199254740999";
const rowVersion = "9007199254741001",
  serverToday = "2026-09-07";
const databases: Kysely<DB>[] = [];
const context = (overrides: Record<string, unknown> = {}) => ({
  academic_year: 2026,
  class_id: classId,
  class_status: "active",
  edu_office_code: "B10",
  grade: 4,
  member_id: memberId,
  profile_status: "active",
  role: "teacher",
  school_code: "S001",
  temporary_password_must_change: 0,
  ...overrides,
});
const resource = (overrides: Record<string, unknown> = {}) => ({
  class_id: classId,
  description: "private description",
  due_date: "2026-09-09",
  id: scheduleId,
  row_version: rowVersion,
  schedule_type: "exam",
  subject: "수학",
  title: "합성 일정",
  ...overrides,
});
const clock = { rows: [{ server_today: serverToday }] };
const lockSteps = (): Step[] => [
  { rows: [{ deleted_at: null, display_name: "합성 교사", is_active: 1 }] },
  {
    rows: [
      {
        academic_year: 2026,
        edu_office_code: "C20",
        grade: 5,
        id: classId,
        school_code: "S002",
        status: "active",
      },
    ],
  },
  { rows: [{ id: memberId, role: "teacher", status: "approved", user_id: actorUserId }] },
  { rows: [{ status: "active", temporary_password_must_change: 0 }] },
];
const createCommand = {
  actorUserId,
  description: "private description",
  dueDate: "2026-09-09",
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  scheduleType: "exam" as const,
  subject: "수학",
  title: "합성 일정",
};
const updateCommand: UpdateScheduleCommand = {
  actorUserId,
  scheduleId,
  ifMatch: `"${rowVersion}"`,
  requestId: createCommand.requestId,
  description: undefined,
  dueDate: undefined,
  scheduleType: undefined,
  subject: undefined,
  title: undefined,
};
const editSteps = (): Step[] => [
  clock,
  { rows: [context()] },
  { rows: [resource()] },
  ...lockSteps(),
  { rows: [resource()] },
];

function boundary(steps: Step[], engine: "mariadb" | "postgres" = "mariadb") {
  const statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const state: { commitError?: unknown } = {};
  const release = vi.fn(),
    destroy = vi.fn();
  const product = (statement: string) => /^\s*(select|insert|update|delete)\b/iu.test(statement);
  function response(statement: string, parameters: readonly unknown[]): Step {
    statements.push({ sql: statement, parameters });
    if (/^commit$/iu.test(statement)) return { error: state.commitError };
    if (!product(statement)) return {};
    return steps.shift() ?? { error: new Error("Unexpected SQL boundary query") };
  }
  const database =
    engine === "mariadb"
      ? createMariaDbDatabase<DB>(
          () => ({
            getConnection: (callback) =>
              callback(null, {
                query(statement, parameters, callback) {
                  const step = response(statement, parameters);
                  callback(
                    step.error,
                    step.rows ?? {
                      affectedRows: step.affectedRows ?? 1,
                      insertId: step.insertId ?? "0",
                    },
                  );
                },
                release,
                destroy,
              }),
            end: (callback) => callback(null),
          }),
          {
            host: "mariadb.test.invalid",
            database: "synthetic_schedules",
            user: "synthetic_app",
            password: "synthetic",
            sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic",
          },
        )
      : new Kysely<DB>({
          dialect: new PostgresDialect({
            pool: {
              connect: async () => ({
                query: async (statement: string, parameters: readonly unknown[] = []) => {
                  const step = response(statement, parameters);
                  if (step.error) throw step.error;
                  return {
                    rows: step.rows ?? [],
                    rowCount: step.affectedRows ?? 1,
                    command: statement.trim().split(" ")[0]?.toUpperCase(),
                  };
                },
                release,
              }),
              end: async () => undefined,
            } as never,
          }),
        });
  databases.push(database);
  const environment =
    engine === "mariadb"
      ? new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: engine })
      : undefined;
  const access = new SchedulesAccessService(database, environment);
  return {
    access,
    commands: new SchedulesCommandService(database, access, environment),
    queries: new SchedulesQueryService(database, access, environment),
    database,
    steps,
    statements,
    state,
    release,
    destroy,
    sql: () => statements.filter(({ sql }) => product(sql)),
    commits: () => statements.filter(({ sql }) => /^commit$/iu.test(sql)).length,
  };
}
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

describe("MariaDB schedules shared policy with real SQL compiler and guarded transactions", () => {
  describe.each(["mariadb", "postgres"] as const)("relative schedule periods on %s", (engine) => {
    it.each([
      { scope: "today", today: "2026-09-22", start: "2026-09-22", end: "2026-09-22" },
      { scope: "today", today: "2028-02-29", start: "2028-02-29", end: "2028-02-29" },
      { scope: "this_week", today: "2026-09-21", start: "2026-09-21", end: "2026-09-27" },
      { scope: "this_week", today: "2026-09-27", start: "2026-09-21", end: "2026-09-27" },
      { scope: "this_week", today: "2027-01-01", start: "2026-12-28", end: "2027-01-03" },
      { scope: "this_week", today: "2028-02-29", start: "2028-02-28", end: "2028-03-05" },
    ] as const)(
      "applies inclusive $scope bounds for $today before limiting results",
      async ({ scope, today, start, end }) => {
        const probe = boundary(
          [
            { rows: [{ server_today: today }] },
            {
              rows: [
                context({ temporary_password_must_change: engine === "postgres" ? false : 0 }),
              ],
            },
            {
              rows: Array.from({ length: 21 }, (_, index) =>
                resource({ id: String(index + 1), due_date: start, schedule_type: "assignment" }),
              ),
            },
          ],
          engine,
        );
        const result = await probe.queries.list({
          actorUserId,
          scope,
          scheduleType: "assignment",
          search: "수학",
        });
        const range = { start_date: start, end_date: end };
        expect(result.date_range).toEqual(range);
        expect(result.server_today).toBe(today);
        expect(result.items).toHaveLength(20);
        expect(probe.sql()[2]?.parameters).toEqual([
          classId,
          "assignment",
          "%수학%",
          "%수학%",
          "%수학%",
          start,
          end,
          21,
        ]);
        const statement = probe.sql()[2]!.sql.replaceAll('"', "").replaceAll("`", "");
        expect(statement).toContain("schedule.due_date >=");
        expect(statement).toContain("schedule.due_date <=");
        expect(statement).toContain("schedule.deleted_at is null");
        expect(statement).toContain("order by schedule.due_date asc, schedule.id asc");
        expect(
          decodeScheduleListCursor(result.next_cursor!, scope, "assignment", "수학", range),
        ).toMatchObject({ dueDate: start, id: "20", dateRange: range });
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
    "rejects a $scope cursor after the period changes without reading schedule rows",
    async ({ scope, today, range }) => {
      const cursor = encodeScheduleListCursor({
        scope,
        id: "20",
        dueDate: range.start_date,
        dateRange: range,
      });
      const probe = boundary([{ rows: [{ server_today: today }] }, { rows: [context()] }]);
      await expect(probe.queries.list({ actorUserId, scope, cursor })).rejects.toBeInstanceOf(
        InvalidScheduleCursorException,
      );
      expect(probe.sql()).toHaveLength(2);
    },
  );

  it("continues the same week after midnight, including earlier dates, with a stable tie breaker", async () => {
    const dateRange = { start_date: "2026-09-21", end_date: "2026-09-27" };
    const cursor = encodeScheduleListCursor({
      scope: "this_week",
      id: "20",
      dueDate: "2026-09-21",
      dateRange,
    });
    const probe = boundary([
      { rows: [{ server_today: "2026-09-22" }] },
      { rows: [context()] },
      { rows: [] },
    ]);
    const result = await probe.queries.list({ actorUserId, scope: "this_week", cursor });
    expect(result.date_range).toEqual(dateRange);
    expect(probe.sql()[2]?.parameters).toEqual([
      classId,
      "2026-09-21",
      "2026-09-27",
      "2026-09-21",
      "2026-09-21",
      "20",
      21,
    ]);
    expect(probe.sql()[2]?.sql).toContain("schedule.id >");
  });

  it.each(["mariadb", "postgres"] as const)(
    "filters before pagination with literal search and class/date bounds on %s",
    async (engine) => {
      const probe = boundary(
        [
          clock,
          {
            rows: [context({ temporary_password_must_change: engine === "postgres" ? false : 0 })],
          },
          {
            rows: Array.from({ length: 21 }, (_, index) =>
              resource({ id: String(index + 1), schedule_type: "assignment" }),
            ),
          },
        ],
        engine,
      );
      const search = "수학!%_\\";
      const result = await probe.queries.list({
        actorUserId,
        scope: "upcoming",
        scheduleType: "assignment",
        search: ` ${search} `,
      });
      expect(result.items).toHaveLength(20);
      const list = probe.sql()[2]!;
      const pattern = engine === "mariadb" ? "%수학!!!%!_\\%" : "%수학!\\%\\_\\\\%";
      expect(list.parameters).toEqual([
        classId,
        "assignment",
        pattern,
        pattern,
        pattern,
        serverToday,
        21,
      ]);
      expect(list.sql).toContain("schedule.subject");
      expect(list.sql).toContain("schedule.title");
      expect(list.sql).toContain("schedule.description");
      expect(list.sql).toContain(engine === "mariadb" ? "ESCAPE '!'" : "ILIKE");
      expect(
        decodeScheduleListCursor(result.next_cursor!, "upcoming", "assignment", search),
      ).toEqual({
        dueDate: "2026-09-09",
        id: "20",
        scope: "upcoming",
        scheduleType: "assignment",
        search,
      });
    },
  );

  it("keeps past ordering and the 90-day bound while continuing a filtered cursor", async () => {
    const cursor = encodeScheduleListCursor({
      dueDate: "2026-09-06",
      id: "55",
      scope: "past",
      scheduleType: "exam",
      search: "수학",
    });
    const probe = boundary([clock, { rows: [context()] }, { rows: [] }]);
    await probe.queries.list({
      actorUserId,
      scope: "past",
      cursor,
      scheduleType: "exam",
      search: "수학",
    });
    expect(probe.sql()[2]?.parameters).toEqual([
      classId,
      "exam",
      "%수학%",
      "%수학%",
      "%수학%",
      "2026-06-09",
      serverToday,
      "2026-09-06",
      "2026-09-06",
      "55",
      21,
    ]);
    expect(probe.sql()[2]?.sql).toContain(
      "order by `schedule`.`due_date` desc, `schedule`.`id` desc",
    );
    expect(probe.sql()[2]?.sql).toContain("`schedule`.`deleted_at` is null");
  });

  it("rejects a changed type before executing the schedule query and ignores blank search", async () => {
    const cursor = encodeScheduleListCursor({
      dueDate: "2026-09-09",
      id: "55",
      scope: "upcoming",
      scheduleType: "exam",
    });
    const mismatch = boundary([clock, { rows: [context()] }]);
    await expect(
      mismatch.queries.list({ actorUserId, scope: "upcoming", cursor, scheduleType: "other" }),
    ).rejects.toBeDefined();
    expect(mismatch.sql()).toHaveLength(2);
    const blank = boundary([clock, { rows: [context()] }, { rows: [] }]);
    await blank.queries.list({ actorUserId, scope: "upcoming", search: "   " });
    expect(blank.sql()[2]?.parameters).toEqual([classId, serverToday, 21]);
  });

  it("keeps the PostgreSQL default date cast and cursor ordering", async () => {
    const probe = boundary(
      [
        clock,
        { rows: [context({ temporary_password_must_change: false })] },
        { rows: [resource({ due_date: new Date(2026, 8, 9) })] },
      ],
      "postgres",
    );
    const result = await probe.queries.list({ actorUserId, scope: "upcoming" });
    expect(result.items[0]?.due_date).toBe("2026-09-09");
    expect(probe.sql()[0]?.sql).toContain("clock_timestamp()");
    expect(probe.sql()[2]?.sql).toContain("::date");
    expect(probe.sql()[2]?.sql).toContain(
      'order by "schedule"."due_date" asc, "schedule"."id" asc',
    );
  });

  it("accepts student NULL teacher profile and rejects a malformed truthy boolean", async () => {
    const student = boundary([
      {
        rows: [
          context({ role: "student", profile_status: null, temporary_password_must_change: null }),
        ],
      },
    ]);
    await expect(student.access.getCollectionContext(actorUserId)).resolves.toMatchObject({
      role: "student",
      classId,
    });
    const malformed = boundary([{ rows: [context({ temporary_password_must_change: "0" })] }]);
    await expect(malformed.access.getCollectionContext(actorUserId)).rejects.toBeDefined();
    const locked = boundary([{ rows: [{ deleted_at: null, display_name: "합성", is_active: 0 }] }]);
    await expect(
      locked.database.transaction().execute((tx) =>
        locked.access.lockActorContext(
          tx,
          {
            academicYear: 2026,
            classId,
            eduOfficeCode: "B10",
            grade: 4,
            memberId,
            role: "teacher",
            schoolCode: "S001",
          },
          actorUserId,
        ),
      ),
    ).rejects.toBeInstanceOf(UnauthenticatedException);
    expect(locked.commits()).toBe(0);
  });

  it("normalizes rows even when an access lock receives a raw transaction", async () => {
    const probe = boundary(lockSteps());
    const actor = await probe.database.transaction().execute((tx) =>
      probe.access.lockActorContext(
        tx,
        {
          academicYear: 2026,
          classId,
          eduOfficeCode: "B10",
          grade: 4,
          memberId,
          role: "teacher",
          schoolCode: "S001",
        },
        actorUserId,
      ),
    );
    expect(actor).toMatchObject({ schoolCode: "S002", eduOfficeCode: "C20", grade: 5 });
    expect(
      probe
        .sql()
        .slice(0, 3)
        .every(({ sql }) => sql.endsWith("for update")),
    ).toBe(true);
  });

  it("refuses another class's schedule and a date outside the 90-day history window", async () => {
    for (const row of [resource({ class_id: "111" }), resource({ due_date: "2026-06-08" })]) {
      const probe = boundary([{ rows: [context()] }, { rows: [row] }]);
      await expect(
        probe.access.getResourceContext(actorUserId, scheduleId, serverToday),
      ).rejects.toBeInstanceOf(ScheduleNotFoundException);
    }
  });

  it("returns the same full schedule projection to an authorized student with a canonical DATE", async () => {
    const probe = boundary([
      clock,
      {
        rows: [
          context({ role: "student", profile_status: null, temporary_password_must_change: null }),
        ],
      },
      { rows: [resource()] },
    ]);
    await expect(probe.queries.get({ actorUserId, scheduleId })).resolves.toEqual({
      d_day_label: "D-2",
      days_until: 2,
      description: "private description",
      due_date: "2026-09-09",
      id: scheduleId,
      row_version: rowVersion,
      schedule_type: "exam",
      subject: "수학",
      title: "합성 일정",
    });
    expect(probe.sql()[2]?.parameters).toEqual([scheduleId]);
  });

  it.each(["2026-02-30", "2026-09-09 00:00:00.000000", "0000-00-00"])(
    "rejects malformed DATE %s before producing a response",
    async (due_date) => {
      const probe = boundary([clock, { rows: [context()] }, { rows: [resource({ due_date })] }]);
      await expect(probe.queries.list({ actorUserId, scope: "upcoming" })).rejects.toBeDefined();
    },
  );

  it("keeps holiday dates visible before the class history boundary without querying hidden schedules", async () => {
    const probe = boundary([
      clock,
      { rows: [context()] },
      { rows: [{ date: "2026-05-05", name: "어린이날" }] },
    ]);
    const result = await probe.queries.calendar({
      actorUserId,
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    });
    expect(result.items).toEqual([]);
    expect(result.holidays).toEqual([{ date: "2026-05-05", name: "어린이날" }]);
    expect(probe.sql()).toHaveLength(3);
    expect(probe.sql()[2]?.sql).toContain("DATE_FORMAT(holiday.holiday_date");
    expect(probe.sql()[2]?.parameters).toEqual(["2026-05-01", "2026-05-31"]);
  });

  it("merges school/class calendar dates with grade mask and lossless BIGINT sorting", async () => {
    const probe = boundary([
      clock,
      { rows: [context()] },
      { rows: [] },
      { rows: [resource()] },
      {
        rows: [
          {
            id: "9007199254741003",
            event_date: "2026-09-09",
            event_content: null,
            event_name: "학교 일정",
            grade_mask: 24,
            school_day_type: "normal",
            source_loaded_on: "2026-09-06",
          },
        ],
      },
    ]);
    const result = await probe.queries.calendar({
      actorUserId,
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    });
    expect(result.items.map((item) => item.source)).toEqual(["class", "school"]);
    expect(result.items[1]).toMatchObject({
      target_grades: [4, 5],
      due_date: "2026-09-09",
      source_loaded_on: "2026-09-06",
    });
    const school = probe.sql()[4];
    expect(school?.sql).toContain("event.grade_mask & ?");
    expect(school?.parameters).toEqual(["B10", "S001", 2026, 8, "2026-09-01", "2026-09-30"]);
    expect(probe.sql().some(({ sql }) => /::|NULLS (FIRST|LAST)/u.test(sql))).toBe(false);
  });

  it("paginates by DATE/BIGINT and binds cursor values without Number conversion", async () => {
    const rows = Array.from({ length: 21 }, (_, i) =>
      resource({ id: (9007199254740993n + BigInt(i)).toString() }),
    );
    const probe = boundary([clock, { rows: [context()] }, { rows }]);
    const result = await probe.queries.list({ actorUserId, scope: "upcoming" });
    expect(result.items).toHaveLength(20);
    expect(result.next_cursor).not.toBeNull();
    const decoded = decodeScheduleListCursor(result.next_cursor!, "upcoming");
    expect(decoded.id).toBe("9007199254741012");
    const next = boundary([clock, { rows: [context()] }, { rows: [] }]);
    await next.queries.list({ actorUserId, scope: "upcoming", cursor: result.next_cursor! });
    expect(next.sql()[2]?.sql).toContain("schedule.id > CAST(? AS SIGNED)");
    expect(next.sql()[2]?.parameters).toEqual([
      classId,
      serverToday,
      "2026-09-09",
      "2026-09-09",
      decoded.id,
      21,
    ]);
    const past = boundary([clock, { rows: [context()] }, { rows: [] }]);
    await past.queries.list({
      actorUserId,
      scope: "past",
      cursor: encodeScheduleListCursor({ id: scheduleId, dueDate: "2026-09-06", scope: "past" }),
    });
    expect(past.sql()[2]?.sql).toContain("schedule.id < CAST(? AS SIGNED)");
    expect(past.sql()[2]?.sql).toContain(
      "order by `schedule`.`due_date` desc, `schedule`.`id` desc",
    );
  });

  it("creates inside Maria idempotency reservation, reads inserted ID, audits then finalizes reservation", async () => {
    const probe = boundary([
      { rows: [context()] },
      { rows: [] },
      { insertId: "71" },
      clock,
      ...lockSteps(),
      { insertId: scheduleId },
      { rows: [resource({ row_version: "1" })] },
      {},
      {},
      {},
    ]);
    const result = await probe.commands.create(createCommand);
    expect(result).toMatchObject({ id: scheduleId, row_version: "1", due_date: "2026-09-09" });
    expect(probe.steps).toHaveLength(0);
    expect(probe.commits()).toBe(1);
    const queries = probe.sql();
    expect(queries[8]?.sql).toContain("insert into `schedules`");
    expect(queries[9]?.parameters).toEqual([scheduleId, classId]);
    const audit = queries[10];
    expect(audit?.sql).toContain("insert into `audit_logs`");
    const json = audit?.parameters.find(
      (value) => typeof value === "string" && value.startsWith("{"),
    );
    expect(JSON.parse(json as string)).toEqual({
      deleted_at: null,
      due_date: "2026-09-09",
      schedule_id: scheduleId,
      schedule_type: "exam",
      subject: "수학",
      title: "합성 일정",
    });
    expect(JSON.stringify(audit?.parameters)).not.toContain("private description");
    expect(queries[11]?.sql).toContain("DELETE FROM api_idempotency_keys");
    expect(queries[12]?.sql).toContain("INSERT INTO api_idempotency_keys");
    expect(queries.some(({ sql }) => /returning|pg_advisory|::date/u.test(sql))).toBe(false);
  });

  it("replays raw stored JSON after current authorization without duplicate schedule/audit writes", async () => {
    const body = {
      id: scheduleId,
      row_version: "1",
      due_date: "2026-09-09",
      days_until: 2,
      d_day_label: "D-2",
      description: "private description",
      schedule_type: "exam",
      subject: "수학",
      title: "합성 일정",
    };
    const requestHash = createIdempotencyRequestHash({
      body: {
        description: createCommand.description,
        due_date: createCommand.dueDate,
        schedule_type: createCommand.scheduleType,
        subject: createCommand.subject,
        title: createCommand.title,
      },
      effectiveClassId: classId,
    });
    const probe = boundary([
      { rows: [context()] },
      {
        rows: [
          {
            id: "71",
            request_hash: requestHash,
            response_body_json: JSON.stringify(body),
            response_status: 201,
          },
        ],
      },
      { rows: [{ unexpired: 1 }] },
    ]);
    await expect(probe.commands.create(createCommand)).resolves.toEqual(body);
    expect(probe.sql()).toHaveLength(3);
  });

  it("rejects a student before reserving an idempotency key", async () => {
    const probe = boundary([
      {
        rows: [
          context({ role: "student", profile_status: null, temporary_password_must_change: null }),
        ],
      },
    ]);
    await expect(probe.commands.create(createCommand)).rejects.toBeInstanceOf(
      ScheduleRoleInsufficientException,
    );
    expect(probe.sql()).toHaveLength(1);
    expect(probe.commits()).toBe(0);
  });

  it("keeps stale If-Match and no-op free of updates/audit", async () => {
    const stale = boundary(editSteps());
    await expect(
      stale.commands.update({ ...updateCommand, ifMatch: '"1"' }),
    ).rejects.toBeInstanceOf(ResourceVersionChangedException);
    expect(stale.commits()).toBe(0);
    const noop = boundary(editSteps());
    await expect(noop.commands.update(updateCommand)).resolves.toMatchObject({
      row_version: rowVersion,
    });
    expect(noop.sql()).toHaveLength(8);
    expect(noop.commits()).toBe(1);
  });

  it("distinguishes omitted fields from explicit NULL, increments exact version and audits after readback", async () => {
    const nextVersion = (BigInt(rowVersion) + 1n).toString();
    const probe = boundary([
      ...editSteps(),
      {},
      { rows: [resource({ description: null, subject: null, row_version: nextVersion })] },
      {},
    ]);
    const result = await probe.commands.update({
      ...updateCommand,
      description: null,
      subject: null,
    });
    expect(result).toMatchObject({
      description: null,
      subject: null,
      title: "합성 일정",
      row_version: nextVersion,
    });
    const update = probe.sql()[8];
    expect(update?.sql).not.toContain("`title` =");
    expect(update?.parameters.slice(-3)).toEqual([scheduleId, classId, rowVersion]);
    expect(probe.sql()[9]?.parameters).toEqual([scheduleId, classId, nextVersion]);
    expect(probe.sql()[10]?.sql).toContain("insert into `audit_logs`");
    expect(probe.commits()).toBe(1);
  });

  it("rolls back a failed conditional UPDATE and never audits it", async () => {
    const probe = boundary([...editSteps(), { affectedRows: 0 }]);
    await expect(probe.commands.update({ ...updateCommand, title: "변경" })).rejects.toBeInstanceOf(
      ResourceVersionChangedException,
    );
    expect(probe.commits()).toBe(0);
    expect(probe.sql()).toHaveLength(9);
  });

  it("soft-deletes with reason and version guard before audit, and rolls back an audit failure", async () => {
    const command = {
      actorUserId,
      scheduleId,
      ifMatch: `"${rowVersion}"`,
      requestId: createCommand.requestId,
      reason: "합성 사유",
    };
    const probe = boundary([...editSteps(), {}, {}]);
    await expect(probe.commands.delete(command)).resolves.toBeUndefined();
    expect(probe.sql()[8]?.sql).toContain("update `schedules` set `delete_reason`");
    expect(probe.sql()[8]?.parameters).toContain(command.reason);
    expect(probe.sql()[9]?.sql).toContain("insert into `audit_logs`");
    expect(probe.commits()).toBe(1);
    const failed = boundary([...editSteps(), {}, { error: { errno: 4025, sqlState: "23000" } }]);
    await expect(failed.commands.delete(command)).rejects.toBeDefined();
    expect(failed.commits()).toBe(0);
  });

  it("does not commit a create or idempotency response after audit failure", async () => {
    const probe = boundary([
      { rows: [context()] },
      { rows: [] },
      { insertId: "71" },
      clock,
      ...lockSteps(),
      { insertId: scheduleId },
      { rows: [resource({ row_version: "1" })] },
      { error: { errno: 4025, sqlState: "23000" } },
    ]);
    await expect(probe.commands.create(createCommand)).rejects.toBeDefined();
    expect(probe.commits()).toBe(0);
    expect(
      probe.sql().filter(({ sql }) => sql.includes("INSERT INTO api_idempotency_keys")),
    ).toHaveLength(1);
  });
});
