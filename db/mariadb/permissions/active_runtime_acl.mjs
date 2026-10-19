import assert from "node:assert/strict";
import { readMariaDbActiveScope } from "../scope/active-scope.mjs";
import { buildSemanticAclCandidate, renderSemanticAcl } from "./semantic_acl_candidate.mjs";

export const activeRuntimeAclPath = "db/mariadb/permissions/0036_active_runtime_acl.sql";
export const currentRuntimeAclPath = "db/mariadb/permissions/0039_current_runtime_acl.sql";
export const signupRoleSource = "db/migrations/1783700048000_signup-role.sql";
export const currentApplicationAclSources = Object.freeze([
  "db/mariadb/migrations/0037_signup_role.sql",
  "db/mariadb/migrations/0038_admin_user_status.sql",
  "db/mariadb/permissions/0038_admin_user_status_execute.sql",
  "db/mariadb/migrations/0040_admin_member_status.sql",
  "db/mariadb/permissions/0040_admin_member_status_execute.sql",
]);
export const currentRuntimeGrantCounts = Object.freeze({
  app: 251,
  operator: 195,
  worker: 2,
  retention: 43,
});
export const adminSessionRenewalAclOverlay = Object.freeze({
  sourcePath: "db/migrations/1783700047000_admin-session-renewal.sql",
  grant: "table|admin_sessions|UPDATE|absolute_expires_at",
  role: "app",
});
export function assertAdminSessionRenewalAclSource(source) {
  assert.deepEqual(
    source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
    [
      "-- Up Migration",
      "GRANT UPDATE (absolute_expires_at) ON admin_sessions TO classhub_app;",
      "-- Down Migration",
      "REVOKE UPDATE (absolute_expires_at) ON admin_sessions FROM classhub_app;",
    ],
    "administrator renewal overlay must grant and revoke exactly one column",
  );
}
export const activeRuntimeGrantCounts = Object.freeze({
  app: 247,
  operator: 195,
  worker: 2,
  retention: 43,
});

function reviewedScope(scope) {
  const approved = readMariaDbActiveScope();
  assert.equal(scope.id, approved.id, "active ACL scope changed");
  assert.equal(scope.product_table_count, 54);
  assert.deepEqual(scope.product_tables, approved.product_tables, "active ACL tables changed");
  assert.deepEqual(scope.retired_tables, approved.retired_tables, "retired ACL tables changed");
  return approved;
}

/** Retain source47 evidence and apply only the explicit current runtime overlays. */
export function buildActiveRuntimeAcl(source, scope = readMariaDbActiveScope()) {
  reviewedScope(scope);
  const historical = buildSemanticAclCandidate(source);
  const historicalTables = [
    ...new Set(Object.values(historical.roles).flatMap(Object.keys)),
  ].sort();
  assert.deepEqual(historicalTables, [...scope.product_tables, ...scope.retired_tables].sort());
  const roles = globalThis.structuredClone(historical.roles);
  for (const tables of Object.values(roles)) {
    for (const retired of scope.retired_tables) delete tables[retired];
    assert.ok(Object.keys(tables).every((table) => scope.product_tables.includes(table)));
  }
  // Preserve the reviewed 0029 caller-owned, exact OUT timestamp audit grants.
  for (const table of ["audit_logs", "operator_audit_logs"]) {
    const columns = roles.classhub_operator[table].INSERT;
    assert.ok(Array.isArray(columns) && !columns.includes("created_at"));
    columns.push("created_at");
    columns.sort();
  }
  // Source0047 is an ACL-only follow-up, not a rewrite of source47/0028 evidence.
  const sessionColumns = roles.classhub_app.admin_sessions.UPDATE;
  assert.deepEqual(sessionColumns, ["last_seen_at", "reauthenticated_at", "revoked_at"]);
  sessionColumns.push("absolute_expires_at");
  sessionColumns.sort();
  return {
    roles,
    procedures: globalThis.structuredClone(historical.procedures),
    scopeId: scope.id,
    productTableCount: scope.product_table_count,
    activationApplied: false,
    sourceOverlays: [adminSessionRenewalAclOverlay],
  };
}

/** Preserve the prior 0036 evidence and add only current, reviewed application rights. */
export function buildCurrentRuntimeAcl(source, scope = readMariaDbActiveScope()) {
  const candidate = buildActiveRuntimeAcl(source, scope);
  for (const right of ["INSERT", "UPDATE"]) {
    const columns = candidate.roles.classhub_app.users[right];
    assert.ok(Array.isArray(columns) && !columns.includes("signup_role"));
    columns.push("signup_role");
    columns.sort();
  }
  assert.ok(!candidate.procedures.classhub_app.includes("set_admin_user_status"));
  candidate.procedures.classhub_app.push("set_admin_user_status");
  assert.ok(!candidate.procedures.classhub_app.includes("set_admin_member_status"));
  candidate.procedures.classhub_app.push("set_admin_member_status");
  candidate.procedures.classhub_app.sort();
  return {
    ...candidate,
    currentApplication: true,
    sourceOverlays: [
      ...candidate.sourceOverlays,
      {
        sourcePath: signupRoleSource,
        role: "app",
        grants: ["table|users|INSERT|signup_role", "table|users|UPDATE|signup_role"],
      },
      {
        sourcePath: currentApplicationAclSources[1],
        role: "app",
        grant: "procedure|set_admin_user_status|EXECUTE",
      },
      {
        sourcePath: currentApplicationAclSources[3],
        role: "app",
        grant: "procedure|set_admin_member_status|EXECUTE",
      },
    ],
  };
}

export function activeRuntimeCatalogRoles(candidate) {
  const scope = readMariaDbActiveScope();
  assert.equal(candidate.scopeId, scope.id);
  assert.equal(candidate.productTableCount, scope.product_table_count);
  const roles = {};
  for (const [principal, tables] of Object.entries(candidate.roles)) {
    assert.match(principal, /^classhub_(app|operator|worker|retention)$/u);
    const entries = [];
    for (const [table, rights] of Object.entries(tables)) {
      assert.ok(scope.product_tables.includes(table), "non-active table in runtime ACL");
      assert.ok(!scope.retired_tables.includes(table), "retired table in runtime ACL");
      for (const [privilege, columns] of Object.entries(rights))
        for (const column of columns === "*" ? ["*"] : columns)
          entries.push(`table|${table}|${privilege}|${column}`);
    }
    for (const routine of candidate.procedures[principal])
      entries.push(`procedure|${routine}|EXECUTE`);
    assert.equal(new Set(entries).size, entries.length, "duplicate active runtime grant");
    roles[principal.replace("classhub_", "")] = entries.sort();
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(roles).map(([role, entries]) => [role, entries.length])),
    candidate.currentApplication ? currentRuntimeGrantCounts : activeRuntimeGrantCounts,
    "active runtime grant counts changed",
  );
  return roles;
}

export function renderActiveRuntimeAcl(candidate) {
  activeRuntimeCatalogRoles(candidate);
  return [
    "-- Generated by generate_runtime_grant_catalog.mjs --write; current P-016 active54 scope.",
    "-- Apply to the new active schema after its tables and invariant routines exist.",
    "-- Installer must reset the four attested runtime accounts' earlier grants before applying.",
    "-- GRANT-only output cannot remove broader phase0001 privileges from existing accounts.",
    "-- This file replaces historical 0028+0029 for that schema; those artifacts remain evidence.",
    "-- Includes operator INSERT(created_at) on both caller-owned audit tables.",
    "-- Includes source0047 app UPDATE(absolute_expires_at) for explicit administrator session renewal.",
    "-- Optional worker profile: install 0033 lock table, then permissions/0034 (+2 entries).",
    "-- Optional retention profile: install scope/0035 retained locks (3 seeds), then permissions/0035 (+1).",
    ...(candidate.currentApplication
      ? [
          "-- Requires follow-ups 0037 signup role, 0038 protected user status and 0040 protected member status.",
          "-- Prior 0036 ACL is retained as evidence; current app251/operator195/worker2/retention43.",
          "-- users.is_active and class membership lifecycle writes remain protected procedure calls.",
        ]
      : ["-- Baseline app247/operator195/worker2/retention43; profiles worker4/retention44."]),
    "-- Artifact generation performs no database or runtime activation.",
    renderSemanticAcl(candidate).trimEnd(),
    "",
  ].join("\n");
}
