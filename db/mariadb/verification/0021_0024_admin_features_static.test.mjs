import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

const read = (file) =>
  readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const strip = (sql) => sql.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*--.*$/gmu, "");
const definitions = [
  ["1783700042000_admin-signup-approval.sql", "0021_admin_signup_approvals.sql", 20],
  ["1783700043000_admin-inquiries-system-state.sql", "0022_admin_inquiries_system_state.sql", 17],
  ["1783700044000_admin-terms-management.sql", "0023_admin_terms_management.sql", 11],
  ["1783700045000_admin-account-management.sql", "0024_admin_account_management.sql", 11],
];
const phases = definitions.map(([original, ported, count]) => ({
  original: strip(read(`../../migrations/${original}`).split("-- Down Migration")[0]),
  ported: strip(read(`../migrations/${ported}`)),
  count,
}));
const tableBodies = (sql) =>
  Object.fromEntries(
    [...sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\)/gu)].map((m) => [m[1], m[2]]),
  );
const columnNames = (body) =>
  [
    ...body.matchAll(
      /^ {2}`?(\w+)`? (?:BIGINT|TEXT|LONGTEXT|VARCHAR|BYTEA|VARBINARY|TIMESTAMPTZ|DATETIME|INTEGER|INT|UUID|JSONB|JSON)\b/gmu,
    ),
  ].map((m) => m[1]);
const alterBodies = (sql) =>
  Object.fromEntries(
    [...sql.matchAll(/ALTER TABLE (\w+)\s+([\s\S]*?);/gu)].map((m) => [m[1], m[2]]),
  );

// Keep grouping and quoted literals; normalizing whitespace must not hide changed predicates.
function parenthesized(sql, opening) {
  assert.equal(sql[opening], "(");
  let depth = 1;
  let quoted = false;
  for (let end = opening + 1; end < sql.length; end++) {
    const character = sql[end];
    if (character === "'") {
      if (quoted && sql[end + 1] === "'") {
        end++;
        continue;
      }
      quoted = !quoted;
    }
    if (!quoted && character === "(") depth++;
    if (!quoted && character === ")") depth--;
    if (depth === 0) return sql.slice(opening + 1, end);
  }
  assert.fail("unterminated CHECK expression");
}

function normalizeCheck(expression) {
  const normalized = expression
    .replace(/\bnum_nonnulls\(\s*(\w+)\s*,\s*(\w+)\s*\)/giu, "nonnulls($1,$2)")
    .replace(/\((\w+) IS NOT NULL\)\s*\+\s*\((\w+) IS NOT NULL\)/gu, "nonnulls($1,$2)")
    .replace(/\(nonnulls\((\w+),(\w+)\)\)/gu, "nonnulls($1,$2)")
    .replace(/\bBINARY\s+/gu, "")
    .replace(/\bNEW\./gu, "")
    .replace(/\bbtrim\b/giu, "trim")
    .replace(/`(\w+)`/gu, "$1");
  return (normalized.match(/'(?:''|[^'])*'|[a-zA-Z_]\w*|\d+|<>|<=|>=|[^\s]/gu) ?? [])
    .map((token) => (token.startsWith("'") ? token : token.toLowerCase()))
    .join(" ");
}

const checks = (sql) =>
  [...sql.matchAll(/\bCHECK\s*\(/gu)].map((m) =>
    normalizeCheck(parenthesized(sql, m.index + m[0].lastIndexOf("("))),
  );
const namedCheck = (sql, name) => {
  const match = sql.match(new RegExp(`CONSTRAINT ${name} CHECK \\(`, "u"));
  assert.ok(match, name);
  return normalizeCheck(parenthesized(sql, match.index + match[0].lastIndexOf("(")));
};

test("six tables preserve all 59 source columns in order with only two generated helpers", () => {
  let sourceCount = 0;
  let portedCount = 0;
  const names = [];
  const helpers = {
    admin_signup_approvals: ["open_email_key_digest"],
    admin_terms_versions: ["published_document_type"],
  };
  for (const { original, ported, count } of phases) {
    const sourceTables = tableBodies(original);
    const targetTables = tableBodies(ported);
    assert.deepEqual(Object.keys(targetTables), Object.keys(sourceTables));
    let phaseCount = 0;
    for (const [table, body] of Object.entries(sourceTables)) {
      const columns = columnNames(body);
      assert.deepEqual(columnNames(targetTables[table]), [...columns, ...(helpers[table] ?? [])]);
      phaseCount += columns.length;
      portedCount += columnNames(targetTables[table]).length;
      names.push(table);
    }
    assert.equal(phaseCount, count);
    sourceCount += phaseCount;
  }
  assert.deepEqual(names, [
    "admin_signup_approvals",
    "admin_signup_approval_events",
    "admin_inquiries",
    "admin_system_state",
    "admin_terms_versions",
    "admin_operation_audit_logs",
  ]);
  assert.equal(sourceCount, 59);
  assert.equal(portedCount, 61);
  assert.equal(
    (
      phases
        .map((p) => p.ported)
        .join("\n")
        .match(/GENERATED ALWAYS AS \(/gu) ?? []
    ).length,
    2,
  );
});

test("six existing-table additions and three nullable creator changes follow source", () => {
  let addedCount = 0;
  let nullableCount = 0;
  for (const { original, ported } of phases) {
    const sourceAlters = alterBodies(original);
    const targetAlters = alterBodies(ported);
    assert.deepEqual(Object.keys(targetAlters), Object.keys(sourceAlters));
    for (const [table, body] of Object.entries(sourceAlters)) {
      const additions = (value) =>
        [...value.matchAll(/ADD COLUMN (\w+) (\w+)/gu)].map((m) => [
          m[1],
          m[2] === "TIMESTAMPTZ" ? "DATETIME" : m[2],
        ]);
      assert.deepEqual(additions(targetAlters[table]), additions(body), table);
      addedCount += additions(body).length;
      const nullable = [...body.matchAll(/ALTER COLUMN (\w+) DROP NOT NULL/gu)].map((m) => m[1]);
      assert.deepEqual(
        [...targetAlters[table].matchAll(/MODIFY COLUMN (\w+) BIGINT NULL/gu)].map((m) => m[1]),
        nullable,
        table,
      );
      nullableCount += nullable.length;
    }
  }
  assert.equal(addedCount, 6);
  assert.equal(nullableCount, 3);
});

test("all table and creator CHECK expressions match the source after bounded dialect normalization", () => {
  let count = 0;
  for (const { original, ported } of phases) {
    const sourceTables = tableBodies(original);
    const targetTables = tableBodies(ported);
    for (const [table, body] of Object.entries(sourceTables)) {
      assert.deepEqual(checks(targetTables[table]), checks(body), table);
      count += checks(body).length;
    }
    const sourceAlters = alterBodies(original);
    const targetAlters = alterBodies(ported);
    for (const [table, body] of Object.entries(sourceAlters)) {
      if (table === "class_member_status_history") continue;
      assert.deepEqual(checks(targetAlters[table]), checks(body), table);
      count += checks(body).length;
    }
  }
  assert.equal(count, 33);
  // BINARY is an intentional byte comparison, not an optional normalization at execution time.
  for (const column of ["policy_version", "title", "content"])
    assert.match(
      phases[2].ported,
      new RegExp(`BINARY ${column} = BINARY TRIM\\(${column}\\)`, "u"),
    );
  assert.match(phases[2].ported, /policy_version LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL/u);
  assert.match(phases[3].ported, /target_id LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL/u);
});

test("partial unique indexes use only source predicates and cover every valid policy-version character", () => {
  const approval = phases[0];
  assert.match(
    approval.original,
    /ON admin_signup_approvals \(email_key_digest, role\)\s+WHERE consumed_at IS NULL AND revoked_at IS NULL/u,
  );
  assert.match(
    approval.ported,
    /CASE WHEN consumed_at IS NULL AND revoked_at IS NULL THEN email_key_digest ELSE NULL END/u,
  );
  assert.match(approval.ported, /ON admin_signup_approvals \(open_email_key_digest, role\)/u);
  const terms = phases[2];
  assert.match(terms.original, /UNIQUE \(document_type, policy_version\)/u);
  assert.match(terms.ported, /ON admin_terms_versions \(document_type, policy_version\(80\)\)/u);
  assert.match(
    terms.original,
    /ON admin_terms_versions \(document_type\)\s+WHERE status = 'published'/u,
  );
  assert.match(terms.ported, /CASE WHEN status = 'published' THEN document_type ELSE NULL END/u);
  assert.match(terms.ported, /ON admin_terms_versions \(published_document_type\)/u);
});

test("history replacement expands the source actor predicate and preserves the original validation tail", () => {
  const trigger = strip(read("../migrations/0024_admin_history_trigger.sql"));
  const previous = strip(read("../migrations/0002_class_membership.sql"));
  const actorStart = trigger.indexOf("IF NOT (") + "IF NOT ".length;
  assert.ok(actorStart >= "IF NOT ".length);
  assert.equal(
    normalizeCheck(parenthesized(trigger, actorStart)),
    namedCheck(phases[3].original, "class_member_history_actor_check"),
  );
  const tail = (value) => {
    const start = value.indexOf("  SET member_role = (");
    assert.notEqual(start, -1);
    return value.slice(start).trim();
  };
  assert.equal(tail(trigger), tail(previous));
  assert.match(
    trigger,
    /CREATE OR REPLACE DEFINER = 'classhub_routine'@'%' TRIGGER class_member_status_history_validate\s+BEFORE INSERT ON class_member_status_history\s+FOR EACH ROW/u,
  );
  assert.equal((trigger.match(/\bTRIGGER\b/gu) ?? []).length, 1);
  assert.doesNotMatch(trigger, /\b(?:GRANT|REVOKE|CREATE USER|COMMIT|ROLLBACK)\b/iu);
});

test("inquiry PostgreSQL reference is the unmodified source table, with one explicit effective-FK exception", () => {
  const original = read("../../migrations/1783700043000_admin-inquiries-system-state.sql");
  const fixture = read("../../../OPERATIONS/mariadb-dev/phase22-postgres-reference.sql");
  const table = (value) => value.match(/CREATE TABLE admin_inquiries \([\s\S]*?\n\);/u)?.[0];
  assert.ok(table(original));
  assert.equal(table(fixture), table(original));
  assert.equal(
    fixture.slice(fixture.indexOf("CREATE TABLE admin_inquiries")).trim(),
    table(original),
  );
  assert.match(
    original,
    /responded_by_admin_account_id BIGINT REFERENCES admin_accounts\(id\) ON DELETE SET NULL/u,
  );
  assert.match(
    phases[1].ported,
    /FOREIGN KEY \(responded_by_admin_account_id\) REFERENCES admin_accounts \(id\) ON DELETE RESTRICT/u,
  );
  for (const [column, parent] of [
    ["requester_user_id", "users"],
    ["assigned_admin_account_id", "admin_accounts"],
  ])
    assert.match(
      phases[1].ported,
      new RegExp(
        `FOREIGN KEY \\(${column}\\) REFERENCES ${parent} \\(id\\) ON DELETE SET NULL`,
        "u",
      ),
    );
  const runner = read("../../../OPERATIONS/mariadb-dev/phase22-postgres-reference.mjs");
  assert.match(runner, /23514/u);
  assert.match(runner, /admin_inquiries_response_state_check/u);
  assert.match(runner, /baseline\(\)/u);
});

test("all 16 new foreign keys preserve referenced columns and delete actions except the respondent", () => {
  let count = 0;
  for (const { original, ported } of phases) {
    const sourceBodies = { ...tableBodies(original), ...alterBodies(original) };
    const targetBodies = { ...tableBodies(ported), ...alterBodies(ported) };
    for (const [table, body] of Object.entries(sourceBodies)) {
      const expected = [
        ...body.matchAll(
          /(\w+)\s+(?:BIGINT|UUID)(?:\s+NOT NULL)?\s+REFERENCES (\w+)\s*\((\w+)\) ON DELETE (RESTRICT|SET NULL|CASCADE)/gu,
        ),
      ].map((m) => [
        m[1],
        m[2],
        m[3],
        table === "admin_inquiries" && m[1] === "responded_by_admin_account_id" ? "RESTRICT" : m[4],
      ]);
      const actual = [
        ...targetBodies[table].matchAll(
          /FOREIGN KEY \((\w+)\) REFERENCES (\w+)\s*\((\w+)\) ON DELETE (RESTRICT|SET NULL|CASCADE)/gu,
        ),
      ].map((m) => m.slice(1));
      assert.deepEqual(actual, expected, table);
      count += expected.length;
    }
  }
  assert.equal(count, 16);
});

test("both QA services remain temporary and only the locked history owner receives one new column grant", () => {
  const compose = read("../../../compose.mariadb-phase21-24-qa.yaml");
  const mariaService = compose.split("  postgres-inquiry-qa:")[0];
  assert.match(compose, /name: classhub-mariadb-phase21-24-qa/u);
  assert.match(
    compose,
    /mariadb:11\.4\.13@sha256:611a2fcc5fa7c6ceb8644c6f74b25ede004ff6c3a6b38c8f8c23d3bbf6c26430/u,
  );
  assert.match(
    compose,
    /postgres:15\.18-alpine3\.23@sha256:3889f6e66267065437b17a404058a6220d9080c73b701edd225770f8b2d6a52c/u,
  );
  assert.match(compose, /internal: true/u);
  assert.match(compose, /\/var\/lib\/mysql:rw,noexec,nosuid,size=1073741824/u);
  assert.match(compose, /\/var\/lib\/postgresql\/data:rw,noexec,nosuid,size=268435456/u);
  assert.doesNotMatch(
    compose,
    /\n\s+ports:|\nvolumes:|network_mode:|runtime_activation|runtime_rollback/u,
  );
  assert.equal((compose.match(/com\.classhub\.runtime-activation: "false"/gu) ?? []).length, 2);
  assert.equal((mariaService.match(/\/docker-entrypoint-initdb\.d\//gu) ?? []).length, 45);
  assert.equal((mariaService.match(/\/opt\/classhub\/phase21-24\//gu) ?? []).length, 6);
  for (const line of compose.split("\n").filter((line) => /^\s+- \.\//u.test(line)))
    assert.ok(line.endsWith(":ro"), line);
  for (const { ported } of phases)
    assert.doesNotMatch(
      ported.replace(/'(?:''|[^'])*'/gu, "''"),
      /\b(?:GRANT|REVOKE|CREATE USER|CREATE TRIGGER|ON UPDATE|DROP TABLE|TRUNCATE)\b/iu,
    );
  assert.equal(
    strip(read("../permissions/0024_admin_history_trigger_grants.sql"))
      .replace(/\s+/gu, " ")
      .trim(),
    "GRANT SELECT (actor_admin_account_id) ON classhub_mariadb_phase1_dev.class_member_status_history TO 'classhub_routine'@'%';",
  );
  const runner = read("../../../OPERATIONS/mariadb-dev/verify-phase21-24-qa.mjs");
  const addition = runner.match(/const expectedAddedAcl = \[([\s\S]*?)\];/u)?.[1];
  assert.ok(addition);
  const values = [...addition.matchAll(/"((?:\\.|[^"\\])*)"/gu)].map((m) => JSON.parse(m[0]));
  assert.deepEqual(values, [
    "'classhub_routine'@'%'\tclass_member_status_history\tactor_admin_account_id\tSELECT\tNO",
  ]);
  for (const marker of [
    "no old grants removed",
    "host ports forbidden",
    "seedAndZeroRows()",
    "persistentNonseedRows: 0",
    "runtimeActivationApplied: false",
  ])
    assert.ok(runner.includes(marker), marker);
});
