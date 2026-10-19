import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readEvidenceDocument } from "./evidence-document.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const migration = read("../migrations/0011_seat_draws.sql");
const sql = migration.replace(/^\s*--.*$/gmu, "");
const trigger = read("../migrations/0011_seat_draw_triggers.sql");
const grants = read("../permissions/0011_seat_draw_trigger_grants.sql");
const gaps = readEvidenceDocument("db/mariadb/verification/0011_seat_draws_gaps.md");
const source = read("../../migrations/1783700017000_seat-draws.sql").split("-- Down Migration")[0];
const literals = (value) => [...value.matchAll(/'([^']*)'/gu)].map((match) => match[1]);

test("three source tables retain same-class FKs, row domains and published uniqueness", () => {
  const tables = (input) =>
    [...input.matchAll(/^CREATE TABLE ([a-z_]+) \(/gmu)].map((match) => match[1]);
  assert.deepEqual(tables(sql), tables(source));
  assert.equal(tables(sql).length, 3);
  const foreignKeys = (input) =>
    [...input.matchAll(/FOREIGN KEY (\([^;]+?ON DELETE \w+)/gu)]
      .map((match) => match[1].replace(/\s+/gu, " "))
      .filter((value) => value.slice(0, value.indexOf(")")).includes(","));
  assert.deepEqual(foreignKeys(sql), foreignKeys(source));
  for (const name of [
    "seat_draws_dimensions_check",
    "seat_draws_counts_check",
    "seat_draws_row_version_check",
    "seat_draw_slots_position_check",
    "seat_draw_assignments_student_number_check",
  ]) {
    const pattern = new RegExp(`CONSTRAINT ${name} CHECK \\(([\\s\\S]*?)\\)`, "u");
    const canonical = (value) => value.replace(/\s+/gu, " ").trim();
    assert.equal(canonical(sql.match(pattern)[1]), canonical(source.match(pattern)[1]), name);
  }
  assert.match(
    source,
    /CREATE UNIQUE INDEX seat_draws_one_published_per_class[\s\S]*?WHERE status = 'published'/u,
  );
  assert.match(sql, /CASE WHEN BINARY status = BINARY 'published' THEN class_id ELSE NULL END/u);
  assert.match(sql, /seat_draws_one_published_per_class UNIQUE \(published_class_id\)/u);
  assert.match(sql, /CHECK \(is_usable IN \(FALSE, TRUE\)\)/u);
  assert.match(sql, /CHECK \(is_fixed IN \(FALSE, TRUE\)\)/u);
  assert.doesNotMatch(
    sql,
    /\b(?:GRANT|REVOKE|CREATE USER|ALTER USER|DROP TABLE|DROP DATABASE)\b/iu,
  );
});

test("all 38 source audit actions and 30 key lists remain phase-specific", () => {
  const actionPattern =
    /ADD CONSTRAINT audit_logs_action_check CHECK \(([\s\S]*?)\),\s*ADD CONSTRAINT audit_logs_json_allowlist_check/u;
  const actions = literals(source.match(actionPattern)[1]);
  assert.equal(actions.length, 38);
  assert.deepEqual(literals(sql.match(actionPattern)[1]), actions);
  assert.doesNotMatch(sql, /'seat_draw\.adjusted'|'team_draw\./u);
  const expectedKeys = [
    ...source.matchAll(/jsonb_has_only_keys\(\s*(\w+),\s*ARRAY\[([^\]]*)\]/gu),
  ].map((match) => ({ field: match[1], keys: literals(match[2]) }));
  const actualKeys = [...sql.matchAll(/JSON_CONTAINS\(\s*'([^']+)',\s*JSON_KEYS\((\w+)\)/gu)].map(
    (match) => ({ field: match[2], keys: JSON.parse(match[1]) }),
  );
  assert.equal(expectedKeys.length, 30);
  assert.deepEqual(actualKeys, expectedKeys);
  const branches = (input) =>
    [...input.matchAll(/\bWHEN ([^\n]+) THEN/gu)].map((match) => match[1]);
  assert.deepEqual(
    branches(sql).filter((branch) => !branch.startsWith("BINARY status")),
    branches(source),
  );
});

test("four locked guards preserve missing-parent then range/usability validation order", () => {
  const bodies = [
    ...trigger.matchAll(
      /TRIGGER (\w+)\s+BEFORE (INSERT|UPDATE) ON (\w+)[\s\S]*?BEGIN([\s\S]*?)END\/\//gu,
    ),
  ];
  assert.equal(bodies.length, 4);
  for (const [kind, table, first, second] of [
    ["slot", "seat_draw_slots", 31101, 31102],
    ["assignment", "seat_draw_assignments", 31103, 31104],
  ]) {
    for (const event of ["INSERT", "UPDATE"]) {
      const body = bodies.find(
        (match) => match[1] === `validate_seat_draw_${kind}_${event.toLowerCase()}`,
      );
      assert.equal(body[2], event);
      assert.equal(body[3], table);
      assert.ok(
        body[4].indexOf(`MYSQL_ERRNO = ${first}`) < body[4].indexOf(`MYSQL_ERRNO = ${second}`),
      );
    }
  }
  assert.equal(
    (trigger.match(/IF target_rows IS NULL OR target_columns IS NULL THEN/gu) ?? []).length,
    2,
  );
  assert.equal(
    (
      trigger.match(
        /IF NEW\.row_index > target_rows OR NEW\.column_index > target_columns THEN/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.equal((trigger.match(/IF target_usable IS NULL THEN/gu) ?? []).length, 2);
  assert.equal((trigger.match(/IF target_usable IS NOT TRUE THEN/gu) ?? []).length, 2);
  assert.equal((trigger.match(/CREATE DEFINER=`classhub_routine`@`%` TRIGGER/gu) ?? []).length, 4);
  assert.doesNotMatch(
    trigger,
    /SET NEW\.|INSERT INTO|DELETE FROM|DECLARE (?:row_count|column_count)\b/u,
  );
});

test("only thirteen owner column reads and two trigger rights are introduced", () => {
  const grantsSql = grants.replace(/^--.*$/gmu, "");
  const reads = [
    ...grantsSql.matchAll(
      /GRANT SELECT \(([^)]+)\)\s+ON classhub_mariadb_phase1_dev\.(\w+)\s+TO 'classhub_routine'@'%';/gu,
    ),
  ].map((match) => [match[2], match[1].split(",").map((column) => column.trim())]);
  assert.deepEqual(reads, [
    ["seat_draws", ["id", "class_id", "row_count", "column_count"]],
    [
      "seat_draw_slots",
      ["id", "seat_draw_id", "class_id", "row_index", "column_index", "is_usable"],
    ],
    ["seat_draw_assignments", ["seat_slot_id", "seat_draw_id", "class_id"]],
  ]);
  assert.deepEqual(
    [
      ...grantsSql.matchAll(
        /GRANT TRIGGER\s+ON classhub_mariadb_phase1_dev\.(\w+)\s+TO 'classhub_routine'@'%';/gu,
      ),
    ].map((match) => match[1]),
    ["seat_draw_slots", "seat_draw_assignments"],
  );
  assert.doesNotMatch(
    grantsSql,
    /GRANT UPDATE|GRANT ALL|WITH GRANT OPTION|IDENTIFIED BY|classhub_(?:app|operator|worker|retention)/u,
  );
  for (const blocker of ["B-01", "B-02", "B-03", "B-04"])
    assert.match(gaps, new RegExp(`### ${blocker}`, "u"));
});
