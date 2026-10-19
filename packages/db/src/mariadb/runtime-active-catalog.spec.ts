import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import catalog from "./runtime-grant-catalog.json" with { type: "json" };
import { requiredMariaDbRuntimeGrants } from "./runtime-grant-profile.js";
import { parseMariaDbRuntimeGrants } from "./runtime-grants.js";
import { attestMariaDbRuntimeConnection, type MariaDbRuntimeRole } from "./runtime-role.js";

const read = (path: string) =>
  readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
const scope = JSON.parse(read("db/mariadb/scope/active-scope.json")) as {
  retired_tables: string[];
};
const sql = read("db/mariadb/permissions/0039_current_runtime_acl.sql");
const account = "`qa_runtime`@`%`";
const usage = {
  grant: `GRANT USAGE ON *.* TO ${account} IDENTIFIED BY PASSWORD '*${"A".repeat(40)}' REQUIRE SSL`,
};
const identity = {
  account: "qa_runtime@%",
  login_user: "qa_runtime@172.20.0.2",
  database_name: "qa",
  active_role: null,
  server_version: catalog.serverVersion,
  ssl_cipher: "TLS_AES_256_GCM_SHA384",
  applicable_roles: 0,
  enabled_roles: 0,
};

// Adapt generated GRANT DDL to the canonical SHOW GRANTS spelling; never connect to a server.
function grants(role: MariaDbRuntimeRole) {
  return [
    usage,
    ...sql
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("GRANT ") && line.endsWith(`TO 'classhub_${role}'@'%';`))
      .map((line) => ({
        grant: line
          .replace(/classhub_mariadb_phase1_dev\.([a-z_]+)(?= TO)/u, "`qa`.`$1`")
          .replace("classhub_mariadb_phase1_dev.", "`qa`.")
          .replace(`TO 'classhub_${role}'@'%';`, `TO ${account}`),
      })),
  ];
}
const expected = (role: MariaDbRuntimeRole) => ({
  role,
  user: "qa_runtime",
  accountHost: "%",
  database: "qa",
});
const query = (rows: { grant: string }[]) => async (statement: string) =>
  statement.startsWith("SELECT CURRENT_USER")
    ? [identity]
    : statement === "SHOW GRANTS FOR PUBLIC"
      ? []
      : rows;

describe("active54 MariaDB runtime catalog", () => {
  it.each(["app", "operator", "worker", "retention"] as const)(
    "accepts exactly the generated %s SQL envelope",
    async (role) => {
      const rows = grants(role);
      expect(parseMariaDbRuntimeGrants(rows, expected(role))).toEqual(catalog.roles[role]);
      await expect(
        attestMariaDbRuntimeConnection(query(rows), expected(role)),
      ).resolves.toBeUndefined();
      expect(requiredMariaDbRuntimeGrants(role, undefined)).toHaveLength(
        { app: 251, operator: 195, worker: 2, retention: 43 }[role],
      );
    },
  );

  it.each(scope.retired_tables)(
    "rejects reintroduced %s privileges before application work",
    async (table) => {
      const rows = [
        ...grants("app"),
        { grant: `GRANT SELECT ON \`qa\`.\`${table}\` TO ${account}` },
      ];
      await expect(
        attestMariaDbRuntimeConnection(query(rows), expected("app")),
      ).rejects.toMatchObject({ reason: "privileges_rejected" });
    },
  );

  it("rejects a same-count column substitution and missing operator timestamp authority", async () => {
    const wrongColumn = grants("app").map((row) => ({
      grant: row.grant.replace("UPDATE (`display_name_in_class`", "UPDATE (`is_active`"),
    }));
    await expect(
      attestMariaDbRuntimeConnection(query(wrongColumn), expected("app")),
    ).rejects.toMatchObject({ reason: "privileges_rejected" });
    const missingTimestamp = grants("operator").map((row) => ({
      grant: row.grant.replace("`created_at`, ", ""),
    }));
    await expect(
      attestMariaDbRuntimeConnection(query(missingTimestamp), expected("operator")),
    ).rejects.toMatchObject({ reason: "privileges_rejected" });
  });

  it("retains only the existing role-specific lock extensions", () => {
    expect(requiredMariaDbRuntimeGrants("worker", "worker_security_audit_v1")).toHaveLength(4);
    expect(requiredMariaDbRuntimeGrants("retention", "retention_v1")).toHaveLength(44);
    for (const role of ["app", "operator"])
      for (const profile of ["worker_security_audit_v1", "retention_v1"])
        expect(requiredMariaDbRuntimeGrants(role, profile)).toBeUndefined();
    for (const entries of Object.values(catalog.roles))
      expect(entries.some((entry) => scope.retired_tables.includes(entry.split("|")[1]!))).toBe(
        false,
      );
  });

  it("rejects an otherwise current envelope that lacks session renewal authority", async () => {
    const previous = grants("app").map((row) => ({
      grant: row.grant.replace("UPDATE (`absolute_expires_at`, ", "UPDATE ("),
    }));
    expect(parseMariaDbRuntimeGrants(previous, expected("app"))).toHaveLength(
      catalog.roles.app.length - 1,
    );
    await expect(
      attestMariaDbRuntimeConnection(query(previous), expected("app")),
    ).rejects.toMatchObject({ reason: "privileges_rejected" });
  });
});
