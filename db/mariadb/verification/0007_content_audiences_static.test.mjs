import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readEvidenceDocument } from "./evidence-document.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../migrations/0007_content_audiences.sql");
const trigger = read("../migrations/0007_content_audience_triggers.sql");
const grants = read("../permissions/0007_content_audience_trigger_grants.sql");
const gaps = readEvidenceDocument("db/mariadb/verification/0007_content_audiences_gaps.md");
const source = read("../../migrations/1783700009000_content-audiences.sql").split(
  "-- Down Migration",
)[0];
const sql = migration.replace(/^\s*--.*$/gmu, "");
const literals = (value) => [...value.matchAll(/'([^']*)'/gu)].map((match) => match[1]);

test("phase 0007 keeps source recipient references and audience/category domains", () => {
  const tables = (input) =>
    [...input.matchAll(/^CREATE TABLE ([a-z_]+) \(/gmu)].map((match) => match[1]);
  assert.deepEqual(tables(sql), tables(source));
  assert.equal(tables(sql).length, 2);
  const foreignKeys = (input) =>
    [...input.matchAll(/FOREIGN KEY (\([^;]+?ON DELETE \w+)/gu)].map((match) =>
      match[1].replace(/\s+/gu, " "),
    );
  assert.deepEqual(foreignKeys(sql), foreignKeys(source));
  for (const constraint of [
    "notices_audience_mode_check",
    "notices_category_check",
    "supplies_audience_mode_check",
  ]) {
    const pattern = new RegExp(`CONSTRAINT ${constraint} CHECK \\(([\\s\\S]*?)\\)\\s*\\)`, "u");
    assert.deepEqual(
      literals(sql.match(pattern)[1]),
      literals(source.match(pattern)[1]),
      constraint,
    );
  }
  const supplyChanges = sql.slice(
    sql.indexOf("ALTER TABLE supplies"),
    sql.indexOf("CREATE TABLE notice_recipients"),
  );
  assert.doesNotMatch(supplyChanges, /\bcategory\b/u);
  assert.match(sql, /ON notices \(class_id, deleted_at, category, published_at DESC, id DESC\)/u);
  assert.match(sql, /ON supplies \(class_id, deleted_at, created_at DESC, id DESC\)/u);
});

test("the 24 audit key lists and branches match source without replacing other guards", () => {
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
  assert.deepEqual(
    [...sql.matchAll(/\bDROP CONSTRAINT (\w+)/gu)].map((match) => match[1]),
    ["audit_logs_json_allowlist_check"],
  );
  assert.doesNotMatch(
    sql,
    /\b(?:GRANT|REVOKE|CREATE USER|ALTER USER|DROP TABLE|DROP DATABASE)\b/iu,
  );
});

test("the immutable guards use binary null-safe comparisons and unchanged-value noops", () => {
  assert.match(source, /NEW\.audience_mode IS DISTINCT FROM OLD\.audience_mode/u);
  for (const table of ["notices", "supplies"]) {
    assert.ok(
      trigger.includes(
        `CREATE DEFINER=\`classhub_routine\`@\`%\` TRIGGER ${table}_audience_mode_immutable`,
      ),
    );
    assert.ok(trigger.includes(`BEFORE UPDATE ON ${table}`));
  }
  assert.equal(
    (
      trigger.match(/IF NOT \(BINARY NEW\.audience_mode <=> BINARY OLD\.audience_mode\) THEN/gu) ??
      []
    ).length,
    2,
  );
  assert.equal((trigger.match(/MYSQL_ERRNO = 30801/gu) ?? []).length, 2);
  assert.doesNotMatch(trigger, /SET NEW\.|INSERT INTO|DELETE FROM/u);
});

test("only exact owner read/trigger privileges are introduced", () => {
  const grantsSql = grants.replace(/^--.*$/gmu, "");
  const statements = [
    ...grantsSql.matchAll(
      /GRANT ([\s\S]*?) ON classhub_mariadb_phase1_dev\.(\w+)\s+TO '([^']+)'@'%';/gu,
    ),
  ].map((match) => ({ right: match[1].trim(), table: match[2], owner: match[3] }));
  assert.deepEqual(statements, [
    { right: "SELECT (audience_mode)", table: "notices", owner: "classhub_routine" },
    { right: "TRIGGER", table: "notices", owner: "classhub_routine" },
    { right: "SELECT (audience_mode)", table: "supplies", owner: "classhub_routine" },
    { right: "TRIGGER", table: "supplies", owner: "classhub_routine" },
  ]);
  assert.doesNotMatch(grantsSql, /GRANT UPDATE|GRANT ALL|WITH GRANT OPTION|IDENTIFIED BY/u);
  for (const blocker of ["B-01", "B-02", "B-03", "B-04"]) {
    assert.match(gaps, new RegExp(`### ${blocker}`, "u"));
  }
});
