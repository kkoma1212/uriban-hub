import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const strip = (sql) =>
  sql.replace(/'(?:''|\\.|[^'])*'|\/\*[\s\S]*?\*\/|--[^\n]*/gu, (part) =>
    part.startsWith("'") ? part : "",
  );
const source = (file) => strip(read(`../../migrations/${file}`).split("-- Down Migration")[0]);
const migrated = (file) => strip(read(`../migrations/${file}`));
const schoolSource = source("1783700014000_neis-school-details.sql");
const reminderSource = source("1783700023000_temporary-password-reminder.sql");
const passwordSource = source("1783700040000_password-input-version.sql");
const transferSource = source("1783700039000_operator-suspended-class-transfer.sql");
const actorSource = source("1783700027000_retention-job-visibility.sql");
const authSource = source("1783700041000_admin-auth-foundation.sql");
const identity = migrated("0025_identity_school_followups.sql");
const transfer = migrated("0026_checked_teacher_transfer.sql");
const actor = migrated("0027_retention_system_actor.sql");
const foundation = migrated("0002_class_membership.sql");
const legacyTransfer = migrated("0002_class_transition_operator_routine.sql");
const auth = migrated("0020_admin_auth.sql");
const literals = (value) => [...value.matchAll(/'((?:''|\\.|[^'])*)'/gu)].map((match) => match[1]);
const normalize = (value) =>
  (value.match(/'(?:''|\\.|[^'])*'|@@?[\w.]+|[a-zA-Z_][\w.]*|\d+|!~|<>|<=|>=|[^ \t\r\n]/gu) ?? [])
    .filter((token) => token.toUpperCase() !== "BINARY")
    .map((token) => {
      if (token.startsWith("'")) return token;
      if (token === "!~") return "not regexp";
      if (token === "~") return "regexp";
      return token.toLowerCase() === "btrim" ? "trim" : token.toLowerCase();
    })
    .join(" ");

// Preserve grouping and quoted literals; deleting parentheses can hide changed actor predicates.
function parenthesized(sql, opening) {
  assert.equal(sql[opening], "(");
  let depth = 1;
  let quoted = false;
  for (let end = opening + 1; end < sql.length; end++) {
    const character = sql[end];
    if (quoted && character === "\\") {
      end++;
      continue;
    }
    if (character === "'") {
      if (quoted && sql[end + 1] === "'") {
        end++;
        continue;
      }
      quoted = !quoted;
    }
    if (!quoted && character === "(") depth++;
    if (!quoted && character === ")") depth--;
    if (!depth) return sql.slice(opening + 1, end);
  }
  assert.fail("unterminated CHECK");
}
function namedCheck(sql, name) {
  const pattern = new RegExp(`CONSTRAINT\\s+${name}\\s+CHECK\\s*\\(`, "gu");
  const matches = [...sql.matchAll(pattern)];
  assert.equal(matches.length, 1, `exactly one definition of ${name}`);
  const match = matches[0];
  return parenthesized(sql, match.index + match[0].lastIndexOf("("));
}
const namesAfter = (sql, expression) => [...sql.matchAll(expression)].map((match) => match[1]);

test("0025 covers six source columns with only one new column and one net new CHECK", () => {
  const schoolColumns = ["road_address", "road_address_detail", "phone_number", "homepage_url"];
  assert.deepEqual(namesAfter(schoolSource, /ADD COLUMN (\w+) TEXT/gu), schoolColumns);
  assert.match(reminderSource, /ADD COLUMN temporary_password_reminder_sent_at TIMESTAMPTZ;/u);
  assert.match(
    passwordSource,
    /ADD COLUMN password_input_version TEXT NOT NULL DEFAULT 'legacy_exact_v0'/u,
  );
  for (const [column, length] of [
    ["road_address", 200],
    ["road_address_detail", 200],
    ["phone_number", 50],
    ["homepage_url", 500],
  ])
    assert.match(foundation, new RegExp(`\\b${column} VARCHAR\\(${length}\\)`, "u"));
  assert.match(foundation, /temporary_password_reminder_sent_at DATETIME\(6\),/u);
  assert.deepEqual(namesAfter(identity, /ALTER TABLE (\w+)/gu), ["schools", "users"]);
  assert.deepEqual(namesAfter(identity, /ADD COLUMN (\w+)/gu), ["password_input_version"]);
  assert.deepEqual(
    namesAfter(identity, /MODIFY COLUMN (\w+) LONGTEXT COLLATE utf8mb4_nopad_bin NULL/gu),
    schoolColumns,
  );
  const oldChecks = schoolColumns.map((column) => `schools_${column}_check`);
  assert.deepEqual(namesAfter(identity, /DROP CONSTRAINT (\w+)/gu), oldChecks);
  assert.deepEqual(namesAfter(identity, /ADD CONSTRAINT (\w+)/gu), [
    ...oldChecks,
    "users_password_input_version_check",
  ]);
  assert.doesNotMatch(
    identity,
    /ALTER TABLE teacher_profiles|DROP COLUMN|ADD COLUMN (?:road_|phone_|homepage_)/u,
  );
});

test("0025 preserves address and telephone CHECKs, with MariaDB global replacement", () => {
  for (const name of ["schools_road_address_check", "schools_road_address_detail_check"]) {
    assert.equal(
      normalize(namedCheck(identity, name)),
      normalize(namedCheck(schoolSource, name)),
      name,
    );
  }
  const original = namedCheck(schoolSource, "schools_phone_number_check");
  assert.equal((original.match(/,\s*'g'\s*\)/gu) ?? []).length, 1);
  const globalReplacement = original.replace(/,\s*'g'(?=\s*\))/u, "");
  assert.equal(
    normalize(namedCheck(identity, "schools_phone_number_check")),
    normalize(globalReplacement),
  );
  assert.match(
    read("../migrations/0025_identity_school_followups.sql"),
    /MariaDB REGEXP_REPLACE replaces every match; PostgreSQL requires its fourth 'g' argument/u,
  );
});

test("0025 URL translation documents exact anchors, measured source whitespace and TEXT NUL", () => {
  const original = namedCheck(schoolSource, "schools_homepage_url_check");
  const replacement = namedCheck(identity, "schools_homepage_url_check");
  const sourcePattern = "^https?://[^[:space:]]+$";
  assert.ok(literals(original).includes(sourcePattern));
  const measuredSpace = literals(foundation).find(
    (value) =>
      value.startsWith("[") && value.includes(String.raw`\\x{0009}`) && value.endsWith("]+"),
  );
  assert.ok(measuredSpace, "the existing measured PostgreSQL whitespace set is present");
  const pattern =
    String.raw`(?-i)\\Ahttps?://[^\\x{0000}` + measuredSpace.slice(1, -2) + String.raw`]+\\z`;
  assert.ok(literals(replacement).includes(pattern));
  assert.equal(
    normalize(replacement.replace(`'${pattern}'`, "'source_url_pattern'")),
    normalize(original.replace(`'${sourcePattern}'`, "'source_url_pattern'")),
  );
  // Deliberately retain the source's loose non-space suffix; no hostname or general-control rule.
  assert.doesNotMatch(replacement, /cntrl|host|INET|LOCATE/iu);
  const documented = read("../migrations/0025_identity_school_followups.sql");
  assert.match(documented, /measured PostgreSQL en_US\.utf8 whitespace set/u);
  assert.match(documented, /NUL is also excluded because PostgreSQL TEXT cannot store it/u);
  assert.match(
    documented,
    /permits non-space control characters and does not validate a hostname/u,
  );
});

test("0025 keeps legacy password defaults and the existing unconstrained reminder time", () => {
  assert.match(
    identity,
    /ADD COLUMN password_input_version LONGTEXT COLLATE utf8mb4_nopad_bin\s+NOT NULL DEFAULT 'legacy_exact_v0'/u,
  );
  assert.equal(
    normalize(namedCheck(identity, "users_password_input_version_check")),
    normalize(namedCheck(passwordSource, "users_password_input_version_check")),
  );
  assert.deepEqual(literals(namedCheck(identity, "users_password_input_version_check")), [
    "legacy_exact_v0",
    "nfc_v1",
  ]);
  assert.doesNotMatch(reminderSource, /\bCHECK\b/u);
  assert.doesNotMatch(identity, /temporary_password_reminder_sent_at/u);
  assert.equal((foundation.match(/temporary_password_reminder_sent_at/gmu) ?? []).length, 1);
  assert.match(
    read("../migrations/0025_identity_school_followups.sql"),
    /nullable DATETIME\(6\) without a default or time-order CHECK/u,
  );
});

const versionGuard = `
  IF BINARY locked_class_status = BINARY 'suspended' THEN
    IF p_expected_row_version IS NULL THEN
      SIGNAL SQLSTATE '22023' SET MYSQL_ERRNO = 30514,
        MESSAGE_TEXT = 'suspended teacher transfer requires the expected row version';
    END IF;
    IF locked_class_version <> p_expected_row_version THEN
      SIGNAL SQLSTATE '40001' SET MYSQL_ERRNO = 30515,
        MESSAGE_TEXT = 'suspended teacher transfer row version changed';
    END IF;
  END IF;`.trim();

test("0026 adds only its checked name, token input, locked version and suspended guard", () => {
  let equivalent = transfer;
  for (const [before, after] of [
    ["PROCEDURE transfer_class_teacher_checked(", "PROCEDURE transfer_class_teacher("],
    ["  IN p_expected_row_version BIGINT,\n", ""],
    ["  DECLARE locked_class_version BIGINT;\n", ""],
    [
      "SELECT status, row_version INTO locked_class_status, locked_class_version\n  FROM classes WHERE id = p_class_id FOR UPDATE;",
      "SELECT status INTO locked_class_status FROM classes WHERE id = p_class_id FOR UPDATE;",
    ],
    [versionGuard, ""],
  ]) {
    assert.equal(equivalent.split(before).length - 1, 1, `one approved transfer change: ${before}`);
    equivalent = equivalent.replace(before, after);
  }
  // Tokenization removes only layout whitespace; BINARY, quoted spacing and grouping stay exact.
  const exactTokens = (sql) => sql.match(/'(?:''|\\.|[^'])*'|[a-zA-Z_][\w.]*|\d+|<>|<=|>=|[^\s]/gu);
  assert.deepEqual(exactTokens(equivalent), exactTokens(legacyTransfer));
});

test("0026 enforces source0039's suspended-only token before any membership write", () => {
  assert.match(transferSource, /IF p_class_id IS NULL OR p_expected_row_version IS NULL THEN/u);
  assert.match(transferSource, /IF current_status <> 'suspended' THEN/u);
  assert.match(
    transferSource,
    /IF current_row_version <> p_expected_row_version THEN[\s\S]*?ERRCODE = '40001'/u,
  );
  assert.match(transferSource, /AND target\.row_version = p_expected_row_version/u);
  assert.ok(transfer.includes(versionGuard));
  assert.ok(
    transfer.indexOf(versionGuard) >
      transfer.indexOf("FROM classes WHERE id = p_class_id FOR UPDATE;"),
  );
  assert.ok(transfer.indexOf(versionGuard) < transfer.indexOf("UPDATE class_members"));
  assert.equal((transfer.match(/\bp_expected_row_version\b/gu) ?? []).length, 3);
  assert.match(
    transfer,
    /IF BINARY locked_class_status NOT IN \(BINARY 'active', BINARY 'suspended'\)/u,
  );
  const cli = read("../../../apps/operator-cli/src/class-transfer.ts");
  assert.match(
    cli,
    /const reactivated = targetClass\.status === "suspended";\s+if \(reactivated\)/u,
  );
  assert.match(cli, /reactivate_suspended_class_for_teacher_transfer\(/u);
});

test("0026 retains the MariaDB user-class lock order and the caller transaction boundary", () => {
  // This is the existing MariaDB invariant boundary, not a claim about PostgreSQL CLI lock order.
  const order = [
    "IF @@SESSION.in_transaction = 0 THEN",
    "CALL assert_read_committed_session();",
    "FROM users FORCE INDEX (PRIMARY)",
    "CLOSE user_cursor;",
    "CALL lock_class_invariant_boundary(p_class_id);",
    "FROM classes WHERE id = p_class_id FOR UPDATE;",
    "DECLARE member_cursor CURSOR FOR",
    "FROM teacher_profiles",
    "UPDATE class_members",
    "UPDATE classes",
    "CALL assert_class_invariants(p_class_id);",
  ].map((marker) => {
    const offset = transfer.indexOf(marker);
    assert.ok(offset >= 0, marker);
    return offset;
  });
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.match(
    transfer,
    /WHERE id IN \(p_outgoing_user_id, p_incoming_user_id\)\s+ORDER BY id\s+FOR UPDATE/u,
  );
  assert.match(
    transfer,
    /CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE transfer_class_teacher_checked/u,
  );
  assert.match(transfer, /\)\s+SQL SECURITY DEFINER\s+MODIFIES SQL DATA/u);
  assert.match(transfer, /MYSQL_ERRNO = 30001/u);
  assert.doesNotMatch(transfer, /\b(?:COMMIT|ROLLBACK|START TRANSACTION|SET AUTOCOMMIT)\b/iu);
  assert.doesNotMatch(transfer, /INSERT INTO (?:audit_logs|operator_audit_logs)/u);
  assert.equal((transfer.match(/INSERT INTO class_member_status_history/gu) ?? []).length, 2);
});

test("0026 changes only the six source reactivation fields while retaining its clock boundary", () => {
  const fields = (sql, pattern) => {
    const body = pattern.exec(sql)?.[1];
    assert.ok(body, "one class reactivation UPDATE");
    return namesAfter(body, /\b(\w+)\s*=/gu).sort();
  };
  assert.deepEqual(
    fields(transfer, /UPDATE classes\s+SET ([\s\S]*?)\s+WHERE id = p_class_id/u),
    fields(transferSource, /UPDATE public\.classes AS target\s+SET ([\s\S]*?)\s+WHERE target\.id/u),
  );
  assert.match(
    transfer,
    /WHERE id = p_class_id AND BINARY status = BINARY 'suspended';\s+IF ROW_COUNT\(\) <> 1 THEN/u,
  );
  assert.match(transferSource, /updated_at = transaction_timestamp\(\)/u);
  assert.match(transfer, /SET out_occurred_at = UTC_TIMESTAMP\(6\);/u);
  // A locked comparison precedes writes; this is not standalone-function, clock or rollback parity.
  assert.match(
    read("../migrations/0026_checked_teacher_transfer.sql"),
    /Actor authentication, audit writes, full rollback and runtime activation remain separate gates/u,
  );
});

test("0027 preserves the exact source operator/system predicate and its five system actions", () => {
  const original = namedCheck(actorSource, "operator_audit_logs_actor_check");
  const replacement = namedCheck(actor, "operator_audit_logs_actor_check");
  assert.equal(normalize(replacement), normalize(original));
  const systemActions = literals(replacement).filter((value) => value.includes("."));
  assert.deepEqual(systemActions, [
    "operator.bootstrapped",
    "operator.credential_recovered",
    "retention.executed",
    "reminder.executed",
    "job.failed",
  ]);
  assert.deepEqual(namesAfter(actor, /ALTER TABLE (\w+)/gu), ["operator_audit_logs"]);
  assert.deepEqual(namesAfter(actor, /DROP CONSTRAINT (\w+)/gu), [
    "operator_audit_logs_actor_check",
  ]);
  assert.deepEqual(namesAfter(actor, /ADD CONSTRAINT (\w+)/gu), [
    "operator_audit_logs_actor_check",
  ]);
});

test("0027 inherits source0041's final 22 actions without redefinition", () => {
  const actionName = "operator_audit_logs_action_check";
  const inherited = literals(namedCheck(auth, actionName)).sort();
  assert.equal(inherited.length, 22);
  assert.equal(new Set(inherited).size, 22);
  assert.deepEqual(inherited, literals(namedCheck(authSource, actionName)).sort());
  for (const previous of literals(namedCheck(actorSource, actionName)))
    assert.ok(inherited.includes(previous));
  assert.ok(inherited.includes("admin.created"));
  assert.ok(inherited.includes("holiday.imported"));
  assert.doesNotMatch(
    actor,
    /operator_audit_logs_(?:action|json_allowlist)_check|before_json|after_json/u,
  );
});

test("0027 retains all inherited source JSON branches, object guards and before/after key sets", () => {
  const original = namedCheck(authSource, "operator_audit_logs_json_allowlist_check");
  const inherited = namedCheck(auth, "operator_audit_logs_json_allowlist_check");
  const sourceCalls = [
    ...original.matchAll(
      /jsonb_has_only_keys\(\s*(before_json|after_json),\s*ARRAY\[([\s\S]*?)\]\s*\)/gu,
    ),
  ];
  assert.equal(sourceCalls.length, 18);
  let translated = original;
  for (const [call, column, values] of sourceCalls) {
    const keys = JSON.stringify(literals(values));
    translated = translated.replace(
      call,
      `(${column} IS NULL OR (
      JSON_TYPE(${column}) = 'OBJECT'
      AND JSON_CONTAINS('${keys}', JSON_KEYS(${column})) = 1
    ))`,
    );
  }
  assert.equal(normalize(inherited), normalize(translated));
  assert.equal((inherited.match(/JSON_TYPE\(/gu) ?? []).length, 18);
  assert.match(inherited, /WHEN action = 'reminder\.executed' THEN/u);
  assert.match(inherited, /WHEN action = 'job\.failed' THEN/u);
  assert.doesNotMatch(actor, /JSON_TYPE|JSON_CONTAINS|jsonb_has_only_keys/u);
});

test("0025..0027 definitions contain no account or runtime permission activation", () => {
  for (const sql of [identity, transfer, actor]) {
    assert.doesNotMatch(
      sql,
      /\b(?:GRANT|REVOKE|CREATE USER|ALTER USER|CREATE ROLE|DROP USER|CREATE TABLE|DROP TABLE|TRUNCATE)\b/iu,
    );
    assert.match(sql, /SET time_zone = '\+00:00';/u);
    assert.match(sql, /SET NAMES utf8mb4 COLLATE utf8mb4_bin;/u);
  }
});
import { URL } from "node:url";
