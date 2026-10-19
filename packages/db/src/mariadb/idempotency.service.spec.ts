import { sql, type Kysely, type Transaction } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DB, JsonValue } from "../generated/database.js";
import type { IdempotencyRequest } from "../idempotency/idempotency.service.js";
import { createMariaDbDatabase } from "./connection.js";
import type { MariaDbRawConnection } from "./guarded-driver.js";
import { MariaDbIdempotencyError, MariaDbIdempotencyService } from "./idempotency.service.js";

const key = "ABCDEFAB-1234-5678-9ABC-DEF012345678";
const request = (): IdempotencyRequest => ({
  actorUserId: "9223372036854775807",
  idempotencyKey: key,
  requestHash: Buffer.alloc(32, 7),
  routeKey: "/classes",
});
const native = (errno: number, sqlState: string) => ({ errno, sqlState });
type Row = {
  id: string;
  request_hash: Buffer;
  response_body_json: string;
  response_status: number;
  unexpired: number;
};
const stored = (values: Partial<Row> = {}): Row => ({
  id: "9007199254740993",
  request_hash: request().requestHash,
  response_body_json: '{"id":"9223372036854775807"}',
  response_status: 201,
  unexpired: 1,
  ...values,
});
const copy = (row: Row | undefined): Row | undefined =>
  row && { ...row, request_hash: Buffer.from(row.request_hash) };

// A transactional store models durable response and business writes. Real Kysely
// and the guarded driver supply commit, rollback-only and retry boundaries.
class MemoryConnection implements MariaDbRawConnection {
  commands: { statement: string; parameters: readonly unknown[] }[] = [];
  row: Row | undefined;
  pendingRow: Row | undefined;
  durableWrites = 0;
  pendingWrites = 0;
  begins = 0;
  commits = 0;
  destroyed = 0;
  lostCommit = false;
  nextId = 9007199254740994n;
  fault: (statement: string, parameters: readonly unknown[]) => unknown = () => undefined;

  query(
    statement: string,
    parameters: readonly unknown[],
    callback: (e: unknown, r: unknown) => void,
  ) {
    statement = statement.trim().replace(/\s+/gu, " ");
    this.commands.push({ statement, parameters });
    queueMicrotask(() => {
      const failure = this.fault(statement, parameters);
      if (failure !== undefined) return callback(failure, undefined);
      let result: unknown = { affectedRows: 0, insertId: 0 };
      if (statement.startsWith("START TRANSACTION")) {
        this.begins++;
        this.pendingRow = copy(this.row);
        this.pendingWrites = 0;
      } else if (statement === "ROLLBACK") {
        this.pendingRow = undefined;
        this.pendingWrites = 0;
      } else if (statement === "COMMIT") {
        this.row = copy(this.pendingRow);
        this.durableWrites += this.pendingWrites;
        this.pendingWrites = 0;
        this.commits++;
        if (this.lostCommit) return callback(new Error("connection lost"), undefined);
      } else if (statement.startsWith("SELECT id, request_hash")) {
        result = this.pendingRow ? [{ ...this.pendingRow }] : [];
      } else if (statement.startsWith("SELECT expires_at")) {
        result = this.pendingRow ? [{ unexpired: this.pendingRow.unexpired }] : [];
      } else if (statement.startsWith("DELETE FROM api_idempotency_keys")) {
        const found = this.pendingRow?.id === parameters[0];
        if (found) this.pendingRow = undefined;
        result = { affectedRows: found ? 1 : 0, insertId: 0 };
      } else if (statement.startsWith("INSERT INTO api_idempotency_keys")) {
        if (this.pendingRow) return callback(native(1062, "23000"), undefined);
        this.pendingRow = stored({
          id: String(this.nextId++),
          request_hash: Buffer.from(parameters[3] as Buffer),
          response_status: parameters.length === 4 ? 200 : (parameters[4] as number),
          response_body_json: parameters.length === 4 ? "null" : (parameters[5] as string),
        });
        result = { affectedRows: 1, insertId: this.pendingRow.id };
      } else if (statement === "INSERT INTO audit_logs DEFAULT VALUES") {
        this.pendingWrites++;
        result = { affectedRows: 1, insertId: "1" };
      }
      callback(null, result);
    });
  }
  release() {}
  destroy() {
    this.destroyed++;
    this.pendingRow = undefined;
    this.pendingWrites = 0;
  }
}

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
});
function setup(row?: Row) {
  const raw = new MemoryConnection();
  raw.row = row;
  const database = createMariaDbDatabase<DB>(
    () => ({
      getConnection: (callback) => callback(null, raw),
      end: (callback) => callback(null),
    }),
    {
      host: "qa.invalid",
      database: "qa",
      user: "qa_app",
      password: "synthetic",
      sslCa: "-----BEGIN CERTIFICATE-----",
    },
  );
  databases.push(database);
  return { raw, service: new MariaDbIdempotencyService(database) };
}
async function write(transaction: Transaction<DB>) {
  await sql`INSERT INTO audit_logs DEFAULT VALUES`.execute(transaction);
  return { body: { id: "9223372036854775807" }, statusCode: 201 };
}
const reservationSql = (text: string, parameters: readonly unknown[]) =>
  text.startsWith("INSERT INTO api_idempotency_keys") && parameters.length === 4;

describe("MariaDB idempotency transaction candidate", () => {
  it("commits once and replays the durable response without calling the operation", async () => {
    const { raw, service } = setup();
    const operation = vi.fn(write);
    const first = await service.execute(request(), operation);
    const second = await service.execute(request(), operation);
    expect(first).toEqual({
      body: { id: "9223372036854775807" },
      statusCode: 201,
      replayed: false,
    });
    expect(second).toEqual({ ...first, replayed: true });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(raw.durableWrites).toBe(1);
    expect(raw.row?.response_status).toBe(201);
    expect(
      raw.commands
        .filter(({ statement }) => statement.startsWith("INSERT INTO api_idempotency_keys"))
        .every(({ parameters }) => parameters[2] === key.toLowerCase()),
    ).toBe(true);
  });

  it("snapshots request hashes before asynchronous connection acquisition", async () => {
    const { raw, service } = setup();
    const input = request();
    const promise = service.execute(input, write);
    input.requestHash.fill(9);
    await promise;
    expect(raw.row?.request_hash).toEqual(Buffer.alloc(32, 7));
  });

  it.each([
    { actorUserId: "0" },
    { actorUserId: "01" },
    { actorUserId: "9223372036854775808" },
    { routeKey: "" },
    { routeKey: "/classes " },
    { routeKey: "😀".repeat(256) },
    { routeKey: "\uD800" },
    { requestHash: Buffer.alloc(31) },
  ])("rejects invalid identity before borrowing a connection: %o", async (change) => {
    const { raw, service } = setup();
    await expect(service.execute({ ...request(), ...change }, write)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(raw.commands).toHaveLength(0);
  });

  it("preserves the existing invalid UUID error", async () => {
    const { raw, service } = setup();
    await expect(
      service.execute({ ...request(), idempotencyKey: "wrong" }, write),
    ).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
    expect(raw.commands).toHaveLength(0);
  });

  it("checks expiration after obtaining the row lock and allows a new hash", async () => {
    const { raw, service } = setup(stored({ request_hash: Buffer.alloc(32, 1) }));
    raw.fault = (statement) => {
      if (statement.startsWith("SELECT expires_at") && raw.pendingRow) raw.pendingRow.unexpired = 0;
    };
    await expect(service.execute(request(), write)).resolves.toMatchObject({ replayed: false });
    expect(raw.durableWrites).toBe(1);
    expect(raw.row?.request_hash).toEqual(request().requestHash);
  });

  it("rejects a different hash for an unexpired stored response", async () => {
    const { raw, service } = setup(stored({ request_hash: Buffer.alloc(32, 1) }));
    const operation = vi.fn(write);
    await expect(service.execute(request(), operation)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(operation).not.toHaveBeenCalled();
    expect(raw.commits).toBe(0);
  });

  it.each([
    { response_body_json: "{" },
    { response_status: 500 },
    { request_hash: Buffer.alloc(31) },
    { unexpired: 2 },
  ])("rejects corrupt stored responses without business writes: %o", async (change) => {
    const { raw, service } = setup(stored(change));
    const operation = vi.fn(write);
    await expect(service.execute(request(), operation)).rejects.toMatchObject({
      code: "invalid_stored_response",
    });
    expect(operation).not.toHaveBeenCalled();
    expect(raw.commits).toBe(0);
  });

  it("rolls back a reservation 1062 before retrying and replaying the winner", async () => {
    const { raw, service } = setup();
    raw.fault = (statement, parameters) => {
      if (raw.begins === 1 && reservationSql(statement, parameters)) {
        raw.row = stored();
        return native(1062, "23000");
      }
    };
    const operation = vi.fn(write);
    await expect(service.execute(request(), operation)).resolves.toMatchObject({ replayed: true });
    expect(operation).not.toHaveBeenCalled();
    expect(raw.begins).toBe(2);
    const statements = raw.commands.map(({ statement }) => statement);
    const firstInsert = statements.findIndex((statement) =>
      statement.startsWith("INSERT INTO api_idempotency_keys"),
    );
    expect(
      statements.slice(firstInsert + 1, statements.lastIndexOf("START TRANSACTION READ WRITE")),
    ).toContain("ROLLBACK");
  });

  it.each([
    native(1062, "23000"),
    native(30515, "40001"),
    native(1205, "HY000"),
    native(1213, "HY000"),
  ])("never retries a business error without exact deadlock metadata: %o", async (failure) => {
    const { raw, service } = setup();
    const operation = vi.fn(async (transaction: Transaction<DB>) => {
      await write(transaction);
      throw failure;
    });
    await expect(service.execute(request(), operation)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(raw.begins).toBe(1);
    expect(raw.durableWrites).toBe(0);
    expect(raw.row).toBeUndefined();
  });

  it("limits exact deadlock retries to three whole transactions", async () => {
    const { raw, service } = setup();
    const failure = native(1213, "40001");
    const operation = vi.fn(async (transaction: Transaction<DB>) => {
      await write(transaction);
      throw failure;
    });
    await expect(service.execute(request(), operation)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(raw.begins).toBe(3);
    expect(raw.durableWrites).toBe(0);
    expect(raw.row).toBeUndefined();
  });

  it("does not trust a caller-created reservation-conflict error as a retry token", async () => {
    const { raw, service } = setup();
    const operation = vi.fn(async () => {
      throw new MariaDbIdempotencyError("reservation_conflict");
    });
    await expect(service.execute(request(), operation)).rejects.toMatchObject({
      code: "reservation_conflict",
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(raw.begins).toBe(1);
  });

  it("keeps caught SQL errors rollback-only", async () => {
    const { raw, service } = setup();
    raw.fault = (statement) =>
      statement === "SELECT fail_operation" ? native(1062, "23000") : undefined;
    await expect(
      service.execute(request(), async (transaction) => {
        const result = await write(transaction);
        await sql`SELECT fail_operation`.execute(transaction).catch(() => undefined);
        return result;
      }),
    ).rejects.toMatchObject({ code: "rollback_only" });
    expect(raw.begins).toBe(1);
    expect(raw.commits).toBe(0);
    expect(raw.durableWrites).toBe(0);
    expect(raw.row).toBeUndefined();
  });

  it("does not retry an uncertain COMMIT acknowledgement", async () => {
    const { raw, service } = setup();
    raw.lostCommit = true;
    const operation = vi.fn(write);
    await expect(service.execute(request(), operation)).rejects.toThrow("connection lost");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(raw.destroyed).toBe(1);
    expect(raw.durableWrites).toBe(1);
    expect(raw.row?.response_status).toBe(201);
  });

  it.each([199, 300, 200.5])("rolls back a non-success status %s", async (statusCode) => {
    const { raw, service } = setup();
    await expect(
      service.execute(request(), async (transaction) => ({
        ...(await write(transaction)),
        statusCode,
      })),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(raw.row).toBeUndefined();
    expect(raw.durableWrites).toBe(0);
  });

  it.each([undefined, 1n])("rolls back an unserializable response %s", async (body) => {
    const { raw, service } = setup();
    await expect(
      service.execute(request(), async (transaction) => ({
        ...(await write(transaction)),
        body: body as unknown as JsonValue,
      })),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(raw.row).toBeUndefined();
    expect(raw.durableWrites).toBe(0);
  });

  it("returns the same JSON snapshot initially and on replay", async () => {
    const { service } = setup();
    const body = { nested: { value: Number.NaN }, zero: -0, id: "9223372036854775807" };
    const first = await service.execute(request(), async () => ({ body, statusCode: 200 }));
    body.nested.value = 10;
    const replay = await service.execute(request(), write);
    expect(first.body).toEqual({ nested: { value: null }, zero: 0, id: body.id });
    expect(replay.body).toEqual(first.body);
    expect(first.body).not.toBe(body);
  });

  it("does not expose a response serializer's private error", async () => {
    const { raw, service } = setup();
    const body = {
      toJSON() {
        throw new Error("private-response-value");
      },
    };
    const failure = await service
      .execute(request(), async (transaction) => ({
        ...(await write(transaction)),
        body: body as unknown as JsonValue,
      }))
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "invalid_response" });
    expect(String(failure)).not.toContain("private-response-value");
    expect(failure).not.toHaveProperty("cause");
    expect(raw.durableWrites).toBe(0);
    expect(raw.row).toBeUndefined();
  });

  it("treats a lost reservation as a non-retryable contract failure", async () => {
    const { raw, service } = setup();
    const operation = vi.fn(async (transaction: Transaction<DB>) => {
      const result = await write(transaction);
      raw.pendingRow = undefined;
      return result;
    });
    await expect(service.execute(request(), operation)).rejects.toMatchObject({
      code: "reservation_lost",
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(raw.begins).toBe(1);
    expect(raw.durableWrites).toBe(0);
    expect(raw.row).toBeUndefined();
  });

  it("bounds repeated reservation collisions without running business writes", async () => {
    const { raw, service } = setup();
    raw.fault = (statement, parameters) =>
      reservationSql(statement, parameters) ? native(1062, "23000") : undefined;
    const operation = vi.fn(write);
    await expect(service.execute(request(), operation)).rejects.toMatchObject({
      code: "reservation_conflict",
    });
    expect(raw.begins).toBe(3);
    expect(raw.commits).toBe(0);
    expect(operation).not.toHaveBeenCalled();
  });

  it("rolls back final response INSERT failure without retrying the callback", async () => {
    const { raw, service } = setup();
    const failure = native(1062, "23000");
    raw.fault = (statement, parameters) =>
      statement.startsWith("INSERT INTO api_idempotency_keys") && parameters.length === 6
        ? failure
        : undefined;
    const operation = vi.fn(write);
    await expect(service.execute(request(), operation)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(raw.durableWrites).toBe(0);
    expect(raw.row).toBeUndefined();
  });
});
