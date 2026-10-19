import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createDatabase, type DB } from "@classhub/db";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "kysely";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "../src/auth/password-hasher.js";
import { loadEnvironment } from "../src/config/environment.js";
import {
  LOCAL_ADMIN_CSRF_COOKIE,
  LOCAL_ADMIN_SESSION_COOKIE,
} from "../src/local-test-admin/local-test-admin.cookies.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);

const publicOrigin = "http://localhost:5173";
const operatorEmail = "local-admin-regression@classhub.local";
const localAdminPassword = "integration-local-admin-password-1234";
const environmentKeys = [
  "AGE_POLICY_VERSION",
  "DATABASE_ENGINE",
  "DATABASE_URL",
  "EMAIL_HMAC_KEY",
  "EMAIL_HMAC_KEY_VERSION",
  "LOCAL_TEST_ADMIN_DATABASE_URL",
  "LOCAL_TEST_ADMIN_ENABLED",
  "LOCAL_TEST_ADMIN_OPERATOR_EMAIL",
  "LOCAL_TEST_ADMIN_PASSWORD_HASH",
  "LOCAL_TEST_ADMIN_USERNAME",
  "LOG_LEVEL",
  "NODE_ENV",
  "POLLS_ENABLED",
  "SEAT_DRAWS_ENABLED",
  "TEAM_DRAWS_ENABLED",
  "PRIVACY_POLICY_VERSION",
  "PUBLIC_API_ORIGIN",
  "PUBLIC_APP_ORIGIN",
  "REDIS_URL",
  "SERVE_WEB",
  "SMTP_FROM",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "TERMS_POLICY_VERSION",
] as const;
const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]] as const));

let postgres: StartedNativeTestService;
let bootstrapDatabase: ReturnType<typeof createDatabase<DB>>;
let httpApplication: NestFastifyApplication;

function reachableHost(container: StartedNativeTestService): string {
  return container.getHost() === "localhost" ? "127.0.0.1" : container.getHost();
}

function postgresUrl(user: string, password: string): string {
  return `postgresql://${user}:${password}@${reachableHost(postgres)}:${postgres.getMappedPort(5432)}/classhub_dev`;
}

async function applyMigrations(): Promise<void> {
  const migratorDatabase = createDatabase<DB>(
    postgresUrl("classhub_migrator", "local_migrator_password"),
  );

  try {
    await sql
      .raw(
        `
          CREATE TABLE pgmigrations (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            run_on TIMESTAMPTZ NOT NULL
          )
        `,
      )
      .execute(migratorDatabase);

    for (const migrationPath of await loadAllTestMigrationPaths()) {
      const migration = await readFile(migrationPath, "utf8");
      const up = migration.split("-- Down Migration", 1)[0]!.replace("-- Up Migration", "");
      await migratorDatabase
        .transaction()
        .execute((transaction) => sql.raw(up).execute(transaction));
    }
  } finally {
    await migratorDatabase.destroy();
  }
}

function responseCookies(headers: {
  "set-cookie"?: number | string | string[] | undefined;
}): string[] {
  const value = headers["set-cookie"];
  if (value === undefined || typeof value === "number") return [];
  return Array.isArray(value) ? value : [value];
}

function rawCookie(cookies: string[], name: string): string {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  const raw = cookie?.slice(name.length + 1).split(";", 1)[0];
  if (raw === undefined || raw.length === 0) throw new Error(`${name} cookie is missing.`);
  return raw;
}

async function accountDependencies(userId: string) {
  const [user, teacherProfile, consents, membershipCount] = await Promise.all([
    bootstrapDatabase.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst(),
    bootstrapDatabase
      .selectFrom("teacher_profiles")
      .selectAll()
      .where("user_id", "=", userId)
      .executeTakeFirst(),
    bootstrapDatabase
      .selectFrom("user_consents")
      .selectAll()
      .where("user_id", "=", userId)
      .orderBy("id")
      .execute(),
    bootstrapDatabase
      .selectFrom("class_members")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow(),
  ]);

  return { consents, membershipCount: membershipCount.count, teacherProfile, user };
}

beforeAll(async () => {
  postgres = await startNativeTestService("postgres", {
    POSTGRES_DB: "classhub_dev",
    POSTGRES_PASSWORD: "local_bootstrap_password",
    POSTGRES_USER: "classhub_bootstrap",
  });

  bootstrapDatabase = createDatabase<DB>(
    postgresUrl("classhub_bootstrap", "local_bootstrap_password"),
  );
  await sql.raw(await readFile(bootstrapPath, "utf8")).execute(bootstrapDatabase);
  await applyMigrations();

  const operator = await bootstrapDatabase
    .insertInto("operators")
    .values({
      credential_hash: createHash("sha256").update("local-admin-regression-operator").digest(),
      email_normalized: operatorEmail,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const localAdminPasswordHash = await hashPassword(localAdminPassword);

  const fixtureEnvironment = {
    AGE_POLICY_VERSION: "age-2026-07",
    DATABASE_ENGINE: "postgres",
    DATABASE_URL: postgresUrl("classhub_app", "local_app_password"),
    EMAIL_HMAC_KEY: "local-admin-integration-hmac-key-32-bytes",
    EMAIL_HMAC_KEY_VERSION: "test-v1",
    LOCAL_TEST_ADMIN_DATABASE_URL: postgresUrl("classhub_local_admin", "local_admin_db_password"),
    LOCAL_TEST_ADMIN_ENABLED: "true",
    LOCAL_TEST_ADMIN_OPERATOR_EMAIL: operatorEmail,
    LOCAL_TEST_ADMIN_PASSWORD_HASH: localAdminPasswordHash,
    LOCAL_TEST_ADMIN_USERNAME: "admin",
    LOG_LEVEL: "fatal",
    NODE_ENV: "development",
    POLLS_ENABLED: "false",
    SEAT_DRAWS_ENABLED: "false",
    PRIVACY_POLICY_VERSION: "privacy-2026-07",
    PUBLIC_API_ORIGIN: publicOrigin,
    PUBLIC_APP_ORIGIN: publicOrigin,
    REDIS_URL: "redis://127.0.0.1:1",
    SERVE_WEB: "false",
    SMTP_FROM: "no-reply@classhub.local",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "1",
    SMTP_SECURE: "false",
    TERMS_POLICY_VERSION: "terms-2026-07",
  };
  Object.assign(process.env, fixtureEnvironment);

  const { createApplication } = await import("../src/app.factory.js");
  ({ app: httpApplication } = await createApplication({
    environment: loadEnvironment(fixtureEnvironment),
  }));

  expect(operator.id).toMatch(/^\d+$/u);
}, 120_000);

afterAll(async () => {
  let cleanupError: unknown;

  try {
    const databaseCleanup = await Promise.allSettled([
      httpApplication?.close(),
      bootstrapDatabase?.destroy(),
    ]);
    for (const outcome of databaseCleanup) {
      if (outcome.status === "rejected" && cleanupError === undefined) {
        cleanupError = outcome.reason;
      }
    }

    try {
      await postgres?.stop();
    } catch (error) {
      cleanupError ??= error;
    }
  } finally {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  if (cleanupError !== undefined) throw cleanupError;
}, 120_000);

describe("local test admin dependency protection", () => {
  it("returns a domain 409 and preserves a profile-only teacher account", async () => {
    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/local-test-admin/login",
      headers: { origin: publicOrigin },
      payload: { password: localAdminPassword, username: "admin" },
    });
    expect(login.statusCode).toBe(200);

    const cookies = responseCookies(login.headers);
    const sessionToken = rawCookie(cookies, LOCAL_ADMIN_SESSION_COOKIE);
    const csrfToken = rawCookie(cookies, LOCAL_ADMIN_CSRF_COOKIE);
    const cookieHeader = `${LOCAL_ADMIN_SESSION_COOKIE}=${sessionToken}; ${LOCAL_ADMIN_CSRF_COOKIE}=${csrfToken}`;
    const accountPayload = {
      display_name: "프로필 교사",
      email: "teacher-profile-only@example.com",
      email_verified: true,
      password: "classhub123",
    };

    const created = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/local-test-admin/accounts",
      headers: {
        cookie: cookieHeader,
        origin: publicOrigin,
        "x-local-admin-csrf": csrfToken,
      },
      payload: accountPayload,
    });
    expect(created.statusCode).toBe(201);
    const userId = created.json().id as string;

    const operator = await bootstrapDatabase
      .selectFrom("operators")
      .select("id")
      .where("email_normalized", "=", operatorEmail)
      .executeTakeFirstOrThrow();
    await bootstrapDatabase
      .insertInto("teacher_profiles")
      .values({
        created_by_operator_id: operator.id,
        temporary_password_expires_at: null,
        temporary_password_must_change: false,
        user_id: userId,
      })
      .execute();

    const before = await accountDependencies(userId);
    expect(before.membershipCount).toBe("0");
    expect(before.consents).toHaveLength(3);
    expect(before.teacherProfile).toBeDefined();

    const deleted = await httpApplication.inject({
      method: "DELETE",
      url: `/api/v1/local-test-admin/accounts/${userId}`,
      headers: {
        cookie: cookieHeader,
        origin: publicOrigin,
        "x-local-admin-csrf": csrfToken,
      },
      payload: { email: accountPayload.email },
    });

    expect(deleted.statusCode).toBe(409);
    expect(deleted.json()).toEqual({
      error: {
        code: "LOCAL_TEST_ACCOUNT_HAS_MEMBERSHIP",
        message: "반 멤버십이 있는 테스트 계정은 이 화면에서 삭제할 수 없습니다.",
        request_id: deleted.headers["x-request-id"],
      },
    });
    expect(deleted.json().error.code).not.toBe("INTERNAL_ERROR");
    await expect(accountDependencies(userId)).resolves.toEqual(before);
  });
});
