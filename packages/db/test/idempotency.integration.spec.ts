import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sql, type Kysely } from "kysely";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../src/connection.js";
import type { DB } from "../src/generated/database.js";
import {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  IdempotencyKeyReusedError,
  IdempotencyService,
} from "../src/idempotency/index.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
const migrationsDirectory = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

let actorUserId: string;
let bootstrapPool: Pool;
let container: StartedNativeTestService;
let database: Kysely<DB>;
let service: IdempotencyService;

function databaseUrl(username: string, password: string): string {
  return `postgresql://${username}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/classhub_dev`;
}

function request(idempotencyKey = randomUUID(), body: Record<string, unknown> = { title: "알림" }) {
  const effectiveClassId = "42";

  return {
    actorUserId,
    idempotencyKey,
    requestHash: createIdempotencyRequestHash({ body, effectiveClassId }),
    routeKey: createIdempotencyRouteKey("POST /notices", effectiveClassId),
  };
}

beforeAll(async () => {
  container = await startNativeTestService("postgres", {
    POSTGRES_DB: "classhub_dev",
    POSTGRES_PASSWORD: "local_bootstrap_password",
    POSTGRES_USER: "classhub_bootstrap",
  });

  bootstrapPool = new Pool({
    connectionString: databaseUrl("classhub_bootstrap", "local_bootstrap_password"),
  });
  await bootstrapPool.query(await readFile(bootstrapPath, "utf8"));

  await runner({
    databaseUrl: databaseUrl("classhub_migrator", "local_migrator_password"),
    direction: "up",
    dir: migrationsDirectory,
    migrationsTable: "pgmigrations",
    verbose: false,
  });

  database = createDatabase<DB>(databaseUrl("classhub_app", "local_app_password"));
  const actor = await database
    .insertInto("users")
    .values({
      display_name: "멱등 사용자",
      email_normalized: "idempotency@example.com",
      password_hash: "argon2-placeholder",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  actorUserId = actor.id;
  service = new IdempotencyService(database);
});

afterAll(async () => {
  await database?.destroy();
  await bootstrapPool?.end();
  await container?.stop({ remove: true, removeVolumes: true });
});

describe("IdempotencyService", () => {
  it("replays the first 2xx response for the same request", async () => {
    const input = request();
    let executions = 0;

    const operation = async () => {
      executions += 1;
      return { body: { notice_id: "100" }, statusCode: 201 } as const;
    };

    const first = await service.execute(input, operation);
    const replay = await service.execute(input, operation);

    expect(first).toEqual({ body: { notice_id: "100" }, replayed: false, statusCode: 201 });
    expect(replay).toEqual({ body: { notice_id: "100" }, replayed: true, statusCode: 201 });
    expect(executions).toBe(1);
  });

  it("rejects the same key with a different canonical request", async () => {
    const idempotencyKey = randomUUID();
    await service.execute(request(idempotencyKey), async () => ({
      body: { notice_id: "101" },
      statusCode: 201,
    }));

    await expect(
      service.execute(request(idempotencyKey, { title: "다른 알림" }), async () => ({
        body: { notice_id: "102" },
        statusCode: 201,
      })),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it("serializes concurrent first requests and executes the operation once", async () => {
    const input = request();
    let executions = 0;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.execute(input, async (transaction) => {
          executions += 1;
          await sql`SELECT pg_sleep(0.05)`.execute(transaction);
          return { body: { notice_id: "103" }, statusCode: 201 };
        }),
      ),
    );

    expect(executions).toBe(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(9);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
  });

  it("rolls business changes back when the operation fails", async () => {
    const input = request();
    const rollbackEmail = `rollback-${randomUUID()}@example.com`;

    await expect(
      service.execute(input, async (transaction) => {
        await transaction
          .insertInto("users")
          .values({
            display_name: "롤백 사용자",
            email_normalized: rollbackEmail,
            password_hash: "argon2-placeholder",
          })
          .execute();
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");

    const user = await database
      .selectFrom("users")
      .select("id")
      .where("email_normalized", "=", rollbackEmail)
      .executeTakeFirst();
    const stored = await database
      .selectFrom("api_idempotency_keys")
      .select("id")
      .where("actor_user_id", "=", actorUserId)
      .where("route_key", "=", input.routeKey)
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirst();

    expect(user).toBeUndefined();
    expect(stored).toBeUndefined();
  });

  it("removes an expired record and accepts the key as a new request", async () => {
    const idempotencyKey = randomUUID();
    const input = request(idempotencyKey, { title: "새 알림" });
    const now = Date.now();

    await database
      .insertInto("api_idempotency_keys")
      .values({
        actor_user_id: actorUserId,
        created_at: new Date(now - 25 * 60 * 60 * 1_000),
        expires_at: new Date(now - 60 * 60 * 1_000),
        idempotency_key: idempotencyKey,
        request_hash: Buffer.alloc(32, 1),
        response_body_json: { notice_id: "expired" },
        response_status: 201,
        route_key: input.routeKey,
      })
      .execute();

    const result = await service.execute(input, async () => ({
      body: { notice_id: "104" },
      statusCode: 201,
    }));

    expect(result).toEqual({ body: { notice_id: "104" }, replayed: false, statusCode: 201 });
    const rows = await database
      .selectFrom("api_idempotency_keys")
      .select(["response_body_json", "response_status"])
      .where("actor_user_id", "=", actorUserId)
      .where("route_key", "=", input.routeKey)
      .where("idempotency_key", "=", idempotencyKey)
      .execute();
    expect(rows).toEqual([{ response_body_json: { notice_id: "104" }, response_status: 201 }]);
  });

  it("rolls back a non-2xx operation result and does not store it", async () => {
    const input = request();
    const rollbackEmail = `non-2xx-${randomUUID()}@example.com`;

    await expect(
      service.execute(input, async (transaction) => {
        await transaction
          .insertInto("users")
          .values({
            display_name: "실패 사용자",
            email_normalized: rollbackEmail,
            password_hash: "argon2-placeholder",
          })
          .execute();
        return { body: { error: "conflict" }, statusCode: 409 };
      }),
    ).rejects.toThrow("Only 2xx idempotency responses can be stored.");

    const user = await database
      .selectFrom("users")
      .select("id")
      .where("email_normalized", "=", rollbackEmail)
      .executeTakeFirst();
    const stored = await database
      .selectFrom("api_idempotency_keys")
      .select("id")
      .where("actor_user_id", "=", actorUserId)
      .where("route_key", "=", input.routeKey)
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirst();

    expect(user).toBeUndefined();
    expect(stored).toBeUndefined();
  });
});
