import { createRequire } from "node:module";

import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { assertProductionDatabaseUrl } from "./production-database-url.js";

interface ParsedPgSslOptions {
  checkServerIdentity?: (...arguments_: unknown[]) => unknown;
  rejectUnauthorized?: boolean;
}

interface ParsedPgConnection {
  database?: string;
  host?: string;
  hostaddr?: string;
  passfile?: string;
  password?: string;
  port?: string;
  service?: string;
  ssl?: boolean | ParsedPgSslOptions;
  user?: string;
}

interface PgConnectionStringModule {
  parse(connectionString: string): ParsedPgConnection;
}

const requireFromDatabasePackage = createRequire(import.meta.url);
const requireFromPgPackage = createRequire(requireFromDatabasePackage.resolve("pg"));
const parsePgConnectionString = (
  requireFromPgPackage("pg-connection-string") as PgConnectionStringModule
).parse;

const VALID_DATABASE_URL =
  "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?sslmode=verify-full&application_name=transport-test";
const REVIEWER_LIBPQ_BYPASS_DATABASE_URL =
  "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?sslmode=require&uselibpqcompat=true";
const ORIGINAL_PGSSLMODE = process.env.PGSSLMODE;

function assertApiProductionUrl(
  databaseUrl: string,
  environment: Readonly<Record<string, string | undefined>> = {},
): void {
  assertProductionDatabaseUrl(databaseUrl, {
    environment,
    expectedUsername: "classhub_app",
    variableName: "DATABASE_URL",
  });
}

function expectParserPreservesCertificateVerification(connectionString: string): void {
  const { ssl } = parsePgConnectionString(connectionString);

  expect(ssl).toBeDefined();
  expect(ssl).not.toBe(false);
  if (typeof ssl !== "object" || ssl === null) return;

  expect(ssl.rejectUnauthorized).not.toBe(false);
  if (ssl.checkServerIdentity !== undefined) {
    const implementation = Function.prototype.toString.call(ssl.checkServerIdentity);
    expect(implementation.replace(/\s/gu, "")).not.toMatch(/\{\}/u);
  }
}

afterEach(() => {
  if (ORIGINAL_PGSSLMODE === undefined) delete process.env.PGSSLMODE;
  else process.env.PGSSLMODE = ORIGINAL_PGSSLMODE;
});

describe("assertProductionDatabaseUrl", () => {
  it("accepts the exact role, explicit authority, verify-full, and application name", () => {
    expect(() => assertApiProductionUrl(VALID_DATABASE_URL)).not.toThrow();
    expectParserPreservesCertificateVerification(VALID_DATABASE_URL);
  });

  it("allows single canonical nonblank custom CA and mTLS material paths", () => {
    expect(() =>
      assertApiProductionUrl(
        "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?sslmode=verify-full&sslrootcert=%2Frun%2Fsecrets%2Fca.pem&sslcert=%2Frun%2Fsecrets%2Fclient.pem&sslkey=%2Frun%2Fsecrets%2Fclient.key",
      ),
    ).not.toThrow();
  });

  it("rejects the reviewer bypass that the installed parser turns into no verification", () => {
    const parsedBypass = parsePgConnectionString(REVIEWER_LIBPQ_BYPASS_DATABASE_URL);
    if (typeof parsedBypass.ssl !== "object" || parsedBypass.ssl === null) {
      throw new Error("reviewer bypass must produce parsed SSL options");
    }
    expect(parsedBypass.ssl.rejectUnauthorized).toBe(false);
    expect(() => assertApiProductionUrl(REVIEWER_LIBPQ_BYPASS_DATABASE_URL)).toThrow(
      "canonical sslmode=verify-full",
    );
  });

  it.each([
    ["missing sslmode", "postgresql://classhub_app:password@db.internal/classhub"],
    ["sslmode=disable", "postgresql://classhub_app:password@db.internal/classhub?sslmode=disable"],
    [
      "sslmode=no-verify",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=no-verify",
    ],
    ["sslmode=require", "postgresql://classhub_app:password@db.internal/classhub?sslmode=require"],
    [
      "sslmode=verify-ca",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-ca",
    ],
    [
      "duplicate sslmode",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&sslmode=verify-full",
    ],
    [
      "uppercase SSLMODE",
      "postgresql://classhub_app:password@db.internal/classhub?SSLMODE=verify-full",
    ],
    [
      "percent-encoded first sslmode character",
      "postgresql://classhub_app:password@db.internal/classhub?%73slmode=verify-full",
    ],
    [
      "percent-encoded middle sslmode character",
      "postgresql://classhub_app:password@db.internal/classhub?ssl%6dode=verify-full",
    ],
    [
      "percent-encoded sslmode hyphen",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify%2Dfull",
    ],
    [
      "percent-encoded sslmode value character",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=%76erify-full",
    ],
    [
      "percent-encoded sslmode final word character",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-%66ull",
    ],
    [
      "plus-encoded sslmode separator",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify+full",
    ],
    [
      "uselibpqcompat",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&UseLibpqCompat=false",
    ],
    [
      "ssl switch",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&ssl=1",
    ],
    [
      "rejectUnauthorized override",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&reject_Unauthorized=false",
    ],
    [
      "unknown SSL-shaped key",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&sslFutureOption=true",
    ],
    [
      "query authority override",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&user=classhub_migrator",
    ],
    [
      "hostaddr override",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&hostaddr=203.0.113.7",
    ],
    [
      "libpq passfile",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&passfile=%2Frun%2Fsecrets%2Fpgpass",
    ],
    [
      "libpq service",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&service=privileged-service",
    ],
    [
      "unsupported sslpassword",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&sslpassword=secret",
    ],
    [
      "startup options",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&options=-c%20role%3Dclasshub_migrator",
    ],
    [
      "SSL negotiation override",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&sslnegotiation=direct",
    ],
    [
      "duplicate application name",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&application_name=one&application_name=two",
    ],
    [
      "empty application name",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&application_name=",
    ],
    [
      "duplicate TLS material",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&sslrootcert=one&sslrootcert=two",
    ],
    [
      "empty TLS material",
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&sslrootcert=",
    ],
  ])("rejects %s", (_label, databaseUrl) => {
    expect(() => assertApiProductionUrl(databaseUrl)).toThrow("canonical sslmode=verify-full");
  });

  it.each([
    [
      "an encoded Unix socket hostname",
      "postgresql://classhub_app:password@%2Fvar%2Frun%2Fpostgresql/classhub?sslmode=verify-full",
    ],
    ["localhost", "postgresql://classhub_app:password@localhost/classhub?sslmode=verify-full"],
    [
      "an IPv4 loopback hostname",
      "postgresql://classhub_app:password@127.0.0.1/classhub?sslmode=verify-full",
    ],
    [
      "a single-part decimal IPv4 loopback hostname",
      "postgresql://classhub_app:password@2130706433/classhub?sslmode=verify-full",
    ],
    [
      "a single-part hexadecimal IPv4 loopback hostname",
      "postgresql://classhub_app:password@0x7f000001/classhub?sslmode=verify-full",
    ],
    [
      "a single-part octal IPv4 loopback hostname",
      "postgresql://classhub_app:password@017700000001/classhub?sslmode=verify-full",
    ],
    [
      "a dotted hexadecimal IPv4 loopback hostname",
      "postgresql://classhub_app:password@0x7f.0.0.1/classhub?sslmode=verify-full",
    ],
    [
      "a dotted octal IPv4 loopback hostname",
      "postgresql://classhub_app:password@0177.0.0.1/classhub?sslmode=verify-full",
    ],
    [
      "a single-part hexadecimal unspecified IPv4 hostname",
      "postgresql://classhub_app:password@0x0/classhub?sslmode=verify-full",
    ],
    [
      "an IPv6 loopback hostname",
      "postgresql://classhub_app:password@[::1]/classhub?sslmode=verify-full",
    ],
    ["a missing password", "postgresql://classhub_app@db.internal/classhub?sslmode=verify-full"],
    [
      "a blank encoded password",
      "postgresql://classhub_app:%20%20@db.internal/classhub?sslmode=verify-full",
    ],
    [
      "a missing database name",
      "postgresql://classhub_app:password@db.internal/?sslmode=verify-full",
    ],
    [
      "a blank encoded database name",
      "postgresql://classhub_app:password@db.internal/%20?sslmode=verify-full",
    ],
  ])("rejects production DSN authority with %s", (_label, databaseUrl) => {
    expect(() => assertApiProductionUrl(databaseUrl)).toThrow(
      "explicit remote hostname, nonblank password, and database name",
    );
  });

  it("proves the installed parser applies authority query overrides before they are rejected", () => {
    const databaseUrl =
      "postgresql://classhub_app:original-password@db.internal:5432/classhub?sslmode=verify-full&host=attacker.internal&port=6543&user=classhub_migrator&password=overridden";
    const parsed = parsePgConnectionString(databaseUrl);

    expect(parsed).toMatchObject({
      host: "attacker.internal",
      password: "overridden",
      port: "6543",
      user: "classhub_migrator",
    });
    expect(() => assertApiProductionUrl(databaseUrl)).toThrow("approved connection query");
  });

  it("proves the installed parser preserves libpq-style config query keys before rejection", () => {
    const databaseUrl =
      "postgresql://classhub_app:password@db.internal/classhub?sslmode=verify-full&hostaddr=203.0.113.7&passfile=%2Frun%2Fsecrets%2Fpgpass&service=privileged-service";
    const parsed = parsePgConnectionString(databaseUrl);

    expect(parsed).toMatchObject({
      hostaddr: "203.0.113.7",
      passfile: "/run/secrets/pgpass",
      service: "privileged-service",
    });
    expect(() => assertApiProductionUrl(databaseUrl)).toThrow("approved connection query");
  });

  it("rejects a non-PostgreSQL scheme and a mismatched effective role", () => {
    expect(() =>
      assertApiProductionUrl(
        "https://classhub_app:password@db.internal/classhub?sslmode=verify-full",
      ),
    ).toThrow("PostgreSQL URL");
    expect(() =>
      assertApiProductionUrl(
        "postgresql://classhub_migrator:password@db.internal/classhub?sslmode=verify-full",
      ),
    ).toThrow("classhub_app database role");
  });

  it("rejects Node's global certificate verification bypass", () => {
    expect(() =>
      assertApiProductionUrl(VALID_DATABASE_URL, {
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      }),
    ).toThrow("NODE_TLS_REJECT_UNAUTHORIZED");
  });

  it.each(["disable", "verify-full"])("rejects a conflicting PGSSLMODE=%s", (sslMode) => {
    expect(() => assertApiProductionUrl(VALID_DATABASE_URL, { PGSSLMODE: sslMode })).toThrow(
      "PGSSL*",
    );
  });

  it("proves pg currently keeps URL verify-full over PGSSLMODE=disable", () => {
    process.env.PGSSLMODE = "disable";
    const client = new Client({ connectionString: VALID_DATABASE_URL });
    const ssl = (
      client as unknown as {
        connectionParameters: { ssl: boolean | ParsedPgSslOptions | undefined };
      }
    ).connectionParameters.ssl;

    expect(ssl).toBeDefined();
    expect(ssl).not.toBe(false);
    if (typeof ssl === "object" && ssl !== null) {
      expect(ssl.rejectUnauthorized).not.toBe(false);
    }
  });
});
