import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDatabase,
  createMariaDbDatabase,
  createMysql2MariaDbPool,
  type DB,
} from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, MysqlDialect, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { AuthService } from "../src/auth/auth.service.js";
import type { SignUpCommand } from "../src/auth/auth.types.js";
import type { AppEnvironment } from "../src/config/environment.js";
import {
  CONSENT_DOCUMENT_TYPES,
  currentLegalConsentSnapshot,
  parseLegalConsentSnapshot,
  type LegalConsentSnapshot,
} from "../src/legal/legal-consent-snapshot.js";
import { authDateValue } from "../src/auth/mariadb/auth-persistence.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";

// The optional MariaDB target is created and owned by an isolated QA runner.
// Production DSNs and default service ports are deliberately not accepted here.
const mariaConfigPath = process.env.LEGAL_CONSENT_QA_MARIADB_CONFIG;
if (!mariaConfigPath && process.env.CLASSHUB_REQUIRE_MARIADB === "1") {
  throw new Error(
    "The MariaDB gate cannot fall back to PostgreSQL. Run corepack pnpm test:mariadb-isolated.",
  );
}
const maria = mariaConfigPath !== undefined;
const root = new URL("../../../", import.meta.url);
const config = {
  agePolicyVersion: "age-test-1",
  termsPolicyVersion: "legacy-terms",
  privacyPolicyVersion: "legacy-privacy",
  emailHmacKey: "isolated-consent-test-hmac-key-only",
  emailHmacKeyVersion: "test-v1",
};
let admin: Kysely<DB>;
let app: Kysely<DB>;
let postgres: StartedNativeTestService | undefined;
let issuerId: string;
let legacyRequestId: string;
let snapshot: LegalConsentSnapshot;
let auth: AuthService;
const messages: string[] = [];
const mailer = {
  sendGuardianConsentEmail: async (_email: string, token: string) => {
    messages.push(token);
  },
  sendVerificationEmail: async () => undefined,
};
function service(required: boolean) {
  return new AuthService(
    app,
    // 인증 메일은 consumeAll로 여러 한도를 한꺼번에 예약한다(7f30eff).
    {
      consume: async () => ({ allowed: true }),
      consumeAll: async () => ({ allowed: true }),
    } as never,
    mailer,
    config,
    { publish: async () => undefined, close: async () => undefined },
    new ConfigService<AppEnvironment, true>({
      DATABASE_ENGINE: maria ? "mariadb" : "postgres",
      LEGAL_CONSENT_BINDING_ENABLED: required,
    }),
  );
}
const command = (email = `${randomUUID()}@example.invalid`): SignUpCommand => ({
  role: "student",
  age_route: "over_14",
  email,
  display_name: "동의 시험",
  password: "Safe1!x8",
  consents: { terms: true, privacy: true },
  legal_documents: snapshot,
});
async function publish(type: (typeof CONSENT_DOCUMENT_TYPES)[number]) {
  const id = randomUUID();
  const content = `Synthetic consent integration fixture ${type} ${id}`;
  await admin
    .updateTable("admin_terms_versions")
    .set({ status: "retired" })
    .where("document_type", "=", type)
    .where("status", "=", "published")
    .execute();
  await admin
    .insertInto("admin_terms_versions")
    .values({
      id,
      document_type: type,
      policy_version: `${type}-${id}`.padEnd(80, "x"),
      title: `Fixture ${type}`,
      content,
      content_sha256: createHash("sha256").update(content).digest(),
      status: "published",
      published_at: authDateValue(new Date(Date.now() - 1000), maria),
      effective_at: authDateValue(new Date(Date.now() - 1000), maria),
      created_by_admin_account_id: issuerId,
    })
    .execute();
}
beforeAll(async () => {
  const migrationPaths = await loadAllTestMigrationPaths();
  const consentMigrationPaths = migrationPaths.filter((path) =>
    path.endsWith("_legal-consent-snapshots.sql"),
  );
  if (consentMigrationPaths.length !== 1) {
    throw new Error("Expected exactly one legal consent snapshot migration");
  }
  const consentMigrationPath = consentMigrationPaths[0]!;
  if (mariaConfigPath) {
    const target = JSON.parse(await readFile(mariaConfigPath, "utf8"));
    expect(target.kind).toBe("classhub-consent-isolated-qa");
    expect(target.database).toBe("classhub_consent_qa");
    expect(target.host).toBe("localhost");
    expect(target.port).toBeGreaterThan(1024);
    expect([3306, 3307, 5173, 5174]).not.toContain(target.port);
    const require = createRequire(new URL("packages/db/package.json", root));
    const mysql = require("mysql2");
    const connection = {
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.user,
      password: target.password,
    };
    admin = new Kysely<DB>({
      dialect: new MysqlDialect({
        pool: mysql.createPool({
          ...connection,
          ssl: { ca: target.sslCa, rejectUnauthorized: true, verifyIdentity: true },
          timezone: "Z",
          supportBigNumbers: true,
          bigNumberStrings: true,
          dateStrings: true,
          multipleStatements: true,
          connectionLimit: 3,
        }),
      }),
    });
    app = createMariaDbDatabase<DB>(createMysql2MariaDbPool, {
      ...connection,
      sslCa: target.sslCa,
      user: target.appUser,
      password: target.appPassword,
    });
    issuerId = "1";
  } else {
    postgres = await startNativeTestService("postgres");
    const url = (user: string, password: string) =>
      `postgresql://${user}:${password}@127.0.0.1:${postgres!.getMappedPort(5432)}/classhub_dev`;
    admin = createDatabase<DB>(url("classhub_bootstrap", "local_bootstrap_password"));
    await sql
      .raw(await readFile(new URL("db/bootstrap/001-local-development-roles.sql", root), "utf8"))
      .execute(admin);
    const migrator = createDatabase<DB>(url("classhub_migrator", "local_migrator_password"));
    try {
      await sql
        .raw(
          "CREATE TABLE pgmigrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, run_on TIMESTAMPTZ NOT NULL)",
        )
        .execute(migrator);
      for (const path of migrationPaths) {
        if (path === consentMigrationPath) continue;
        await sql
          .raw((await readFile(path, "utf8")).split("-- Down Migration")[0]!)
          .execute(migrator);
      }
    } finally {
      await migrator.destroy();
    }
    const operator = await admin
      .insertInto("operators")
      .values({
        credential_hash: Buffer.alloc(32, 9),
        email_normalized: "fixture-operator@example.invalid",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const issuer = await admin
      .insertInto("admin_accounts")
      .values({
        created_by_admin_account_id: null,
        created_by_operator_id: operator.id,
        display_name: "시험 관리자",
        email_normalized: "fixture-admin@example.invalid",
        password_hash: "not-a-login-credential",
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    issuerId = issuer.id;
    app = createDatabase<DB>(url("classhub_app", "local_app_password"));
  }
  // Run the old preview behavior against the old schema before applying the candidate.
  const legacy = service(false);
  const oldCommand = command("legacy@example.invalid");
  delete oldCommand.legal_documents;
  await legacy.signUp(oldCommand, "127.0.0.1");
  legacyRequestId = (
    await legacy.requestGuardianConsent("legacy-parent@example.invalid", "127.0.0.1")
  ).request_id;
  const path = maria
    ? new URL("db/mariadb/migrations/0045_legal_consent_snapshots.sql", root)
    : consentMigrationPath;
  await sql.raw((await readFile(path, "utf8")).split("-- Down Migration")[0]!).execute(admin);
  auth = service(true);
}, 120_000);
beforeEach(async () => {
  messages.length = 0;
  for (const type of CONSENT_DOCUMENT_TYPES) await publish(type);
  snapshot = await currentLegalConsentSnapshot(app, maria, new Date());
});
afterAll(async () => {
  await Promise.allSettled([app?.destroy(), admin?.destroy()]);
  await postgres?.stop();
});

describe(`legal consent evidence on ${maria ? "MariaDB" : "PostgreSQL"}`, () => {
  it("leaves pre-migration evidence unknown and rejects incomplete new JSON", async () => {
    const legacy = await admin
      .selectFrom("user_consents")
      .innerJoin("users", "users.id", "user_consents.user_id")
      .select("document_snapshot")
      .where("email_normalized", "=", "legacy@example.invalid")
      .execute();
    expect(legacy).toHaveLength(3);
    expect(legacy.every((row) => row.document_snapshot === null)).toBe(true);
    const guardian = await admin
      .selectFrom("guardian_consent_requests")
      .select("document_snapshot")
      .where("id", "=", legacyRequestId)
      .executeTakeFirstOrThrow();
    expect(guardian.document_snapshot).toBeNull();
    await expect(
      admin
        .updateTable("guardian_consent_requests")
        .set({ document_snapshot: "{}" })
        .where("id", "=", legacyRequestId)
        .execute(),
    ).rejects.toThrow();
  });
  it("stores all four immutable references and supports 80-character policy versions", async () => {
    const signup = command();
    await auth.signUp(signup, "127.0.0.1");
    const rows = await admin
      .selectFrom("user_consents")
      .innerJoin("users", "users.id", "user_consents.user_id")
      .select(["document_snapshot", "policy_version", "consent_type", "accepted_at"])
      .where("email_normalized", "=", signup.email)
      .execute();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(parseLegalConsentSnapshot(row.document_snapshot)).toEqual(snapshot);
      expect(row.accepted_at).toBeTruthy();
    }
    expect(rows.find((row) => row.consent_type === "privacy")?.policy_version).toBe(
      snapshot.privacy_consent.policy_version,
    );
  });
  it("binds guardian creation, explicit approval and one-time signup consumption", async () => {
    const request = await auth.requestGuardianConsent(
      "parent@example.invalid",
      "127.0.0.1",
      snapshot,
    );
    expect(await auth.getGuardianConsentStatus(request)).toEqual({ status: "pending" });
    await auth.confirmGuardianConsent(messages[0]!, snapshot);
    expect(await auth.getGuardianConsentStatus(request)).toEqual({ status: "approved" });
    const signup: SignUpCommand = {
      ...command(),
      age_route: "guardian_consent",
      guardian_consent: {
        request_id: request.request_id,
        completion_token: request.completion_token,
      },
    };
    await auth.signUp(signup, "127.0.0.1");
    const evidence = await admin
      .selectFrom("guardian_consent_requests")
      .selectAll()
      .where("id", "=", request.request_id)
      .executeTakeFirstOrThrow();
    expect(parseLegalConsentSnapshot(evidence.document_snapshot)).toEqual(snapshot);
    expect(evidence.approved_at).toBeTruthy();
    expect(evidence.consumed_at).toBeTruthy();
    expect(evidence.completion_token_hash).toBeNull();
    await expect(
      auth.signUp({ ...signup, email: "replay@example.invalid" }, "127.0.0.1"),
    ).rejects.toMatchObject({ status: 400 });
  });
  it.each(CONSENT_DOCUMENT_TYPES)(
    "rejects old guardian approval after %s changes",
    async (type) => {
      await auth.requestGuardianConsent("parent@example.invalid", "127.0.0.1", snapshot);
      await publish(type);
      const current = await currentLegalConsentSnapshot(app, maria, new Date());
      await expect(auth.confirmGuardianConsent(messages[0]!, current)).rejects.toMatchObject({
        status: 400,
      });
      await expect(auth.confirmGuardianConsent(messages[0]!, snapshot)).rejects.toMatchObject({
        status: 409,
      });
    },
  );
  it("does not create a user or consume proof when only the privacy notice changes after approval", async () => {
    const request = await auth.requestGuardianConsent(
      "parent@example.invalid",
      "127.0.0.1",
      snapshot,
    );
    await auth.confirmGuardianConsent(messages[0]!, snapshot);
    await publish("privacy_policy");
    snapshot = await currentLegalConsentSnapshot(app, maria, new Date());
    expect(await auth.getGuardianConsentStatus(request)).toEqual({ status: "expired" });
    const signup: SignUpCommand = {
      ...command(),
      age_route: "guardian_consent",
      guardian_consent: {
        request_id: request.request_id,
        completion_token: request.completion_token,
      },
    };
    await expect(auth.signUp(signup, "127.0.0.1")).rejects.toMatchObject({ status: 400 });
    expect(
      await admin
        .selectFrom("users")
        .select("id")
        .where("email_normalized", "=", signup.email)
        .execute(),
    ).toHaveLength(0);
    expect(
      (
        await admin
          .selectFrom("guardian_consent_requests")
          .select("consumed_at")
          .where("id", "=", request.request_id)
          .executeTakeFirstOrThrow()
      ).consumed_at,
    ).toBeNull();
  });
  it("fails closed when the published body no longer matches its hash", async () => {
    await admin
      .updateTable("admin_terms_versions")
      .set({ content: "Corrupted fixture body" })
      .where("id", "=", snapshot.terms.id)
      .execute();
    await expect(
      auth.requestGuardianConsent("parent@example.invalid", "127.0.0.1", snapshot),
    ).rejects.toMatchObject({ status: 503 });
    expect(messages).toHaveLength(0);
  });
  it("holds publication rows until the consent transaction releases them", async () => {
    let unlock!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((done) => {
      locked = done;
    });
    const release = new Promise<void>((done) => {
      unlock = done;
    });
    const reader = app.transaction().execute(async (transaction) => {
      await currentLegalConsentSnapshot(transaction, maria, new Date(), true);
      locked();
      await release;
    });
    await ready;
    let changed = false;
    const writer = admin
      .updateTable("admin_terms_versions")
      .set({ status: "retired" })
      .where("id", "=", snapshot.terms.id)
      .execute()
      .then(() => {
        changed = true;
      });
    try {
      await delay(150);
      expect(changed).toBe(false);
    } finally {
      unlock();
      await reader;
      await writer;
    }
    expect(changed).toBe(true);
  });
});
