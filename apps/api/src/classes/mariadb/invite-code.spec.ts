import {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  MariaDbIdempotencyService,
  type DB,
  type IdempotencyExecutionResult,
  type IdempotencyRequest,
  type JsonValue,
} from "@classhub/db";
import { BadRequestException } from "@nestjs/common";
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type Transaction,
} from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RotateInviteCodeCommand } from "../classes.types.js";
import { getCurrentInviteCodeMariaDb, rotateInviteCodeMariaDb } from "./invite-code.js";

const actorUserId = "9007199254740993",
  classId = "9007199254740995",
  memberId = "9007199254740997";
const previousId = "9007199254740999",
  nextId = "9007199254741001";
const occurredAt = "2026-09-06 13:00:00.123456",
  expiresAt = "2026-09-20 13:00:00.123456";
const candidates = ["AAAAAAA2", "AAAAAAA3", "AAAAAAA4", "AAAAAAA5", "AAAAAAA6"];
const command = (): RotateInviteCodeCommand => ({
  actorUserId,
  requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  idempotencyKey: "ABCDEFAB-1234-5678-9ABC-DEF012345678",
});
const failure = (status: number, code: string) => ({ status, response: { code } });
type Row = Record<string, unknown>;
type Operation = (tx: Transaction<DB>) => Promise<{ body: JsonValue; statusCode: number }>;

// These compiled-SQL fixtures exercise caller contracts only. Root's disposable DB QA owns persistence and concurrency.
function boundary() {
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
  const target = { id: classId, status: "active" },
    actor = { id: memberId, role: "teacher", status: "approved" },
    profile = { status: "active", temporary_password_must_change: 0 };
  const previous = {
    id: previousId,
    class_id: classId,
    code: "AAAAAAA7",
    created_at: "2026-09-01 13:00:00.123456",
    expires_at: "2026-09-15 13:00:00.123456",
    created_by_member_id: memberId,
    revoked_at: null,
    revoked_by_member_id: null,
    revoked_by_operator_id: null,
    revoke_reason: null,
  };
  const out = {
    previous_invite_id: previousId,
    invite_id: nextId,
    invite_code: candidates[2],
    invite_created_at: occurredAt,
    invite_expires_at: expiresAt,
    occurred_at: occurredAt,
  };
  const revoked = {
    ...previous,
    revoked_at: occurredAt,
    revoked_by_member_id: memberId,
    revoke_reason: "재발급",
  };
  const created = {
    ...previous,
    id: nextId,
    code: candidates[2],
    created_at: occurredAt,
    expires_at: expiresAt,
  };
  const queued: Row[][] = [
    [context],
    [account],
    [target],
    [actor],
    [profile],
    [previous],
    [],
    [out],
    [revoked, created],
    [],
    [],
  ];
  const executeQuery = vi
    .spyOn(database.getExecutor(), "executeQuery")
    .mockImplementation(async () => {
      const next = queued.shift();
      if (!next) throw new Error("Query exceeds test fixture");
      return { rows: next };
    });
  const execute = vi
    .spyOn(MariaDbIdempotencyService.prototype, "execute")
    .mockImplementation(
      async <T extends JsonValue>(
        _request: IdempotencyRequest,
        operation: Operation,
      ): Promise<IdempotencyExecutionResult<T>> => {
        const result = await operation(database as Transaction<DB>);
        return { ...result, body: result.body as T, replayed: false };
      },
    );
  const codeFactory = vi.fn<() => string>();
  for (const code of candidates) codeFactory.mockReturnValueOnce(code);
  return {
    database,
    context,
    account,
    target,
    actor,
    profile,
    previous,
    out,
    revoked,
    created,
    queued,
    executeQuery,
    execute,
    codeFactory,
  };
}
afterEach(() => vi.restoreAllMocks());

describe("MariaDB invite read", () => {
  it.each([
    ["2026-09-15T13:00:00.122Z", "active"],
    ["2026-09-15T13:00:00.123Z", "expired"],
  ])("preserves exact projection and PG millisecond expiration at %s", async (now, status) => {
    const h = boundary();
    h.queued.splice(1, h.queued.length, [h.previous]);
    expect(await getCurrentInviteCodeMariaDb(h.database, actorUserId, new Date(now))).toEqual({
      class_id: classId,
      invite_code: {
        id: previousId,
        code: "AAAAAAA7",
        created_at: "2026-09-01T13:00:00.123Z",
        expires_at: "2026-09-15T13:00:00.123Z",
        status,
      },
    });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.executeQuery.mock.calls[1]![0].parameters).toEqual([classId]);
    expect(h.executeQuery.mock.calls[1]![0].sql).toContain("revoked_at IS NULL");
  });
  it("reports missing current invite and rejects stored invalid calendar safely", async () => {
    const h = boundary();
    h.queued.splice(1, h.queued.length, []);
    await expect(getCurrentInviteCodeMariaDb(h.database, actorUserId)).rejects.toMatchObject(
      failure(404, "INVITE_CODE_NOT_FOUND"),
    );
    h.queued.push([h.context], [{ ...h.previous, expires_at: "2026-02-30 00:00:00.123456" }]);
    await expect(getCurrentInviteCodeMariaDb(h.database, actorUserId)).rejects.toMatchObject(
      failure(500, "INTERNAL_ERROR"),
    );
  });
});

describe("MariaDB invite rotation caller", () => {
  it("uses five candidates, scoped canonical idempotency, ordered locks and exact private-code-free audits", async () => {
    const h = boundary();
    const result = await rotateInviteCodeMariaDb(h.database, command(), h.codeFactory);
    expect(result).toEqual({
      class_id: classId,
      invite_code: {
        id: nextId,
        code: candidates[2],
        created_at: "2026-09-06T13:00:00.123Z",
        expires_at: "2026-09-20T13:00:00.123Z",
        status: "active",
      },
    });
    expect(h.execute.mock.calls[0]![0]).toEqual({
      actorUserId,
      idempotencyKey: String(command().idempotencyKey).toLowerCase(),
      requestHash: createIdempotencyRequestHash({ body: {}, effectiveClassId: classId }),
      routeKey: createIdempotencyRouteKey("/classes/current/invite-code/rotate", classId),
    });
    expect(h.codeFactory).toHaveBeenCalledTimes(5);
    await expect(h.execute.mock.results[0]!.value).resolves.toMatchObject({ statusCode: 200 });
    const queries = h.executeQuery.mock.calls.map(([query]) => query);
    expect(queries.slice(1, 6).map((query) => query.parameters)).toEqual([
      [actorUserId],
      [classId],
      [memberId, classId, actorUserId],
      [actorUserId],
      [classId],
    ]);
    for (const query of queries.slice(1, 6)) expect(query.sql).toContain("FOR UPDATE");
    expect(queries[6]!.sql).toContain("CALL rotate_class_invite");
    expect(queries[6]!.parameters).toEqual([classId, actorUserId, memberId, ...candidates]);
    expect(queries[8]!.parameters).toEqual([classId, previousId, nextId]);
    expect(queries[9]!.parameters).toEqual([
      "invite_code.revoked",
      "교사 계정",
      memberId,
      actorUserId,
      '{"revoke_reason":"재발급","revoked_at":"2026-09-06T13:00:00.123Z"}',
      '{"revoke_reason":null,"revoked_at":null}',
      classId,
      "재발급",
      command().requestId,
      previousId,
    ]);
    expect(queries[10]!.parameters).toEqual([
      "invite_code.created",
      "교사 계정",
      memberId,
      actorUserId,
      `{"class_id":"${classId}","expires_at":"2026-09-20T13:00:00.123Z","invite_code_id":"${nextId}","revoke_reason":null,"revoked_at":null}`,
      null,
      classId,
      null,
      command().requestId,
      nextId,
    ]);
    for (const query of queries.slice(9)) {
      expect(query.sql).not.toContain("created_at");
      expect(JSON.stringify(query.parameters)).not.toMatch(/AAAAAAA[234567]/u);
    }
    expect(queries.every((query) => !/^\s*(UPDATE|DELETE)\s/iu.test(query.sql))).toBe(true);
    expect(h.queued).toHaveLength(0);
  });
  it("snapshots identity/header/request ID before context awaits", async () => {
    const h = boundary(),
      input = command();
    h.executeQuery.mockImplementationOnce(async () => {
      Object.assign(input, { actorUserId: "1", idempotencyKey: "bad", requestId: "bad" });
      return { rows: h.queued.shift()! };
    });
    await rotateInviteCodeMariaDb(h.database, input, h.codeFactory);
    expect(h.execute.mock.calls[0]![0].actorUserId).toBe(actorUserId);
    expect(h.execute.mock.calls[0]![0].idempotencyKey).toBe(
      String(command().idempotencyKey).toLowerCase(),
    );
    expect(h.executeQuery.mock.calls[9]![0].parameters[8]).toBe(command().requestId);
  });
  it("rejects an invalid generated candidate before the protected routine", async () => {
    const h = boundary();
    await expect(
      rotateInviteCodeMariaDb(h.database, command(), () => "invalid-code"),
    ).rejects.toMatchObject(failure(500, "INTERNAL_ERROR"));
    expect(h.executeQuery.mock.calls.every(([query]) => !query.sql.includes("CALL "))).toBe(true);
  });
  it("checks preliminary permission before replay and does not call factory or locked callback on replay", async () => {
    const h = boundary(),
      cached = { class_id: classId, invite_code: { cached: true } };
    h.execute.mockResolvedValue({ body: cached, statusCode: 200, replayed: true });
    expect(await rotateInviteCodeMariaDb(h.database, command(), h.codeFactory)).toEqual(cached);
    expect(h.executeQuery).toHaveBeenCalledTimes(1);
    expect(h.codeFactory).not.toHaveBeenCalled();
    h.queued.splice(0, h.queued.length, [{ ...h.context, temporary_password_must_change: 1 }]);
    await expect(
      rotateInviteCodeMariaDb(
        h.database,
        { ...command(), idempotencyKey: undefined },
        h.codeFactory,
      ),
    ).rejects.toMatchObject(failure(403, "ROLE_INSUFFICIENT"));
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it.each([
    [undefined, "IDEMPOTENCY_KEY_REQUIRED"],
    ["bad", "INVALID_IDEMPOTENCY_KEY"],
    [["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"], "INVALID_IDEMPOTENCY_KEY"],
  ])("maps invalid header %o after teacher context", async (key, code) => {
    const h = boundary();
    await expect(
      rotateInviteCodeMariaDb(h.database, { ...command(), idempotencyKey: key }, h.codeFactory),
    ).rejects.toMatchObject(failure(400, String(code)));
    expect(h.executeQuery).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it.each([
    [0, { class_status: "suspended", role: "student" }, 423, "CLASS_SUSPENDED"],
    [0, { class_status: "archived" }, 404, "NOT_FOUND"],
    [0, { role: "student" }, 403, "ROLE_INSUFFICIENT"],
    [1, { is_active: 0 }, 401, "UNAUTHENTICATED"],
    [2, { status: "suspended" }, 423, "CLASS_SUSPENDED"],
    [3, { status: "transferred" }, 403, "ROLE_INSUFFICIENT"],
    [4, { status: "revoked" }, 403, "ROLE_INSUFFICIENT"],
  ] as const)(
    "preserves context/transaction denial at query %s",
    async (index, patch, status, code) => {
      const h = boundary();
      Object.assign(h.queued[index]![0]!, patch);
      await expect(
        rotateInviteCodeMariaDb(h.database, command(), h.codeFactory),
      ).rejects.toMatchObject(failure(status, code));
      expect(h.codeFactory).not.toHaveBeenCalled();
      expect(h.executeQuery.mock.calls.every(([query]) => !query.sql.includes("CALL "))).toBe(true);
    },
  );
  it.each([
    { previous_invite_id: "1" },
    { invite_id: previousId },
    { invite_id: "01" },
    { invite_code: "AAAAAAA7" },
    { occurred_at: "2026-09-06 13:00:00.123457" },
    { invite_created_at: "2026-02-30 13:00:00.123456" },
    { invite_expires_at: "2026-09-20 13:00:00.123457" },
    { invite_expires_at: "2026-09-19 13:00:00.123456" },
  ])("rejects malformed or inconsistent OUT before audit: %o", async (patch) => {
    const h = boundary();
    Object.assign(h.out, patch);
    await expect(
      rotateInviteCodeMariaDb(h.database, command(), h.codeFactory),
    ).rejects.toMatchObject(failure(500, "INTERNAL_ERROR"));
    expect(
      h.executeQuery.mock.calls.every(([query]) => !query.sql.includes("INSERT INTO audit_logs")),
    ).toBe(true);
  });
  it.each(["old_actor", "old_time", "new_code", "new_expiry", "missing_row"])(
    "rejects actual row mismatch %s before audit",
    async (field) => {
      const h = boundary();
      if (field === "old_actor") h.revoked.revoked_by_member_id = "1";
      if (field === "old_time") h.revoked.revoked_at = "2026-09-06 13:00:00.123457";
      if (field === "new_code") h.created.code = "AAAAAAA7";
      if (field === "new_expiry") h.created.expires_at = "2026-09-20 13:00:00.123457";
      if (field === "missing_row") h.queued[8]!.pop();
      await expect(
        rotateInviteCodeMariaDb(h.database, command(), h.codeFactory),
      ).rejects.toMatchObject(failure(500, "INTERNAL_ERROR"));
      expect(
        h.executeQuery.mock.calls.every(([query]) => !query.sql.includes("INSERT INTO audit_logs")),
      ).toBe(true);
    },
  );
  it("passes native deadlock unchanged to the shared idempotency boundary", async () => {
    const h = boundary(),
      native = { errno: 1213, sqlState: "40001", message: "private SQL" };
    const original = h.executeQuery.getMockImplementation()!;
    h.executeQuery.mockImplementation(async (...args) => {
      if (args[0].sql.includes("CALL ")) throw native;
      return original(...args);
    });
    h.execute.mockImplementation(async (_request, operation) => {
      await expect(operation(h.database as Transaction<DB>)).rejects.toBe(native);
      throw native;
    });
    await expect(
      rotateInviteCodeMariaDb(h.database, command(), h.codeFactory),
    ).rejects.toMatchObject(failure(500, "INTERNAL_ERROR"));
  });
  it.each([9, 10])("contains arbitrary HTTP/native audit failure at query %s", async (index) => {
    const h = boundary(),
      original = h.executeQuery.getMockImplementation()!;
    let calls = 0;
    h.executeQuery.mockImplementation(async (...args) => {
      if (calls++ === index)
        throw new BadRequestException({ code: "PRIVATE_SQL", message: "private invite AAAAAAA4" });
      return original(...args);
    });
    const error: unknown = await rotateInviteCodeMariaDb(
      h.database,
      command(),
      h.codeFactory,
    ).catch((error: unknown) => error);
    expect(error).toMatchObject(failure(500, "INTERNAL_ERROR"));
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_SQL|AAAAAAA4/u);
    expect(error).not.toHaveProperty("cause");
  });
});
