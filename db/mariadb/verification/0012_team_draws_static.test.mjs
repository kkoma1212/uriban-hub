import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import { verifyTeamDrawEvidence } from "./0012_team_draws_evidence.mjs";
import { readEvidenceDocument } from "./evidence-document.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const sql = read("../migrations/0012_team_draws.sql").replace(/^\s*--.*$/gmu, "");
const trigger = read("../migrations/0012_team_draw_triggers.sql");
const grants = read("../permissions/0012_team_draw_trigger_grants.sql");
const gaps = readEvidenceDocument("db/mariadb/verification/0012_team_draws_gaps.md");
const up = (file) => read(`../../migrations/${file}`).split("-- Down Migration")[0];
const source = up("1783700018000_team-draws.sql");
const seatAdjustment = up("1783700019000_seat-draw-adjustment-audit.sql");
const teamAdjustment = up("1783700020000_team-draw-adjustment-audit.sql");
const literals = (value) => [...value.matchAll(/'([^']*)'/gu)].map((match) => match[1]);
const canonical = (value) => value.replace(/\s+/gu, " ").trim();

test("three source tables preserve composite FKs, counts and published uniqueness", () => {
  const tables = (input) =>
    [...input.matchAll(/^CREATE TABLE ([a-z_]+) \(/gmu)].map((match) => match[1]);
  assert.deepEqual(tables(sql), tables(source));
  assert.equal(tables(sql).length, 3);
  const foreignKeys = (input) =>
    [...input.matchAll(/FOREIGN KEY (\([^;]+?ON DELETE \w+)/gu)]
      .map((match) => canonical(match[1]))
      .filter((value) => value.slice(0, value.indexOf(")")).includes(","));
  assert.deepEqual(foreignKeys(sql), foreignKeys(source));
  assert.match(
    sql,
    /FOREIGN KEY \(team_group_id, team_draw_id, class_id\)\s+REFERENCES team_draw_groups \(id, team_draw_id, class_id\) ON DELETE RESTRICT/u,
  );
  for (const name of [
    "team_draws_counts_check",
    "team_draws_row_version_check",
    "team_draw_groups_index_check",
    "team_draw_assignments_student_number_check",
  ]) {
    const pattern = new RegExp(`CONSTRAINT ${name} CHECK \\(([\\s\\S]*?)\\)`, "u");
    assert.equal(canonical(sql.match(pattern)[1]), canonical(source.match(pattern)[1]), name);
  }
  assert.match(sql, /BINARY title = BINARY TRIM\(title\)/u);
  assert.match(sql, /BINARY display_name_snapshot = BINARY TRIM\(display_name_snapshot\)/u);
  assert.match(
    source,
    /CREATE UNIQUE INDEX team_draws_one_published_per_class[\s\S]*?WHERE status = 'published'/u,
  );
  assert.match(sql, /CASE WHEN BINARY status = BINARY 'published' THEN class_id ELSE NULL END/u);
  assert.match(sql, /team_draws_one_published_per_class UNIQUE \(published_class_id\)/u);
  const assignmentUniques = (input) =>
    [...input.matchAll(/CONSTRAINT (team_draw_assignments_\w+)\s+UNIQUE (\([^)]*\))/gu)].map(
      (match) => [match[1], canonical(match[2])],
    );
  assert.deepEqual(assignmentUniques(sql), assignmentUniques(source));
  assert.equal(assignmentUniques(sql).length, 1);
  assert.doesNotMatch(
    sql,
    /\b(?:GRANT|REVOKE|CREATE USER|ALTER USER|DROP TABLE|DROP DATABASE)\b/iu,
  );
});

test("44 final actions fold two additive follow-ups while retaining all 33 base key lists", () => {
  const actions = (input) =>
    literals(
      input.match(/ADD CONSTRAINT audit_logs_action_check CHECK\s*\(([\s\S]*?)\)\s*[,;]/u)[1],
    );
  assert.equal(actions(source).length, 42);
  assert.equal(actions(seatAdjustment).length, 43);
  assert.equal(actions(teamAdjustment).length, 44);
  assert.deepEqual(
    actions(seatAdjustment).filter((action) => !actions(source).includes(action)),
    ["seat_draw.adjusted"],
  );
  assert.deepEqual(
    actions(teamAdjustment).filter((action) => !actions(seatAdjustment).includes(action)),
    ["team_draw.adjusted"],
  );
  assert.deepEqual(actions(sql), actions(teamAdjustment));
  assert.doesNotMatch(seatAdjustment + teamAdjustment, /json_allowlist|jsonb_has_only_keys/u);
  const expectedKeys = [
    ...source.matchAll(/jsonb_has_only_keys\(\s*(\w+),\s*ARRAY\[([^\]]*)\]/gu),
  ].map((match) => ({ field: match[1], keys: literals(match[2]) }));
  const actualKeys = [...sql.matchAll(/JSON_CONTAINS\(\s*'([^']+)',\s*JSON_KEYS\((\w+)\)/gu)].map(
    (match) => ({ field: match[2], keys: JSON.parse(match[1]) }),
  );
  assert.equal(expectedKeys.length, 33);
  assert.deepEqual(actualKeys, expectedKeys);
  const branches = (input) =>
    [...input.matchAll(/\bWHEN ([^\n]+) THEN/gu)].map((match) => match[1]);
  assert.deepEqual(
    branches(sql).filter((branch) => !branch.startsWith("BINARY status")),
    branches(source),
  );
  assert.doesNotMatch(
    sql,
    /DROP CONSTRAINT audit_logs_(?:reminder_shape|attendance_privacy)_check/u,
  );
});

test("both locked group guards preserve lookup and missing-parent before upper-bound checks", () => {
  assert.match(source, /BEFORE INSERT OR UPDATE ON team_draw_groups/u);
  const bodies = [
    ...trigger.matchAll(
      /TRIGGER (\w+)\s+BEFORE (INSERT|UPDATE) ON (\w+)[\s\S]*?BEGIN([\s\S]*?)END\/\//gu,
    ),
  ];
  assert.equal(bodies.length, 2);
  for (const [index, event] of ["INSERT", "UPDATE"].entries()) {
    const body = bodies[index];
    assert.equal(body[1], `validate_team_draw_group_${event.toLowerCase()}`);
    assert.equal(body[2], event);
    assert.equal(body[3], "team_draw_groups");
    assert.match(body[4], /DECLARE target_group_count SMALLINT DEFAULT NULL/u);
    assert.match(
      body[4],
      /SELECT candidate\.group_count\s+INTO target_group_count\s+FROM team_draws AS candidate\s+WHERE candidate\.id = NEW\.team_draw_id AND candidate\.class_id = NEW\.class_id/u,
    );
    assert.match(body[4], /IF target_group_count IS NULL THEN/u);
    assert.match(body[4], /IF NEW\.group_index > target_group_count THEN/u);
    assert.ok(body[4].indexOf("MYSQL_ERRNO = 31201") >= 0);
    assert.ok(body[4].indexOf("MYSQL_ERRNO = 31202") > body[4].indexOf("MYSQL_ERRNO = 31201"));
  }
  assert.equal((trigger.match(/CREATE DEFINER=`classhub_routine`@`%` TRIGGER/gu) ?? []).length, 2);
  assert.doesNotMatch(trigger, /SET NEW\.|INSERT INTO|DELETE FROM|DECLARE group_count\b/u);
});

test("only six exact owner column reads and one group trigger right are introduced", () => {
  const grantsSql = grants.replace(/^--.*$/gmu, "");
  const reads = [
    ...grantsSql.matchAll(
      /GRANT SELECT \(([^)]+)\)\s+ON classhub_mariadb_phase1_dev\.(\w+)\s+TO 'classhub_routine'@'%';/gu,
    ),
  ].map((match) => [match[2], match[1].split(",").map((column) => column.trim())]);
  assert.deepEqual(reads, [
    ["team_draws", ["id", "class_id", "group_count"]],
    ["team_draw_groups", ["team_draw_id", "class_id", "group_index"]],
  ]);
  assert.deepEqual(
    [
      ...grantsSql.matchAll(
        /GRANT TRIGGER\s+ON classhub_mariadb_phase1_dev\.(\w+)\s+TO 'classhub_routine'@'%';/gu,
      ),
    ].map((match) => match[1]),
    ["team_draw_groups"],
  );
  assert.equal((grantsSql.match(/\bGRANT\b/gu) ?? []).length, 3);
  assert.doesNotMatch(
    grantsSql,
    /GRANT UPDATE|GRANT ALL|WITH GRANT OPTION|IDENTIFIED BY|classhub_(?:app|operator|worker|retention)/u,
  );
  for (const blocker of ["B-01", "B-02", "B-03", "B-04"])
    assert.match(gaps, new RegExp(`### ${blocker}`, "u"));
  assert.match(gaps, /NULLS LAST/u);
  assert.match(gaps, /NULLS FIRST/u);
});

test("phase evidence rejects a substituted artifact digest and inflated probe count", async () => {
  const manifest = JSON.parse(read("../manifest.json"));
  const phase = manifest.phases.find((entry) => entry.id === "0012_team_draws");
  const readRepositoryFile = async (file) => read(`../../../${file}`);
  await verifyTeamDrawEvidence(phase, readRepositoryFile);
  const changedDigest = {
    ...phase,
    verification: { ...phase.verification, trigger_sha256: "0".repeat(64) },
  };
  await assert.rejects(
    verifyTeamDrawEvidence(changedDigest, readRepositoryFile),
    /trigger_file digest drifted/u,
  );
  const inflatedCount = {
    ...phase,
    verification: {
      ...phase.verification,
      targeted_rejection_probe_count: phase.verification.targeted_rejection_probe_count + 1,
    },
  };
  await assert.rejects(
    verifyTeamDrawEvidence(inflatedCount, readRepositoryFile),
    /targeted_rejection_probe_count/u,
  );
});
