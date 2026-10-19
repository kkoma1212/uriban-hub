import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readEvidenceDocument } from "./evidence-document.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../migrations/0010_polls.sql");
const sql = migration.replace(/^\s*--.*$/gmu, "");
const source = read("../../migrations/1783700016000_class-polls.sql").split("-- Down Migration")[0];
const visibilitySource = read(
  "../../migrations/1783700021000_poll-visibility-and-results-policy.sql",
).split("-- Down Migration")[0];
const classSource = read("../migrations/0002_class_membership.sql");
const gaps = readEvidenceDocument("db/mariadb/verification/0010_polls_gaps.md");
const literals = (value) => [...value.matchAll(/'([^']*)'/gu)].map((match) => match[1]);

test("poll tables, composite relationships and source unique ballot keys are retained", () => {
  const tables = (input) =>
    [...input.matchAll(/^CREATE TABLE ([a-z_]+) \(/gmu)].map((match) => match[1]);
  assert.deepEqual(tables(sql), tables(source));
  assert.equal(tables(sql).length, 3);
  const compositeForeignKeys = (input) =>
    [...input.matchAll(/FOREIGN KEY (\([^;]+?ON DELETE \w+)/gu)]
      .map((match) => match[1].replace(/\s+/gu, " "))
      .filter((value) => value.slice(0, value.indexOf(")")).includes(","));
  assert.deepEqual(compositeForeignKeys(sql), compositeForeignKeys(source));
  for (const constraint of [
    "polls_id_class_unique",
    "poll_options_id_poll_unique",
    "poll_options_poll_position_unique",
    "poll_options_poll_label_unique",
    "poll_votes_poll_member_unique",
  ]) {
    const pattern = new RegExp(`CONSTRAINT ${constraint} UNIQUE \\(([^)]+)\\)`, "u");
    assert.equal(sql.match(pattern)[1], source.match(pattern)[1], constraint);
  }
  assert.doesNotMatch(
    sql,
    /\b(?:GRANT|REVOKE|CREATE USER|ALTER USER|CREATE TRIGGER|DROP TABLE|DROP DATABASE)\b/iu,
  );
});

test("source text boundaries and final visibility/result enum columns are folded faithfully", () => {
  for (const [name, origin] of [
    ["polls_option_count_check", source],
    ["poll_options_position_check", source],
    ["polls_row_version_check", source],
    ["polls_ballot_visibility_check", visibilitySource],
    ["polls_results_policy_check", visibilitySource],
  ]) {
    const pattern = new RegExp(`CONSTRAINT ${name} CHECK \\(([\\s\\S]*?)\\)(?:\\s*\\))?`, "u");
    assert.deepEqual(literals(sql.match(pattern)[1]), literals(origin.match(pattern)[1]), name);
    const canonical = (value) =>
      value
        .replace(/\bBINARY\s+/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
    assert.equal(canonical(sql.match(pattern)[1]), canonical(origin.match(pattern)[1]), name);
  }
  assert.match(
    sql,
    /closes_at >= created_at \+ INTERVAL 5 MINUTE\s+AND closes_at <= created_at \+ INTERVAL 30 DAY/u,
  );
  assert.match(sql, /ballot_visibility VARCHAR\(24\)[^\n]*DEFAULT 'private'/u);
  assert.match(sql, /results_policy VARCHAR\(24\)[^\n]*DEFAULT 'after_vote'/u);
  for (const field of ["title", "description", "label"]) {
    assert.ok(sql.includes(`BINARY ${field} = BINARY TRIM(${field})`));
  }
  assert.match(sql, /title NOT REGEXP '\[\[:cntrl:\]\]'/u);
  assert.match(sql, /label NOT REGEXP '\[\[:cntrl:\]\]'/u);
  const description = sql.slice(
    sql.indexOf("CONSTRAINT polls_description_check"),
    sql.indexOf("CONSTRAINT polls_option_count_check"),
  );
  assert.doesNotMatch(description, /cntrl/u);
});

test("normalized labels reuse measured whitespace/folding with no-pad identity and 80 characters", () => {
  assert.match(source, /lower\(regexp_replace\(btrim\(label\), '\[\[:space:\]\]\+'/u);
  const expression = /GENERATED ALWAYS AS \(([\s\S]*?)\) STORED/u;
  const classExpression = classSource
    .slice(classSource.indexOf("name_normalized VARCHAR(40)"))
    .match(expression)[1];
  const labelExpression = sql
    .slice(sql.indexOf("label_normalized VARCHAR(80)"))
    .match(expression)[1];
  assert.equal(labelExpression, classExpression.replace("TRIM(name)", "TRIM(label)"));
  assert.match(
    sql,
    /label_normalized VARCHAR\(80\) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin/u,
  );
  assert.match(sql, /poll_options_poll_label_unique UNIQUE \(poll_id, label_normalized\)/u);
  assert.match(gaps, /significant ASCII trailing space/u);
  assert.match(gaps, /`NO_BACKSLASH_ESCAPES` must be absent/u);
});

test("all 34 audit actions and 27 key lists match the PostgreSQL source", () => {
  const actionPattern =
    /ADD CONSTRAINT audit_logs_action_check CHECK \(([\s\S]*?)\),\s*ADD CONSTRAINT audit_logs_json_allowlist_check/u;
  const expectedActions = literals(source.match(actionPattern)[1]);
  assert.equal(expectedActions.length, 34);
  assert.deepEqual(literals(sql.match(actionPattern)[1]), expectedActions);
  const expectedKeys = [
    ...source.matchAll(/jsonb_has_only_keys\(\s*(\w+),\s*ARRAY\[([^\]]*)\]/gu),
  ].map((match) => ({ field: match[1], keys: literals(match[2]) }));
  const actualKeys = [...sql.matchAll(/JSON_CONTAINS\(\s*'([^']+)',\s*JSON_KEYS\((\w+)\)/gu)].map(
    (match) => ({ field: match[2], keys: JSON.parse(match[1]) }),
  );
  assert.equal(expectedKeys.length, 27);
  assert.deepEqual(actualKeys, expectedKeys);
  const branches = (input) =>
    [...input.matchAll(/\bWHEN ([^\n]+) THEN/gu)].map((match) => match[1]);
  assert.deepEqual(branches(sql), branches(source));
  assert.deepEqual(
    [...sql.matchAll(/\bDROP CONSTRAINT (\w+)/gu)].map((match) => match[1]),
    ["audit_logs_action_check", "audit_logs_json_allowlist_check"],
  );
  for (const blocker of ["B-01", "B-02", "B-03", "B-04"])
    assert.match(gaps, new RegExp(`### ${blocker}`, "u"));
});
