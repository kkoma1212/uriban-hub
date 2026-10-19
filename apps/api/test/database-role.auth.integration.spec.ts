import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createDatabase, type DB } from "@classhub/db";
import { sql } from "kysely";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertApplicationDatabaseRole,
  openApplicationDatabase,
} from "../src/database/database.module.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);

let postgres: StartedNativeTestService;
let bootstrapDatabase: ReturnType<typeof createDatabase<DB>>;

function reachableHost(container: StartedNativeTestService): string {
  return container.getHost() === "localhost" ? "127.0.0.1" : container.getHost();
}

function postgresUrl(user: string, password: string): string {
  return `postgresql://${user}:${password}@${reachableHost(postgres)}:${postgres.getMappedPort(
    5432,
  )}/classhub_dev`;
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
}, 120_000);

afterAll(async () => {
  await bootstrapDatabase?.destroy();
  await postgres?.stop();
}, 120_000);

describe.sequential("application database runtime identity", () => {
  it("opens with the exact least-privilege application role", async () => {
    const database = await openApplicationDatabase(
      postgresUrl("classhub_app", "local_app_password"),
    );

    try {
      await expect(assertApplicationDatabaseRole(database)).resolves.toBeUndefined();
    } finally {
      await database.destroy();
    }
  });

  it.each([
    ["bootstrap", "classhub_bootstrap", "local_bootstrap_password"],
    ["migrator", "classhub_migrator", "local_migrator_password"],
  ])("rejects the %s connection before returning a database", async (_label, user, password) => {
    await expect(openApplicationDatabase(postgresUrl(user, password))).rejects.toThrow(
      "classhub_app",
    );
  });

  it("rejects current_user and session_user role mismatch", async () => {
    const database = createDatabase<DB>(
      postgresUrl("classhub_bootstrap", "local_bootstrap_password"),
    );

    try {
      await database.transaction().execute(async (transaction) => {
        await sql`SET ROLE classhub_app`.execute(transaction);

        try {
          const identity = await transaction
            .selectNoFrom([
              sql<string>`current_user`.as("current_role_name"),
              sql<string>`session_user`.as("session_role_name"),
            ])
            .executeTakeFirstOrThrow();

          expect(identity).toEqual({
            current_role_name: "classhub_app",
            session_role_name: "classhub_bootstrap",
          });
          await expect(assertApplicationDatabaseRole(transaction)).rejects.toThrow("classhub_app");
        } finally {
          await sql`RESET ROLE`.execute(transaction);
        }
      });
    } finally {
      await database.destroy();
    }
  });

  it("rejects the expected role when a dangerous PostgreSQL attribute is granted", async () => {
    await sql.raw("ALTER ROLE classhub_app SUPERUSER").execute(bootstrapDatabase);

    try {
      await expect(
        openApplicationDatabase(postgresUrl("classhub_app", "local_app_password")),
      ).rejects.toThrow("최소 권한");
    } finally {
      await sql.raw("ALTER ROLE classhub_app NOSUPERUSER").execute(bootstrapDatabase);
    }
  });

  it("rejects the expected role when INHERIT is enabled", async () => {
    await sql.raw("ALTER ROLE classhub_app INHERIT").execute(bootstrapDatabase);

    try {
      await expect(
        openApplicationDatabase(postgresUrl("classhub_app", "local_app_password")),
      ).rejects.toThrow("최소 권한");
    } finally {
      await sql.raw("ALTER ROLE classhub_app NOINHERIT").execute(bootstrapDatabase);
    }
  });

  it("rejects direct role membership drift even with NOINHERIT", async () => {
    await sql.raw("GRANT pg_read_all_data TO classhub_app").execute(bootstrapDatabase);

    try {
      await expect(
        openApplicationDatabase(postgresUrl("classhub_app", "local_app_password")),
      ).rejects.toThrow("최소 권한");
    } finally {
      await sql.raw("REVOKE pg_read_all_data FROM classhub_app").execute(bootstrapDatabase);
    }
  });
});
