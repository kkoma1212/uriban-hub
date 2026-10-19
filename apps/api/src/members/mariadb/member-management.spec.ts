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
import type { ApproveMemberCommand, MemberTransitionCommand } from "../members.types.js";
import {
  approveMemberMariaDb,
  rejectMemberMariaDb,
  removeMemberMariaDb,
  allowMemberRejoinMariaDb,
} from "./member-management.js";

const operations = [
  {
    name: "approve",
    run: approveMemberMariaDb,
    before: "pending",
    after: "approved",
    routine: "approve_class_member",
  },
  {
    name: "reject",
    run: rejectMemberMariaDb,
    before: "pending",
    after: "rejected",
    routine: "reject_class_member",
  },
  {
    name: "remove",
    run: removeMemberMariaDb,
    before: "approved",
    after: "removed",
    routine: "remove_class_member",
  },
  {
    name: "rejoin",
    run: allowMemberRejoinMariaDb,
    before: "removed",
    after: "rejoin_allowed",
    routine: "allow_class_member_rejoin",
  },
] as const;
type Operation = (typeof operations)[number];
type Command = ApproveMemberCommand & MemberTransitionCommand;
const actorUserId = "9007199254740993",
  targetUserId = "10000000000000000";
const actorMemberId = "10000000000000001",
  targetMemberId = "9007199254740995",
  classId = "77";
const occurredAt = "2026-09-06 04:05:06.123456";
const command = (): Command => ({
  actorUserId,
  memberId: targetMemberId,
  requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  displayNameInClass: "  새 이름  ",
  studentNumber: 12,
  reason: "  새 사유  ",
});
const failure = (status: number, code: string) => ({ status, response: { code } });

// Fixed query results check caller behavior and compiled bindings, without a DB
// state engine or simulated routine writes. Real MariaDB QA proves persistence,
// constraint behavior, rollback and concurrency. DummyDriver cannot connect.
function boundary(operation: Operation, input = command()) {
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
    deleted_at: null,
    is_active: 1,
    display_name: "교사 계정",
  };
  const targetAccount = {
    id: targetUserId,
    deleted_at: null,
    is_active: 1,
    display_name: "학생 계정",
  };
  const target = {
    id: targetMemberId,
    class_id: classId,
    user_id: targetUserId,
    role: "student",
    status: operation.before,
    row_version: "9007199254740996",
    display_name_in_class: "기존 이름",
    student_number: operation.name === "remove" ? 8 : null,
  };
  const actor = {
    ...target,
    id: actorMemberId,
    user_id: actorUserId,
    role: "teacher",
    status: "approved",
    student_number: null,
  };
  const changed = {
    ...target,
    status: operation.after,
    row_version: "9007199254740997",
    display_name_in_class:
      operation.name === "approve"
        ? (input.displayNameInClass?.trim() ?? null)
        : target.display_name_in_class,
    student_number: operation.name === "approve" ? input.studentNumber : null,
  };
  const rows: Record<string, unknown>[][] = [
    [context],
    [{ class_id: classId, id: targetMemberId, user_id: targetUserId }],
    [actorAccount, targetAccount],
    [{ id: classId, status: "active", expected_student_count: 30 }],
    [target, actor],
    [{ status: "active", temporary_password_must_change: 0 }],
  ];
  if (operation.name !== "approve") rows.push([{ reason: "이전 사유" }]);
  else if (input.studentNumber !== null) rows.push([]);
  const callIndex = rows.length;
  rows.push([], [{ occurred_at: occurredAt }], [changed]);
  const deleteTables = operation.name === "approve" ? ["notice_reads", "supply_checks"] : [];
  // 2026-10-02 P-025①: 승인 때 기존 '반 전체' 공지·준비물 받는 사람에 넣는 INSERT 두 개.
  const classWideInserts =
    operation.name === "approve" ? ["notice_recipients", "supply_recipients"] : [];
  rows.push(...deleteTables.map(() => []), ...classWideInserts.map(() => []), []);
  if (operation.name === "approve") rows.push([{ count: "31" }]);
  const executeQuery = vi
    .spyOn(database.getExecutor(), "executeQuery")
    .mockImplementation(async () => {
      const next = rows.shift();
      if (!next) throw new Error("Query beyond this caller boundary fixture");
      return { rows: next };
    });
  const execute = vi.fn(async (callback: (tx: Transaction<DB>) => Promise<unknown>) =>
    callback(database as Transaction<DB>),
  );
  const transaction = vi
    .spyOn(database, "transaction")
    .mockImplementation(() => ({ execute }) as unknown as TransactionBuilder<DB>);
  return {
    database,
    context,
    actorAccount,
    targetAccount,
    actor,
    target,
    changed,
    rows,
    callIndex,
    deleteTables,
    classWideInserts,
    executeQuery,
    execute,
    transaction,
  };
}
afterEach(() => vi.restoreAllMocks());

describe.each(operations)("MariaDB member-management $name", (operation) => {
  it.each(["0", "000", "-1", "1.0", "1e3", "wrong", "9223372036854775808"])(
    "keeps malformed target path ID %s at 404 before DB access",
    async (memberId) => {
      const harness = boundary(operation);
      await expect(
        operation.run(harness.database, { ...command(), memberId }),
      ).rejects.toMatchObject(failure(404, "MEMBER_NOT_FOUND"));
      expect(harness.executeQuery).not.toHaveBeenCalled();
    },
  );
  it.each([
    { actorUserId: "0" },
    { actorUserId: "01" },
    { actorUserId: "9223372036854775808" },
    { requestId: "invalid" },
  ])("rejects malformed authenticated identity/UUID at 400: %o", async (change) => {
    const harness = boundary(operation);
    await expect(
      operation.run(harness.database, { ...command(), ...change }),
    ).rejects.toMatchObject(failure(400, "VALIDATION_FAILED"));
    expect(harness.executeQuery).not.toHaveBeenCalled();
  });
  it("normalizes leading zero target IDs and snapshots the command before the first await", async () => {
    const original = { ...command(), memberId: `000${targetMemberId}` },
      harness = boundary(operation, original);
    harness.executeQuery.mockImplementationOnce(async () => {
      Object.assign(original, {
        actorUserId: "1",
        memberId: "2",
        requestId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        reason: "변경 사유",
        displayNameInClass: "변경 이름",
        studentNumber: 99,
      });
      return { rows: harness.rows.shift()! };
    });
    await operation.run(harness.database, original);
    expect(harness.executeQuery.mock.calls[1]![0].parameters).toEqual([targetMemberId]);
    const call = harness.executeQuery.mock.calls[harness.callIndex]![0];
    expect(call.parameters).toEqual([
      classId,
      actorUserId,
      actorMemberId,
      targetUserId,
      targetMemberId,
      ...(operation.name === "approve" ? ["새 이름", 12] : ["새 사유"]),
    ]);
    const audit = harness.executeQuery.mock.calls.find(([query]) =>
      query.sql.includes("INSERT INTO audit_logs"),
    )![0];
    expect(audit.parameters[8]).toBe(command().requestId);
  });
  it("returns context404 before target lookup and preserves current-student role visibility", async () => {
    const harness = boundary(operation);
    harness.rows[0] = [];
    await expect(operation.run(harness.database, command())).rejects.toMatchObject(
      failure(404, "MEMBER_NOT_FOUND"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(1);
    expect(harness.executeQuery.mock.calls[0]![0].sql).toContain(
      "m.status IN ('pending','approved')",
    );
    expect(harness.executeQuery.mock.calls[0]![0].sql).not.toContain("m.role='teacher'");
    expect(harness.transaction).not.toHaveBeenCalled();
  });
  it.each([undefined, "other-class"])(
    "keeps target %s 404 ahead of teacher access and suspension",
    async (class_id) => {
      const harness = boundary(operation);
      harness.rows[0] = [
        { ...harness.context, role: "student", class_status: "suspended", profile_status: null },
      ];
      harness.rows[1] = class_id ? [{ id: targetMemberId, user_id: targetUserId, class_id }] : [];
      await expect(operation.run(harness.database, command())).rejects.toMatchObject(
        failure(404, "MEMBER_NOT_FOUND"),
      );
      expect(harness.executeQuery).toHaveBeenCalledTimes(2);
      expect(harness.transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    [{ class_status: "suspended", role: "student" }, 423, "CLASS_SUSPENDED"],
    [{ role: "student" }, 403, "ROLE_INSUFFICIENT"],
    [{ profile_status: "revoked" }, 403, "ROLE_INSUFFICIENT"],
    [{ temporary_password_must_change: 1 }, 403, "ROLE_INSUFFICIENT"],
  ] as const)("preserves initial teacher access precedence: %o", async (change, status, code) => {
    const harness = boundary(operation);
    harness.rows[0] = [{ ...harness.context, ...change }];
    await expect(operation.run(harness.database, command())).rejects.toMatchObject(
      failure(status, code),
    );
    expect(harness.transaction).not.toHaveBeenCalled();
  });
  it("preserves operation-specific account error precedence when both accounts disappear", async () => {
    const harness = boundary(operation);
    harness.rows[2] = [];
    await expect(operation.run(harness.database, command())).rejects.toMatchObject(
      operation.name === "approve"
        ? failure(409, "MEMBER_ACCOUNT_INACTIVE")
        : failure(403, "ROLE_INSUFFICIENT"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(3);
  });
  it("preserves the missing target account boundary with an eligible actor", async () => {
    const harness = boundary(operation);
    harness.rows[2] = [harness.actorAccount];
    await expect(operation.run(harness.database, command())).rejects.toMatchObject(
      operation.name === "approve"
        ? failure(409, "MEMBER_ACCOUNT_INACTIVE")
        : failure(404, "MEMBER_NOT_FOUND"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(3);
  });
  it("checks teacher membership and profile before a missing target membership", async () => {
    const harness = boundary(operation);
    harness.rows[4] = [harness.actor];
    harness.rows[5] = [{ status: "revoked", temporary_password_must_change: 0 }];
    await expect(operation.run(harness.database, command())).rejects.toMatchObject(
      failure(403, "ROLE_INSUFFICIENT"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(6);
  });
  it("rejects a target state changed after the preliminary lookup", async () => {
    const harness = boundary(operation);
    harness.rows[4] = [{ ...harness.target, status: "left" }, harness.actor];
    await expect(operation.run(harness.database, command())).rejects.toMatchObject(
      failure(409, "MEMBER_STATUS_CHANGED"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(6);
  });
  it("preserves numeric lock order, actor snapshots, timestamps and operation-owned cleanup", async () => {
    const harness = boundary(operation);
    const result = await operation.run(harness.database, command());
    const queries = harness.executeQuery.mock.calls.map(([query]) => query);
    expect(queries[2]!.sql).toContain("FROM users FORCE INDEX (PRIMARY)");
    expect(queries[2]!.sql).toContain("ORDER BY id FOR UPDATE");
    expect(queries[2]!.parameters).toEqual([actorUserId, targetUserId]);
    expect(queries[3]!.sql).toMatch(/FROM classes WHERE id=\? FOR UPDATE/u);
    expect(queries[3]!.parameters).toEqual([classId]);
    expect(queries[4]!.sql).toContain("ORDER BY id FOR UPDATE");
    expect(queries[4]!.parameters).toEqual([targetMemberId, actorMemberId]);
    expect(queries[5]!.sql).toMatch(/FROM teacher_profiles WHERE user_id=\? FOR UPDATE/u);
    expect(queries[harness.callIndex]!.sql).toContain(`CALL ${operation.routine}(`);
    const oldReason = operation.name === "approve" ? null : "이전 사유",
      reason = operation.name === "approve" ? null : "새 사유";
    const history = queries.find((query) =>
      query.sql.includes("SELECT reason FROM class_member_status_history"),
    );
    if (operation.name === "approve") expect(history).toBeUndefined();
    else {
      expect(history!.sql).toContain("ORDER BY created_at DESC,id DESC LIMIT 1");
      expect(history!.parameters).toEqual([targetMemberId, operation.before]);
    }
    expect(queries[harness.callIndex + 2]!.parameters).toEqual([
      targetMemberId,
      classId,
      targetUserId,
      operation.after,
      occurredAt,
      occurredAt,
      operation.before,
      operation.after,
      actorUserId,
      actorMemberId,
      reason,
      occurredAt,
    ]);
    const deletes = queries.filter((query) => query.sql.trim().startsWith("DELETE"));
    expect(deletes.map((query) => query.sql.trim())).toEqual(
      harness.deleteTables.map((table) => `DELETE FROM ${table} WHERE member_id=?`),
    );
    for (const query of deletes) expect(query.parameters).toEqual([targetMemberId]);
    const classWide = queries.filter((query) =>
      /^INSERT INTO (notice|supply)_recipients/u.test(query.sql.trim()),
    );
    expect(classWide.map((query) => query.sql.trim().split(" ")[2])).toEqual(
      harness.classWideInserts,
    );
    for (const query of classWide) {
      expect(query.sql).toContain("audience_mode = 'all_snapshot'");
      expect(query.parameters).toEqual([classId, targetMemberId]);
    }
    expect(queries.map((query) => query.sql).join("\n")).not.toMatch(
      /election|api_idempotency|email_verified|signup_approved/u,
    );
    const audit = queries.find((query) => query.sql.includes("INSERT INTO audit_logs"))!;
    expect(audit.parameters).toEqual([
      `member.${operation.after}`,
      "교사 계정",
      actorMemberId,
      actorUserId,
      JSON.stringify({
        display_name_snapshot: operation.name === "approve" ? "새 이름" : "기존 이름",
        member_id: targetMemberId,
        reason,
        role: "student",
        status: operation.after,
      }),
      JSON.stringify({
        display_name_snapshot: "기존 이름",
        member_id: targetMemberId,
        reason: oldReason,
        role: "student",
        status: operation.before,
      }),
      classId,
      reason,
      command().requestId,
      targetMemberId,
      occurredAt,
    ]);
    expect(result.member).toMatchObject({
      id: targetMemberId,
      row_version: "9007199254740997",
      status: operation.after,
      status_changed_at: "2026-09-06T04:05:06.123Z",
    });
    if (operation.name !== "approve")
      expect(result).toEqual({
        member: {
          id: targetMemberId,
          reason: "새 사유",
          row_version: "9007199254740997",
          status: operation.after,
          status_changed_at: "2026-09-06T04:05:06.123Z",
        },
      });
    expect(harness.rows).toEqual([]);
    expect(harness.transaction).toHaveBeenCalledTimes(1);
  });
  it.each([
    { user_id: "2" },
    { row_version: "9007199254740996" },
    { role: "teacher" },
    { display_name_in_class: "다른 이름" },
  ])(
    "rejects changed result identity/version/content before cleanup or audit: %o",
    async (change) => {
      const harness = boundary(operation);
      harness.rows[harness.callIndex + 2] = [{ ...harness.changed, ...change }];
      await expect(operation.run(harness.database, command())).rejects.toMatchObject(
        failure(500, "INTERNAL_ERROR"),
      );
      expect(harness.executeQuery).toHaveBeenCalledTimes(harness.callIndex + 3);
    },
  );
  it.each([
    null,
    "2026-09-06 04:05:06.123",
    "2025-02-29 00:00:00.000000",
    "2026-09-06 24:00:00.000000",
  ])("rejects invalid OUT timestamp %o", async (occurred_at) => {
    const harness = boundary(operation);
    harness.rows[harness.callIndex + 1] = [{ occurred_at }];
    await expect(operation.run(harness.database, command())).rejects.toMatchObject(
      failure(500, "INTERNAL_ERROR"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(harness.callIndex + 2);
  });
  it.each([
    { errno: 1213, sqlState: "40001" },
    { errno: 1205, sqlState: "HY000" },
    { errno: 1062, sqlState: "23000", constraint: "class_members_student_number_unique" },
    new Error("private COMMIT acknowledgement"),
    new BadRequestException({ code: "PRIVATE", message: "private SQL" }),
  ])("does not retry or expose unknown transaction errors: %o", async (native) => {
    const harness = boundary(operation);
    harness.execute.mockRejectedValueOnce(native);
    const error: unknown = await operation
      .run(harness.database, command())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject(failure(500, "INTERNAL_ERROR"));
    expect(JSON.stringify(error)).not.toContain("private");
    expect(error).not.toHaveProperty("cause");
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.executeQuery).toHaveBeenCalledTimes(2);
  });
});

describe("MariaDB approval-specific boundaries", () => {
  const operation = operations[0];
  it.each([
    { studentNumber: 0 },
    { studentNumber: 100 },
    { studentNumber: 1.5 },
    { studentNumber: undefined },
    { displayNameInClass: "가" },
    { displayNameInClass: "😀".repeat(21) },
    { displayNameInClass: "<b>학생</b>" },
    { displayNameInClass: "학생\n이름" },
    { displayNameInClass: "학생\uD800" },
    { displayNameInClass: undefined },
  ])("validates approval-only DTO fields before DB: %o", async (change) => {
    const harness = boundary(operation);
    await expect(
      approveMemberMariaDb(harness.database, { ...command(), ...change } as ApproveMemberCommand),
    ).rejects.toMatchObject(failure(400, "VALIDATION_FAILED"));
    expect(harness.executeQuery).not.toHaveBeenCalled();
  });
  it.each([
    { studentNumber: null, displayNameInClass: null },
    { studentNumber: 1, displayNameInClass: "😀😀" },
    { studentNumber: 99, displayNameInClass: "😀".repeat(20) },
  ])("accepts nullable fields and exact code-point/number boundaries: %o", async (change) => {
    const input = { ...command(), ...change },
      harness = boundary(operation, input);
    const result = await approveMemberMariaDb(harness.database, input);
    expect(result.member).toMatchObject({
      display_name: change.displayNameInClass ?? "학생 계정",
      display_name_in_class: change.displayNameInClass,
      student_number: change.studentNumber,
      account_state: "active",
      requested_at: null,
    });
    expect(input).toEqual({ ...command(), ...change });
  });
  it("keeps duplicate approved student numbers at 409 before CALL without an active-account filter", async () => {
    const harness = boundary(operation);
    harness.rows[6] = [{ id: "88" }];
    await expect(approveMemberMariaDb(harness.database, command())).rejects.toMatchObject(
      failure(409, "STUDENT_NUMBER_ALREADY_IN_USE"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(7);
    const query = harness.executeQuery.mock.calls[6]![0];
    expect(query.sql).toContain("status='approved' AND student_number=?");
    expect(query.sql).not.toMatch(/users|is_active|deleted_at/u);
  });
  it.each(["30", "31", "9007199254740993"])(
    "warns only above expected student count %s and still returns approval",
    async (count) => {
      const harness = boundary(operation);
      harness.rows[harness.rows.length - 1] = [{ count }];
      const result = await approveMemberMariaDb(harness.database, command());
      expect(result.member.status).toBe("approved");
      expect(result.warnings).toEqual(count === "30" ? [] : ["EXPECTED_STUDENT_COUNT_EXCEEDED"]);
      const sql = harness.executeQuery.mock.calls.at(-1)![0].sql;
      expect(sql).toContain(
        "m.role='student' AND m.status='approved' AND a.is_active=TRUE AND a.deleted_at IS NULL",
      );
    },
  );
  it.each([{ is_active: 0 }, { deleted_at: occurredAt }])(
    "rejects inactive/deleted approval targets before actor account eligibility: %o",
    async (change) => {
      const harness = boundary(operation);
      harness.rows[2] = [{ ...harness.targetAccount, ...change }];
      await expect(approveMemberMariaDb(harness.database, command())).rejects.toMatchObject(
        failure(409, "MEMBER_ACCOUNT_INACTIVE"),
      );
      expect(harness.executeQuery).toHaveBeenCalledTimes(3);
    },
  );
});

describe.each(operations.slice(1))(
  "MariaDB $name reason and inactive-target boundaries",
  (operation) => {
    it.each(["가".repeat(301), "<p>사유</p>", "사유\n내용", "사유\uD800"])(
      "rejects invalid reason %s before DB",
      async (reason) => {
        const harness = boundary(operation);
        await expect(
          operation.run(harness.database, { ...command(), reason }),
        ).rejects.toMatchObject(failure(400, "VALIDATION_FAILED"));
        expect(harness.executeQuery).not.toHaveBeenCalled();
      },
    );
    it.each([null, "  ", "😀".repeat(300)])(
      "normalizes nullable/empty reason and accepts 300 code points",
      async (reason) => {
        const input = { ...command(), reason },
          harness = boundary(operation, input);
        const result = await operation.run(harness.database, input);
        expect(result.member).toMatchObject({ reason: reason?.trim() || null });
        const audit = harness.executeQuery.mock.calls.at(-1)![0];
        expect(audit.parameters[7]).toBe(reason?.trim() || null);
        expect(JSON.parse(audit.parameters[5] as string)).toMatchObject({ reason: "이전 사유" });
        expect(input.reason).toBe(reason);
      },
    );
    it.each([{ is_active: 0 }, { deleted_at: occurredAt }])(
      "allows an existing inactive/deleted target without adding approval gates: %o",
      async (change) => {
        const harness = boundary(operation);
        harness.rows[2] = [harness.actorAccount, { ...harness.targetAccount, ...change }];
        await expect(operation.run(harness.database, command())).resolves.toMatchObject({
          member: { status: operation.after },
        });
      },
    );
  },
);
