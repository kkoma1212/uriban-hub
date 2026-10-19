import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readEvidenceDocument } from "./evidence-document.mjs";

const verificationDirectory = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(verificationDirectory, "../migrations/0002_class_invariant_boundary.sql"),
  "utf8",
);
const gaps = readEvidenceDocument("db/mariadb/verification/0002_class_invariant_boundary_gaps.md");
const sqlWithoutComments = migration.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*--.*$/gmu, "");
const expectedProtectedRoutines = [
  "create_class_with_teacher_and_invite",
  "archive_class",
  "rotate_class_invite",
  "request_class_membership",
  "cancel_class_membership_request",
  "leave_class",
  "approve_class_member",
  "reject_class_member",
  "remove_class_member",
  "allow_class_member_rejoin",
  "delete_user_account",
  "transfer_class_teacher",
];
const expectedColumnScopedTransactions = ["update_class_details", "update_student_profile"];
const expectedMutationInventory = [
  ["ROUTINE", "create_class_with_teacher_and_invite"],
  ["ROUTINE", "archive_class"],
  ["COLUMN_SCOPED_APP_TX", "update_class_details"],
  ["ROUTINE", "rotate_class_invite"],
  ["ROUTINE", "request_class_membership"],
  ["ROUTINE", "cancel_class_membership_request"],
  ["ROUTINE", "leave_class"],
  ["ROUTINE", "approve_class_member"],
  ["COLUMN_SCOPED_APP_TX", "update_student_profile"],
  ["ROUTINE", "reject_class_member"],
  ["ROUTINE", "remove_class_member"],
  ["ROUTINE", "allow_class_member_rejoin"],
  ["ROUTINE", "delete_user_account"],
  ["ROUTINE", "transfer_class_teacher"],
];

function procedureBody(name) {
  const startPattern = new RegExp(
    `CREATE\\s+DEFINER\\s*=\\s*'classhub_routine'@'%'\\s+PROCEDURE\\s+${name}\\b`,
    "iu",
  );
  const start = sqlWithoutComments.search(startPattern);
  assert.notEqual(start, -1, `missing procedure ${name}`);
  const end = sqlWithoutComments.indexOf("END//", start);
  assert.notEqual(end, -1, `missing END delimiter for ${name}`);
  return sqlWithoutComments.slice(start, end + "END//".length);
}

const sessionBoundary = procedureBody("assert_read_committed_session");
const lockBoundary = procedureBody("lock_class_invariant_boundary");
const assertion = procedureBody("assert_class_invariants");

test("the companion defines only the three exact phase-0002 internal helpers", () => {
  const procedures = [
    ...sqlWithoutComments.matchAll(
      /CREATE\s+DEFINER\s*=\s*'classhub_routine'@'%'\s+PROCEDURE\s+([a-z0-9_]+)/giu,
    ),
  ].map((match) => match[1]);

  assert.deepEqual(procedures, [
    "assert_read_committed_session",
    "lock_class_invariant_boundary",
    "assert_class_invariants",
  ]);
  assert.equal((sqlWithoutComments.match(/SQL\s+SECURITY\s+DEFINER/giu) ?? []).length, 3);
  assert.doesNotMatch(sqlWithoutComments, /SQL\s+SECURITY\s+INVOKER/iu);
});

test("the isolation helper measures only the caller session default fail closed", () => {
  assert.match(sessionBoundary, /@@SESSION\.in_transaction\s*=\s*0/iu);
  assert.match(
    sessionBoundary,
    /@@SESSION\.transaction_isolation\s*<>\s*BINARY\s+'READ-COMMITTED'/iu,
  );
  assert.match(sessionBoundary, /MYSQL_ERRNO\s*=\s*30006/iu);
  assert.doesNotMatch(sessionBoundary, /performance_schema|INNODB_TRX|\bPROCESS\b/iu);
});

test("both invariant helpers require a caller transaction and effective isolation check", () => {
  for (const body of [lockBoundary, assertion]) {
    assert.match(body, /@@SESSION\.in_transaction\s*=\s*0/iu);
    assert.match(body, /CALL\s+assert_read_committed_session\s*\(\s*\)/iu);
    assert.match(body, /SIGNAL\s+SQLSTATE\s+'45000'/iu);
  }

  assert.doesNotMatch(
    sqlWithoutComments,
    /\b(?:START\s+TRANSACTION|COMMIT|ROLLBACK|SET\s+AUTOCOMMIT)\b/iu,
  );
});

test("the reusable boundary takes a class row lock and fails closed for a missing class", () => {
  assert.match(
    lockBoundary,
    /SELECT\s+id\s+INTO\s+locked_class_id\s+FROM\s+classes\s+WHERE\s+id\s*=\s*target_class_id\s+FOR\s+UPDATE/iu,
  );
  assert.match(lockBoundary, /MYSQL_ERRNO\s*=\s*30002/iu);
  assert.match(lockBoundary, /class_not_found\s+OR\s+locked_class_id\s+IS\s+NULL/iu);
});

test("the final assertion uses a current class read and covers user and teacher-profile state", () => {
  assert.match(
    assertion,
    /SELECT\s+id,\s*status\s+INTO\s+locked_class_id,\s*class_status[\s\S]*?FROM\s+classes[\s\S]*?FOR\s+UPDATE/iu,
  );
  assert.match(assertion, /BINARY\s+class_status\s*=\s*BINARY\s+'active'/iu);
  assert.match(assertion, /FROM\s+class_members\s+AS\s+member/iu);
  assert.match(assertion, /INNER\s+JOIN\s+users\s+AS\s+teacher_user/iu);
  assert.match(assertion, /INNER\s+JOIN\s+teacher_profiles\s+AS\s+teacher_profile/iu);
  assert.match(assertion, /teacher_user\.is_active\s*=\s*TRUE/iu);
  assert.match(assertion, /teacher_user\.deleted_at\s+IS\s+NULL/iu);
  assert.match(assertion, /teacher_profile\.status\s*=\s*BINARY\s+'active'/iu);
  assert.match(assertion, /active_teacher_count\s*<>\s*1/iu);
  assert.equal(
    (assertion.match(/FOR\s+UPDATE/giu) ?? []).length,
    1,
    "only the class serialization fence may lock during the final assertion",
  );
});

test("the final assertion rejects archived classes with current members or an open invite", () => {
  assert.match(assertion, /BINARY\s+class_status\s*=\s*BINARY\s+'archived'/iu);
  assert.match(assertion, /member\.status\s+IN\s*\(BINARY\s+'pending',\s*BINARY\s+'approved'\)/iu);
  assert.match(assertion, /current_member_count\s*<>\s*0/iu);
  assert.match(assertion, /FROM\s+class_invite_codes\s+AS\s+invite/iu);
  assert.match(assertion, /invite\.revoked_at\s+IS\s+NULL/iu);
  assert.match(assertion, /open_invite_count\s*<>\s*0/iu);
});

test("the static draft cannot be mistaken for an activated ACL boundary", () => {
  for (const pattern of [
    /\bCREATE\s+USER\b/iu,
    /\bGRANT\b/iu,
    /\bREVOKE\b/iu,
    /\bDROP\b/iu,
    /\bIDENTIFIED\s+BY\b/iu,
  ]) {
    assert.doesNotMatch(sqlWithoutComments, pattern);
  }

  assert.match(gaps, /not apply-approved or runtime-activation-ready/u);
  for (const blocker of ["G-01", "G-02", "G-03", "G-04"]) {
    assert.match(gaps, new RegExp(`### ${blocker}`, "u"));
  }
  assert.equal(expectedProtectedRoutines.length, 12);
  assert.deepEqual(expectedColumnScopedTransactions, [
    "update_class_details",
    "update_student_profile",
  ]);
  expectedMutationInventory.forEach(([boundary, routine], index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    assert.match(gaps, new RegExp(`\\|\\s+${ordinal}\\s+\\|[^\\n]+${routine}`, "u"));
    assert.match(migration, new RegExp(`--\\s+${ordinal}\\s+${boundary}\\s+${routine}`, "u"));
  });
  assert.match(gaps, /12 protected routine families/u);
  assert.match(gaps, /2 column-scoped app\s+transactions/u);
});
