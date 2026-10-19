import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readEvidenceDocument } from "./evidence-document.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("../../migrations/1783700015000_student-assessment-records.sql").split(
  "-- Down Migration",
)[0];
const sql = read("../migrations/0009_student_assessments.sql").replace(/^\s*--.*$/gmu, "");
const gaps = readEvidenceDocument("db/mariadb/verification/0009_student_assessments_gaps.md");

test("phase 0009 preserves every source check and recorded completion requirement", () => {
  const checks = (text) =>
    [...text.matchAll(/CONSTRAINT ([a-z_]+) CHECK/gu)].map((match) => match[1]);
  assert.deepEqual(checks(sql), checks(source));
  assert.equal(checks(sql).length, 13);
  const required = (text) => {
    const completion = text.slice(
      text.indexOf("CONSTRAINT student_assessment_records_completion_check"),
    );
    return [...completion.matchAll(/AND (\w+) IS NOT NULL/gu)].map((match) => match[1]);
  };
  assert.deepEqual(required(sql), required(source));
  const ranges = (text) =>
    [...text.matchAll(/BETWEEN (\d+) AND (\d+)/giu)].map((match) => match[0]);
  assert.deepEqual(ranges(sql), ranges(source));
  assert.match(sql, /FOREIGN KEY \(owner_user_id\) REFERENCES users \(id\) ON DELETE RESTRICT/u);
  assert.match(sql, /BINARY subject = BINARY TRIM\(subject\)/u);
  assert.match(sql, /BINARY title = BINARY TRIM\(title\)/u);
  assert.doesNotMatch(sql, /\b(?:GRANT|REVOKE|CREATE USER|ALTER USER|DROP TABLE)\b/iu);
});

test("phase 0009 retains UTC day intervals, leap-safe March boundaries and NULL-last sorting", () => {
  assert.match(source, /clock_timestamp\(\) \+ interval '30 days'/u);
  assert.match(sql, /DEFAULT \(UTC_TIMESTAMP\(6\) \+ INTERVAL 30 DAY\)/u);
  assert.match(source, /expires_at = recorded_at \+ interval '365 days'/u);
  assert.match(sql, /expires_at = recorded_at \+ INTERVAL 365 DAY/u);
  assert.match(sql, /assessment_date >= MAKEDATE\(academic_year, 1\) \+ INTERVAL 2 MONTH/u);
  assert.match(sql, /assessment_date < MAKEDATE\(academic_year \+ 1, 1\) \+ INTERVAL 2 MONTH/u);
  const index = /student_assessment_records_owner_list_index[\s\S]*?\(([^)]+)\)/u;
  const expected = source
    .match(index)[1]
    .replace(/ NULLS LAST/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  assert.equal(sql.match(index)[1].replace(/\s+/gu, " ").trim(), expected);
  for (const id of ["B-01", "B-02", "B-03", "B-04"]) assert.ok(gaps.includes(`### ${id}`));
  assert.match(gaps, /per-call wall clock/u);
});
