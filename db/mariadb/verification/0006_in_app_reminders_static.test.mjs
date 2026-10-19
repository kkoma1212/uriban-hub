import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readEvidenceDocument } from "./evidence-document.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../migrations/0006_in_app_reminders.sql");
const trigger = read("../migrations/0006_reminder_resolution_trigger.sql");
const grants = read("../permissions/0006_reminder_trigger_grants.sql");
const gaps = readEvidenceDocument("db/mariadb/verification/0006_in_app_reminders_gaps.md");
const source = read("../../migrations/1783700008000_in-app-reminders.sql").split(
  "-- Down Migration",
)[0];
const sql = migration.replace(/^\s*--.*$/gmu, "");
const literals = (value) => [...value.matchAll(/'([^']*)'/gu)].map((match) => match[1]);

test("phase 0006 preserves source tables and composite class/resource relationships", () => {
  const tables = (input) =>
    [...input.matchAll(/^CREATE TABLE ([a-z_]+) \(/gmu)].map((match) => match[1]);
  assert.deepEqual(tables(sql), tables(source));
  assert.equal(tables(sql).length, 2);
  const foreignKeys = (input) =>
    [...input.matchAll(/FOREIGN KEY (\([^;]+?ON DELETE \w+)/gu)].map((match) =>
      match[1].replace(/\s+/gu, " "),
    );
  assert.deepEqual(foreignKeys(sql).slice(1), foreignKeys(source));
  assert.match(sql, /FOREIGN KEY \(class_id\) REFERENCES classes \(id\) ON DELETE CASCADE/u);
  assert.match(
    sql,
    /\(notice_id IS NOT NULL AND supply_id IS NULL\)\s+OR \(notice_id IS NULL AND supply_id IS NOT NULL\)/u,
  );
  assert.match(sql, /resolved_at IS NULL OR resolved_at >= created_at/u);
  assert.doesNotMatch(
    sql,
    /\b(?:GRANT|REVOKE|CREATE USER|ALTER USER|DROP TABLE|DROP DATABASE)\b/iu,
  );
});

test("audit action catalog and all 24 JSON key sets match PostgreSQL", () => {
  const pattern =
    /ADD CONSTRAINT audit_logs_action_check CHECK \(([\s\S]*?)\),\s*ADD CONSTRAINT audit_logs_json_allowlist_check/u;
  const expectedActions = literals(source.match(pattern)[1]);
  assert.equal(expectedActions.length, 32);
  assert.deepEqual(literals(sql.match(pattern)[1]), expectedActions);
  const expectedKeys = [
    ...source.matchAll(/jsonb_has_only_keys\(\s*(\w+),\s*ARRAY\[([^\]]*)\]/gu),
  ].map((match) => ({ field: match[1], keys: literals(match[2]) }));
  const actualKeys = [...sql.matchAll(/JSON_CONTAINS\(\s*'([^']+)',\s*JSON_KEYS\((\w+)\)/gu)].map(
    (match) => ({ field: match[2], keys: JSON.parse(match[1]) }),
  );
  assert.equal(expectedKeys.length, 24);
  assert.deepEqual(actualKeys, expectedKeys);
  const branches = (input) =>
    [...input.matchAll(/\bWHEN ([^\n]+) THEN/gu)].map((match) => match[1]);
  assert.deepEqual(branches(sql), branches(source));
});

test("reminder audit shape preserves privacy, required keys and effective SQL NULL semantics", () => {
  const shape = sql.slice(sql.indexOf("ADD CONSTRAINT audit_logs_reminder_created_shape_check"));
  for (const field of ["target_snapshot", "before_json", "reason"]) {
    assert.match(shape, new RegExp(`AND ${field} IS NULL`, "u"));
  }
  for (const field of [
    "reminder_batch_id",
    "content_revision",
    "current_unresolved_count",
    "created_count",
    "cooldown_suppressed_count",
  ]) {
    assert.ok(shape.includes(`'$.${field}'`), `missing required key: ${field}`);
    assert.ok(
      shape.includes(`JSON_TYPE(JSON_EXTRACT(after_json, '$.${field}'))`),
      `missing JSON type: ${field}`,
    );
  }
  assert.match(shape, /JSON_CONTAINS_PATH\(\s*after_json, 'all'/u);
  assert.match(shape, /BINARY target_type = BINARY 'notice'/u);
  assert.match(shape, /BINARY target_type = BINARY 'supply'/u);
  assert.equal((shape.match(/IN \('INTEGER', 'DOUBLE'\)/gu) ?? []).length, 3);
  assert.doesNotMatch(shape, /after_json IS NOT NULL|COALESCE/iu);
  assert.match(gaps, /permits SQL NULL `after_json`/u);
  assert.match(gaps, /not exhaustive JSONB numeric equivalence/u);
});

test("one-way trigger has only the locked-definer read and trigger envelope", () => {
  assert.match(source, /NEW\.resolved_at IS NOT DISTINCT FROM OLD\.resolved_at/u);
  assert.match(
    trigger,
    /CREATE DEFINER=`classhub_routine`@`%` TRIGGER in_app_reminder_recipients_resolution_guard/u,
  );
  assert.match(trigger, /BEFORE UPDATE ON in_app_reminder_recipients/u);
  assert.match(trigger, /NOT \(NEW\.resolved_at <=> OLD\.resolved_at\)/u);
  assert.match(trigger, /AND NOT \(OLD\.resolved_at IS NULL AND NEW\.resolved_at IS NOT NULL\)/u);
  assert.match(trigger, /MYSQL_ERRNO = 30701/u);
  assert.doesNotMatch(trigger, /SET NEW\.|INSERT INTO|DELETE FROM/u);
  const grantsSql = grants.replace(/^--.*$/gmu, "");
  assert.match(grantsSql, /GRANT SELECT \(resolved_at\)/u);
  assert.match(grantsSql, /GRANT TRIGGER/u);
  assert.equal((grantsSql.match(/TO 'classhub_routine'@'%'/gu) ?? []).length, 2);
  assert.doesNotMatch(grantsSql, /GRANT UPDATE|GRANT ALL|WITH GRANT OPTION|IDENTIFIED BY/u);
  for (const blocker of ["B-01", "B-02", "B-03", "B-04"]) {
    assert.match(gaps, new RegExp(`### ${blocker}`, "u"));
  }
});
