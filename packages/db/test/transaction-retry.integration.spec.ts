import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Kysely, Transaction } from "kysely";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../src/connection.js";
import type { DB } from "../src/generated/database.js";
import { withSerializationRetry } from "../src/transaction-retry.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
const migrationsDirectory = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

let bootstrapPool: Pool;
let container: StartedNativeTestService;
let database: Kysely<DB>;
let leftUserId: string;
let rightUserId: string;

function databaseUrl(username: string, password: string): string {
  return `postgresql://${username}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/classhub_dev`;
}

async function lockUser(transaction: Transaction<DB>, userId: string): Promise<void> {
  await transaction.selectFrom("users").select("id").where("id", "=", userId).forUpdate().execute();
}

interface Signal {
  readonly promise: Promise<void>;
  resolve: () => void;
}

function signal(): Signal {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
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
  const [left, right] = await Promise.all([
    database
      .insertInto("users")
      .values({
        display_name: "교착 좌",
        email_normalized: "deadlock-left@example.com",
        password_hash: "argon2-placeholder",
      })
      .returning("id")
      .executeTakeFirstOrThrow(),
    database
      .insertInto("users")
      .values({
        display_name: "교착 우",
        email_normalized: "deadlock-right@example.com",
        password_hash: "argon2-placeholder",
      })
      .returning("id")
      .executeTakeFirstOrThrow(),
  ]);
  leftUserId = left.id;
  rightUserId = right.id;
}, 180_000);

afterAll(async () => {
  await database?.destroy();
  await bootstrapPool?.end();
  await container?.stop({ remove: true, removeVolumes: true });
}, 120_000);

/*
 * P1-02의 교착은 실제 서비스에서 타이밍에 달려 있어 재현이 어렵다. 여기서는 두
 * 트랜잭션이 서로 반대 순서로 잠그도록 인터리빙을 배리어로 고정해 확실히 만든다.
 * 잠그는 대상이 users 두 행이라 classes↔users 조합과 표는 다르지만, 교착의 성립
 * 조건과 PostgreSQL의 대응(한쪽을 40P01로 중단)은 같다 — 재시도 계층이 실제
 * 교착에서 복구하는지가 이 시험의 대상이다.
 */
describe.sequential("deadlock recovery", () => {
  it("aborts one side with 40P01 when two transactions lock in opposite order", async () => {
    const leftLocked = signal();
    const rightLocked = signal();

    const takeLeftThenRight = database.transaction().execute(async (transaction) => {
      await lockUser(transaction, leftUserId);
      leftLocked.resolve();
      await rightLocked.promise;
      await lockUser(transaction, rightUserId);
      return "left-first";
    });
    const takeRightThenLeft = database.transaction().execute(async (transaction) => {
      await lockUser(transaction, rightUserId);
      rightLocked.resolve();
      await leftLocked.promise;
      await lockUser(transaction, leftUserId);
      return "right-first";
    });

    const outcomes = await Promise.allSettled([takeLeftThenRight, takeRightThenLeft]);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

    // 정확히 한 쪽만 죽어야 한다. 둘 다 살면 교착이 안 난 것이라 이 시험이 무의미하고,
    // 둘 다 죽으면 재현 방식이 잘못된 것이다.
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    expect(reason.code).toBe("40P01");
  }, 60_000);

  it("lets both sides finish when the same collision runs under retry", async () => {
    const leftLocked = signal();
    const rightLocked = signal();
    let leftAttempts = 0;
    let rightAttempts = 0;

    // 배리어는 첫 시도에만 건다. 재시도까지 붙잡아 두면 상대가 이미 끝난 신호를
    // 기다리다 멈춘다.
    const takeLeftThenRight = withSerializationRetry(async () => {
      leftAttempts += 1;
      const attempt = leftAttempts;
      return database.transaction().execute(async (transaction) => {
        await lockUser(transaction, leftUserId);
        if (attempt === 1) {
          leftLocked.resolve();
          await rightLocked.promise;
        }
        await lockUser(transaction, rightUserId);
        return "left-first";
      });
    });
    const takeRightThenLeft = withSerializationRetry(async () => {
      rightAttempts += 1;
      const attempt = rightAttempts;
      return database.transaction().execute(async (transaction) => {
        await lockUser(transaction, rightUserId);
        if (attempt === 1) {
          rightLocked.resolve();
          await leftLocked.promise;
        }
        await lockUser(transaction, leftUserId);
        return "left-second";
      });
    });

    await expect(Promise.all([takeLeftThenRight, takeRightThenLeft])).resolves.toEqual([
      "left-first",
      "left-second",
    ]);
    // 한 쪽은 반드시 희생돼 다시 돌았어야 한다. 둘 다 1회였다면 교착이 나지 않은
    // 것이므로, 이 시험이 재시도를 검증했다고 말할 수 없다.
    expect(leftAttempts + rightAttempts).toBeGreaterThan(2);
  }, 60_000);
});
