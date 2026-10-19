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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateMemberProfileCommand } from "../members.types.js";
import {
  getMemberProfileMariaDb,
  listMembersMariaDb,
  updateMemberProfileMariaDb,
} from "./member-profile.js";

const actorUserId = "10000000000000000",
  targetUserId = "9007199254740993";
const actorMemberId = "10000000000000001",
  memberId = "9007199254740995",
  classId = "77";
const version = "9007199254740996",
  occurredAt = "2026-09-06 04:05:06.123456";
const command = (): UpdateMemberProfileCommand => ({
  actorUserId,
  memberId,
  expectedRowVersion: version,
  requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  displayNameInClass: "  새 이름  ",
  studentNumber: 12,
});
const failure = (status: number, code: string) => ({ status, response: { code } });
type Row = Record<string, unknown>;

// Fixed boundary responses validate compiled SQL/HTTP contracts. Real DB QA proves
// persistence, rollback and concurrency; this fixture does not simulate DB writes.
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
    member_id: actorMemberId,
    role: "teacher",
    profile_status: "active",
    temporary_password_must_change: 0,
  };
  const actorAccount = {
    id: actorUserId,
    display_name: "교사 계정",
    is_active: 1,
    deleted_at: null,
  };
  const targetAccount = {
    id: targetUserId,
    display_name: "학생 계정",
    is_active: 1,
    deleted_at: null,
  };
  const target = {
    class_id: classId,
    id: memberId,
    user_id: targetUserId,
    role: "student",
    status: "approved",
    row_version: version,
    display_name_in_class: "기존 이름",
    student_number: 8,
    status_changed_at: "2026-09-01 01:02:03.456789",
    updated_at: "2026-09-02 01:02:03.987654",
  };
  const actor = {
    ...target,
    id: actorMemberId,
    user_id: actorUserId,
    role: "teacher",
    student_number: null,
  };
  const targetClass = { id: classId, status: "active" },
    profile = { status: "active", temporary_password_must_change: 0 };
  const changed = {
    ...target,
    display_name_in_class:
      input.displayNameInClass === undefined
        ? target.display_name_in_class
        : (input.displayNameInClass?.trim() ?? null),
    student_number: input.studentNumber === undefined ? target.student_number : input.studentNumber,
    row_version: "9007199254740997",
    updated_at: occurredAt,
  };
  const rows: Row[][] = [
    [context],
    [target],
    [{ occurred_at: occurredAt }],
    [targetAccount, actorAccount],
    [targetClass],
    [target, actor],
    [profile],
  ];
  if (
    changed.display_name_in_class !== target.display_name_in_class ||
    changed.student_number !== target.student_number
  ) {
    if (changed.student_number !== target.student_number && changed.student_number !== null)
      rows.push([]);
    rows.push([], [changed], []);
  }
  const executeQuery = vi
    .spyOn(database.getExecutor(), "executeQuery")
    .mockImplementation(async (query) => {
      const next = rows.shift();
      if (!next) throw new Error("Unexpected query beyond boundary fixture");
      return { rows: next, ...(query.sql.startsWith("UPDATE ") ? { numAffectedRows: 1n } : {}) };
    });
  const execute = vi.fn(async (callback: (tx: Transaction<DB>) => Promise<unknown>) =>
    callback(database as Transaction<DB>),
  );
  const transaction = vi
    .spyOn(database, "transaction")
    .mockImplementation(() => ({ execute }) as unknown as TransactionBuilder<DB>);
  const projection = {
    ...target,
    account_display_name: targetAccount.display_name,
    is_active: 1,
    deleted_at: null,
    email_normalized: "private-name@example.invalid",
  };
  return {
    database,
    rows,
    context,
    target,
    actor,
    targetClass,
    profile,
    actorAccount,
    targetAccount,
    changed,
    projection,
    executeQuery,
    execute,
    transaction,
  };
}
afterEach(() => vi.restoreAllMocks());

describe("MariaDB member profile command boundary", () => {
  it.each(["0", "01", "-1", "1e3", "9223372036854775808"])(
    "keeps invalid member ID %s at 404 before DB",
    async (id) => {
      const h = boundary();
      await expect(
        updateMemberProfileMariaDb(h.database, { ...command(), memberId: id }),
      ).rejects.toMatchObject(failure(404, "MEMBER_NOT_FOUND"));
      expect(h.executeQuery).not.toHaveBeenCalled();
    },
  );
  it.each([
    { actorUserId: "01" },
    { requestId: "bad" },
    { expectedRowVersion: "0" },
    { expectedRowVersion: "01" },
    { expectedRowVersion: '"1"' },
    { displayNameInClass: "한" },
    { displayNameInClass: "가".repeat(21) },
    { displayNameInClass: "<b>이름</b>" },
    { displayNameInClass: "이\u0000름" },
    { displayNameInClass: "이\ud800름" },
    { studentNumber: 0 },
    { studentNumber: 100 },
    { studentNumber: 1.5 },
    { studentNumber: Number.NaN },
  ])("rejects invalid boundary input %o without SQL", async (change) => {
    const h = boundary();
    await expect(
      updateMemberProfileMariaDb(h.database, { ...command(), ...change }),
    ).rejects.toMatchObject(failure(400, "VALIDATION_FAILED"));
    expect(h.executeQuery).not.toHaveBeenCalled();
  });
  it("copies mutable input before await and binds exact BIGINT IDs, version and trimmed name", async () => {
    const original = command(),
      h = boundary(original);
    h.executeQuery.mockImplementationOnce(async () => {
      Object.assign(original, {
        actorUserId: "1",
        memberId: "2",
        expectedRowVersion: "1",
        displayNameInClass: "변경 이름",
        studentNumber: 99,
        requestId: "changed",
      });
      return { rows: h.rows.shift()! };
    });
    const result = await updateMemberProfileMariaDb(h.database, original);
    expect(result).toMatchObject({
      profile_updated: true,
      member: {
        id: memberId,
        row_version: "9007199254740997",
        display_name: "새 이름",
        student_number: 12,
        status_changed_at: "2026-09-01T01:02:03.456Z",
        requested_at: null,
      },
    });
    const queries = h.executeQuery.mock.calls.map(([query]) => query);
    expect(queries[2]!.sql).toContain("UTC_TIMESTAMP(6)");
    expect(queries[3]!.parameters).toEqual([targetUserId, actorUserId]);
    expect(queries[3]!.sql).toContain("FORCE INDEX (PRIMARY)");
    expect(queries[5]!.parameters).toEqual([memberId, actorMemberId]);
    expect(queries[6]!.sql).toContain("FOR UPDATE");
    const update = queries.find((query) => query.sql.startsWith("UPDATE "))!;
    expect(update.parameters).toEqual([
      "새 이름",
      12,
      occurredAt,
      memberId,
      classId,
      targetUserId,
      version,
    ]);
    expect(update.sql).not.toContain("status_changed_at=");
    expect(update.sql).toContain("row_version=?");
    const audit = queries.at(-1)!;
    expect(audit.parameters).toEqual([
      "교사 계정",
      actorMemberId,
      actorUserId,
      '{"display_name_snapshot":"새 이름"}',
      '{"display_name_snapshot":"기존 이름"}',
      classId,
      command().requestId,
      memberId,
      occurredAt,
    ]);
    expect(result.member).not.toHaveProperty("email_masked");
    expect(h.rows).toHaveLength(0);
  });
  it.each([{}, { displayNameInClass: "  기존 이름  " }, { studentNumber: 8 }])(
    "keeps effective no-op %o without UPDATE, audit or version increase",
    async (patch) => {
      const { displayNameInClass: _name, studentNumber: _number, ...base } = command();
      const input = { ...base, ...patch },
        h = boundary(input);
      expect(await updateMemberProfileMariaDb(h.database, input)).toMatchObject({
        profile_updated: false,
        member: { row_version: version, student_number: 8 },
      });
      expect(
        h.executeQuery.mock.calls.every(([query]) => query.sql.trimStart().startsWith("SELECT")),
      ).toBe(true);
      expect(h.rows).toHaveLength(0);
    },
  );
  it.each(["name", "number", "clear"] as const)(
    "supports partial/nullable %s changes and minimum audit data",
    async (mode) => {
      const { displayNameInClass: _name, studentNumber: _number, ...base } = command();
      const input = {
          ...base,
          ...(mode === "name"
            ? { displayNameInClass: "😀😀" }
            : mode === "number"
              ? { studentNumber: 99 }
              : { displayNameInClass: null, studentNumber: null }),
        },
        h = boundary(input);
      const result = await updateMemberProfileMariaDb(h.database, input);
      const queries = h.executeQuery.mock.calls.map(([query]) => query),
        update = queries.find((query) => query.sql.startsWith("UPDATE "))!;
      if (mode === "number") {
        expect(update.sql).not.toContain("display_name_in_class=");
        expect(queries.at(-1)!.parameters.slice(3, 5)).toEqual(["{}", "{}"]);
      } else {
        if (mode === "name") expect(update.sql).not.toContain("student_number=");
        expect(result.member.display_name).toBe(mode === "name" ? "😀😀" : "학생 계정");
      }
    },
  );
  it.each(["1", "9223372036854775808", "9".repeat(40)])(
    "compares valid oversized/stale If-Match %s before any cast or status denial",
    async (expectedRowVersion) => {
      const h = boundary();
      h.target.status = "removed";
      await expect(
        updateMemberProfileMariaDb(h.database, { ...command(), expectedRowVersion }),
      ).rejects.toMatchObject({
        ...failure(409, "RESOURCE_VERSION_CHANGED"),
        response: { code: "RESOURCE_VERSION_CHANGED", details: { current_row_version: version } },
      });
      expect(h.executeQuery).toHaveBeenCalledTimes(7);
    },
  );
  it.each([
    [0, "class_status", "suspended", 423, "CLASS_SUSPENDED"],
    [0, "class_status", "archived", 403, "ROLE_INSUFFICIENT"],
    [0, "role", "student", 403, "ROLE_INSUFFICIENT"],
    [0, "temporary_password_must_change", 1, 403, "ROLE_INSUFFICIENT"],
    [1, "class_id", "88", 404, "MEMBER_NOT_FOUND"],
    [4, "status", "archived", 404, "MEMBER_NOT_FOUND"],
    [4, "status", "suspended", 423, "CLASS_SUSPENDED"],
    [5, "status", "removed", 409, "MEMBER_STATUS_CHANGED"],
    [5, "role", "teacher", 404, "MEMBER_NOT_FOUND"],
    [6, "status", "revoked", 403, "ROLE_INSUFFICIENT"],
    [6, "temporary_password_must_change", 1, 403, "ROLE_INSUFFICIENT"],
  ] as const)("rechecks denial at query %s / %s", async (index, key, value, status, code) => {
    const h = boundary();
    h.rows[index]![0]![key] = value;
    await expect(updateMemberProfileMariaDb(h.database, command())).rejects.toMatchObject(
      failure(status, code),
    );
    expect(h.executeQuery.mock.calls.some(([query]) => /^(UPDATE|INSERT)/u.test(query.sql))).toBe(
      false,
    );
  });
  it.each([0, 1, 4, 6])(
    "rejects missing context/target/class/profile at query %s",
    async (index) => {
      const h = boundary();
      h.rows[index] = [];
      await expect(updateMemberProfileMariaDb(h.database, command())).rejects.toMatchObject(
        failure(index === 6 ? 403 : 404, index === 6 ? "ROLE_INSUFFICIENT" : "MEMBER_NOT_FOUND"),
      );
    },
  );
  it("rechecks actor account and member after locking", async () => {
    const h = boundary();
    h.actorAccount.is_active = 0;
    await expect(updateMemberProfileMariaDb(h.database, command())).rejects.toMatchObject(
      failure(401, "UNAUTHENTICATED"),
    );
    const other = boundary();
    other.actor.status = "removed";
    await expect(updateMemberProfileMariaDb(other.database, command())).rejects.toMatchObject(
      failure(403, "ROLE_INSUFFICIENT"),
    );
  });
  it("permits inactive target but rejects deleted target", async () => {
    const h = boundary();
    h.targetAccount.is_active = 0;
    expect(await updateMemberProfileMariaDb(h.database, command())).toMatchObject({
      member: { account_state: "inactive" },
    });
    const deleted = boundary();
    Object.assign(deleted.targetAccount, { deleted_at: occurredAt });
    await expect(updateMemberProfileMariaDb(deleted.database, command())).rejects.toMatchObject(
      failure(409, "MEMBER_STATUS_CHANGED"),
    );
  });
  it("checks student number across all approved accounts before writing", async () => {
    const h = boundary();
    h.rows[7] = [{ id: "9007199254740999" }];
    await expect(updateMemberProfileMariaDb(h.database, command())).rejects.toMatchObject(
      failure(409, "STUDENT_NUMBER_ALREADY_IN_USE"),
    );
    const query = h.executeQuery.mock.calls.at(-1)![0];
    expect(query.parameters).toEqual([classId, memberId, 12]);
    expect(query.sql).not.toContain("is_active");
  });
  it.each([
    { id: "99" },
    { class_id: "88" },
    { user_id: "99" },
    { role: "teacher" },
    { status: "pending" },
    { row_version: version },
    { display_name_in_class: "잘못된 이름" },
    { student_number: 13 },
    { status_changed_at: occurredAt },
    { updated_at: "2026-09-06 04:05:06.123457" },
  ])("rejects persisted row mismatch %o before audit/commit", async (change) => {
    const h = boundary();
    Object.assign(h.changed, change);
    await expect(updateMemberProfileMariaDb(h.database, command())).rejects.toMatchObject(
      failure(500, "INTERNAL_ERROR"),
    );
    expect(
      h.executeQuery.mock.calls.some(([query]) => query.sql.startsWith("INSERT INTO audit_logs")),
    ).toBe(false);
  });
  it.each(["2026-02-30 04:05:06.123456", "2026-09-06 04:05:06", "2026-09-06T04:05:06.123Z", null])(
    "rejects invalid DB clock %s",
    async (occurred_at) => {
      const h = boundary();
      h.rows[2] = [{ occurred_at }];
      await expect(updateMemberProfileMariaDb(h.database, command())).rejects.toMatchObject(
        failure(500, "INTERNAL_ERROR"),
      );
      expect(h.executeQuery).toHaveBeenCalledTimes(3);
    },
  );
  it("enforces affected-row CAS metadata", async () => {
    const h = boundary(),
      original = h.executeQuery.getMockImplementation()!;
    h.executeQuery.mockImplementation(async (...args) => {
      const result = await original(...args);
      return args[0].sql.startsWith("UPDATE ") ? { ...result, numAffectedRows: 0n } : result;
    });
    await expect(updateMemberProfileMariaDb(h.database, command())).rejects.toMatchObject(
      failure(409, "RESOURCE_VERSION_CHANGED"),
    );
    expect(h.executeQuery).toHaveBeenCalledTimes(9);
  });
  it.each(Array.from({ length: 11 }, (_, index) => index))(
    "redacts an untrusted DB failure at query %s and never retries",
    async (index) => {
      const h = boundary(),
        original = h.executeQuery.getMockImplementation()!;
      let calls = 0;
      h.executeQuery.mockImplementation(async (...args) => {
        if (calls++ === index)
          throw Object.assign(new BadRequestException("PRIVATE SQL AND EMAIL"), {
            errno: 1213,
            sqlState: "40001",
            cause: "PRIVATE",
          });
        return original(...args);
      });
      const error: unknown = await updateMemberProfileMariaDb(h.database, command()).catch(
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

describe("MariaDB teacher member reads", () => {
  it.each(["", "pending,", " pending", "left", "pending,removed' OR 1=1"])(
    "rejects invalid filter %s before DB",
    async (filter) => {
      const h = boundary();
      await expect(listMembersMariaDb(h.database, actorUserId, filter)).rejects.toMatchObject(
        failure(400, "VALIDATION_FAILED"),
      );
      expect(h.executeQuery).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, "removed,pending,removed"])(
    "binds default or deduplicated filter %s and avoids transactions",
    async (filter) => {
      const h = boundary();
      h.rows.splice(1, h.rows.length, []);
      expect(await listMembersMariaDb(h.database, actorUserId, filter)).toEqual({ members: [] });
      expect(h.executeQuery.mock.calls[1]![0].parameters).toEqual([
        classId,
        ...(filter === undefined ? ["pending", "approved"] : ["removed", "pending"]),
      ]);
      expect(h.transaction).not.toHaveBeenCalled();
    },
  );
  it("preserves status/number/Korean name/BigInt tie order and millisecond date projection", async () => {
    const h = boundary();
    const row = (id: string, status: string, extras: Row = {}) => ({
      ...h.projection,
      id,
      status,
      student_number: null,
      ...extras,
    });
    h.rows.splice(1, h.rows.length, [
      row("18", "rejoin_allowed"),
      row("17", "removed"),
      row("16", "removed", { status_changed_at: occurredAt }),
      row("15", "approved", { display_name_in_class: "나나" }),
      row("14", "approved", { display_name_in_class: "가가" }),
      row("13", "approved", { student_number: 9 }),
      row("12", "approved", { student_number: 1 }),
      row("10000000000000000", "pending", { status_changed_at: "2026-09-01 01:02:03.456001" }),
      row("9007199254740993", "pending", { status_changed_at: "2026-09-01 01:02:03.456999" }),
    ]);
    const result = await listMembersMariaDb(
      h.database,
      actorUserId,
      "pending,approved,removed,rejoin_allowed",
    );
    expect(result.members.map((member) => member.id)).toEqual([
      "9007199254740993",
      "10000000000000000",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
    ]);
    expect(result.members[0]).toMatchObject({
      email_masked: "pr***@example.invalid",
      requested_at: "2026-09-01T01:02:03.456Z",
    });
    for (const member of result.members.slice(2)) {
      expect(member).not.toHaveProperty("email_masked");
      expect(member.requested_at).toBeNull();
    }
    expect(JSON.stringify(result)).not.toContain("private-name");
  });
  it.each([
    ["a@example.invalid", "a***@example.invalid"],
    ["bad", "***"],
    ["@example.invalid", "***"],
  ])("masks pending address %s", async (email_normalized, email_masked) => {
    const h = boundary();
    h.rows.splice(1, h.rows.length, [{ ...h.projection, status: "pending", email_normalized }]);
    expect(await listMembersMariaDb(h.database, actorUserId)).toMatchObject({
      members: [{ email_masked }],
    });
  });
  it("detail selects approved same-class student without requesting email and preserves inactive fallback", async () => {
    const h = boundary();
    h.rows.splice(1, h.rows.length, [
      { ...h.projection, is_active: 0, display_name_in_class: null },
    ]);
    const result = await getMemberProfileMariaDb(h.database, actorUserId, memberId);
    expect(result.member).toMatchObject({
      account_state: "inactive",
      display_name: "학생 계정",
      requested_at: null,
    });
    expect(result.member).not.toHaveProperty("email_masked");
    const query = h.executeQuery.mock.calls[1]![0];
    expect(query.parameters).toEqual([memberId, classId]);
    expect(query.sql).toContain("m.role='student' AND m.status='approved'");
    expect(query.sql).not.toContain("email");
  });
  it("detail validates malformed ID before actor and preserves absent target404", async () => {
    const h = boundary();
    await expect(getMemberProfileMariaDb(h.database, "bad", "01")).rejects.toMatchObject(
      failure(404, "MEMBER_NOT_FOUND"),
    );
    expect(h.executeQuery).not.toHaveBeenCalled();
    h.rows.splice(1, h.rows.length, []);
    await expect(getMemberProfileMariaDb(h.database, actorUserId, memberId)).rejects.toMatchObject(
      failure(404, "MEMBER_NOT_FOUND"),
    );
  });
});
