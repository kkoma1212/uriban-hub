import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import { readMariaDbActiveScope } from "../scope/active-scope.mjs";
import { buildSemanticAclCandidate } from "./semantic_acl_candidate.mjs";
import {
  activeRuntimeAclPath,
  activeRuntimeCatalogRoles,
  adminSessionRenewalAclOverlay,
  assertAdminSessionRenewalAclSource,
  buildActiveRuntimeAcl,
  buildCurrentRuntimeAcl,
  currentRuntimeAclPath,
  renderActiveRuntimeAcl,
} from "./active_runtime_acl.mjs";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const source = JSON.parse(read("db/mariadb/permissions/semantic_source_acl.json"));
const scope = readMariaDbActiveScope();
const historical = buildSemanticAclCandidate(source);
const active = buildActiveRuntimeAcl(source);
const current = buildCurrentRuntimeAcl(source);
const catalog = JSON.parse(read("packages/db/src/mariadb/runtime-grant-catalog.json"));

test("active ACL preserves historical rights with exactly the explicit audit and renewal overlays", () => {
  const before = globalThis.structuredClone(historical);
  const oldSource = globalThis.structuredClone(source);
  const result = buildActiveRuntimeAcl(source);
  for (const [principal, tables] of Object.entries(historical.roles)) {
    const expected = globalThis.structuredClone(tables);
    for (const table of scope.retired_tables) delete expected[table];
    if (principal === "classhub_app")
      expected.admin_sessions.UPDATE = [
        ...expected.admin_sessions.UPDATE,
        "absolute_expires_at",
      ].sort();
    if (principal === "classhub_operator") {
      expected.audit_logs.INSERT = [...expected.audit_logs.INSERT, "created_at"].sort();
      expected.operator_audit_logs.INSERT = [
        ...expected.operator_audit_logs.INSERT,
        "created_at",
      ].sort();
    }
    assert.deepEqual(result.roles[principal], expected);
  }
  assert.deepEqual(result.procedures, historical.procedures);
  assert.deepEqual(source, oldSource);
  assert.deepEqual(historical, before);
  assert.deepEqual(
    [...new Set(Object.values(result.roles).flatMap(Object.keys))].sort(),
    scope.product_tables,
  );
  assert.deepEqual(
    Object.values(result.roles).map((tables) => Object.keys(tables).length),
    [49, 17, 1, 18],
  );
});

test("active baseline removes app39/retention2 and adds one renewal column, keeping exact 487 entries", () => {
  const roles = activeRuntimeCatalogRoles(active);
  assert.deepEqual(
    Object.fromEntries(Object.entries(roles).map(([role, grants]) => [role, grants.length])),
    { app: 247, operator: 195, worker: 2, retention: 43 },
  );
  assert.equal(Object.values(roles).flat().length, 487);
  assert.ok(roles.app.includes(adminSessionRenewalAclOverlay.grant));
  for (const entries of Object.values(roles)) {
    assert.equal(new Set(entries).size, entries.length);
    assert.deepEqual(entries, [...entries].sort());
    assert.ok(entries.every((entry) => !scope.retired_tables.includes(entry.split("|")[1])));
  }
  for (const table of ["audit_logs", "operator_audit_logs"])
    assert.ok(roles.operator.includes(`table|${table}|INSERT|created_at`));
  for (const column of ["is_active", "deleted_at"])
    assert.ok(!roles.app.includes(`table|users|UPDATE|${column}`));
  assert.ok(!roles.app.includes("table|class_member_status_history|INSERT|*"));
});

test("the reviewed active scope cannot swap a retired table back in at the same count", () => {
  const changed = globalThis.structuredClone(scope);
  changed.product_tables[changed.product_tables.indexOf("notices")] = "seat_draws";
  changed.retired_tables[changed.retired_tables.indexOf("seat_draws")] = "notices";
  changed.product_tables.sort();
  changed.retired_tables.sort();
  assert.throws(() => buildActiveRuntimeAcl(source, changed), /active ACL tables changed/u);
});

test("catalog extraction and SQL rendering reject each retired or unknown object", () => {
  for (const table of [...scope.retired_tables, "unreviewed_table"]) {
    const changed = globalThis.structuredClone(active);
    changed.roles.classhub_app[table] = { SELECT: "*" };
    assert.throws(() => activeRuntimeCatalogRoles(changed), /non-active table in runtime ACL/u);
    assert.throws(() => renderActiveRuntimeAcl(changed), /non-active table in runtime ACL/u);
  }
  for (const missing of ["INSERT", "SELECT"]) {
    const changed = globalThis.structuredClone(active);
    delete changed.roles.classhub_worker.security_audit_logs[missing];
    assert.throws(() => activeRuntimeCatalogRoles(changed), /active runtime grant counts changed/u);
  }
});

test("the generated SQL and catalog agree with the active builder and exact source bytes", () => {
  assert.equal(read(activeRuntimeAclPath).toString("utf8"), renderActiveRuntimeAcl(active));
  assert.equal(read(currentRuntimeAclPath).toString("utf8"), renderActiveRuntimeAcl(current));
  assert.deepEqual(catalog.roles, activeRuntimeCatalogRoles(current));
  assert.equal(catalog.revision, "active54-source49-signup0037-adminstatus0038-memberstatus0040");
  assert.deepEqual(catalog.sourceOverlays, current.sourceOverlays);
  assert.equal(catalog.productScope, scope.id);
  assert.equal(catalog.productTableCount, 54);
  assert.equal(catalog.activationApproved, false);
  for (const [path, digest] of Object.entries(catalog.sourceHashes))
    assert.equal(createHash("sha256").update(read(path)).digest("hex"), digest, path);
  const statements = read(activeRuntimeAclPath)
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim() && !line.startsWith("--"));
  assert.ok(statements.every((line) => line.startsWith("GRANT ")));
  assert.ok(statements.every((line) => !/WITH GRANT OPTION|ON \*\.\*|ON [^.]+\.\*/u.test(line)));
  assert.ok(
    !statements.some((line) => /retention_lock_keys|worker_security_audit_lock_keys/u.test(line)),
  );
});

test("current signup and administrator changes add only two columns and two protected calls", () => {
  const before = activeRuntimeCatalogRoles(active);
  const after = activeRuntimeCatalogRoles(current);
  assert.deepEqual(
    after.app.filter((entry) => !before.app.includes(entry)),
    [
      "procedure|set_admin_member_status|EXECUTE",
      "procedure|set_admin_user_status|EXECUTE",
      "table|users|INSERT|signup_role",
      "table|users|UPDATE|signup_role",
    ],
  );
  for (const role of ["operator", "worker", "retention"])
    assert.deepEqual(after[role], before[role]);
  for (const column of ["is_active", "deleted_at"])
    assert.ok(!after.app.includes(`table|users|UPDATE|${column}`));
  assert.ok(!after.app.includes("table|class_members|UPDATE|status"));
});

test("the renewal source has only the one-column GRANT and exact inverse, with no table/data changes", () => {
  const source = read(adminSessionRenewalAclOverlay.sourcePath).toString("utf8");
  assertAdminSessionRenewalAclSource(source);
  for (const changed of [
    source.replace("UPDATE (absolute_expires_at)", "UPDATE"),
    source.replace("FROM classhub_app", "FROM classhub_operator"),
    source.replace(
      "-- Down Migration",
      "ALTER TABLE admin_sessions ADD COLUMN extra INT;\n-- Down Migration",
    ),
    source + "DELETE FROM admin_sessions;\n",
  ])
    assert.throws(() => assertAdminSessionRenewalAclSource(changed), /exactly one column/u);
  assert.equal(
    historical.roles.classhub_app.admin_sessions.UPDATE.includes("absolute_expires_at"),
    false,
  );
});

test("historical evidence SQL and source ACL are unchanged by active generation", () => {
  for (const [path, digest] of [
    [
      "db/mariadb/permissions/semantic_source_acl.json",
      "822b9219b8ab712cc2a9f38a72e154d38ce48b8b7b0d1303bab2dadfa60849fd",
    ],
    [
      "db/mariadb/permissions/0028_runtime_acl_candidate.sql",
      "e422583d5d63b81fbba7958eaf3284588ca4a48816ec88cd8271656615e0da86",
    ],
    [
      "db/mariadb/permissions/0029_operator_audit_timestamp_candidate.sql",
      "a5d4b56ab55ce281f8295b1a5483b23073f6dcf722b401d3c5c5fb2df386b96c",
    ],
  ])
    assert.equal(createHash("sha256").update(read(path)).digest("hex"), digest);
});
