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
import type { ArchiveCurrentClassCommand, ArchiveCurrentClassResult } from "../classes.types.js";
import { archiveCurrentClassMariaDb } from "./archive-class.js";

const userId = "9223372036854775807",
  classId = "9007199254740993",
  memberId = "9007199254740995",
  inviteId = "9007199254740998";
const occurredAt = "2026-09-06 04:05:06.123456",
  iso = "2026-09-06T04:05:06.123Z",
  reason = "반 운영 종료";
const input = (): ArchiveCurrentClassCommand => ({
  actorUserId: userId,
  expectedClassId: classId,
  expectedRowVersion: "9007199254740996",
  classNameConfirmation: "우리  반",
  requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
});
const failure = (status: number, code: string) => ({ status, response: { code } });

// Fixed responses test caller decisions and real compiled SQL bindings only.
// They do not emulate routine writes or transaction state. Real MariaDB QA must
// prove rollback, locks, existing noncurrent member preservation and 0031 parity.
function boundary(openInvite = true) {
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
  const account = { deleted_at: null, display_name: "교사 계정", is_active: 1 };
  const targetClass = {
    id: classId,
    name: input().classNameConfirmation,
    status: "active",
    row_version: "9007199254740996",
    archived_at: null,
  };
  const members = [
    { id: memberId, user_id: userId, role: "teacher", status: "approved", row_version: "1" },
    {
      id: "9007199254740996",
      user_id: "2",
      role: "student",
      status: "approved",
      row_version: "9007199254740996",
    },
    { id: "9007199254740997", user_id: "3", role: "student", status: "pending", row_version: "3" },
  ];
  const changedMembers = members.map((member) => ({
    ...member,
    status: member.status === "pending" ? "canceled" : "archived",
    row_version: (BigInt(member.row_version) + 1n).toString(),
    student_number: null,
    history_count: "1",
  }));
  const archived = {
    id: classId,
    name: targetClass.name,
    row_version: "9007199254740997",
    current_count: "0",
    open_invite_count: "0",
  };
  const rows: Record<string, unknown>[][] = [
    [context],
    [account],
    [targetClass],
    members,
    openInvite ? [{ id: inviteId, class_id: classId, revoked_at: null, revoke_reason: null }] : [],
    [{ status: "active", temporary_password_must_change: 0 }],
    [],
    [{ occurred_at: occurredAt }],
    [archived],
    changedMembers,
    ...(openInvite ? [[{ id: inviteId }], [], []] : [[]]),
  ];
  const executeQuery = vi
    .spyOn(database.getExecutor(), "executeQuery")
    .mockImplementation(async () => {
      const next = rows.shift();
      if (!next) throw new Error("Query beyond archive fixture");
      return { rows: next };
    });
  const execute = vi.fn(
    async (callback: (tx: Transaction<DB>) => Promise<ArchiveCurrentClassResult>) =>
      callback(database as Transaction<DB>),
  );
  const transaction = vi
    .spyOn(database, "transaction")
    .mockImplementation(() => ({ execute }) as unknown as TransactionBuilder<DB>);
  return {
    database,
    rows,
    context,
    account,
    targetClass,
    members,
    changedMembers,
    archived,
    executeQuery,
    execute,
    transaction,
  };
}
afterEach(() => vi.restoreAllMocks());

describe("MariaDB archive-class input and access boundaries", () => {
  it.each([
    { expectedClassId: "0" },
    { expectedClassId: "9223372036854775808" },
    { expectedRowVersion: undefined as unknown as string },
    { expectedRowVersion: "01" },
    { actorUserId: "0" },
    { actorUserId: "01" },
    { actorUserId: "9223372036854775808" },
    { requestId: "invalid" },
    { classNameConfirmation: "" },
    { classNameConfirmation: "😀".repeat(41) },
    { classNameConfirmation: "<b>반</b>" },
    { classNameConfirmation: "반\n이름" },
    { classNameConfirmation: "반\uD800" },
  ])("rejects invalid command before DB: %o", async (change) => {
    const harness = boundary();
    await expect(
      archiveCurrentClassMariaDb(harness.database, { ...input(), ...change }),
    ).rejects.toMatchObject(failure(400, "VALIDATION_FAILED"));
    expect(harness.executeQuery).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    { class_status: "archived" },
    { class_status: "suspended", role: "student" },
    { role: "student" },
    { profile_status: "revoked" },
    { temporary_password_must_change: 1 },
  ])("preserves preliminary class/role precedence: %o", async (change) => {
    const harness = boundary();
    harness.rows[0] = change ? [{ ...harness.context, ...change }] : [];
    const expected =
      !change || change.class_status === "archived"
        ? failure(404, "NOT_FOUND")
        : change.class_status === "suspended"
          ? failure(423, "CLASS_SUSPENDED")
          : failure(403, "ROLE_INSUFFICIENT");
    await expect(archiveCurrentClassMariaDb(harness.database, input())).rejects.toMatchObject(
      expected,
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(1);
    expect(harness.transaction).not.toHaveBeenCalled();
  });
  it.each([undefined, { is_active: 0 }, { deleted_at: occurredAt }])(
    "denies an inactive actor at 401 before locked class reads: %o",
    async (change) => {
      const harness = boundary();
      harness.rows[1] = change ? [{ ...harness.account, ...change }] : [];
      await expect(archiveCurrentClassMariaDb(harness.database, input())).rejects.toMatchObject(
        failure(401, "UNAUTHENTICATED"),
      );
      expect(harness.executeQuery).toHaveBeenCalledTimes(2);
    },
  );
  it.each([undefined, "suspended", "archived"])(
    "revalidates class state inside the transaction: %s",
    async (status) => {
      const harness = boundary();
      harness.rows[2] = status ? [{ ...harness.targetClass, status }] : [];
      await expect(archiveCurrentClassMariaDb(harness.database, input())).rejects.toMatchObject(
        status === undefined
          ? failure(404, "NOT_FOUND")
          : status === "suspended"
            ? failure(423, "CLASS_SUSPENDED")
            : failure(409, "CLASS_ARCHIVE_CONFLICT"),
      );
      expect(harness.executeQuery).toHaveBeenCalledTimes(3);
    },
  );
  it("checks actor membership before invitations and teacher profile", async () => {
    const harness = boundary();
    harness.rows[3] = harness.members.slice(1);
    await expect(archiveCurrentClassMariaDb(harness.database, input())).rejects.toMatchObject(
      failure(403, "ROLE_INSUFFICIENT"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(4);
  });
  it("checks teacher profile before mismatching confirmation", async () => {
    const harness = boundary();
    harness.rows[5] = [{ status: "revoked", temporary_password_must_change: 0 }];
    await expect(
      archiveCurrentClassMariaDb(harness.database, { ...input(), classNameConfirmation: "wrong" }),
    ).rejects.toMatchObject(failure(403, "ROLE_INSUFFICIENT"));
    expect(harness.executeQuery).toHaveBeenCalledTimes(6);
  });
  it.each([" 우리  반", "우리 반", "우리  반 "])(
    "keeps exact confirmation spacing instead of normalizing %s",
    async (classNameConfirmation) => {
      const harness = boundary();
      await expect(
        archiveCurrentClassMariaDb(harness.database, { ...input(), classNameConfirmation }),
      ).rejects.toMatchObject(failure(409, "CLASS_NAME_CONFIRMATION_MISMATCH"));
      expect(harness.executeQuery).toHaveBeenCalledTimes(6);
    },
  );
});

describe("MariaDB archive-class caller contract", () => {
  it.each([false, true])(
    "verifies routine results and audits with open invite=%s",
    async (hasInvite) => {
      const harness = boundary(hasInvite);
      await expect(archiveCurrentClassMariaDb(harness.database, input())).resolves.toEqual({
        archived_at: iso,
        class_id: classId,
        next_action: "CREATE_CLASS",
        row_version: "9007199254740997",
      });
      const queries = harness.executeQuery.mock.calls.map(([query]) => query);
      expect(queries[0]!.sql).toContain("m.status='approved'");
      expect(queries[0]!.sql).not.toContain("m.role='teacher'");
      expect(queries[1]!.sql).toMatch(/FROM users WHERE id=\? FOR UPDATE/u);
      expect(queries[2]!.sql).toMatch(/FROM classes WHERE id=\? FOR UPDATE/u);
      expect(queries[3]!.sql).toContain("status IN ('pending','approved') ORDER BY id FOR UPDATE");
      expect(queries[4]!.sql).toContain("revoked_at IS NULL ORDER BY id FOR UPDATE");
      expect(queries[4]!.sql).not.toContain("expires_at");
      expect(queries[5]!.sql).toMatch(/FROM teacher_profiles WHERE user_id=\? FOR UPDATE/u);
      expect(queries[6]!.sql).toContain("CALL archive_class(");
      expect(queries[6]!.parameters).toEqual([
        classId,
        userId,
        memberId,
        input().classNameConfirmation,
      ]);
      expect(queries[8]!.parameters).toEqual([classId, occurredAt, occurredAt, userId]);
      expect(queries[9]!.parameters).toEqual([
        userId,
        memberId,
        reason,
        occurredAt,
        classId,
        ...harness.members.map((member) => member.id),
        occurredAt,
        occurredAt,
      ]);
      expect(queries[9]!.sql).toContain("h.actor_admin_account_id IS NULL");
      const audits = queries.filter((query) => query.sql.includes("INSERT INTO audit_logs"));
      expect(audits).toHaveLength(hasInvite ? 2 : 1);
      expect(audits[0]!.sql).toContain("'class.archived'");
      expect(audits[0]!.parameters).toEqual([
        "교사 계정",
        memberId,
        userId,
        JSON.stringify({ archived_at: iso, status: "archived" }),
        JSON.stringify({ archived_at: null, status: "active" }),
        classId,
        occurredAt,
        input().requestId,
        classId,
      ]);
      if (hasInvite) {
        expect(queries[10]!.parameters).toEqual([classId, inviteId, occurredAt, memberId, reason]);
        expect(audits[1]!.sql).toContain("'invite_code.revoked'");
        expect(audits[1]!.parameters).toEqual([
          "교사 계정",
          memberId,
          userId,
          JSON.stringify({ revoke_reason: reason, revoked_at: iso }),
          JSON.stringify({ revoke_reason: null, revoked_at: null }),
          classId,
          occurredAt,
          reason,
          input().requestId,
          inviteId,
        ]);
      }
      expect(queries.map((query) => query.sql).join("\n")).not.toMatch(
        /DELETE FROM|UPDATE classes|UPDATE class_members|api_idempotency|email_verified|signup_approved/u,
      );
      expect(harness.rows).toEqual([]);
      expect(harness.transaction).toHaveBeenCalledTimes(1);
    },
  );
  it("captures confirmation and identity before input changes during the preliminary read", async () => {
    const harness = boundary(),
      command = input();
    harness.executeQuery.mockImplementationOnce(async () => {
      Object.assign(command, {
        expectedClassId: "999",
        expectedRowVersion: "999",
        actorUserId: "1",
        classNameConfirmation: "다른 반",
        requestId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      });
      return { rows: harness.rows.shift()! };
    });
    await archiveCurrentClassMariaDb(harness.database, command);
    expect(harness.executeQuery.mock.calls[6]![0].parameters).toEqual([
      classId,
      userId,
      memberId,
      input().classNameConfirmation,
    ]);
    expect(harness.executeQuery.mock.calls[11]![0].parameters[7]).toBe(input().requestId);
  });
  it.each([
    undefined,
    "2026-09-06 04:05:06.123",
    "2025-02-29 00:00:00.000000",
    "2026-09-06 24:00:00.000000",
  ])("rejects malformed OUT clock before post-CALL queries: %o", async (occurred_at) => {
    const harness = boundary();
    harness.rows[7] = occurred_at === undefined ? [] : [{ occurred_at }];
    await expect(archiveCurrentClassMariaDb(harness.database, input())).rejects.toMatchObject(
      failure(500, "INTERNAL_ERROR"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(8);
  });
  it.each([
    { row_version: "9007199254740996" },
    { current_count: "1" },
    { open_invite_count: "1" },
  ])("rejects archive version or remaining-current inconsistency: %o", async (change) => {
    const harness = boundary();
    harness.rows[8] = [{ ...harness.archived, ...change }];
    await expect(archiveCurrentClassMariaDb(harness.database, input())).rejects.toMatchObject(
      failure(500, "INTERNAL_ERROR"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(9);
  });
  it.each([
    { history_count: "0" },
    { history_count: "2" },
    { status: "approved" },
    { row_version: "1" },
    { student_number: 8 },
    { user_id: "5" },
  ])(
    "rejects missing/wrong reason history or a mismatched member transition: %o",
    async (change) => {
      const harness = boundary();
      harness.rows[9] = [
        { ...harness.changedMembers[0]!, ...change },
        ...harness.changedMembers.slice(1),
      ];
      await expect(archiveCurrentClassMariaDb(harness.database, input())).rejects.toMatchObject(
        failure(500, "INTERNAL_ERROR"),
      );
      expect(harness.executeQuery).toHaveBeenCalledTimes(10);
    },
  );
  it("rejects unmatched invite revocation before any audit", async () => {
    const harness = boundary();
    harness.rows[10] = [];
    await expect(archiveCurrentClassMariaDb(harness.database, input())).rejects.toMatchObject(
      failure(500, "INTERNAL_ERROR"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(11);
  });
  it.each([11, 12])("does not swallow an audit error at query %s or retry", async (index) => {
    const harness = boundary();
    harness.executeQuery.mockImplementation(async () => {
      if (harness.executeQuery.mock.calls.length === index + 1)
        throw { errno: 4025, sqlState: "23000", message: "private SQL" };
      return { rows: harness.rows.shift()! };
    });
    const error: unknown = await archiveCurrentClassMariaDb(harness.database, input()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject(failure(500, "INTERNAL_ERROR"));
    expect(JSON.stringify(error)).not.toContain("private SQL");
    expect(harness.transaction).toHaveBeenCalledTimes(1);
  });
  it.each([
    { errno: 1213, sqlState: "40001" },
    { errno: 1205, sqlState: "HY000" },
    { errno: 1062, sqlState: "23000" },
    new Error("private uncertain COMMIT acknowledgement"),
    new BadRequestException({ code: "PRIVATE", message: "private SQL" }),
  ])("never retries unknown/native/uncertain transaction errors: %o", async (native) => {
    const harness = boundary();
    harness.execute.mockRejectedValueOnce(native);
    const error: unknown = await archiveCurrentClassMariaDb(harness.database, input()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject(failure(500, "INTERNAL_ERROR"));
    expect(JSON.stringify(error)).not.toContain("private");
    expect(error).not.toHaveProperty("cause");
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.executeQuery).toHaveBeenCalledTimes(1);
  });
});

describe("반 종료의 정확한 대상과 버전", () => {
  it("다른 탭에서 같은 이름의 새 반으로 바뀌면 새 반을 종료하지 않는다", async () => {
    const harness = boundary(false);
    harness.context.class_id = "9007199254740994";
    harness.targetClass.id = harness.context.class_id;
    harness.archived.id = harness.context.class_id;
    await expect(archiveCurrentClassMariaDb(harness.database, input())).rejects.toMatchObject(
      failure(409, "CLASS_ARCHIVE_CONFLICT"),
    );
    expect(harness.execute).toHaveBeenCalledOnce();
    expect(harness.executeQuery).toHaveBeenCalledTimes(1);
    expect(
      harness.executeQuery.mock.calls.some(([q]) => q.sql.includes("CALL archive_class")),
    ).toBe(false);
  });
  it("대상 이름과 ID가 같아도 잠금 시점에 버전이 바뀌면 종료하지 않는다", async () => {
    const harness = boundary();
    harness.targetClass.row_version = "9007199254740997";
    harness.archived.row_version = "9007199254740998";
    await expect(archiveCurrentClassMariaDb(harness.database, input())).rejects.toMatchObject(
      failure(409, "RESOURCE_VERSION_CHANGED"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(3);
    expect(
      harness.executeQuery.mock.calls.some(([q]) =>
        /^\s*(?:CALL archive_class|INSERT|UPDATE|DELETE)/.test(q.sql),
      ),
    ).toBe(false);
  });
});
