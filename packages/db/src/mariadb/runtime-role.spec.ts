import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { createMariaDbDatabase } from "./connection.js";
import type { MariaDbPool, MariaDbRawConnection } from "./guarded-driver.js";
import { attestMariaDbRuntimeConnection, type MariaDbRuntimeIdentity } from "./runtime-role.js";

const expected: MariaDbRuntimeIdentity = {
  role: "worker",
  user: "qa_worker",
  accountHost: "%",
  database: "qa",
};
const identity = {
  account: "qa_worker@%",
  login_user: "qa_worker@172.20.0.2",
  database_name: "qa",
  active_role: null,
  server_version: "11.4.13-MariaDB-ubu2404",
  ssl_cipher: "TLS_AES_256_GCM_SHA384",
  applicable_roles: 0,
  enabled_roles: "0",
};
const grantRows = () => [
  {
    grant:
      "GRANT USAGE ON *.* TO `qa_worker`@`%` IDENTIFIED BY PASSWORD '*" +
      "A".repeat(40) +
      "' REQUIRE SSL",
  },
  { grant: "GRANT SELECT, INSERT ON `qa`.`security_audit_logs` TO `qa_worker`@`%`" },
];
const auditProfile = "worker_security_audit_v1" as const;
const auditProfileGrants = [
  "GRANT INSERT ON `qa`.`security_audit_logs` TO `qa_worker`@`%`",
  "GRANT SELECT ON `qa`.`security_audit_logs` TO `qa_worker`@`%`",
  "GRANT INSERT ON `qa`.`worker_security_audit_lock_keys` TO `qa_worker`@`%`",
  "GRANT SELECT ON `qa`.`worker_security_audit_lock_keys` TO `qa_worker`@`%`",
];
const profileGrantRows = (privileges = auditProfileGrants) => [
  grantRows()[0],
  ...privileges.map((grant) => ({ grant })),
];
function query(overrides = {}, grants: unknown = grantRows()) {
  return vi.fn(async (statement: string) =>
    statement.startsWith("SELECT CURRENT_USER")
      ? [{ ...identity, ...overrides }]
      : statement === "SHOW GRANTS FOR PUBLIC"
        ? []
        : grants,
  );
}
describe("MariaDB runtime connection attestation", () => {
  it("accepts the exact worker envelope and zero non-null enabled roles", async () => {
    await expect(attestMariaDbRuntimeConnection(query(), expected)).resolves.toBeUndefined();
  });
  it("accepts the pinned native Windows version with the same TLS and grant checks", async () => {
    await expect(
      attestMariaDbRuntimeConnection(query({ server_version: "11.4.13-MariaDB" }), expected),
    ).resolves.toBeUndefined();
  });
  it.each(["11.4.14-MariaDB", "11.4.14-MariaDB-ubu2404", "11.4.20-MariaDB"])(
    "accepts a later 11.4 LTS security patch %s with the same checks (D3-03)",
    async (server_version) => {
      await expect(
        attestMariaDbRuntimeConnection(query({ server_version }), expected),
      ).resolves.toBeUndefined();
    },
  );
  it.each([
    { account: "root@localhost" },
    { login_user: "proxy@172.20.0.2" },
    { database_name: "other" },
    { active_role: "extra" },
    { applicable_roles: 1 },
    { enabled_roles: 1 },
    { ssl_cipher: "" },
    // 11.4 LTS 13 이상 패치만(2026-10-03 D3-03): 이전 패치·다른 계열은 거절.
    { server_version: "11.4.12-MariaDB" },
    { server_version: "11.8.9-MariaDB" },
    { server_version: "10.11.9-MariaDB" },
    { server_version: "11.4.14" },
  ])("rejects identity drift %o", async (values) => {
    await expect(attestMariaDbRuntimeConnection(query(values), expected)).rejects.toMatchObject({
      reason: "identity_rejected",
    });
  });
  it("rejects both missing and excess privilege sets", async () => {
    await expect(
      attestMariaDbRuntimeConnection(query({}, grantRows().slice(0, 1)), expected),
    ).rejects.toMatchObject({ reason: "privileges_rejected" });
    await expect(
      attestMariaDbRuntimeConnection(
        query({}, [...grantRows(), { grant: "GRANT SELECT ON `qa`.`users` TO `qa_worker`@`%`" }]),
        expected,
      ),
    ).rejects.toMatchObject({ reason: "privileges_rejected" });
  });
  it("rejects PUBLIC privileges even when both role counts are zero", async () => {
    const own = query();
    const run = (statement: string) =>
      statement === "SHOW GRANTS FOR PUBLIC"
        ? Promise.resolve([{ grant: "GRANT SELECT ON `qa`.`users` TO PUBLIC" }])
        : own(statement);
    await expect(attestMariaDbRuntimeConnection(run, expected)).rejects.toMatchObject({
      reason: "privileges_rejected",
    });
  });
  it("does not expose native errors or authentication hashes", async () => {
    const privateQuery = async () => {
      throw new Error("private-token SHOW GRANTS PASSWORD '*" + "A".repeat(40) + "'");
    };
    const error = await attestMariaDbRuntimeConnection(privateQuery, expected).catch(
      (error) => error,
    );
    expect(error).toMatchObject({
      reason: "query_failed",
      code: "MARIADB_RUNTIME_ROLE_ATTESTATION_FAILED",
    });
    expect(String(error)).not.toMatch(/private-token|PASSWORD|AAAA/u);
    expect(error).not.toHaveProperty("cause");
  });
  it("rejects malformed configuration before allocating a pool", () => {
    const factory = vi.fn();
    expect(() =>
      createMariaDbDatabase(factory, {
        host: "qa.invalid",
        database: "qa",
        user: "qa_worker",
        password: "synthetic",
        sslCa: "-----BEGIN CERTIFICATE-----",
        runtimeRole: "worker",
      }),
    ).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it("does not expose private SHOW metadata through application SQL", async () => {
    const queryMetadata = query();
    let forbiddenSent = false;
    const raw: MariaDbRawConnection = {
      query(statement, _parameters, callback) {
        if (
          statement === "SHOW GRANTS FOR CURRENT_USER" ||
          statement === "SHOW GRANTS FOR PUBLIC" ||
          statement.startsWith("SELECT CURRENT_USER")
        )
          void queryMetadata(statement).then((result) => callback(null, result));
        else {
          if (statement === "SHOW GRANTS") forbiddenSent = true;
          callback(null, { affectedRows: 0, insertId: 0 });
        }
      },
      release() {},
      destroy() {},
    };
    const pool: MariaDbPool = {
      getConnection(callback) {
        callback(null, raw);
      },
      end(callback) {
        callback(null);
      },
    };
    const db = createMariaDbDatabase(() => pool, {
      host: "qa.invalid",
      database: "qa",
      user: "qa_worker",
      password: "synthetic",
      sslCa: "-----BEGIN CERTIFICATE-----",
      runtimeRole: "worker",
      accountHost: "%",
    });
    try {
      await expect(sql.raw("SHOW GRANTS").execute(db)).rejects.toMatchObject({
        code: "sql_not_allowed",
      });
      expect(forbiddenSent).toBe(false);
    } finally {
      await db.destroy();
    }
  });
  it.each([undefined, auditProfile])(
    "rechecks a reused socket, discards privilege drift and never executes the second write: %s",
    async (runtimeGrantProfile) => {
      let grants = runtimeGrantProfile ? profileGrantRows() : grantRows(),
        writes = 0,
        reads = 0,
        destroyed = 0,
        released = 0;
      const raw: MariaDbRawConnection = {
        query(statement, _parameters, callback) {
          if (statement.startsWith("SELECT CURRENT_USER")) {
            reads++;
            callback(null, [identity]);
          } else if (statement === "SHOW GRANTS FOR CURRENT_USER") callback(null, grants);
          else if (statement === "SHOW GRANTS FOR PUBLIC") callback(null, []);
          else {
            if (statement.startsWith("INSERT")) writes++;
            callback(null, { affectedRows: 1, insertId: 0 });
          }
        },
        release() {
          released++;
        },
        destroy() {
          destroyed++;
        },
      };
      const pool: MariaDbPool = {
        getConnection(callback) {
          callback(null, raw);
        },
        end(callback) {
          callback(null);
        },
      };
      const db = createMariaDbDatabase(() => pool, {
        host: "qa.invalid",
        database: "qa",
        user: "qa_worker",
        password: "synthetic",
        sslCa: "-----BEGIN CERTIFICATE-----",
        runtimeRole: "worker",
        runtimeGrantProfile,
        accountHost: "%",
      });
      try {
        await sql`INSERT INTO security_audit_logs VALUES ('synthetic')`.execute(db);
        grants = [...grants, { grant: "GRANT SELECT ON `qa`.`users` TO `qa_worker`@`%`" }];
        await expect(
          sql`INSERT INTO security_audit_logs VALUES ('synthetic')`.execute(db),
        ).rejects.toMatchObject({ reason: "privileges_rejected" });
        expect(writes).toBe(1);
        expect(reads).toBe(2);
        expect(destroyed).toBe(1);
        expect(released).toBe(1);
      } finally {
        await db.destroy();
      }
    },
  );
});

describe("MariaDB worker security audit profile attestation", () => {
  const profileExpected = { ...expected, runtimeGrantProfile: auditProfile };
  it("accepts exactly four privileges even when SHOW GRANTS returns them in another order", async () => {
    await expect(
      attestMariaDbRuntimeConnection(
        query({}, profileGrantRows([...auditProfileGrants].reverse())),
        profileExpected,
      ),
    ).resolves.toBeUndefined();
  });
  it("requires explicit profile selection; neither the baseline nor the profile tolerates the other envelope", async () => {
    await expect(
      attestMariaDbRuntimeConnection(query({}, profileGrantRows()), expected),
    ).rejects.toMatchObject({ reason: "privileges_rejected" });
    await expect(attestMariaDbRuntimeConnection(query(), profileExpected)).rejects.toMatchObject({
      reason: "privileges_rejected",
    });
  });
  it.each([0, 1, 2, 3])("rejects each missing profile privilege: %i", async (missing) => {
    const grants = profileGrantRows(auditProfileGrants.filter((_, index) => index !== missing));
    await expect(
      attestMariaDbRuntimeConnection(query({}, grants), profileExpected),
    ).rejects.toMatchObject({
      reason: "privileges_rejected",
    });
  });
  it.each([
    "GRANT DELETE ON `qa`.`worker_security_audit_lock_keys` TO `qa_worker`@`%`",
    "GRANT UPDATE ON `qa`.`worker_security_audit_lock_keys` TO `qa_worker`@`%`",
    "GRANT SELECT ON `qa`.`users` TO `qa_worker`@`%`",
    "GRANT SELECT ON `qa`.* TO `qa_worker`@`%`",
    "GRANT INSERT ON `qa`.`worker_security_audit_lock_keys` TO `qa_worker`@`%` WITH GRANT OPTION",
  ])("rejects excess or broader privileges: %s", async (extra) => {
    await expect(
      attestMariaDbRuntimeConnection(
        query({}, profileGrantRows([...auditProfileGrants, extra])),
        profileExpected,
      ),
    ).rejects.toMatchObject({ reason: "privileges_rejected" });
  });
  it.each([
    { account: "root@localhost" },
    { login_user: "proxy@172.20.0.2" },
    { database_name: "other" },
    { active_role: "extra" },
    { applicable_roles: 1 },
    { enabled_roles: 1 },
    { ssl_cipher: "" },
    // 11.4 LTS 13 이상 패치만(2026-10-03 D3-03): 이전 패치·다른 계열은 거절.
    { server_version: "11.4.12-MariaDB" },
    { server_version: "11.8.9-MariaDB" },
    { server_version: "10.11.9-MariaDB" },
    { server_version: "11.4.14" },
  ])("keeps all identity and TLS checks with the profile: %o", async (values) => {
    await expect(
      attestMariaDbRuntimeConnection(query(values, profileGrantRows()), profileExpected),
    ).rejects.toMatchObject({ reason: "identity_rejected" });
  });
  it("still rejects PUBLIC grants with no active or applicable role", async () => {
    const own = query({}, profileGrantRows());
    const run = (statement: string) =>
      statement === "SHOW GRANTS FOR PUBLIC"
        ? Promise.resolve([{ grant: "GRANT SELECT ON `qa`.`users` TO PUBLIC" }])
        : own(statement);
    await expect(attestMariaDbRuntimeConnection(run, profileExpected)).rejects.toMatchObject({
      reason: "privileges_rejected",
    });
  });
  it("rejects an invalid profile before any metadata query and does not expose its value", async () => {
    const run = query();
    const error: unknown = await attestMariaDbRuntimeConnection(run, {
      ...expected,
      runtimeGrantProfile: "private-profile-token",
    } as unknown as MariaDbRuntimeIdentity).catch((error: unknown) => error);
    expect(run).not.toHaveBeenCalled();
    expect(error).toMatchObject({ reason: "configuration_rejected" });
    expect(String(error)).not.toContain("private-profile-token");
    expect(error).not.toHaveProperty("cause");
  });
});
