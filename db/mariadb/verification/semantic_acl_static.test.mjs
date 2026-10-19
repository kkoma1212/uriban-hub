import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  buildSemanticAclCandidate,
  renderSemanticAcl,
} from "../permissions/semantic_acl_candidate.mjs";
import { deriveSourceAcl, semanticSourceMigrations } from "./semantic_source_acl.mjs";
import {
  adminSessionRenewalAclOverlay,
  assertAdminSessionRenewalAclSource,
} from "../permissions/active_runtime_acl.mjs";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const originals = new Map(semanticSourceMigrations.map((path) => [path, read(path)]));
const source = await deriveSourceAcl((path) => originals.get(path));
const candidate = buildSemanticAclCandidate(source);
const sorted = (values) => [...values].sort();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const roleNames = ["classhub_app", "classhub_operator", "classhub_worker", "classhub_retention"];
const tableUnion = (roles) => sorted(new Set(Object.values(roles).flatMap(Object.keys)));
const up = (sql) => sql.split("-- Down Migration")[0];
const appendUp = (sql, statement) =>
  sql.replace("-- Down Migration", `${statement}\n\n-- Down Migration`);
const pathAt = (index) => semanticSourceMigrations[index];

test("frozen source47 ACL preserves its hashes/origins while current inventory names the renewal overlay", () => {
  // 2026-10-04 은퇴: 'db/migrations 폴더가 정확히 48개'는 그 시점 사진이었다(이후 파일이 늘어 66개).
  // 고정된 47개 근거와 갱신 덧칠이 폴더에 그대로 있는지만 본다.
  const inventory = readdirSync(new URL("db/migrations/", root))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => `db/migrations/${name}`);
  for (const path of [...semanticSourceMigrations, adminSessionRenewalAclOverlay.sourcePath])
    assert.ok(inventory.includes(path), `${path} must remain in db/migrations`);
  assertAdminSessionRenewalAclSource(read(adminSessionRenewalAclOverlay.sourcePath));
  assert.deepEqual(source, JSON.parse(read("db/mariadb/permissions/semantic_source_acl.json")));
  assert.deepEqual(
    source.sourceMigrations,
    semanticSourceMigrations.map((path) => ({ path, sha256: hash(originals.get(path)) })),
  );
  assert.equal(source.sourceSetSha256, hash(JSON.stringify(source.sourceMigrations)));
  assert.equal(source.grantSources.length, 266);
  for (const grant of source.grantSources) {
    const sql = originals.get(grant.source);
    assert.match(sql.split("\n")[grant.line - 1], /^\s*GRANT\b/u, `${grant.source}:${grant.line}`);
    assert.ok(grant.line <= up(sql).split("\n").length, "provenance belongs to Up");
    assert.ok(source.roles[grant.role][grant.table][grant.privilege], "provenance survives replay");
  }
  assert.match(source.scope, /direct table\/column ACL only; not MariaDB activation authority/u);
  for (const exclusion of [
    /sequences and functions/u,
    /role inheritance/u,
    /ALTER DEFAULT PRIVILEGES/u,
  ])
    assert.ok(source.excluded.some((entry) => exclusion.test(entry)));
});

test("the final source and candidate cover exactly the 65 source tables, without metadata or helpers", () => {
  const created = [];
  for (const sql of originals.values())
    for (const match of up(sql).matchAll(/^CREATE TABLE ([a-z][a-z0-9_]*)\s*\(/gmu))
      created.push(match[1]);
  assert.equal(created.length, 65);
  assert.equal(new Set(created).size, 65);
  assert.deepEqual(tableUnion(source.roles), sorted(created));
  assert.deepEqual(tableUnion(candidate.roles), sorted(created));
  assert.deepEqual(Object.keys(source.roles), roleNames);
  assert.deepEqual(Object.keys(candidate.roles), roleNames);
  assert.deepEqual(
    roleNames.map((role) => Object.keys(source.roles[role]).length),
    [60, 18, 1, 19],
  );
  assert.deepEqual(
    roleNames.map((role) => Object.keys(candidate.roles[role]).length),
    [60, 17, 1, 19],
  );
  assert.ok(!tableUnion(candidate.roles).includes("pgmigrations"));
});

test("source replay honors the actual broad resets and later table resets", async () => {
  assert.match(up(originals.get(pathAt(0))), /GRANT SELECT, INSERT, UPDATE, DELETE/u);
  assert.equal(source.roles.classhub_app.users.DELETE, undefined);
  assert.deepEqual(source.roles.classhub_app.schools, { SELECT: "*", UPDATE: ["updated_at"] });
  assert.deepEqual(source.roles.classhub_worker, {
    security_audit_logs: { INSERT: "*", SELECT: "*" },
  });
  assert.deepEqual(source.roles.classhub_app.in_app_reminder_recipients, {
    INSERT: "*",
    SELECT: "*",
    UPDATE: ["resolved_at"],
  });
  assert.deepEqual(source.roles.classhub_app.notice_recipients, { INSERT: "*", SELECT: "*" });
  assert.deepEqual(source.roles.classhub_app.supply_recipients, { INSERT: "*", SELECT: "*" });

  // Seed historical over-grants in memory; the real 0004/0007/0008/0009 resets must erase them.
  const replayed = await deriveSourceAcl((path) => {
    let sql = originals.get(path);
    if (path === pathAt(0))
      sql = appendUp(
        sql,
        "GRANT DELETE ON users TO classhub_worker, classhub_operator;\n" +
          "GRANT SELECT ON security_audit_logs TO classhub_app;",
      );
    if (path === pathAt(7))
      sql = appendUp(
        sql,
        "GRANT UPDATE, DELETE ON in_app_reminder_recipients, notice_recipients, supply_recipients " +
          "TO classhub_app, classhub_operator, classhub_worker, classhub_retention;",
      );
    return sql;
  });
  assert.deepEqual(replayed.roles, source.roles);
  assert.notEqual(replayed.sourceSetSha256, source.sourceSetSha256);
});

test("source0036 erasure privileges survive Down, and latest Up revoke or missing grant is detected", async () => {
  assert.equal(source.roles.classhub_app.election_participants.DELETE, "*");
  assert.equal(source.roles.classhub_app.election_candidates.UPDATE, "*");
  const withoutGrant = await deriveSourceAcl((path) =>
    path === pathAt(36)
      ? originals.get(path).replace("GRANT UPDATE ON election_candidates TO classhub_app;", "")
      : originals.get(path),
  );
  assert.equal(withoutGrant.roles.classhub_app.election_candidates.UPDATE, undefined);
  assert.equal(withoutGrant.roles.classhub_app.election_participants.DELETE, "*");
  assert.notEqual(withoutGrant.sourceSetSha256, source.sourceSetSha256);
  const revoked = await deriveSourceAcl((path) =>
    path === pathAt(46)
      ? appendUp(originals.get(path), "REVOKE DELETE ON election_participants FROM classhub_app;")
      : originals.get(path),
  );
  assert.equal(revoked.roles.classhub_app.election_participants.DELETE, undefined);
  assert.equal(revoked.roles.classhub_app.election_candidates.UPDATE, "*");
  assert.ok(
    !revoked.grantSources.some(
      (grant) =>
        grant.role === "classhub_app" &&
        grant.table === "election_participants" &&
        grant.privilege === "DELETE",
    ),
  );
});

test("source strings, comments, excluded object grants and Down cannot create a runtime table grant", async () => {
  const replayed = await deriveSourceAcl((path) => {
    if (path !== pathAt(46)) return originals.get(path);
    return (
      appendUp(
        originals.get(path),
        [
          "-- GRANT DELETE ON users TO classhub_app;",
          "/* GRANT DELETE ON users TO classhub_app; */",
          "DO $fixture$ BEGIN EXECUTE 'GRANT DELETE ON users TO classhub_app;'; END $fixture$;",
          "GRANT EXECUTE ON FUNCTION fixture() TO classhub_app;",
          "GRANT USAGE ON SEQUENCE fixture_id_seq TO classhub_app;",
          "GRANT SELECT ON users TO PUBLIC;",
          "ALTER DEFAULT PRIVILEGES FOR ROLE classhub_migrator IN SCHEMA public",
          "  GRANT DELETE ON TABLES TO classhub_app;",
        ].join("\n"),
      ) + "\nGRANT DELETE ON users TO classhub_app;\n"
    );
  });
  assert.deepEqual(replayed.roles, source.roles);
});

test("app audit reads expose the exact 0046 eleven and 0045 seven approved columns", () => {
  const security = sorted([
    "id",
    "event_id",
    "action",
    "method",
    "resource",
    "sanitized_path",
    "deny_reason",
    "failure_code",
    "created_at",
    "request_id",
    "target_class_id",
  ]);
  const authentication = sorted([
    "id",
    "event_id",
    "admin_account_id",
    "action",
    "deny_reason",
    "request_id",
    "created_at",
  ]);
  for (const contract of [source, candidate]) {
    assert.deepEqual(contract.roles.classhub_app.security_audit_logs, { SELECT: security });
    assert.deepEqual(contract.roles.classhub_app.admin_auth_audit_logs.SELECT, authentication);
    assert.equal(contract.roles.classhub_app.admin_auth_audit_logs.UPDATE, undefined);
    assert.equal(contract.roles.classhub_app.admin_auth_audit_logs.DELETE, undefined);
    for (const column of ["actor_email_hmac", "actor_ip_hmac", "hmac_key_version", "user_agent"])
      assert.ok(!contract.roles.classhub_app.admin_auth_audit_logs.SELECT.includes(column));
  }
  assert.equal(candidate.roles.classhub_worker.security_audit_logs.INSERT, "*");
  assert.equal(candidate.roles.classhub_retention.security_audit_logs.DELETE, "*");
  assert.equal(candidate.roles.classhub_retention.admin_auth_audit_logs.DELETE, "*");
});

test("candidate changes exactly seven source role/table entries and preserves all later feature grants", () => {
  const expectedDifferences = sorted([
    "classhub_app/users",
    "classhub_app/classes",
    "classhub_app/class_members",
    "classhub_app/class_invite_codes",
    "classhub_app/class_member_status_history",
    "classhub_operator/class_members",
    "classhub_operator/class_member_status_history",
  ]);
  const differences = [];
  for (const role of roleNames) {
    assert.ok(
      Object.keys(candidate.roles[role]).every((table) => Object.hasOwn(source.roles[role], table)),
    );
    for (const [table, grants] of Object.entries(source.roles[role])) {
      if (!isDeepStrictEqual(candidate.roles[role][table], grants))
        differences.push(`${role}/${table}`);
    }
  }
  assert.deepEqual(sorted(differences), expectedDifferences);
  assert.deepEqual(
    candidate.roles.classhub_app.teacher_profiles.INSERT,
    sorted([
      "user_id",
      "status",
      "temporary_password_must_change",
      "temporary_password_expires_at",
      "created_by_operator_id",
      "created_by_admin_account_id",
    ]),
  );
  assert.deepEqual(
    candidate.roles.classhub_operator.classes.SELECT,
    sorted(["id", "status", "edu_office_code", "school_code", "grade", "row_version"]),
  );
  assert.ok(!candidate.roles.classhub_operator.classes.SELECT.includes("suspended_reason"));
  assert.ok(candidate.roles.classhub_operator.users.INSERT.includes("password_input_version"));
  assert.ok(candidate.roles.classhub_operator.users.UPDATE.includes("password_input_version"));
  assert.deepEqual(candidate.roles.classhub_app.admin_terms_versions.UPDATE, [
    "effective_at",
    "published_at",
    "status",
  ]);
  assert.equal(candidate.roles.classhub_app.election_candidates.UPDATE, "*");
  assert.equal(candidate.roles.classhub_app.election_participants.DELETE, "*");
  assert.deepEqual(
    source,
    JSON.parse(read("db/mariadb/permissions/semantic_source_acl.json")),
    "builder did not mutate source",
  );
});

test("candidate keeps lifecycle state behind routines and limits every permitted direct core write", () => {
  const app = candidate.roles.classhub_app;
  assert.deepEqual(app.users, {
    INSERT: sorted([
      "email_normalized",
      "display_name",
      "password_hash",
      "password_input_version",
      "signup_approved_at",
    ]),
    SELECT: "*",
    UPDATE: sorted([
      "display_name",
      "email_verified_at",
      "failed_login_attempts",
      "locked_until",
      "password_hash",
      "password_input_version",
      "password_last_changed_at",
      "signup_approved_at",
      "updated_at",
    ]),
  });
  assert.deepEqual(app.classes, {
    SELECT: "*",
    UPDATE: sorted(["name", "expected_student_count", "row_version", "updated_at"]),
  });
  assert.deepEqual(app.class_members, {
    SELECT: "*",
    UPDATE: sorted(["display_name_in_class", "student_number", "row_version", "updated_at"]),
  });
  assert.deepEqual(app.class_invite_codes, { SELECT: "*" });
  assert.deepEqual(app.class_member_status_history, { SELECT: "*" });
  assert.deepEqual(app.teacher_profiles.UPDATE, [
    "temporary_password_expires_at",
    "temporary_password_must_change",
  ]);
  assert.deepEqual(candidate.roles.classhub_operator.class_members, {
    SELECT: sorted(["class_id", "id", "role", "row_version", "status", "user_id"]),
  });
  assert.equal(candidate.roles.classhub_operator.class_member_status_history, undefined);
  for (const role of roleNames) {
    const tables = candidate.roles[role];
    for (const table of [
      "classes",
      "class_members",
      "class_invite_codes",
      "class_member_status_history",
    ])
      for (const privilege of ["INSERT", "DELETE"])
        assert.equal(tables[table]?.[privilege], undefined, `${role}/${table}/${privilege}`);
  }
});

test("the only routine grants are the eleven phase0002 app transitions and checked operator transfer", () => {
  const baseline = read("db/mariadb/permissions/0002_class_membership_runtime_activation.sql");
  const appProcedures = [
    ...baseline.matchAll(
      /GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev\.([a-z_]+)\s+TO 'classhub_app'@'%';/gu,
    ),
  ].map((match) => match[1]);
  assert.equal(appProcedures.length, 11);
  assert.deepEqual(candidate.procedures, {
    classhub_app: appProcedures,
    classhub_operator: ["transfer_class_teacher_checked"],
    classhub_worker: [],
    classhub_retention: [],
  });
  const allProcedures = Object.values(candidate.procedures).flat();
  assert.equal(new Set(allProcedures).size, 12);
  for (const forbidden of [
    "transfer_class_teacher",
    "lock_class_invariant_boundary",
    "assert_class_invariants",
    "assert_read_committed_session",
  ])
    assert.ok(!allProcedures.includes(forbidden));
});

// Parse the emitted SQL independently: object identifiers, column identifiers and
// account strings occupy different grammatical positions and cannot substitute for one another.
function parseRendered(sql, probe) {
  const roles = Object.fromEntries(roleNames.map((role) => [role, {}]));
  const procedures = Object.fromEntries(roleNames.map((role) => [role, []]));
  const lines = sql.trimEnd().split("\n");
  for (const line of lines) {
    const grant =
      /^GRANT (.+) ON (.+) TO '(classhub_(?:probe_)?(?:app|operator|worker|retention))'@'%';$/u.exec(
        line,
      );
    assert.ok(grant, `one scoped GRANT per line: ${line}`);
    const [, privilegeText, object, account] = grant;
    assert.equal(account.startsWith("classhub_probe_"), probe);
    const role = account.replace("classhub_probe_", "classhub_");
    const procedure = /^PROCEDURE classhub_mariadb_phase1_dev\.([a-z_][a-z0-9_]*)$/u.exec(object);
    if (procedure) {
      assert.equal(privilegeText, "EXECUTE");
      assert.ok(!procedures[role].includes(procedure[1]), "no duplicate procedure grant");
      procedures[role].push(procedure[1]);
      continue;
    }
    const table = /^classhub_mariadb_phase1_dev\.`([a-z_][a-z0-9_]*)`$/u.exec(object);
    assert.ok(table, `table is one quoted identifier in the fixed schema: ${object}`);
    assert.equal(roles[role][table[1]], undefined, "no duplicate table grant");
    const grants = {};
    let remaining = privilegeText;
    while (remaining) {
      const clause =
        /^(SELECT|INSERT|UPDATE|DELETE)(?: \((`[a-z_][a-z0-9_]*`(?:, `[a-z_][a-z0-9_]*`)*)\))?(?:, |$)/u.exec(
          remaining,
        );
      assert.ok(clause, `strict privilege/column clause: ${remaining}`);
      assert.equal(grants[clause[1]], undefined, "no duplicate privilege");
      grants[clause[1]] = clause[2]
        ? clause[2].split(", ").map((column) => column.slice(1, -1))
        : "*";
      remaining = remaining.slice(clause[0].length);
    }
    roles[role][table[1]] = grants;
  }
  return { roles, procedures, lineCount: lines.length };
}

test("rendered real/probe SQL round-trips the exact 65-table candidate and twelve procedures", () => {
  for (const probe of [false, true]) {
    const sql = renderSemanticAcl(candidate, probe);
    const parsed = parseRendered(sql, probe);
    assert.deepEqual(parsed.roles, candidate.roles);
    assert.deepEqual(parsed.procedures, candidate.procedures);
    assert.equal(parsed.lineCount, 109); // 97 role/table entries and 12 procedure grants.
    assert.equal(tableUnion(parsed.roles).length, 65);
    assert.match(sql, /`content_sha256`/u, "source0044 digit-bearing identifier renders");
    assert.doesNotMatch(sql, /GRANT OPTION|\bALL\b|ON \*|ON classhub_mariadb_phase1_dev\.\*/u);
    assert.doesNotMatch(
      sql,
      /\b(?:REVOKE|CREATE USER|ALTER USER|CREATE ROLE|DROP USER|SET ROLE)\b/u,
    );
  }
  assert.equal(renderSemanticAcl(candidate), renderSemanticAcl(candidate, false));
});

test("SQL rendering rejects injected roles, objects, columns, privileges and unquoted stars", () => {
  const minimal = () => ({
    roles: { classhub_app: { fixture: { SELECT: ["column_sha256"] } } },
    procedures: { classhub_app: ["fixture_procedure"] },
  });
  assert.match(renderSemanticAcl(minimal(), true), /SELECT \(`column_sha256`\)/u);
  for (const bad of [
    "",
    "users.other",
    "users`",
    "users; DELETE",
    "users--",
    "users'",
    "users name",
    "*",
    "1users",
  ]) {
    const table = minimal();
    table.roles.classhub_app = { [bad]: { SELECT: "*" } };
    assert.throws(
      () => renderSemanticAcl(table, true),
      undefined,
      `bad table ${JSON.stringify(bad)}`,
    );
    const column = minimal();
    column.roles.classhub_app.fixture.SELECT = [bad];
    assert.throws(
      () => renderSemanticAcl(column, true),
      undefined,
      `bad column ${JSON.stringify(bad)}`,
    );
    const procedure = minimal();
    procedure.procedures.classhub_app = [bad];
    assert.throws(
      () => renderSemanticAcl(procedure, true),
      undefined,
      `bad procedure ${JSON.stringify(bad)}`,
    );
  }
  for (const bad of [
    "classhub_probe_app",
    "classhub_routine",
    "classhub_app'@'localhost",
    "classhub_app;GRANT",
  ]) {
    const input = minimal();
    input.roles = { [bad]: input.roles.classhub_app };
    input.procedures = { [bad]: [] };
    assert.throws(() => renderSemanticAcl(input, true));
  }
  for (const grants of [
    { SELECT: [] },
    { SELECT: "id" },
    { SELECT: ["*"] },
    { EXECUTE: "*" },
    { REFERENCES: "*" },
    { "SELECT WITH GRANT OPTION": "*" },
  ]) {
    const input = minimal();
    input.roles.classhub_app.fixture = grants;
    assert.throws(() => renderSemanticAcl(input, true));
  }
});

test("static ACL success does not resolve caller authorization, audit timestamps or rollback activation", () => {
  assert.equal(candidate.activationApplied, false);
  assert.equal(candidate.invariantBoundary, "phase0002_direct_lifecycle_writes_remain_forbidden");
  assert.equal(candidate.callerAuthorizationAndRollback, "activation_blocker");
  assert.equal(candidate.administratorMembershipAdapter, "activation_blocker");
  for (const table of ["audit_logs", "operator_audit_logs"]) {
    assert.ok(Array.isArray(candidate.roles.classhub_operator[table].INSERT));
    assert.ok(!candidate.roles.classhub_operator[table].INSERT.includes("created_at"));
  }
  // PG grants alone cannot satisfy this existing MariaDB caller timestamp contract.
  const contract = JSON.parse(read("db/mariadb/verification/0002_class_transition_contract.json"));
  assert.match(JSON.stringify(contract), /round-trip out_occurred_at as an exact canonical value/u);
  assert.match(
    JSON.stringify(contract),
    /Prove byte\/value equality with the routine-written history created_at/u,
  );
});
import { URL } from "node:url";
