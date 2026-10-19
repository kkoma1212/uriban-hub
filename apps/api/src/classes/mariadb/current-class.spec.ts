import type { DB } from "@classhub/db";
import { BadRequestException } from "@nestjs/common";
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type Transaction,
  type TransactionBuilder,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateCurrentClassCommand } from "../classes.types.js";
import { getCurrentClassMariaDb, updateCurrentClassMariaDb } from "./current-class.js";

const actorUserId = "9007199254740993",
  memberId = "9007199254740995",
  classId = "9007199254740997",
  version = "9007199254740999";
const updatedAt = "2026-09-06 06:30:00.123000";
const command = (): UpdateCurrentClassCommand => ({
  actorUserId,
  expectedRowVersion: version,
  name: "  새 반  ",
  expectedStudentCount: 35,
  requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
});
const failure = (status: number, code: string) => ({ status, response: { code } });
type Row = Record<string, unknown>;

// Fixed responses prove the caller and bound SQL. Actual persistence/rollback/concurrency are covered by disposable MariaDB QA.
function boundary(input = command()) {
  const database = new Kysely<DB>({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  });
  const context = {
    class_id: classId,
    class_status: "active",
    member_id: memberId,
    role: "teacher",
    profile_status: "active",
    temporary_password_must_change: 0,
  };
  const account = { id: actorUserId, display_name: "교사 계정", is_active: 1, deleted_at: null };
  const target = {
    academic_year: 2026,
    edu_office_code: "B10",
    school_code: "1234567",
    grade: 2,
    name: "기존 반",
    expected_student_count: 30,
    id: classId,
    row_version: version,
    status: "active",
    updated_at: "2026-09-01 00:00:00.000001",
  };
  const actor = { id: memberId, role: "teacher", status: "approved" },
    profile = { status: "active", temporary_password_must_change: 0 };
  const school = {
    school_name: "시험중학교",
    road_address: "서울 시험로",
    road_address_detail: "101번지",
    phone_number: "02-123-4567",
    homepage_url: "https://school.example.invalid",
  };
  const changed = {
    ...target,
    name: input.name?.trim() ?? target.name,
    expected_student_count: input.expectedStudentCount ?? target.expected_student_count,
    row_version: "9007199254741000",
    updated_at: updatedAt,
  };
  const rows: Row[][] = [[context], [account], [target], [actor], [profile]];
  if (changed.name !== target.name) rows.push([]);
  if (
    changed.name !== target.name ||
    changed.expected_student_count !== target.expected_student_count
  )
    rows.push([], [changed], []);
  rows.push([school], [{ count: "2" }]);
  const executeQuery = vi
    .spyOn(database.getExecutor(), "executeQuery")
    .mockImplementation(async (query) => {
      const next = rows.shift();
      if (!next) throw new Error("Query exceeds boundary fixture");
      return { rows: next, ...(query.sql.startsWith("UPDATE ") ? { numAffectedRows: 1n } : {}) };
    });
  const execute = vi.fn(async (callback: (tx: Transaction<DB>) => Promise<unknown>) =>
    callback(database as Transaction<DB>),
  );
  const transaction = vi
    .spyOn(database, "transaction")
    .mockImplementation(() => ({ execute }) as unknown as TransactionBuilder<DB>);
  const current = {
    ...target,
    ...school,
    role: "teacher",
    teacher_display_name: account.display_name,
  };
  return {
    database,
    context,
    account,
    target,
    actor,
    profile,
    school,
    changed,
    current,
    rows,
    executeQuery,
    transaction,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T06:30:00.123Z"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MariaDB current class update", () => {
  it.each([
    { actorUserId: "01" },
    { actorUserId: "9223372036854775808" },
    { requestId: "bad" },
    { expectedRowVersion: "0" },
    { expectedRowVersion: '"1"' },
    { expectedRowVersion: "01" },
    { name: " " },
    { name: "가".repeat(41) },
    { name: "<b>반</b>" },
    { name: "반\u0000이름" },
    { name: "반\ud800이름" },
    { name: null },
    { expectedStudentCount: null },
    { expectedStudentCount: 0 },
    { expectedStudentCount: 61 },
    { expectedStudentCount: 1.5 },
  ])("rejects invalid input before DB: %o", async (patch) => {
    const h = boundary();
    await expect(
      updateCurrentClassMariaDb(h.database, {
        ...command(),
        ...patch,
      } as UpdateCurrentClassCommand),
    ).rejects.toMatchObject(failure(400, "VALIDATION_FAILED"));
    expect(h.executeQuery).not.toHaveBeenCalled();
  });
  it("snapshots input, binds version/identity, locks in contract order and audits changed fields only", async () => {
    const original = command(),
      h = boundary(original);
    h.executeQuery.mockImplementationOnce(async () => {
      Object.assign(original, {
        actorUserId: "1",
        expectedRowVersion: "1",
        name: "변조",
        expectedStudentCount: 60,
        requestId: "bad",
      });
      return { rows: h.rows.shift()! };
    });
    const result = await updateCurrentClassMariaDb(h.database, original);
    expect(result).toEqual({
      academic_year: 2026,
      active_student_count: 2,
      expected_student_count: 35,
      grade: 2,
      id: classId,
      name: "새 반",
      role: "teacher",
      row_version: "9007199254741000",
      school_address: "서울 시험로 101번지",
      school_homepage_url: h.school.homepage_url,
      school_phone_number: h.school.phone_number,
      school_name: "시험중학교",
      status: "active",
      teacher_display_name: "교사 계정",
    });
    const queries = h.executeQuery.mock.calls.map(([query]) => query);
    expect(queries[0]!.parameters).toEqual([actorUserId]);
    expect(queries.slice(1, 5).map((query) => query.parameters)).toEqual([
      [actorUserId],
      [classId],
      [memberId, classId, actorUserId],
      [actorUserId],
    ]);
    for (const query of queries.slice(1, 5)) expect(query.sql).toContain("FOR UPDATE");
    expect(queries[6]!.parameters).toEqual(["새 반", 35, updatedAt, classId, version]);
    expect(queries[6]!.sql).toContain("row_version=? AND status='active'");
    expect(queries[8]!.parameters).toEqual([
      "교사 계정",
      memberId,
      actorUserId,
      '{"name":"새 반","expected_student_count":35}',
      '{"name":"기존 반","expected_student_count":30}',
      classId,
      command().requestId,
      classId,
    ]);
    expect(queries[8]!.sql).not.toContain("created_at");
    expect(queries.at(-1)!.sql).toContain("a.is_active=1 AND a.deleted_at IS NULL");
    expect(h.rows).toHaveLength(0);
  });
  it.each([
    { name: undefined, expectedStudentCount: undefined },
    { name: " 기존 반 ", expectedStudentCount: 30 },
  ])("preserves effective no-op without audit/version/time writes: %o", async (patch) => {
    const input = { ...command(), ...patch },
      h = boundary(input);
    expect(await updateCurrentClassMariaDb(h.database, input)).toMatchObject({
      name: "기존 반",
      row_version: version,
      expected_student_count: 30,
    });
    expect(
      h.executeQuery.mock.calls.every(([query]) => query.sql.trimStart().startsWith("SELECT")),
    ).toBe(true);
    expect(h.rows).toHaveLength(0);
  });
  it.each(["name", "count"] as const)(
    "changes only requested %s column and audit key",
    async (mode) => {
      const input = {
          ...command(),
          name: mode === "name" ? "😀" : undefined,
          expectedStudentCount: mode === "count" ? 1 : undefined,
        },
        h = boundary(input);
      await updateCurrentClassMariaDb(h.database, input);
      const queries = h.executeQuery.mock.calls.map(([query]) => query),
        update = queries.find((query) => query.sql.startsWith("UPDATE "))!,
        audit = queries.find((query) => query.sql.startsWith("INSERT INTO audit_logs"))!;
      expect(update.sql).not.toContain(mode === "name" ? "expected_student_count=" : "name=");
      expect(JSON.parse(audit.parameters[3] as string)).toEqual(
        mode === "name" ? { name: "😀" } : { expected_student_count: 1 },
      );
      if (mode === "count")
        expect(queries.some((query) => query.sql.includes("name_normalized"))).toBe(false);
    },
  );
  it("uses bound exact measured whitespace, UCA case fold and binary normalized duplicate lookup", async () => {
    const h = boundary();
    h.rows[5] = [{ id: "100" }];
    await expect(updateCurrentClassMariaDb(h.database, command())).rejects.toMatchObject(
      failure(409, "CLASS_ALREADY_EXISTS"),
    );
    const query = h.executeQuery.mock.calls.at(-1)![0];
    expect(query.parameters.slice(0, 6)).toEqual([classId, "B10", "1234567", 2026, 2, "새 반"]);
    expect(query.parameters[6]).toBe(
      String.raw`[\x{0009}-\x{000D}\x{0020}\x{0085}\x{2000}-\x{2006}\x{2008}-\x{200A}\x{2028}-\x{2029}\x{205F}\x{3000}]+`,
    );
    expect(query.sql).toContain("BINARY name_normalized=BINARY LOWER");
    expect(query.sql).toContain("COLLATE utf8mb4_uca1400_as_ci");
    expect(query.sql).toContain("status IN ('active','suspended')");
  });
  it.each(["1", "9223372036854775808", "9".repeat(40)])(
    "keeps stale/oversized positive version %s at 409 before duplicate or no-op",
    async (expectedRowVersion) => {
      const input = {
          ...command(),
          name: undefined,
          expectedStudentCount: undefined,
          expectedRowVersion,
        },
        h = boundary(input);
      await expect(updateCurrentClassMariaDb(h.database, input)).rejects.toMatchObject({
        status: 409,
        response: { code: "RESOURCE_VERSION_CHANGED", details: { current_row_version: version } },
      });
      expect(h.executeQuery).toHaveBeenCalledTimes(5);
    },
  );
  it.each([
    [0, "class_status", "suspended", 423, "CLASS_SUSPENDED"],
    [0, "class_status", "archived", 404, "NOT_FOUND"],
    [0, "role", "student", 403, "ROLE_INSUFFICIENT"],
    [0, "profile_status", "revoked", 403, "ROLE_INSUFFICIENT"],
    [0, "temporary_password_must_change", 1, 403, "ROLE_INSUFFICIENT"],
    [1, "is_active", 0, 401, "UNAUTHENTICATED"],
    [1, "deleted_at", updatedAt, 401, "UNAUTHENTICATED"],
    [2, "status", "suspended", 423, "CLASS_SUSPENDED"],
    [2, "status", "archived", 404, "NOT_FOUND"],
    [3, "role", "student", 403, "ROLE_INSUFFICIENT"],
    [3, "status", "removed", 403, "ROLE_INSUFFICIENT"],
    [4, "status", "revoked", 403, "ROLE_INSUFFICIENT"],
    [4, "temporary_password_must_change", 1, 403, "ROLE_INSUFFICIENT"],
  ] as const)(
    "rechecks authorization at query %s / %s",
    async (index, key, value, status, code) => {
      const h = boundary();
      h.rows[index]![0]![key] = value;
      await expect(updateCurrentClassMariaDb(h.database, command())).rejects.toMatchObject(
        failure(status, code),
      );
      expect(h.executeQuery.mock.calls.some(([query]) => /^(INSERT|UPDATE)/u.test(query.sql))).toBe(
        false,
      );
    },
  );
  it.each([
    [0, 404, "NOT_FOUND"],
    [1, 401, "UNAUTHENTICATED"],
    [2, 404, "NOT_FOUND"],
    [3, 403, "ROLE_INSUFFICIENT"],
    [4, 403, "ROLE_INSUFFICIENT"],
  ] as const)("rejects missing row at query %s", async (index, status, code) => {
    const h = boundary();
    h.rows[index] = [];
    await expect(updateCurrentClassMariaDb(h.database, command())).rejects.toMatchObject(
      failure(status, code),
    );
  });
  it.each([
    { id: "99" },
    { name: "다른 이름" },
    { expected_student_count: 36 },
    { row_version: version },
    { updated_at: "2026-09-06 06:30:00.123001" },
    { status: "suspended" },
    { edu_office_code: "B11" },
    { school_code: "7654321" },
    { academic_year: 2027 },
    { grade: 3 },
  ])("rejects unexpected stored row %o before audit", async (patch) => {
    const h = boundary();
    Object.assign(h.changed, patch);
    await expect(updateCurrentClassMariaDb(h.database, command())).rejects.toMatchObject(
      failure(500, "INTERNAL_ERROR"),
    );
    expect(
      h.executeQuery.mock.calls.some(([query]) => query.sql.startsWith("INSERT INTO audit_logs")),
    ).toBe(false);
  });
  it("requires affected-row CAS proof", async () => {
    const h = boundary(),
      original = h.executeQuery.getMockImplementation()!;
    h.executeQuery.mockImplementation(async (...args) => {
      const result = await original(...args);
      return args[0].sql.startsWith("UPDATE ") ? { ...result, numAffectedRows: 0n } : result;
    });
    await expect(updateCurrentClassMariaDb(h.database, command())).rejects.toMatchObject(
      failure(409, "RESOURCE_VERSION_CHANGED"),
    );
    expect(h.executeQuery).toHaveBeenCalledTimes(7);
  });
  it.each(Array.from({ length: 11 }, (_, index) => index))(
    "redacts DB failure at query %s without automatic retry",
    async (index) => {
      const h = boundary(),
        original = h.executeQuery.getMockImplementation()!;
      let calls = 0;
      h.executeQuery.mockImplementation(async (...args) => {
        if (calls++ === index)
          throw Object.assign(new BadRequestException("PRIVATE SQL EMAIL"), {
            errno: 1062,
            sqlState: "23000",
            cause: "PRIVATE",
          });
        return original(...args);
      });
      const error: unknown = await updateCurrentClassMariaDb(h.database, command()).catch(
        (error: unknown) => error,
      );
      expect(error).toMatchObject(failure(500, "INTERNAL_ERROR"));
      expect(JSON.stringify(error)).not.toContain("PRIVATE");
      expect(error).not.toHaveProperty("cause");
      expect(calls).toBe(index + 1);
      expect(h.transaction.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );
});

describe("MariaDB current class read", () => {
  it.each(["teacher", "student"])(
    "projects exact %s school details and count with role privacy",
    async (role) => {
      const h = boundary();
      h.current.role = role;
      h.rows.splice(0, h.rows.length, [h.current], [{ count: "2" }]);
      const result = await getCurrentClassMariaDb(h.database, actorUserId);
      expect(result).toEqual({
        academic_year: 2026,
        active_student_count: 2,
        ...(role === "teacher" ? { expected_student_count: 30 } : {}),
        grade: 2,
        id: classId,
        name: "기존 반",
        role,
        row_version: version,
        school_address: "서울 시험로 101번지",
        school_homepage_url: h.school.homepage_url,
        school_phone_number: h.school.phone_number,
        school_name: "시험중학교",
        status: "active",
        teacher_display_name: "교사 계정",
      });
      const query = h.executeQuery.mock.calls[0]![0];
      expect(query.sql).toContain("m.status='approved'");
      expect(query.sql).toContain("t.role='teacher' AND t.status='approved'");
      expect(query.sql).not.toContain("teacher_profiles");
      expect(query.parameters).toEqual([actorUserId]);
      expect(h.transaction).not.toHaveBeenCalled();
    },
  );
  it("preserves nullable school contacts/address and zero active students", async () => {
    const h = boundary();
    Object.assign(h.current, {
      road_address: null,
      road_address_detail: null,
      homepage_url: null,
      phone_number: null,
    });
    h.rows.splice(0, h.rows.length, [h.current], [{ count: "0" }]);
    expect(await getCurrentClassMariaDb(h.database, actorUserId)).toMatchObject({
      active_student_count: 0,
      school_address: null,
      school_homepage_url: null,
      school_phone_number: null,
    });
  });
  it.each([
    ["status", "suspended", 423, "CLASS_SUSPENDED"],
    ["status", "archived", 404, "NOT_FOUND"],
    ["role", "other", 404, "NOT_FOUND"],
  ] as const)("rejects unsupported current class %s/%s", async (key, value, status, code) => {
    const h = boundary();
    h.current[key] = value;
    h.rows.splice(0, h.rows.length, [h.current]);
    await expect(getCurrentClassMariaDb(h.database, actorUserId)).rejects.toMatchObject(
      failure(status, code),
    );
  });
  it("validates actor before SQL and returns absent current class404", async () => {
    const h = boundary();
    await expect(getCurrentClassMariaDb(h.database, "01")).rejects.toMatchObject(
      failure(400, "VALIDATION_FAILED"),
    );
    expect(h.executeQuery).not.toHaveBeenCalled();
    h.rows.splice(0, h.rows.length, []);
    await expect(getCurrentClassMariaDb(h.database, actorUserId)).rejects.toMatchObject(
      failure(404, "NOT_FOUND"),
    );
  });
  it.each(["-1", "01", "9007199254740992", 2, null])(
    "rejects corrupt/nonexact count %s without leaking DB values",
    async (count) => {
      const h = boundary();
      h.rows.splice(0, h.rows.length, [h.current], [{ count }]);
      await expect(getCurrentClassMariaDb(h.database, actorUserId)).rejects.toMatchObject(
        failure(500, "INTERNAL_ERROR"),
      );
    },
  );
});
