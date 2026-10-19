import { createMariaDbDatabase, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../config/environment.js";
import { AttendanceNotificationsAccessService } from "./attendance-notifications-access.service.js";
import { AttendanceNotificationsCommandService } from "./attendance-notifications-command.service.js";
import type { AttendanceMutationItem } from "./attendance-notifications-command.types.js";
import { AttendanceNotificationDateChangedException } from "./attendance-notifications-command.errors.js";
import { AttendanceNotificationsIdempotencyService } from "./attendance-notifications-idempotency.service.js";
import { AttendanceNotificationsService } from "./attendance-notifications.service.js";
import { attendanceDatabaseEngine } from "./attendance-notifications.database.js";
import { decodeAttendanceTodayCursor } from "./attendance-notifications.cursor.js";

const actorId = "9007199254741101",
  classId = "9007199254741102",
  memberId = "9007199254741103";
const targetMemberId = "9007199254741104",
  attendanceId = "9007199254741200";
const now = "2026-09-07 12:00:00.123456",
  today = "2026-09-07";
const config = new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" });
const create = {
  actorUserId: actorId,
  expectedTime: "08:30",
  notificationType: "late" as const,
  idempotencyKey: "b0a9b567-b4de-4f1e-a0c1-696c6c15b080",
  requestId: "00000000-0000-4000-8000-000000000001",
  serverToday: today,
};
const state = { ...create, attendanceId, ifMatch: '"1"' };
type Call = { sql: string; parameters: readonly unknown[] };
type Row = Record<string, unknown>;
const databases: ReturnType<typeof createMariaDbDatabase<DB>>[] = [];
const record = (): Row => ({
  id: attendanceId,
  class_id: classId,
  member_id: memberId,
  notification_date: today,
  notification_type: "late",
  status: "pending",
  row_version: "1",
  expected_time: "08:30:00",
  acknowledged_at: null,
  acknowledged_by_member_id: null,
  submitted_at: now,
  updated_at: now,
});
const body: AttendanceMutationItem = {
  id: attendanceId,
  notification_type: "late",
  status: "pending",
  row_version: "1",
  expected_time: "08:30",
  acknowledged_at: null,
  submitted_at: "2026-09-07T12:00:00.123Z",
  updated_at: "2026-09-07T12:00:00.123Z",
};

// Actual MysqlQueryCompiler and guarded transaction driver, with scripted native wire
// replies only. These tests do not claim actual SQL execution, ACL or concurrency proof.
function boundary(role: "student" | "teacher" = "student") {
  const calls: Call[] = [];
  const fixture = {
    existing: undefined as Row | undefined,
    final: record(),
    stored: undefined as Row | undefined,
    account: {
      deleted_at: null,
      display_name: "Synthetic account",
      email_verified_at: null,
      signup_approved_at: now,
      is_active: 1,
    } as Row,
    classStatus: "active",
    profileChange: 0,
    affectedRows: 1,
    clockReads: 0,
    changeDayAt: Infinity,
    context: {
      actor_class_id: classId,
      actor_class_status: "active",
      actor_member_id: memberId,
      actor_role: role,
      actor_profile_status: role === "teacher" ? "active" : null,
      actor_password_change: role === "teacher" ? 0 : null,
      snapshot_today: today,
    } as Row,
    snapshot: undefined as Row[] | undefined,
    fail: undefined as ((call: Call) => unknown) | undefined,
  };
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
            if (/^\s*(?:insert|delete|update)\b/iu.test(statement))
              return reply(null, { affectedRows: fixture.affectedRows, insertId: attendanceId });
            if (/^\s*WITH actor_context/u.test(statement))
              return reply(
                null,
                fixture.snapshot ?? [
                  {
                    ...fixture.context,
                    snapshot_id: null,
                    total: "0",
                    absent: "0",
                    early: "0",
                    late: "0",
                    pending: "0",
                    acknowledged: "0",
                  },
                ],
              );
            if (statement.includes("SELECT c.id AS actor_class_id"))
              return reply(null, [fixture.context]);
            if (statement.includes("AS attendance_clock"))
              return reply(null, [
                {
                  attendance_clock: now,
                  server_today: ++fixture.clockReads >= fixture.changeDayAt ? "2026-09-08" : today,
                },
              ]);
            if (statement.includes("from `api_idempotency_keys`"))
              return reply(null, fixture.stored ? [fixture.stored] : []);
            if (statement.includes("`profile`.`temporary_password_must_change`"))
              return reply(null, [
                {
                  class_id: classId,
                  class_status: fixture.classStatus,
                  member_id: memberId,
                  role,
                  profile_status: role === "teacher" ? "active" : null,
                  temporary_password_must_change: role === "teacher" ? fixture.profileChange : null,
                },
              ]);
            if (statement.includes("from `users`")) return reply(null, [fixture.account]);
            if (statement.includes("from `classes`"))
              return reply(null, [{ id: classId, status: fixture.classStatus }]);
            if (statement.includes("from `class_members` as `member`"))
              return reply(null, [
                { id: memberId, class_id: classId, user_id: actorId, role, status: "approved" },
                ...(role === "teacher"
                  ? [
                      {
                        id: targetMemberId,
                        class_id: classId,
                        user_id: "801",
                        role: "student",
                        status: "left",
                      },
                    ]
                  : []),
              ]);
            if (statement.includes("from `teacher_profiles`"))
              return reply(null, [
                { status: "active", temporary_password_must_change: fixture.profileChange },
              ]);
            if (statement.includes("from `attendance_notifications` as `notification`"))
              return reply(null, fixture.existing ? [fixture.existing] : []);
            if (statement.includes("from `attendance_notifications`"))
              return reply(null, [fixture.final]);
            if (statement.includes("SELECT 17 AS marker")) return reply(null, [{ marker: 17 }]);
            return reply(new Error("Unexpected synthetic attendance SQL"), undefined);
          },
          release: vi.fn(),
          destroy: vi.fn(),
        });
      },
      end: (callback) => callback(null),
    }),
    {
      host: "attendance.test.invalid",
      database: "synthetic",
      user: "synthetic_app",
      password: "synthetic",
      sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic",
    },
  );
  databases.push(database);
  const access = new AttendanceNotificationsAccessService(database, config);
  const idempotency = new AttendanceNotificationsIdempotencyService(database, config);
  return {
    database,
    calls,
    fixture,
    access,
    idempotency,
    command: new AttendanceNotificationsCommandService(database, access, idempotency, config),
    query: new AttendanceNotificationsService(database, config),
  };
}
function business(calls: Call[]) {
  return calls.filter((call) => /^\s*(?:select|insert|delete|update|with)\b/iu.test(call.sql));
}
function assertMariaSql(calls: Call[]) {
  for (const call of business(calls)) {
    expect(call.sql).not.toMatch(
      /::|\breturning\b|pg_advisory|clock_timestamp|to_char|filter\s*\(/iu,
    );
    expect(call.parameters.some((value) => value instanceof Date)).toBe(false);
  }
  expect(calls.some((call) => /REPEATABLE READ/u.test(call.sql))).toBe(false);
}
function snapshot(overrides: Row = {}): Row {
  return {
    snapshot_id: attendanceId,
    snapshot_acknowledged_at: null,
    snapshot_expected_time: "08:30:00",
    snapshot_type: "late",
    snapshot_status: "pending",
    snapshot_version: "1",
    snapshot_submitted_at: now,
    snapshot_updated_at: now,
    snapshot_member_id: targetMemberId,
    snapshot_student_number: 2,
    snapshot_member_status: "left",
    snapshot_display_name: "Synthetic pupil",
    snapshot_account_deleted_at: null,
    snapshot_account_is_active: 0,
    snapshot_date: today,
    total: "3",
    absent: "1",
    early: "1",
    late: "1",
    pending: "2",
    acknowledged: "1",
    ...overrides,
  };
}
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

describe("Attendance MariaDB command boundary", () => {
  it("defaults to PG and rejects an invalid engine before acquisition", () => {
    expect(attendanceDatabaseEngine()).toBe("postgres");
    const h = boundary();
    expect(
      () =>
        new AttendanceNotificationsService(
          h.database,
          new ConfigService({ DATABASE_ENGINE: "sqlite" }) as ConfigService<AppEnvironment, true>,
        ),
    ).toThrow("Invalid attendance database engine");
    expect(h.calls).toHaveLength(0);
  });

  it.each([false, true])(
    "creates or reactivates with exact DB6, native ID and private audit (reactivate=%s)",
    async (reactivate) => {
      const h = boundary();
      if (reactivate) {
        h.fixture.existing = { ...record(), status: "canceled" };
        h.fixture.final.row_version = "2";
      }
      expect(await h.command.create(create)).toEqual({
        item: { ...body, row_version: reactivate ? "2" : "1" },
        statusCode: reactivate ? 200 : 201,
      });
      const mutation = h.calls.find((call) =>
        /^(?:insert into|update) `attendance_notifications`/u.test(call.sql),
      )!;
      expect(mutation.parameters).toContain(now);
      const audit = h.calls.find((call) => call.sql.startsWith("insert into `audit_logs`"))!;
      const snapshots = audit.parameters.filter(
        (value): value is string => typeof value === "string" && value.startsWith("{"),
      );
      expect(snapshots.map((value) => JSON.parse(value))).toEqual([
        {
          attendance_notification_id: attendanceId,
          notification_date: today,
          notification_type: "late",
          status: "pending",
        },
      ]);
      expect(audit.parameters).toContain(null);
      expect(audit.parameters).not.toContain("08:30");
      const stored = h.calls.find((call) =>
        call.sql.startsWith("insert into `api_idempotency_keys`"),
      )!;
      expect(stored.sql).toContain("UTC_TIMESTAMP(6) + INTERVAL 24 HOUR");
      expect(
        stored.parameters
          .filter((value): value is string => typeof value === "string" && value.startsWith("{"))
          .map((value) => JSON.parse(value)),
      ).toEqual([{ ...body, row_version: reactivate ? "2" : "1" }]);
      expect(h.fixture.clockReads).toBe(3);
      expect(h.calls.findIndex((call) => call.sql.includes("from `users`"))).toBeLessThan(
        h.calls.findIndex((call) => call.sql.includes("from `api_idempotency_keys`")),
      );
      assertMariaSql(h.calls);
    },
  );

  it.each(["update", "cancel", "acknowledge"] as const)(
    "%s retains guarded version, roles, state and DB6",
    async (operation) => {
      const h = boundary(operation === "acknowledge" ? "teacher" : "student");
      h.fixture.existing = record();
      h.fixture.final.row_version = "2";
      if (operation === "acknowledge") {
        h.fixture.existing.member_id = targetMemberId;
        Object.assign(h.fixture.final, {
          member_id: targetMemberId,
          status: "acknowledged",
          acknowledged_at: now,
          acknowledged_by_member_id: memberId,
        });
      } else if (operation === "cancel") h.fixture.final.status = "canceled";
      else h.fixture.final.expected_time = "09:15:00";
      const result = await h.command[operation]({ ...state, expectedTime: "09:15" });
      expect(result.row_version).toBe("2");
      expect(result.updated_at).toBe(body.updated_at);
      const mutation = h.calls.find((call) =>
        call.sql.startsWith("update `attendance_notifications`"),
      )!;
      expect(mutation.sql).toContain("`row_version` = ?");
      expect(mutation.sql).toContain("`notification_date` = CAST(? AS DATE)");
      expect(mutation.parameters).toContain(now);
      if (operation === "acknowledge") {
        expect(result.acknowledged_at).toBe(body.updated_at);
        expect(mutation.parameters).toContain(memberId);
        expect(h.calls.some((call) => /from `teacher_profiles`.*for update/u.test(call.sql))).toBe(
          true,
        );
        expect(
          h.calls.find((call) => /from `class_members` as `member`.*for update/u.test(call.sql))
            ?.parameters,
        ).toEqual([memberId, targetMemberId]);
      }
      expect(h.calls.some((call) => call.sql.startsWith("insert into `audit_logs`"))).toBe(true);
      expect(h.calls.some((call) => call.sql.includes("api_idempotency_keys"))).toBe(false);
      assertMariaSql(h.calls);
    },
  );

  it("keeps an unchanged pending update read-only and checks the fresh date", async () => {
    const h = boundary();
    h.fixture.existing = record();
    expect(await h.command.update(state)).toEqual(body);
    expect(h.fixture.clockReads).toBe(2);
    expect(business(h.calls).some((call) => /^(?:insert|update|delete)/u.test(call.sql))).toBe(
      false,
    );
  });

  it.each([false, true])(
    "preserves student acknowledged-before-version and teacher version-before-state (teacher=%s)",
    async (teacher) => {
      const h = boundary(teacher ? "teacher" : "student");
      h.fixture.existing = { ...record(), status: "acknowledged", row_version: "2" };
      if (teacher) {
        h.fixture.existing.member_id = targetMemberId;
        h.fixture.final.member_id = targetMemberId;
      }
      await expect(h.command[teacher ? "acknowledge" : "cancel"](state)).rejects.toMatchObject({
        response: {
          code: teacher
            ? "RESOURCE_VERSION_CHANGED"
            : "ATTENDANCE_NOTIFICATION_ALREADY_ACKNOWLEDGED",
        },
      });
      expect(business(h.calls).some((call) => call.sql.startsWith("update"))).toBe(false);
      expect(h.calls.some((call) => call.sql === "COMMIT")).toBe(false);
    },
  );

  it.each(["inactive", "unapproved", "foreign"] as const)(
    "rejects %s before any business write",
    async (failure) => {
      const h = boundary();
      h.fixture.existing = record();
      if (failure === "inactive") h.fixture.account.is_active = 0;
      if (failure === "unapproved") h.fixture.account.signup_approved_at = null;
      if (failure === "foreign") h.fixture.final.member_id = targetMemberId;
      await expect(h.command.cancel(state)).rejects.toMatchObject({
        status: failure === "inactive" ? 401 : failure === "unapproved" ? 403 : 404,
      });
      expect(business(h.calls).some((call) => /^(?:insert|update|delete)/u.test(call.sql))).toBe(
        false,
      );
    },
  );

  it("rolls back notification, audit and idempotency when the date changes before commit", async () => {
    const h = boundary();
    h.fixture.changeDayAt = 3;
    await expect(h.command.create(create)).rejects.toBeInstanceOf(
      AttendanceNotificationDateChangedException,
    );
    const idem = h.calls.findIndex((call) =>
      call.sql.startsWith("insert into `api_idempotency_keys`"),
    );
    expect(idem).toBeGreaterThan(0);
    expect(h.calls.slice(idem).some((call) => call.sql === "ROLLBACK")).toBe(true);
    expect(h.calls.some((call) => call.sql === "COMMIT")).toBe(false);
  });

  it("does not commit or retry a write followed by an audit SQL failure", async () => {
    const h = boundary();
    const failure = Object.assign(new Error("synthetic private SQL"), {
      errno: 4025,
      sqlState: "23000",
    });
    h.fixture.fail = (call) =>
      call.sql.startsWith("insert into `audit_logs`") ? failure : undefined;
    await expect(h.command.create(create)).rejects.toBe(failure);
    expect(
      h.calls.filter((call) => call.sql.startsWith("insert into `attendance_notifications`")),
    ).toHaveLength(1);
    expect(h.calls.some((call) => call.sql === "COMMIT")).toBe(false);
    expect(h.calls.some((call) => call.sql.startsWith("insert into `api_idempotency_keys`"))).toBe(
      false,
    );
  });
});

describe("Attendance MariaDB specialized replay", () => {
  it("checks authorization before JSON replay, copies the hash and rechecks the date before commit", async () => {
    const h = boundary();
    const requestHash = Buffer.alloc(32, 7);
    h.fixture.stored = {
      request_hash: Buffer.from(requestHash),
      response_status: 201,
      response_body_json: JSON.stringify(body),
    };
    const operation = vi.fn();
    const result = await h.idempotency.execute({
      ...create,
      routeKey: "/attendance:synthetic",
      requestHash,
      beforeLookup: async (tx) => {
        requestHash.fill(9);
        await sql`SELECT 17 AS marker`.execute(tx);
      },
      beforeCommit: async (tx) => {
        await sql`SELECT 17 AS marker`.execute(tx);
      },
      operation,
    });
    expect(result).toEqual({ body, statusCode: 201, replayed: true });
    expect(operation).not.toHaveBeenCalled();
    const markers = h.calls
      .map((call, index) => (call.sql.includes("SELECT 17 AS marker") ? index : -1))
      .filter((index) => index >= 0);
    const lookup = h.calls.findIndex(
      (call) => call.sql.startsWith("select") && call.sql.includes("from `api_idempotency_keys`"),
    );
    expect(markers[0]).toBeLessThan(lookup);
    expect(markers[1]).toBeGreaterThan(lookup);
    expect(h.calls[lookup]?.sql).toContain("for update");
    assertMariaSql(h.calls);
  });

  it("rejects stale authorization before inspecting a stored response", async () => {
    const h = boundary();
    await expect(
      h.idempotency.execute({
        ...create,
        routeKey: "/attendance:synthetic",
        requestHash: Buffer.alloc(32),
        beforeLookup: async () => {
          throw new AttendanceNotificationDateChangedException();
        },
        beforeCommit: vi.fn(),
        operation: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(AttendanceNotificationDateChangedException);
    expect(h.calls.some((call) => call.sql.includes("api_idempotency_keys"))).toBe(false);
  });
});

describe("Attendance MariaDB statement snapshot reads", () => {
  it("decodes teacher totals independently of filters and retained membership/account state", async () => {
    const h = boundary("teacher");
    h.fixture.snapshot = [{ ...h.fixture.context, ...snapshot() }];
    const result = await h.query.today({ actorUserId: actorId, status: "pending", type: "late" });
    expect(result).toMatchObject({
      role: "teacher",
      server_today: today,
      counts: { total: 3, absent: 1, early: 1, late: 1, pending: 2, acknowledged: 1 },
      items: [
        {
          ...body,
          account_state: "inactive",
          membership_state: "left",
          member_id: targetMemberId,
          student_number: 2,
        },
      ],
    });
    const statements = business(h.calls);
    expect(statements).toHaveLength(2);
    expect(statements[1]?.sql).toMatch(/counts AS[\s\S]*FROM notifications[\s\S]*page AS/u);
    expect(statements[1]?.sql).toContain("snapshot_student_number IS NULL");
    assertMariaSql(h.calls);
  });

  it.each(["teacher", "student"] as const)(
    "keeps zero-row %s context and counts without decoding null sentinel IDs",
    async (role) => {
      const h = boundary(role);
      const result = await h.query.today({ actorUserId: actorId, status: "all", type: "all" });
      expect(result).toMatchObject(
        role === "teacher"
          ? { items: [], counts: { total: 0 }, next_cursor: null }
          : { notification: null, role: "student", server_today: today },
      );
    },
  );

  it("preserves student own notification/history and ignores teacher cursor filters for students", async () => {
    const h = boundary();
    h.fixture.snapshot = [{ ...h.fixture.context, ...snapshot() }];
    expect(
      await h.query.today({
        actorUserId: actorId,
        status: "acknowledged",
        type: "absent",
        cursor: "invalid",
      }),
    ).toEqual({ role: "student", server_today: today, notification: body });
    const history = await h.query.history({ actorUserId: actorId, from: today, to: today });
    expect(history).toEqual({
      role: "student",
      server_today: today,
      range: { from: today, to: today },
      counts: { absent: 0, early: 0, late: 1, total: 1 },
      items: [
        {
          expected_time: "08:30",
          notification_date: today,
          notification_type: "late",
          status: "pending",
        },
      ],
    });
    const historySql = business(h.calls).at(-1)!;
    expect(historySql.sql).toContain("actor.actor_member_id=n.member_id");
    expect(historySql.parameters).toEqual([actorId, today, today]);
    assertMariaSql(h.calls);
  });

  it("encodes 20+1 page cursor with native BIGINT and nullable student number", async () => {
    const h = boundary("teacher");
    h.fixture.snapshot = Array.from({ length: 21 }, (_, index) => ({
      ...h.fixture.context,
      ...snapshot({
        snapshot_id: String(BigInt(attendanceId) + BigInt(index)),
        snapshot_member_id: String(BigInt(targetMemberId) + BigInt(index)),
        snapshot_student_number: null,
      }),
    }));
    const result = await h.query.today({ actorUserId: actorId, status: "all", type: "all" });
    if (result.role !== "teacher") throw new Error("Expected teacher result");
    expect(result.items).toHaveLength(20);
    expect(
      decodeAttendanceTodayCursor(result.next_cursor!, {
        classId,
        notificationDate: today,
        status: "all",
        type: "all",
      }),
    ).toMatchObject({ studentNumber: null, memberId: String(BigInt(targetMemberId) + 19n) });
    await h.query.today({
      actorUserId: actorId,
      status: "all",
      type: "all",
      cursor: result.next_cursor!,
    });
    expect(business(h.calls).at(-1)?.sql).toContain("snapshot_member_id > CAST(? AS SIGNED)");
  });

  it("fails closed if membership switches between preliminary auth and the final snapshot", async () => {
    const h = boundary("teacher");
    h.fixture.snapshot = [{ ...h.fixture.context, ...snapshot(), actor_class_id: "991" }];
    await expect(
      h.query.today({ actorUserId: actorId, status: "all", type: "all" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
