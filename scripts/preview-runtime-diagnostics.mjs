import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import { parseEnv } from "node:util";

import { loadEnvironment } from "../apps/api/dist/config/environment.js";
import { createPhonePreviewInput } from "./phone-preview-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const origin = process.argv[2];
if (!origin || !/^https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com$/u.test(origin)) {
  throw new Error("An issued Cloudflare Quick Tunnel HTTPS origin is required.");
}
const files = await Promise.all(
  [".env", ".env.local", ".env.admin.local"].map(async (name) => {
    try {
      const path = resolve(root, name);
      return {
        name,
        values: parseEnv(await readFile(path, "utf8")),
        modifiedAt: (await stat(path)).mtime.toISOString(),
      };
    } catch (error) {
      if (error.code === "ENOENT") return { name, values: {}, modifiedAt: null };
      throw new Error("A local preview environment file could not be inspected.", { cause: error });
    }
  }),
);
// File contents and secrets never enter the report. This is the launch configuration,
// not an inspection of another process's private environment/memory.
const environment = { ...Object.assign({}, ...files.map(({ values }) => values)), ...process.env };
let local, phone;
try {
  local = loadEnvironment({ ...files[0].values, ...environment, NODE_ENV: "development" });
  const defaults = loadEnvironment({ NODE_ENV: "development" });
  phone = loadEnvironment(createPhonePreviewInput(environment, origin, defaults.DATABASE_URL));
} catch {
  throw new Error(
    "The local or public preview launch configuration is invalid; no secret values are reported.",
  );
}
function databaseIdentity(value) {
  const url = new URL(value);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    database: url.pathname.slice(1),
  };
}
function connectionIdentity(value) {
  const url = new URL(value);
  url.searchParams.delete("application_name");
  return url.toString();
}
const report = {
  inspectedAt: new Date().toISOString(),
  configurationScope: "current launch files and this shell; no process-memory inspection",
  files: files.map(({ name, modifiedAt }) => ({ name, present: modifiedAt !== null, modifiedAt })),
  database: databaseIdentity(local.DATABASE_URL),
  sameDatabaseConnection:
    connectionIdentity(local.DATABASE_URL) === connectionIdentity(phone.DATABASE_URL),
  local: {
    engine: local.DATABASE_ENGINE,
    adminWebEnabled: local.ADMIN_WEB_ENABLED,
    adminMfaKeyPresent: !!local.ADMIN_MFA_ENCRYPTION_KEY,
    adminMfaVersionPresent: !!local.ADMIN_MFA_KEY_VERSION,
  },
  phone: {
    engine: phone.DATABASE_ENGINE,
    adminWebEnabled: phone.ADMIN_WEB_ENABLED,
    adminMfaKeyPresent: !!phone.ADMIN_MFA_ENCRYPTION_KEY,
    adminMfaVersionPresent: !!phone.ADMIN_MFA_KEY_VERSION,
    localTestAdminEnabled: phone.LOCAL_TEST_ADMIN_ENABLED,
  },
  sameAdminMfaKey: local.ADMIN_MFA_ENCRYPTION_KEY === phone.ADMIN_MFA_ENCRYPTION_KEY,
  sameAdminMfaVersion: local.ADMIN_MFA_KEY_VERSION === phone.ADMIN_MFA_KEY_VERSION,
  sameEmailHmacKey: local.EMAIL_HMAC_KEY === phone.EMAIL_HMAC_KEY,
  sameEmailHmacVersion: local.EMAIL_HMAC_KEY_VERSION === phone.EMAIL_HMAC_KEY_VERSION,
  surfaces: [],
};
if (process.argv.includes("--schema-ready")) {
  const { createDatabase, assertPostgresRuntimeRole } =
    await import("../packages/db/dist/index.js");
  let database;
  try {
    if (local.DATABASE_ENGINE === "postgres") {
      database = createDatabase(local.DATABASE_URL, {
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
      });
      await assertPostgresRuntimeRole(database, {
        expectedRole: "classhub_app",
        runtimeName: "preview diagnostics",
      });
    } else {
      const { ConfigService } = createRequire(resolve(root, "apps/api/package.json"))(
        "@nestjs/config",
      );
      const { openConfiguredApplicationDatabase } =
        await import("../apps/api/dist/database/database.module.js");
      database = await openConfiguredApplicationDatabase(new ConfigService(local));
    }
    const columns = await database
      .selectFrom("information_schema.columns")
      .select("column_name")
      .where(
        "table_schema",
        "=",
        local.DATABASE_ENGINE === "postgres"
          ? "public"
          : databaseIdentity(local.DATABASE_URL).database,
      )
      .where("table_name", "=", "users")
      .where("column_name", "=", "signup_role")
      .execute();
    report.schemaReady = columns.length === 1;
  } catch {
    throw new Error("Required preview schema could not be verified; no server was restarted.");
  } finally {
    if (database) await database.destroy();
  }
}
if (process.argv.includes("--approval-counts")) {
  if (local.DATABASE_ENGINE !== "postgres")
    throw new Error("This read-only approval inspection currently supports PostgreSQL.");
  const { createDatabase, assertPostgresRuntimeRole } =
    await import("../packages/db/dist/index.js");
  const database = createDatabase(local.DATABASE_URL, {
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  try {
    await assertPostgresRuntimeRole(database, {
      expectedRole: "classhub_app",
      runtimeName: "preview diagnostics",
    });
    report.unusedApprovals = await database
      .transaction()
      .setAccessMode("read only")
      .execute(async (transaction) => {
        const users = await transaction.selectFrom("users").select("email_normalized").execute();
        const approvals = await transaction
          .selectFrom("admin_signup_approvals")
          .select(["email_key_digest", "expires_at", "revoked_at"])
          .where("consumed_at", "is", null)
          .execute();
        const emailDigests = (key) =>
          new Set(
            users.map(({ email_normalized }) =>
              createHmac("sha256", key)
                .update(
                  JSON.stringify([
                    "admin-signup-approval-email",
                    email_normalized.normalize("NFC").trim().toLowerCase(),
                  ]),
                  "utf8",
                )
                .digest("hex"),
            ),
          );
        const localDigests = emailDigests(local.EMAIL_HMAC_KEY);
        const phoneDigests = emailDigests(phone.EMAIL_HMAC_KEY);
        const counts = Object.fromEntries(
          ["localKey", "phoneKey", "bothKeys", "unattributed"].map((key) => [
            key,
            { total: 0, usableNow: 0, expired: 0, revoked: 0 },
          ]),
        );
        for (const approval of approvals) {
          const digest = approval.email_key_digest.toString("hex");
          const matchesLocal = localDigests.has(digest),
            matchesPhone = phoneDigests.has(digest);
          const group =
            counts[
              matchesLocal && matchesPhone
                ? "bothKeys"
                : matchesLocal
                  ? "localKey"
                  : matchesPhone
                    ? "phoneKey"
                    : "unattributed"
            ];
          group.total++;
          if (approval.revoked_at !== null) group.revoked++;
          else if (approval.expires_at.getTime() <= Date.now()) group.expired++;
          else group.usableNow++;
        }
        return {
          counts,
          attribution:
            "email digest match against stored user emails; no code recovery, email or digest output",
        };
      });
  } catch {
    throw new Error(
      "Read-only approval inspection failed; no database details or private values are reported.",
    );
  } finally {
    await database.destroy();
  }
}
try {
  const log = await readFile(resolve(root, ".local-runtime/preview-api/api.stdout.log"), "utf8");
  report.recentPublicAuthResponses = log
    .split(/\r?\n/u)
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        const path = entry.req?.url ?? entry.request?.path;
        if (
          typeof path !== "string" ||
          !/^\/api\/v1\/(?:admin\/auth|auth\/login)(?:\/|$)/u.test(path)
        )
          return [];
        return [
          {
            // Never emit an arbitrary URL suffix or query from an auth request log.
            path: path.startsWith("/api/v1/admin/auth")
              ? "/api/v1/admin/auth/[redacted-route]"
              : "/api/v1/auth/login",
            method: entry.req?.method ?? entry.request?.method,
            status: entry.res?.statusCode ?? entry.statusCode ?? entry.status_code,
            time: entry.time,
          },
        ];
      } catch {
        return [];
      }
    })
    .slice(-20);
} catch {
  report.recentPublicAuthResponses = [];
}
const builtHtml = await readFile(resolve(root, "Web/index.html"), "utf8");
const surfaces = [
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3301",
  "http://localhost:5174",
  origin,
];
async function inspect(surface) {
  const result = { origin: surface, checks: [] };
  for (const path of ["/healthz", "/api/v1/admin/auth/session", "/api/v1/bootstrap", "/login"]) {
    const response = await fetch(surface + path, {
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    const body = await response.text();
    const check = { path, status: response.status };
    if (path === "/login") {
      check.classHubTitle = /<title>우리반 허브<\/title>/u.test(body);
      check.viteDevelopment = body.includes("/@vite/client");
      check.matchesBuiltHtml = digest(body) === digest(builtHtml);
      check.assets = [...body.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/gu)].map(
        (match) => match[1],
      );
      for (const asset of check.assets) {
        const served = await fetch(surface + asset, {
          signal: AbortSignal.timeout(15_000),
          cache: "no-store",
        });
        const localAsset = await readFile(resolve(root, "Web", "." + asset));
        result.checks.push({
          path: asset,
          status: served.status,
          matchesBuiltAsset:
            digest(new Uint8Array(await served.arrayBuffer())) === digest(localAsset),
        });
      }
    } else {
      try {
        check.errorCode = JSON.parse(body).error?.code ?? null;
      } catch {
        check.errorCode = null;
      }
    }
    result.checks.push(check);
  }
  if (process.argv.includes("--probe-login")) {
    const response = await fetch(surface + "/api/v1/admin/auth/login", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        origin: ["http://127.0.0.1:3000", "http://localhost:5174"].includes(surface)
          ? "http://localhost:5174"
          : origin,
      },
      body: JSON.stringify({
        email: `preview-diagnostic-${randomUUID()}@example.invalid`,
        password: "Synthetic-unknown-account-only",
      }),
    });
    let errorCode = null;
    try {
      errorCode = (await response.json()).error?.code ?? null;
    } catch {
      /* Status remains useful. */
    }
    result.checks.push({
      path: "/api/v1/admin/auth/login",
      status: response.status,
      errorCode,
      unknownSyntheticAccountOnly: true,
    });
  }
  return result;
}
if (!process.argv.includes("--offline")) {
  const results = await Promise.allSettled(surfaces.map(inspect));
  report.surfaces = results.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : { origin: surfaces[index], failure: "HTTP inspection did not complete" },
  );
}
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (process.argv.includes("--verify")) {
  const usable =
    report.surfaces.length === 4 &&
    report.surfaces.every(
      (surface) =>
        !surface.failure &&
        surface.checks.some(
          (check) =>
            check.path === "/api/v1/admin/auth/session" &&
            check.status === 401 &&
            check.errorCode === "ADMIN_SESSION_REQUIRED",
        ),
    );
  const publicSurfaces = report.surfaces.filter((surface) =>
    [origin, "http://127.0.0.1:3301"].includes(surface.origin),
  );
  const currentBuild =
    publicSurfaces.length === 2 &&
    publicSurfaces.every(
      (surface) =>
        surface.checks?.some(
          (check) =>
            check.path === "/login" &&
            check.status === 200 &&
            check.classHubTitle &&
            check.matchesBuiltHtml &&
            !check.viteDevelopment,
        ) &&
        surface.checks.filter((check) => check.path.startsWith("/assets/")).length > 0 &&
        surface.checks
          .filter((check) => check.path.startsWith("/assets/"))
          .every((check) => check.status === 200 && check.matchesBuiltAsset),
    );
  if (
    !usable ||
    !currentBuild ||
    !report.sameDatabaseConnection ||
    !report.sameAdminMfaKey ||
    !report.sameAdminMfaVersion ||
    !report.sameEmailHmacKey ||
    !report.sameEmailHmacVersion ||
    (process.argv.includes("--schema-ready") && !report.schemaReady)
  )
    process.exitCode = 1;
}
