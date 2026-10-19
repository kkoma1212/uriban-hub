import { createMariaDbDatabase, type DB } from "@classhub/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readAttendanceTodayCounts,
  readStudentAttendanceToday,
} from "../src/attendance-notifications/attendance-notifications.read.js";
import { AuditLogsService } from "../src/audit-logs/audit-logs.service.js";
import { decodeAuditLogCursor, encodeAuditLogCursor } from "../src/audit-logs/audit-logs.cursor.js";
import {
  AuditLogDataInvalidException,
  AuditLogsClassSuspendedException,
  AuditLogsNotFoundException,
  AuditLogsRoleInsufficientException,
} from "../src/audit-logs/audit-logs.errors.js";
import { UnauthenticatedException } from "../src/auth/auth.errors.js";

const classId = "9007199255640000";
const actorId = "9007199255640001";
const memberId = "9007199255640002";
const auditId = "9007199255640003";
const time = "2026-09-07T10:00:00.123456Z";
type Rows = Record<string, unknown>[];
const databases: ReturnType<typeof createMariaDbDatabase<DB>>[] = [];
function boundary(steps: Rows[]) {
  const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const database = createMariaDbDatabase<DB>(
    () => ({
      getConnection: (callback) =>
        callback(null, {
          query: (statement, parameters, reply) => {
            if (!/^\s*SELECT\b/iu.test(statement))
              return reply(null, { affectedRows: 0, insertId: 0 });
            calls.push({ sql: statement, parameters });
            const rows = steps.shift();
            if (rows === undefined)
              return reply(new Error("Unexpected synthetic SELECT"), undefined);
            reply(null, rows);
          },
          release: vi.fn(),
          destroy: vi.fn(),
        }),
      end: (callback) => callback(null),
    }),
    {
      host: "dashboard.test.invalid",
      database: "synthetic",
      user: "synthetic_app",
      password: "synthetic",
      sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic",
    },
  );
  databases.push(database);
  const service = new AuditLogsService(database, { get: () => "mariadb" } as never);
  return { database, calls, service, steps };
}
const teacher = (changes: Record<string, unknown> = {}) => [
  {
    class_id: classId,
    is_active: 1,
    deleted_at: null,
    class_status: "active",
    role: "teacher",
    profile_status: "active",
    temporary_password_must_change: 0,
    ...changes,
  },
];
const audit = (changes: Record<string, unknown> = {}) => ({
  id: auditId,
  action: "notice.created",
  actor_display_name_snapshot: "검사 선생님",
  actor_role_snapshot: "teacher",
  after_json: JSON.stringify({
    notice_id: memberId,
    title: "허용 제목",
    private_token: "hidden",
    content: "hidden",
    nested: { title: "hidden" },
  }),
  before_json: null,
  target_snapshot: JSON.stringify({ title: "대상 제목", password: "hidden" }),
  target_id: memberId,
  target_type: "notice",
  reason: null,
  created_at_precise: time,
  ...changes,
});
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

describe("MariaDB audit list boundaries", () => {
  it("checks native teacher/account booleans and exposes only approved JSON snapshot keys with ISO6", async () => {
    const target = boundary([teacher(), [audit()]]);
    const result = await target.service.list({ actorUserId: actorId, action: null, days: 365 });
    expect(result).toEqual({
      items: [
        {
          action: "notice.created",
          actor: { display_name: "검사 선생님", role: "teacher" },
          after: { notice_id: memberId, title: "허용 제목" },
          before: null,
          created_at: time,
          reason: null,
          target: { id: memberId, snapshot: { title: "대상 제목" }, type: "notice" },
        },
      ],
      next_cursor: null,
    });
    expect(target.calls[1]?.sql).toContain(
      "DATE_FORMAT(audit.created_at, '%Y-%m-%dT%H:%i:%s.%fZ')",
    );
    expect(target.calls[1]?.sql).toContain("UTC_TIMESTAMP(6) - INTERVAL ? DAY");
    expect(target.calls[1]?.parameters).toEqual([classId, 365, 21]);
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  it("keeps six cursor digits and BIGINT tie ordering through a real MySQL compilation", async () => {
    const cursor = encodeAuditLogCursor({
      action: "notice.created",
      classId,
      createdAt: time,
      days: 30,
      id: auditId,
    });
    const target = boundary([
      teacher(),
      Array.from({ length: 21 }, (_, index) =>
        audit({ id: String(BigInt(auditId) + BigInt(21 - index)) }),
      ),
    ]);
    const result = await target.service.list({
      actorUserId: actorId,
      action: "notice.created",
      days: 30,
      cursor,
    });
    expect(result.items).toHaveLength(20);
    const next = decodeAuditLogCursor(result.next_cursor!, {
      action: "notice.created",
      classId,
      days: 30,
    });
    expect(next).toMatchObject({ createdAt: time, id: String(BigInt(auditId) + 2n) });
    expect(target.calls[1]?.parameters).toEqual([
      classId,
      30,
      "notice.created",
      "2026-09-07 10:00:00.123456",
      "2026-09-07 10:00:00.123456",
      auditId,
      21,
    ]);
    expect(target.calls[1]?.sql).toContain("CAST(? AS SIGNED)");
    expect(target.calls[1]?.sql).not.toMatch(/::|to_char|timestamptz/iu);
  });

  it.each([
    [{ is_active: 0 }, UnauthenticatedException],
    [{ deleted_at: "2026-09-07 10:00:00.000000" }, UnauthenticatedException],
    [
      { role: "student", profile_status: null, temporary_password_must_change: null },
      AuditLogsRoleInsufficientException,
    ],
    [{ temporary_password_must_change: 1 }, AuditLogsRoleInsufficientException],
    [{ class_status: "archived" }, AuditLogsNotFoundException],
    [{ class_status: "suspended" }, AuditLogsClassSuspendedException],
  ])("does not query audit rows after context denial %j", async (changes, exception) => {
    const target = boundary([teacher(changes)]);
    await expect(
      target.service.list({ actorUserId: actorId, action: null, days: 7 }),
    ).rejects.toBeInstanceOf(exception);
    expect(target.calls).toHaveLength(1);
  });

  it("fails safely for malformed stored JSON and preserves null for non-object JSON values", async () => {
    const bad = boundary([teacher(), [audit({ after_json: "private malformed json" })]]);
    await expect(
      bad.service.list({ actorUserId: actorId, action: null, days: 7 }),
    ).rejects.toBeInstanceOf(AuditLogDataInvalidException);
    const valid = boundary([
      teacher(),
      [audit({ after_json: '"a scalar"', before_json: "[]", target_snapshot: "null" })],
    ]);
    const result = await valid.service.list({ actorUserId: actorId, action: null, days: 7 });
    expect(result.items[0]).toMatchObject({
      after: null,
      before: null,
      target: { snapshot: null },
    });
  });

  it("rejects invalid engines before acquiring a database connection", () => {
    const target = boundary([]);
    expect(() => new AuditLogsService(target.database, { get: () => "sqlite" } as never)).toThrow(
      "Unsupported audit-log database engine.",
    );
    expect(target.calls).toHaveLength(0);
  });
});

describe("MariaDB attendance reads shared by home", () => {
  it("keeps today's student scope and expected TIME while converting DB6 dates to existing public milliseconds", async () => {
    const target = boundary([
      [
        {
          acknowledged_at: null,
          expected_time: "09:30:00",
          id: auditId,
          notification_type: "late",
          row_version: "2",
          status: "pending",
          submitted_at: "2026-09-07 00:01:02.123456",
          updated_at: "2026-09-07 00:02:03.456789",
        },
      ],
    ]);
    await expect(
      readStudentAttendanceToday(
        target.database,
        { classId, memberId, serverToday: "2026-09-07" },
        "mariadb",
      ),
    ).resolves.toEqual({
      acknowledged_at: null,
      expected_time: "09:30",
      id: auditId,
      notification_type: "late",
      row_version: "2",
      status: "pending",
      submitted_at: "2026-09-07T00:01:02.123Z",
      updated_at: "2026-09-07T00:02:03.456Z",
    });
    expect(target.calls[0]?.parameters).toEqual([classId, memberId, "2026-09-07", "canceled"]);
    expect(target.calls[0]?.sql).toContain("CAST(? AS DATE)");
  });

  it("keeps an absent notification null", async () => {
    const target = boundary([[]]);
    await expect(
      readStudentAttendanceToday(
        target.database,
        { classId, memberId, serverToday: "2026-09-07" },
        "mariadb",
      ),
    ).resolves.toBeNull();
  });

  it("aggregates the existing student/current-day/non-canceled scope and validates numeric counts", async () => {
    const row = { total: "3", late: "1", absent: "1", early: "1", pending: "2", acknowledged: "1" };
    const target = boundary([[row]]);
    await expect(
      readAttendanceTodayCounts(target.database, { classId, serverToday: "2026-09-07" }, "mariadb"),
    ).resolves.toEqual({ total: 3, late: 1, absent: 1, early: 1, pending: 2, acknowledged: 1 });
    expect(target.calls[0]?.sql.match(/COUNT\(CASE WHEN/gu)).toHaveLength(5);
    expect(target.calls[0]?.sql).not.toMatch(/FILTER|::/u);
    expect(target.calls[0]?.parameters).toEqual([classId, "2026-09-07", "canceled", "student"]);
    const invalid = boundary([[{ ...row, total: "9007199254740992" }]]);
    await expect(
      readAttendanceTodayCounts(
        invalid.database,
        { classId, serverToday: "2026-09-07" },
        "mariadb",
      ),
    ).rejects.toThrow("Invalid MariaDB application value.");
  });
});
