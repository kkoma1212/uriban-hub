import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import { verifyAuditCatalogEvidence } from "./0014_audit_action_catalog_evidence.mjs";
import { readEvidenceDocument } from "./evidence-document.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const sql = read("../migrations/0014_audit_action_catalog.sql").replace(/^\s*--.*$/gmu, "");
const source = read("../../migrations/1783700030000_audit-action-catalog.sql").split(
  "-- Down Migration",
)[0];
const seed = (input) =>
  [
    ...input
      .match(/INSERT INTO audit_log_actions \(action\) VALUES[\s\S]*?;/u)[0]
      .matchAll(/\('([^']+)'\)/gu),
  ].map((m) => m[1]);

test("all 51 source seeds match the immediately preceding binary CHECK exactly", () => {
  const expected = seed(source);
  assert.equal(expected.length, 51);
  assert.equal(new Set(expected).size, 51);
  assert.deepEqual(seed(sql), expected);
  const previous = read("../migrations/0013_duty_rosters.sql");
  const actionCheck = previous.match(
    /ADD CONSTRAINT audit_logs_action_check CHECK\s*\(([\s\S]*?)\)\s*[,;]/u,
  )[1];
  assert.deepEqual(
    [...actionCheck.matchAll(/'([^']+)'/gu)].map((m) => m[1]),
    expected,
  );
  assert.equal(Math.max(...expected.map((action) => action.length)), 36);
  assert.doesNotMatch(sql, /election\.(?:created|opened|closed|published|candidate_registered)/u);
});

test("catalog FK is RESTRICT in both directions and both columns use NOPAD", () => {
  assert.match(source, /action TEXT PRIMARY KEY/u);
  assert.equal(
    (sql.match(/VARCHAR\(64\) CHARACTER SET ascii COLLATE ascii_nopad_bin NOT NULL/gu) ?? [])
      .length,
    2,
  );
  assert.match(sql, /PRIMARY KEY \(action\)/u);
  const fk =
    /FOREIGN KEY \(action\) REFERENCES audit_log_actions \(action\)\s+ON DELETE RESTRICT ON UPDATE RESTRICT/u;
  assert.match(source, fk);
  assert.match(sql, fk);
  assert.match(
    sql,
    /MODIFY COLUMN action[\s\S]*?DROP CONSTRAINT audit_logs_action_check,[\s\S]*?ADD CONSTRAINT audit_logs_action_catalog_fkey/u,
  );
  assert.doesNotMatch(
    sql,
    /audit_logs_json_allowlist_check|audit_logs_reminder_shape_check|audit_logs_attendance_privacy_check/u,
  );
  assert.deepEqual(
    [...sql.matchAll(/DROP CONSTRAINT (\w+)/gu)].map((match) => match[1]),
    ["audit_logs_action_check"],
  );
  assert.doesNotMatch(
    sql,
    /\b(?:GRANT|REVOKE|CREATE USER|ALTER USER|TRIGGER|PROCEDURE|DROP TABLE|DROP DATABASE)\b/iu,
  );
});

test("both source guard intents run before replacing the CHECK without adding persistent routines", () => {
  assert.match(source, /count\(\*\) FROM audit_log_actions\) <> 51/u);
  assert.match(sql, /BEGIN NOT ATOMIC/u);
  assert.match(sql, /COUNT\(\*\) FROM audit_log_actions\) <> 51/u);
  assert.match(sql, /MYSQL_ERRNO = 31401/u);
  assert.match(
    sql,
    /LEFT JOIN audit_log_actions AS catalog ON BINARY catalog\.action = BINARY logs\.action\s+WHERE catalog\.action IS NULL/u,
  );
  assert.match(sql, /MYSQL_ERRNO = 31402/u);
  assert.ok(sql.indexOf("MYSQL_ERRNO = 31401") < sql.indexOf("MYSQL_ERRNO = 31402"));
  assert.ok(sql.indexOf("MYSQL_ERRNO = 31402") < sql.indexOf("DROP CONSTRAINT"));
});

test("runner separates reference rows, retains non-action CHECKs and scopes synthetic guard tests", () => {
  const runner = read("../../../OPERATIONS/mariadb-dev/verify-phase14-qa.mjs");
  const scenarios = read("../../../OPERATIONS/mariadb-dev/phase14-scenarios.mjs");
  const compose = read("../../../compose.mariadb-phase14-qa.yaml");
  assert.match(compose, /internal: true/u);
  assert.match(compose, /\/var\/lib\/mysql:rw,noexec,nosuid,size=1073741824/u);
  assert.doesNotMatch(compose, /\n\s+ports:|runtime_activation|runtime_rollback/u);
  assert.equal((compose.match(/\/docker-entrypoint-initdb\.d\//gu) ?? []).length, 36);
  assert.equal((compose.match(/\/opt\/classhub\/phase14\//gu) ?? []).length, 1);
  assert.match(runner, /const expectedAddedAcl = \[\]/u);
  assert.match(runner, /checkFingerprint\(\), beforeChecks/u);
  assert.match(runner, /seedAndZeroRows\(\)/u);
  assert.match(runner, /persistentRows: 51/u);
  assert.match(runner, /catalogSeedRows: 51/u);
  assert.match(runner, /persistentNonseedRows: 0/u);
  assert.match(scenarios, /CREATE TEMPORARY TABLE audit_log_actions/u);
  assert.match(scenarios, /CREATE TEMPORARY TABLE audit_logs/u);
  assert.doesNotMatch(scenarios, /foreign_key_checks|check_constraint_checks/iu);
  const gaps = readEvidenceDocument("db/mariadb/verification/0014_audit_action_catalog_gaps.md");
  for (const value of [
    "### B-01",
    "### B-02",
    "### B-03",
    "### B-04",
    "persistentRows=51",
    "65자",
    "전체 migration",
    "SELECT",
  ])
    assert.ok(gaps.includes(value), value);
});

test("evidence rejects a changed digest and falsely zero reference-row report", async () => {
  const phase = JSON.parse(read("../manifest.json")).phases.find(
    (p) => p.id === "0014_audit_action_catalog",
  );
  const readRepositoryFile = async (file) => read(`../../../${file}`);
  await verifyAuditCatalogEvidence(phase, readRepositoryFile);
  await assert.rejects(
    verifyAuditCatalogEvidence(
      { ...phase, verification: { ...phase.verification, migration_sha256: "0".repeat(64) } },
      readRepositoryFile,
    ),
    /digest drifted/u,
  );
  await assert.rejects(
    verifyAuditCatalogEvidence(
      { ...phase, verification: { ...phase.verification, persistent_row_count: 0 } },
      readRepositoryFile,
    ),
    /persistent_row_count/u,
  );
});
