import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readEvidenceDocument } from "./evidence-document.mjs";

const migration = readFileSync(
  new URL("../migrations/0005_attendance_notifications.sql", import.meta.url),
  "utf8",
);
const source = readFileSync(
  new URL("../../migrations/1783700006000_attendance-notifications.sql", import.meta.url),
  "utf8",
).split("-- Down Migration")[0];
const gaps = readEvidenceDocument("db/mariadb/verification/0005_attendance_notifications_gaps.md");
const sql = migration.replace(/^--.*$/gmu, "");
const literals = (value) => [...value.matchAll(/'([^']+)'/gu)].map((match) => match[1]);

test("phase 0005 changes only its table, source audit checks and notice index", () => {
  assert.deepEqual(
    [...sql.matchAll(/^CREATE TABLE ([a-z_]+) \(/gmu)].map((match) => match[1]),
    ["attendance_notifications"],
  );
  assert.deepEqual(
    [...sql.matchAll(/\bDROP (?:CONSTRAINT|INDEX) ([a-z_]+)/gu)].map((match) => match[1]),
    ["notices_importance_index", "audit_logs_action_check", "audit_logs_json_allowlist_check"],
  );
  assert.doesNotMatch(sql, /\b(?:GRANT|REVOKE|INSERT|UPDATE|DELETE FROM|TRUNCATE)\b/iu);
  assert.doesNotMatch(sql, /\b(?:CREATE USER|ALTER USER|DROP TABLE|DROP DATABASE)\b/iu);
  assert.match(source, /class_id, is_important DESC, published_at DESC, id DESC/u);
  assert.match(sql, /class_id, deleted_at, is_important DESC, published_at DESC, id DESC/u);
});

test("audit actions and every object-key list match the PostgreSQL source", () => {
  const actionPattern =
    /ADD CONSTRAINT audit_logs_action_check CHECK \(([\s\S]*?)\),\s*ADD CONSTRAINT audit_logs_json_allowlist_check/u;
  assert.deepEqual(literals(sql.match(actionPattern)[1]), literals(source.match(actionPattern)[1]));
  const pgKeys = [...source.matchAll(/jsonb_has_only_keys\(\s*(\w+),\s*ARRAY\[([^\]]+)\]/gu)].map(
    (match) => ({ field: match[1], keys: literals(match[2]) }),
  );
  const mariaKeys = [...sql.matchAll(/JSON_CONTAINS\(\s*'([^']+)',\s*JSON_KEYS\((\w+)\)/gu)].map(
    (match) => ({ field: match[2], keys: JSON.parse(match[1]) }),
  );
  assert.equal(pgKeys.length, 21);
  assert.deepEqual(mariaKeys, pgKeys);
  const branches = (input) =>
    [...input.matchAll(/\bWHEN ([^\n]+) THEN/gu)].map((match) => match[1]);
  assert.deepEqual(branches(sql), branches(source));
  assert.equal((sql.match(/JSON_TYPE\(\w+\) = 'OBJECT'/gu) ?? []).length, 21);
  for (const input of [source, sql]) {
    assert.match(input, /action NOT LIKE 'attendance_notification\.%' OR reason IS NULL/u);
  }
});

test("clock precision and source lifecycle boundaries survive the type translation", () => {
  assert.match(source, /expected_time TIME\(0\) WITHOUT TIME ZONE/u);
  assert.match(sql, /expected_time TIME\(0\)/u);
  assert.match(
    sql,
    /expected_time BETWEEN CAST\('00:00:00' AS TIME\) AND CAST\('24:00:00' AS TIME\)/u,
  );
  assert.match(sql, /expected_time IS NULL OR SECOND\(expected_time\) = 0/u);
  assert.match(gaps, /Every writing session must enable `TIME_ROUND_FRACTIONAL`/u);
  for (const name of [
    "attendance_notifications_type_check",
    "attendance_notifications_expected_time_check",
    "attendance_notifications_expected_time_seconds_check",
    "attendance_notifications_status_check",
    "attendance_notifications_acknowledgement_check",
    "attendance_notifications_row_version_check",
  ]) {
    assert.ok(source.includes(name), `source constraint missing: ${name}`);
    assert.ok(sql.includes(name), `MariaDB constraint missing: ${name}`);
  }
  assert.match(
    sql,
    /BINARY status = BINARY 'acknowledged'\s+AND acknowledged_by_member_id IS NOT NULL\s+AND acknowledged_at IS NOT NULL/u,
  );
  assert.match(
    sql,
    /BINARY status IN \(BINARY 'pending', BINARY 'canceled'\)\s+AND acknowledged_by_member_id IS NULL\s+AND acknowledged_at IS NULL/u,
  );
});

test("date uniqueness and same-class foreign keys preserve the source relationships", () => {
  for (const input of [source, sql]) {
    assert.match(
      input,
      /attendance_notifications_class_member_date_unique UNIQUE \(\s*class_id, member_id, notification_date\s*\)/u,
    );
    for (const actor of ["member_id", "acknowledged_by_member_id"]) {
      assert.ok(
        new RegExp(
          `FOREIGN KEY \\(${actor}, class_id\\)\\s+REFERENCES class_members \\(id, class_id\\) ON DELETE RESTRICT`,
          "u",
        ).test(input),
        `${actor} must be a same-class restrictive reference`,
      );
    }
  }
  assert.doesNotMatch(sql, /ON (?:DELETE|UPDATE) (?:CASCADE|SET NULL)/u);
  for (const blocker of ["B-01", "B-02", "B-03", "B-04"]) {
    assert.match(gaps, new RegExp(`### ${blocker}`, "u"));
  }
});
