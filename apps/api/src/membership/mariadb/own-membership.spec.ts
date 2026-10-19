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
import type {
  OwnMembershipTransitionCommand,
  OwnMembershipTransitionResult,
} from "../membership.types.js";
import { cancelOwnMembershipMariaDb, leaveOwnMembershipMariaDb } from "./own-membership.js";

const command = (): OwnMembershipTransitionCommand => ({
  userId: "9223372036854775807",
  requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
});
const identity = { class_id: "9007199254740993", id: "9007199254740995" };
const occurredAt = "2026-09-06 04:05:06.123456";
const operations = [
  {
    name: "cancel",
    run: cancelOwnMembershipMariaDb,
    expected: "pending",
    next: "canceled",
    routine: "cancel_class_membership_request",
    action: "member.request_canceled",
  },
  {
    name: "leave",
    run: leaveOwnMembershipMariaDb,
    expected: "approved",
    next: "left",
    routine: "leave_class",
    action: "member.left",
  },
] as const;
type Operation = (typeof operations)[number];
const failure = (status: number, code: string) => ({ status, response: { code } });

// Fixed results exercise caller boundaries and compiled bindings only. This is
// not a DB state model: CALL effects, transactional rollback and concurrency are
// verified by isolated real MariaDB QA. DummyDriver opens no connections.
function boundary(operation: Operation) {
  const database = new Kysely<DB>({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  });
  const member = {
    id: identity.id,
    role: "student",
    status: operation.expected,
    row_version: "9007199254740996",
    display_name_in_class: "반 이름",
    student_number: operation.name === "leave" ? 13 : null,
  };
  const changed = {
    ...member,
    status: operation.next,
    row_version: "9007199254740997",
    student_number: null,
  };
  const account = { display_name: "계정 이름", is_active: 1, deleted_at: null };
  const rows: Record<string, unknown>[][] = [
    [{ ...identity }],
    [account],
    [{ id: identity.class_id, status: "active" }],
    [member],
    [],
    [{ occurred_at: occurredAt }],
    [changed],
    [],
  ];
  const executeQuery = vi
    .spyOn(database.getExecutor(), "executeQuery")
    .mockImplementation(async () => {
      const next = rows.shift();
      if (!next) throw new Error("Unexpected query beyond the caller boundary fixture");
      return { rows: next };
    });
  const execute = vi.fn(
    async (callback: (tx: Transaction<DB>) => Promise<OwnMembershipTransitionResult>) =>
      callback(database as Transaction<DB>),
  );
  const transaction = vi
    .spyOn(database, "transaction")
    .mockImplementation(() => ({ execute }) as unknown as TransactionBuilder<DB>);
  return { database, rows, member, changed, account, executeQuery, execute, transaction };
}

afterEach(() => vi.restoreAllMocks());

describe.each(operations)("MariaDB own-membership $name", (operation) => {
  it.each([
    { userId: "0" },
    { userId: "01" },
    { userId: "-1" },
    { userId: "1.0" },
    { userId: "1e3" },
    { userId: "9223372036854775808" },
    { userId: 1 },
    { userId: null },
    { requestId: "not-a-uuid" },
    { requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee " },
    { requestId: null },
  ])("rejects invalid identity input before any DB work: %o", async (change) => {
    const harness = boundary(operation);
    await expect(
      operation.run(harness.database, {
        ...command(),
        ...change,
      } as OwnMembershipTransitionCommand),
    ).rejects.toMatchObject(failure(400, "VALIDATION_FAILED"));
    expect(harness.executeQuery).not.toHaveBeenCalled();
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("returns missing expected student identity 409 before account checks", async () => {
    const harness = boundary(operation);
    harness.rows[0] = [];
    await expect(operation.run(harness.database, command())).rejects.toMatchObject(
      failure(409, "MEMBERSHIP_STATUS_CHANGED"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(1);
    const query = harness.executeQuery.mock.calls[0]![0];
    expect(query.sql).toMatch(
      /FROM class_members\s+WHERE user_id=\? AND role='student' AND status=\?/u,
    );
    expect(query.parameters).toEqual([command().userId, operation.expected]);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it.each([{ id: "0" }, { class_id: "9223372036854775808" }])(
    "rejects malformed DB identity before a transaction: %o",
    async (change) => {
      const harness = boundary(operation);
      harness.rows[0] = [{ ...identity, ...change }];
      await expect(operation.run(harness.database, command())).rejects.toMatchObject(
        failure(500, "INTERNAL_ERROR"),
      );
      expect(harness.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, { is_active: 0 }, { deleted_at: "2026-09-06 00:00:00.000000" }])(
    "checks active and undeleted account before class/member: %o",
    async (change) => {
      const harness = boundary(operation);
      harness.rows[1] = change ? [{ ...harness.account, ...change }] : [];
      await expect(operation.run(harness.database, command())).rejects.toMatchObject(
        failure(401, "UNAUTHENTICATED"),
      );
      expect(harness.executeQuery).toHaveBeenCalledTimes(2);
      expect(harness.transaction).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, "archived"])(
    "rejects unavailable class before member lookup: %s",
    async (status) => {
      const harness = boundary(operation);
      harness.rows[2] = status ? [{ id: identity.class_id, status }] : [];
      await expect(operation.run(harness.database, command())).rejects.toMatchObject(
        failure(409, "MEMBERSHIP_STATUS_CHANGED"),
      );
      expect(harness.executeQuery).toHaveBeenCalledTimes(3);
    },
  );

  it.each([undefined, { role: "teacher" }, { status: "removed" }])(
    "revalidates the original student membership before CALL: %o",
    async (change) => {
      const harness = boundary(operation);
      harness.rows[3] = change ? [{ ...harness.member, ...change }] : [];
      await expect(operation.run(harness.database, command())).rejects.toMatchObject(
        failure(409, "MEMBERSHIP_STATUS_CHANGED"),
      );
      expect(harness.executeQuery).toHaveBeenCalledTimes(4);
    },
  );

  it.each(["active", "suspended"])(
    "preserves locks, microsecond audit, actor and Date response in a %s class",
    async (classStatus) => {
      const harness = boundary(operation);
      harness.rows[2] = [{ id: identity.class_id, status: classStatus }];
      const result = await operation.run(harness.database, command());
      expect(result).toEqual({
        class_id: identity.class_id,
        membership_id: identity.id,
        next_action: "BOOTSTRAP",
        row_version: "9007199254740997",
        status: operation.next,
        status_changed_at: new Date("2026-09-06T04:05:06.123Z"),
      });
      expect(result.status_changed_at).toBeInstanceOf(Date);
      const queries = harness.executeQuery.mock.calls.map(([query]) => query);
      expect(queries[1]!.sql).toMatch(/FROM users WHERE id=\? FOR UPDATE/u);
      expect(queries[1]!.parameters).toEqual([command().userId]);
      expect(queries[2]!.sql).toMatch(/FROM classes WHERE id=\? FOR UPDATE/u);
      expect(queries[2]!.parameters).toEqual([identity.class_id]);
      expect(queries[3]!.sql).toMatch(
        /FROM class_members\s+WHERE id=\? AND class_id=\? AND user_id=\? FOR UPDATE/u,
      );
      expect(queries[3]!.parameters).toEqual([identity.id, identity.class_id, command().userId]);
      expect(queries[4]!.sql).toContain(`CALL ${operation.routine}(`);
      expect(queries[4]!.parameters).toEqual([identity.class_id, command().userId, identity.id]);
      expect(queries[6]!.parameters).toEqual([
        identity.id,
        identity.class_id,
        command().userId,
        operation.next,
        occurredAt,
        occurredAt,
        operation.expected,
        operation.next,
        command().userId,
        operation.name === "leave" ? identity.id : null,
        occurredAt,
      ]);
      const deleted = queries.filter((query) => query.sql.trim().startsWith("DELETE"));
      expect(deleted).toEqual([]);
      for (const query of deleted) expect(query.parameters).toEqual([identity.id]);
      expect(queries.map((query) => query.sql).join("\n")).not.toMatch(
        /email_verified|signup_approved|teacher_profiles|election|idempotency|seat_draw|team_draw|duty_/iu,
      );
      const snapshot = {
        display_name_snapshot: "반 이름",
        member_id: identity.id,
        reason: null,
        role: "student",
      };
      const audit = queries.at(-1)!;
      expect(audit.sql).toContain("INSERT INTO audit_logs");
      expect(audit.parameters).toEqual([
        operation.action,
        "계정 이름",
        operation.name === "leave" ? identity.id : null,
        command().userId,
        JSON.stringify({ ...snapshot, status: operation.next }),
        JSON.stringify({ ...snapshot, status: operation.expected }),
        identity.class_id,
        command().requestId,
        identity.id,
        occurredAt,
      ]);
      expect(harness.rows).toEqual([]);
      expect(harness.transaction).toHaveBeenCalledTimes(1);
    },
  );

  it("uses the account display name only when the class display name is null", async () => {
    const harness = boundary(operation);
    harness.rows[3] = [{ ...harness.member, display_name_in_class: null }];
    harness.rows[6] = [{ ...harness.changed, display_name_in_class: null }];
    await operation.run(harness.database, command());
    const parameters = harness.executeQuery.mock.calls.at(-1)![0].parameters;
    expect(JSON.parse(parameters[4] as string)).toMatchObject({
      display_name_snapshot: "계정 이름",
      reason: null,
    });
    expect(JSON.parse(parameters[5] as string)).toMatchObject({
      display_name_snapshot: "계정 이름",
      reason: null,
    });
  });

  it("keeps command identity and request ID captured before the first await", async () => {
    const harness = boundary(operation);
    const input = command();
    harness.executeQuery.mockImplementationOnce(async () => {
      Object.assign(input, { userId: "1", requestId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" });
      return { rows: harness.rows.shift()! };
    });
    await operation.run(harness.database, input);
    expect(harness.executeQuery.mock.calls[1]![0].parameters).toEqual([command().userId]);
    expect(harness.executeQuery.mock.calls.at(-1)![0].parameters[7]).toBe(command().requestId);
  });

  it.each([
    null,
    new Date("2026-09-06T04:05:06.123Z"),
    "2026-09-06 04:05:06.123",
    "2026-09-06T04:05:06.123456Z",
    "0000-01-01 00:00:00.000000",
    "2025-02-29 00:00:00.000000",
    "2026-04-31 00:00:00.000000",
    "2026-09-06 24:00:00.000000",
  ])(
    "rejects malformed or impossible OUT time before result/audit work: %o",
    async (occurred_at) => {
      const harness = boundary(operation);
      harness.rows[5] = [{ occurred_at }];
      await expect(operation.run(harness.database, command())).rejects.toMatchObject(
        failure(500, "INTERNAL_ERROR"),
      );
      expect(harness.executeQuery).toHaveBeenCalledTimes(6);
      expect(harness.transaction).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    undefined,
    { id: "1" },
    { role: "teacher" },
    { status: "approved" },
    { row_version: "9007199254740996" },
    { display_name_in_class: "다른 이름" },
    { student_number: 13 },
  ])("rejects a mismatched post-CALL member before deletion or audit: %o", async (change) => {
    const harness = boundary(operation);
    harness.rows[6] = change ? [{ ...harness.changed, ...change }] : [];
    await expect(operation.run(harness.database, command())).rejects.toMatchObject(
      failure(500, "INTERNAL_ERROR"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(7);
    expect(harness.transaction).toHaveBeenCalledTimes(1);
  });

  it("retries exact deadlock twice around the whole transaction while retaining one identity", async () => {
    const harness = boundary(operation);
    harness.execute
      .mockRejectedValueOnce({ errno: 1213, sqlState: "40001" })
      .mockRejectedValueOnce({ errno: 1213, sqlState: "40001" });
    await expect(operation.run(harness.database, command())).resolves.toMatchObject({
      membership_id: identity.id,
      status: operation.next,
    });
    expect(harness.transaction).toHaveBeenCalledTimes(3);
    expect(harness.execute).toHaveBeenCalledTimes(3);
    const identities = harness.executeQuery.mock.calls.filter(([query]) =>
      query.sql.includes("SELECT class_id,id"),
    );
    expect(identities).toHaveLength(1);
  });

  it("bounds persistent native deadlock at three attempts without re-querying identity", async () => {
    const harness = boundary(operation);
    harness.execute.mockRejectedValue({ errno: 1213, sqlState: "40001", message: "private SQL" });
    await expect(operation.run(harness.database, command())).rejects.toMatchObject(
      failure(500, "INTERNAL_ERROR"),
    );
    expect(harness.transaction).toHaveBeenCalledTimes(3);
    expect(harness.executeQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    { errno: 1062, sqlState: "23000" },
    { errno: 1205, sqlState: "HY000" },
    { errno: 30515, sqlState: "40001" },
    { errno: 1213, sqlState: "45000" },
    { errno: "1213", sqlState: "40001" },
    Object.create({ errno: 1213, sqlState: "40001" }) as unknown,
    new Error("private uncertain COMMIT acknowledgement"),
    new BadRequestException({ code: "PRIVATE", message: "private SQL" }),
  ])("does not retry unknown, forged or uncertain transaction errors: %o", async (native) => {
    const harness = boundary(operation);
    harness.execute.mockRejectedValue(native);
    const error: unknown = await operation
      .run(harness.database, command())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject(failure(500, "INTERNAL_ERROR"));
    expect(JSON.stringify(error)).not.toContain("private");
    expect(error).not.toHaveProperty("cause");
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.executeQuery).toHaveBeenCalledTimes(1);
  });

  it("does not include the initial identity lookup in the transaction retry", async () => {
    const harness = boundary(operation);
    harness.executeQuery.mockRejectedValueOnce({ errno: 1213, sqlState: "40001" });
    await expect(operation.run(harness.database, command())).rejects.toMatchObject(
      failure(500, "INTERNAL_ERROR"),
    );
    expect(harness.executeQuery).toHaveBeenCalledTimes(1);
    expect(harness.transaction).not.toHaveBeenCalled();
  });
});
