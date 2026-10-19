import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  createDatabase,
  createMariaDbDatabase,
  createMysql2MariaDbPool,
  type DB,
} from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Kysely, MysqlDialect, sql } from "kysely";
import { createClient, type RedisClientType } from "redis";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { createApplication } from "../src/app.factory.js";
import { loadEnvironment, type AppEnvironment } from "../src/config/environment.js";
import { AuthService } from "../src/auth/auth.service.js";
import { SessionService } from "../src/auth/session.service.js";
import { AUTH_CONFIG, AUTH_RATE_LIMITER } from "../src/auth/auth.tokens.js";
import { AccountService } from "../src/account/account.service.js";
import type { AuthConfig } from "../src/auth/auth.types.js";
import { hashPassword } from "../src/auth/password-hasher.js";
import { authDateValue } from "../src/auth/mariadb/auth-persistence.js";
import { SocialAuthProvider } from "../src/auth/social/social-auth.provider.js";
import { SocialAuthService } from "../src/auth/social/social-auth.service.js";
import { SocialAuthFlows } from "../src/auth/social/social-auth.flows.js";
import { ProfilePhotoImageService } from "../src/profile-photos/profile-photo-image.service.js";
import { socialSettingsSchema } from "../src/auth/social/social-auth.environment.js";
import { DEFAULT_REQUEST_LIMIT_POLICY } from "../src/common/rate-limit/request-limit-policy.js";
import type { RedisRateLimiter } from "../src/common/rate-limit/redis-rate-limiter.js";
import {
  CONSENT_DOCUMENT_TYPES,
  currentLegalConsentSnapshot,
  type LegalConsentSnapshot,
} from "../src/legal/legal-consent-snapshot.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";
import { startMockSocialProvider } from "./social-auth.mock-provider.js";

export async function socialAuthHarness(maria: boolean, adminUi = false) {
  let postgres: StartedNativeTestService | undefined, redis: StartedNativeTestService | undefined;
  let http: NestFastifyApplication | undefined, observer: RedisClientType | undefined;
  let admin: Kysely<DB> | undefined, database: Kysely<DB> | undefined;
  const mock = await startMockSocialProvider();
  const guardianMessages: string[] = [];
  const origin = "http://localhost:48901";
  const common = {
    agePolicyVersion: "age-social-qa",
    emailHmacKey: randomBytes(32).toString("base64url"),
    emailHmacKeyVersion: "qa-1",
    privacyPolicyVersion: "privacy-social-qa",
    termsPolicyVersion: "terms-social-qa",
  };
  let authConfig: AuthConfig = common;
  const extras = {
    ...socialSettingsSchema.parse({
      SOCIAL_AUTH_ENABLED: "true",
      SOCIAL_GOOGLE_ENABLED: "true",
      SOCIAL_NAVER_ENABLED: "true",
      SOCIAL_KAKAO_ENABLED: "true",
      SOCIAL_AUTH_MOCK_ISSUER: mock.origin,
      SOCIAL_AUTH_FLOW_KEY: randomBytes(32).toString("base64url"),
    }),
    AUTH_DATABASE_EXTENSIONS: "all",
  };
  const close = async () => {
    observer?.destroy();
    await Promise.allSettled([http?.close(), database?.destroy(), admin?.destroy(), mock.close()]);
    await Promise.allSettled([postgres?.stop(), redis?.stop()]);
  };
  try {
    let config: ConfigService,
      social: SocialAuthService,
      sessions: SessionService,
      auth: AuthService,
      limiter: RedisRateLimiter;
    if (maria) {
      const path = process.env.AUTH_QA_MARIADB_CONFIG;
      if (!path) throw new Error("Use the owned auth-isolated-mariadb runner");
      const target = JSON.parse(await readFile(path, "utf8"));
      if (
        target.kind !== "classhub-auth-isolated-qa" ||
        target.host !== "localhost" ||
        [3000, 3301, 3306, 3307, 5173, 5174, 6380].includes(target.port) ||
        target.port < 1024
      )
        throw new Error("Unsafe QA target");
      const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
      const mysql = require("mysql2");
      const connection = { host: target.host, port: target.port, database: target.database };
      admin = new Kysely<DB>({
        dialect: new MysqlDialect({
          pool: mysql.createPool({
            ...connection,
            user: target.user,
            password: target.password,
            ssl: { ca: target.sslCa, rejectUnauthorized: true, verifyIdentity: true },
            timezone: "Z",
            supportBigNumbers: true,
            bigNumberStrings: true,
            dateStrings: true,
            connectionLimit: 3,
          }),
        }),
      });
      database = createMariaDbDatabase<DB>(createMysql2MariaDbPool, {
        ...connection,
        sslCa: target.sslCa,
        user: target.appUser,
        password: target.appPassword,
      });
      config = new ConfigService({
        ...extras,
        DATABASE_ENGINE: "mariadb",
        PUBLIC_APP_ORIGIN: origin,
        PUBLIC_API_ORIGIN: origin,
        NODE_ENV: "development",
        EMAIL_HMAC_KEY: common.emailHmacKey,
        LEGAL_CONSENT_BINDING_ENABLED: true,
      });
      // PostgreSQL gate exercises the real Redis limits and HTTP guards; Maria gate targets SQL/ACL/locks.
      limiter = {
        getPolicy: async () => DEFAULT_REQUEST_LIMIT_POLICY,
        consume: async () => ({ allowed: true }),
        peek: async () => ({ allowed: true }),
        clear: async () => undefined,
        consumeAll: async () => ({ allowed: true }),
        reset: async () => undefined,
        ensureAvailable: async () => undefined,
      } as unknown as RedisRateLimiter;
      sessions = new SessionService(database, limiter, common, { dialect: "mariadb" });
      auth = new AuthService(
        database,
        limiter,
        {
          sendVerificationEmail: async () => undefined,
          sendGuardianConsentEmail: async (_email, token) => {
            guardianMessages.push(token);
          },
        },
        common,
        { publish: async () => undefined, close: async () => undefined },
        config as unknown as ConfigService<AppEnvironment, true>,
      );
      const provider = new SocialAuthProvider(config),
        flows = new SocialAuthFlows(database, config, provider);
      social = new SocialAuthService(
        database,
        config,
        limiter,
        provider,
        flows,
        auth,
        sessions,
        new ProfilePhotoImageService(),
      );
    } else {
      postgres = await startNativeTestService("postgres");
      const url = (user: string, password: string) =>
        `postgresql://${user}:${password}@127.0.0.1:${postgres!.getMappedPort(5432)}/classhub_dev`;
      admin = createDatabase<DB>(url("classhub_bootstrap", "local_bootstrap_password"));
      await sql
        .raw(
          await readFile(
            new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
            "utf8",
          ),
        )
        .execute(admin);
      const migrator = createDatabase<DB>(url("classhub_migrator", "local_migrator_password"));
      try {
        await sql
          .raw(
            "CREATE TABLE pgmigrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, run_on TIMESTAMPTZ NOT NULL)",
          )
          .execute(migrator);
        for (const path of await loadAllTestMigrationPaths()) {
          const up = (await readFile(path, "utf8"))
            .split("-- Down Migration", 1)[0]!
            .replace("-- Up Migration", "");
          await migrator.transaction().execute((tx) => sql.raw(up).execute(tx));
        }
      } finally {
        await migrator.destroy();
      }
      database = createDatabase<DB>(url("classhub_app", "local_app_password"));
      redis = await startNativeTestService("redis");
      const environment = Object.assign(
        loadEnvironment({
          UNDER_14_SIGNUP_ENABLED: "true",
          NODE_ENV: "development",
          DATABASE_URL: url("classhub_app", "local_app_password"),
          EMAIL_HMAC_KEY: common.emailHmacKey,
          EMAIL_HMAC_KEY_VERSION: "qa-1",
          REDIS_URL: `redis://127.0.0.1:${redis.getMappedPort(6379)}`,
          PUBLIC_APP_ORIGIN: origin,
          PUBLIC_API_ORIGIN: origin,
          LEGAL_CONSENT_BINDING_ENABLED: "true",
          LOG_LEVEL: "fatal",
          SERVE_WEB: "false",
          ...(adminUi
            ? {
                ADMIN_WEB_ENABLED: "true",
                ADMIN_PASSKEYS_ENABLED: "true",
                ADMIN_WEBAUTHN_RP_ID: "localhost",
                ADMIN_MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
                ADMIN_MFA_KEY_VERSION: "qa-1",
              }
            : {}),
        }),
        extras,
      );
      ({ app: http } = await createApplication({ environment }));
      social = http.get(SocialAuthService);
      sessions = http.get(SessionService);
      auth = http.get(AuthService);
      config = http.get(ConfigService);
      limiter = http.get(AUTH_RATE_LIMITER);
      authConfig = http.get(AUTH_CONFIG);
      observer = createClient({ url: environment.REDIS_URL });
      observer.on("error", () => undefined);
      await observer.connect();
    }
    const date = (value: Date) => authDateValue(value, maria);
    await admin
      .insertInto("operators")
      .values({
        ...(maria ? { id: "99" } : {}),
        email_normalized: "social-operator@example.test",
        credential_hash: randomBytes(32),
      })
      .execute();
    const operator = await admin
      .selectFrom("operators")
      .select("id")
      .where("email_normalized", "=", "social-operator@example.test")
      .executeTakeFirstOrThrow();
    await admin
      .insertInto("admin_accounts")
      .values({
        ...(maria ? { id: "99" } : {}),
        email_normalized: "social-admin@example.test",
        display_name: "소셜 검수",
        password_hash: await hashPassword(randomBytes(24).toString("base64url")),
        created_by_operator_id: operator.id,
        status: "active",
      })
      .execute();
    const issuer = await admin
      .selectFrom("admin_accounts")
      .select("id")
      .where("email_normalized", "=", "social-admin@example.test")
      .executeTakeFirstOrThrow();
    for (const type of CONSENT_DOCUMENT_TYPES) {
      const content = `Isolated social consent ${type}`;
      await admin
        .insertInto("admin_terms_versions")
        .values({
          id: randomUUID(),
          document_type: type,
          policy_version: `social-${type}-qa`,
          title: `QA ${type}`,
          content,
          content_sha256: createHash("sha256").update(content).digest(),
          status: "published",
          published_at: date(new Date(Date.now() - 1000)),
          effective_at: date(new Date(Date.now() - 1000)),
          created_by_admin_account_id: issuer.id,
        })
        .execute();
    }
    const snapshot: LegalConsentSnapshot = await currentLegalConsentSnapshot(
      admin,
      maria,
      new Date(),
    );
    // For guardian positive-path checks use a test mail transport, with all real consent persistence/validation.
    const guardianAuth = new AuthService(
      database,
      limiter,
      {
        sendVerificationEmail: async () => undefined,
        sendGuardianConsentEmail: async (_email, token) => {
          guardianMessages.push(token);
        },
      },
      authConfig,
      { publish: async () => undefined, close: async () => undefined },
      config as unknown as ConfigService<AppEnvironment, true>,
    );
    const accounts = new AccountService(
      database,
      limiter,
      authConfig,
      { publish: async () => undefined, close: async () => undefined },
      config as unknown as ConfigService<AppEnvironment, true>,
    );
    return {
      admin,
      database,
      http,
      mock,
      social,
      auth,
      accounts,
      guardianAuth,
      guardianMessages,
      sessions,
      config,
      snapshot,
      origin,
      maria,
      date,
      close,
      async resetLimits() {
        if (observer?.isOpen) await observer.flushDb();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
