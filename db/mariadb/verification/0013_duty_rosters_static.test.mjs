import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import { verifyDutyRosterEvidence } from "./0013_duty_rosters_evidence.mjs";
import { readEvidenceDocument } from "./evidence-document.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const sql = read("../migrations/0013_duty_rosters.sql").replace(/^\s*--.*$/gmu, "");
const source = read("../../migrations/1783700028000_class-duty-rosters.sql").split(
  "-- Down Migration",
)[0];
const canonical = (value) => value.replace(/\s+/gu, " ").trim();
const literals = (value) => [...value.matchAll(/'([^']*)'/gu)].map((match) => match[1]);

test("source tables preserve all composite FKs, named numeric checks and one-role assignment", () => {
  const tables = (input) => [...input.matchAll(/^CREATE TABLE ([a-z_]+) \(/gmu)].map((m) => m[1]);
  assert.deepEqual(tables(sql), tables(source));
  assert.equal(tables(sql).length, 3);
  const foreignKeys = (input) =>
    [...input.matchAll(/FOREIGN KEY (\([^;]+?ON DELETE \w+)/gu)]
      .map((m) => canonical(m[1]))
      .filter((value) => value.slice(0, value.indexOf(")")).includes(","));
  assert.deepEqual(foreignKeys(sql), foreignKeys(source));
  assert.equal(foreignKeys(sql).length, 4);
  for (const name of [
    "class_duty_roles_counts_check",
    "class_duty_roles_row_version_check",
    "duty_rosters_counts_check",
    "duty_rosters_row_version_check",
    "duty_assignments_student_number_check",
  ]) {
    const pattern = new RegExp(`CONSTRAINT ${name} CHECK \\(([\\s\\S]*?)\\)`, "u");
    assert.equal(canonical(sql.match(pattern)[1]), canonical(source.match(pattern)[1]), name);
  }
  const uniques = (input) =>
    [...input.matchAll(/CONSTRAINT (duty_assignments_\w+)\s+UNIQUE (\([^)]*\))/gu)].map((m) => [
      m[1],
      canonical(m[2]),
    ]);
  assert.deepEqual(uniques(sql), uniques(source));
  assert.equal(uniques(sql).length, 1);
  assert.doesNotMatch(
    sql,
    /\b(?:GRANT|REVOKE|CREATE USER|ALTER USER|TRIGGER|PROCEDURE|DROP TABLE|DROP DATABASE)\b/iu,
  );
});

test("both source partial uniques use nullable generated keys without changing text checks", () => {
  assert.match(
    source,
    /CREATE UNIQUE INDEX class_duty_roles_active_name_unique\s+ON class_duty_roles \(class_id, name\)\s+WHERE archived_at IS NULL/u,
  );
  assert.match(sql, /active_name VARCHAR\(20\) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin/u);
  assert.match(sql, /CASE WHEN archived_at IS NULL THEN name ELSE NULL END/u);
  assert.match(sql, /class_duty_roles_active_name_unique UNIQUE \(class_id, active_name\)/u);
  assert.match(
    source,
    /CREATE UNIQUE INDEX duty_rosters_one_published_per_class[\s\S]*?WHERE status = 'published'/u,
  );
  assert.match(sql, /CASE WHEN BINARY status = BINARY 'published' THEN class_id ELSE NULL END/u);
  assert.match(sql, /duty_rosters_one_published_per_class UNIQUE \(published_class_id\)/u);
  for (const [name, field] of [
    ["class_duty_roles_name_check", "name"],
    ["duty_rosters_title_check", "title"],
    ["duty_assignments_display_name_check", "display_name_snapshot"],
    ["duty_assignments_role_name_check", "role_name_snapshot"],
  ]) {
    const pattern = new RegExp(`CONSTRAINT ${name} CHECK \\(([\\s\\S]*?)\\n  \\)`, "u");
    const normalized = sql
      .match(pattern)[1]
      .replaceAll("BINARY ", "")
      .replaceAll("TRIM(", "btrim(")
      .replaceAll("CHAR_LENGTH(", "char_length(")
      .replaceAll(" NOT REGEXP ", " !~ ");
    assert.equal(canonical(normalized), canonical(source.match(pattern)[1]), field);
  }
  const status = /CONSTRAINT duty_rosters_status_check CHECK \(([\s\S]*?)\n {2}\)/u;
  assert.equal(
    canonical(sql.match(status)[1].replaceAll("BINARY ", "")),
    canonical(source.match(status)[1]),
  );
});

test("all 51 actions, 39 key lists and branch order match PostgreSQL including existing adjustments", () => {
  const actions = (input) =>
    literals(
      input.match(/ADD CONSTRAINT audit_logs_action_check CHECK\s*\(([\s\S]*?)\)\s*[,;]/u)[1],
    );
  assert.equal(actions(source).length, 51);
  assert.deepEqual(actions(sql), actions(source));
  const expected = [...source.matchAll(/jsonb_has_only_keys\(\s*(\w+),\s*ARRAY\[([^\]]*)\]/gu)].map(
    (m) => ({ field: m[1], keys: literals(m[2]) }),
  );
  const actual = [...sql.matchAll(/JSON_CONTAINS\(\s*'([^']+)',\s*JSON_KEYS\((\w+)\)/gu)].map(
    (m) => ({ field: m[2], keys: JSON.parse(m[1]) }),
  );
  assert.equal(expected.length, 39);
  assert.deepEqual(actual, expected);
  const branches = (input) => [...input.matchAll(/\bWHEN ([^\n]+) THEN/gu)].map((m) => m[1]);
  assert.deepEqual(
    branches(sql).filter((b) => !b.startsWith("BINARY status") && !b.startsWith("archived_at")),
    branches(source),
  );
  assert.doesNotMatch(
    sql,
    /DROP CONSTRAINT audit_logs_(?:reminder_shape|attendance_privacy)_check/u,
  );
});

test("isolated runner retains empty-row, unchanged ACL, mount and verification-only evidence guards", () => {
  const runner = read("../../../OPERATIONS/mariadb-dev/verify-phase13-qa.mjs");
  const compose = read("../../../compose.mariadb-phase13-qa.yaml");
  assert.match(compose, /internal: true/u);
  assert.match(compose, /\/var\/lib\/mysql:rw,noexec,nosuid,size=1073741824/u);
  assert.doesNotMatch(compose, /\n\s+ports:|runtime_activation|runtime_rollback/u);
  assert.equal((compose.match(/\/docker-entrypoint-initdb\.d\//gu) ?? []).length, 35);
  assert.equal((compose.match(/\/opt\/classhub\/phase13\//gu) ?? []).length, 1);
  assert.match(runner, /const expectedAddedAcl = \[\]/u);
  assert.match(runner, /zeroRows\(baseline\)/u);
  assert.match(runner, /zeroRows\(tables\)/u);
  assert.match(runner, /host ports forbidden/u);
  assert.match(runner, /args\[0\] === "--apply" \? phaseFiles\.map\([\s\S]*?\) : \[\]/u);
  assert.match(runner, /mountedSourceFiles:/u);
  const gaps = readEvidenceDocument("db/mariadb/verification/0013_duty_rosters_gaps.md");
  for (const blocker of [
    "B-01",
    "B-02",
    "B-03",
    "B-04",
    "NULLS LAST",
    "NULLS FIRST",
    "1406",
    "clock_timestamp",
  ])
    assert.ok(gaps.includes(blocker), blocker);
});

test("evidence rejects changed digest and inflated measured probe count", async () => {
  const manifest = JSON.parse(read("../manifest.json"));
  const phase = manifest.phases.find((p) => p.id === "0013_duty_rosters");
  const readRepositoryFile = async (file) => read(`../../../${file}`);
  await verifyDutyRosterEvidence(phase, readRepositoryFile);
  await assert.rejects(
    verifyDutyRosterEvidence(
      { ...phase, verification: { ...phase.verification, migration_sha256: "0".repeat(64) } },
      readRepositoryFile,
    ),
    /digest drifted/u,
  );
  await assert.rejects(
    verifyDutyRosterEvidence(
      { ...phase, verification: { ...phase.verification, targeted_rejection_probe_count: 81 } },
      readRepositoryFile,
    ),
    /targeted_rejection_probe_count/u,
  );
});
