import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import catalog from "./runtime-grant-catalog.json" with { type: "json" };
import { requiredMariaDbRuntimeGrants } from "./runtime-grant-profile.js";

describe("reviewed MariaDB worker audit grant profile", () => {
  it("restricts the retention extension to its role and read-only seeded locks", () => {
    const baseline = [...catalog.roles.retention];
    const profile = requiredMariaDbRuntimeGrants("retention", "retention_v1");
    expect(profile).toEqual([...baseline, "table|retention_lock_keys|SELECT|*"].sort());
    expect(profile).toHaveLength(44);
    expect(Object.isFrozen(profile)).toBe(true);
    for (const role of ["app", "operator", "worker", undefined])
      expect(requiredMariaDbRuntimeGrants(role, "retention_v1")).toBeUndefined();
    expect(requiredMariaDbRuntimeGrants("retention", "worker_security_audit_v1")).toBeUndefined();
    expect(catalog.roles.retention).toEqual(baseline);
  });
  it("keeps every baseline role unchanged and adds only the two lock privileges", () => {
    const baseline = structuredClone(catalog.roles);
    for (const role of Object.keys(baseline))
      expect(requiredMariaDbRuntimeGrants(role, undefined)).toEqual(
        baseline[role as keyof typeof baseline],
      );
    expect(requiredMariaDbRuntimeGrants("worker", "worker_security_audit_v1")).toEqual([
      "table|security_audit_logs|INSERT|*",
      "table|security_audit_logs|SELECT|*",
      "table|worker_security_audit_lock_keys|INSERT|*",
      "table|worker_security_audit_lock_keys|SELECT|*",
    ]);
    expect(catalog.roles).toEqual(baseline);
    expect(catalog.roles.worker).toHaveLength(2);
  });
  it("does not expose a mutable profile grant list", () => {
    const required = requiredMariaDbRuntimeGrants("worker", "worker_security_audit_v1");
    expect(Object.isFrozen(required)).toBe(true);
  });
  it("the review-only ACL candidate contains exactly two worker grants and no execution", () => {
    const candidate = readFileSync(
      new URL("../../../../db/mariadb/permissions/0034_worker_audit_lock_acl.sql", import.meta.url),
      "utf8",
    );
    expect(candidate).toContain("runtimeActivationApplied=false");
    expect(candidate).toContain("realMariaDbVerified=false");
    const statements = candidate
      .split(/\r?\n/u)
      .filter((line) => line.trim() && !line.startsWith("--"));
    expect(statements).toEqual([
      "GRANT INSERT ON classhub_mariadb_phase1_dev.`worker_security_audit_lock_keys` TO 'classhub_worker'@'%';",
      "GRANT SELECT ON classhub_mariadb_phase1_dev.`worker_security_audit_lock_keys` TO 'classhub_worker'@'%';",
    ]);
  });
});
