import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readEvidenceDocument } from "./evidence-document.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("../../migrations/1783700013000_neis-school-schedules.sql").split(
  "-- Down Migration",
)[0];
const sql = read("../migrations/0008_school_schedules.sql").replace(/^\s*--.*$/gmu, "");
const gaps = readEvidenceDocument("db/mariadb/verification/0008_school_schedules_gaps.md");
const literals = (text) => [...text.matchAll(/'([^']*)'/gu)].map((match) => match[1]);
const compact = (text) => text.replace(/\s+/gu, " ").trim();

test("phase 0008 retains source table, constraint and full natural-key contracts", () => {
  const tables = (text) =>
    [...text.matchAll(/^CREATE TABLE ([a-z_]+) \(/gmu)].map((match) => match[1]);
  assert.deepEqual(tables(sql), tables(source));
  const checks = (text) =>
    [...text.matchAll(/CONSTRAINT ([a-z_]+) CHECK/gu)].map((match) => match[1]).sort();
  assert.deepEqual(checks(sql), checks(source));
  const key = /CONSTRAINT school_schedule_events_natural_key UNIQUE \(([^)]+)\)/u;
  assert.equal(compact(sql.match(key)[1]), compact(source.match(key)[1]));
  assert.match(sql, /event_name LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin/u);
  assert.match(sql, /CHAR_LENGTH\(TRIM\(event_name\)\) BETWEEN 1 AND 200/u);
  assert.match(sql, /REFERENCES schools \(edu_office_code, school_code\) ON DELETE RESTRICT/u);
  assert.match(sql, /REFERENCES operators \(id\) ON DELETE RESTRICT/u);
  assert.match(sql, /deleted_count = 0/u);
  assert.match(sql, /OCTET_LENGTH\(checksum\) = 64 AND BINARY checksum REGEXP/u);
  assert.doesNotMatch(sql, /\b(?:GRANT|REVOKE|CREATE USER|ALTER USER|DROP TABLE)\b/iu);
});

test("operator audit actions and all twelve key sets match source phase 0008", () => {
  const action = /ADD CONSTRAINT operator_audit_logs_action_check CHECK \(([\s\S]*?)\),/u;
  assert.deepEqual(literals(sql.match(action)[1]), literals(source.match(action)[1]));
  const expected = [...source.matchAll(/jsonb_has_only_keys\(\s*(\w+),\s*ARRAY\[([^\]]*)\]/gu)].map(
    (match) => ({ field: match[1], keys: literals(match[2]) }),
  );
  const actual = [...sql.matchAll(/JSON_CONTAINS\(\s*'([^']+)',\s*JSON_KEYS\((\w+)\)/gu)].map(
    (match) => ({ field: match[2], keys: JSON.parse(match[1]) }),
  );
  assert.equal(expected.length, 12);
  assert.deepEqual(actual, expected);
  for (const id of ["B-01", "B-02", "B-03", "B-04"]) assert.ok(gaps.includes(`### ${id}`));
});
