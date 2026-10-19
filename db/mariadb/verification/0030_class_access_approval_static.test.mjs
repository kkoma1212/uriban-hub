import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import {
  buildClassAccessApprovalCandidate,
  classAccessApprovalFiles,
  classAccessApprovalSources,
  verifyClassAccessApprovalCandidate,
} from "./0030_class_access_approval_candidate.mjs";

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const migrationSql = read(classAccessApprovalFiles.migration);
const ownerSql = read(classAccessApprovalFiles.owner);

test("generated candidate preserves every original SQL byte outside five reviewed substitutions", () => {
  const candidate = verifyClassAccessApprovalCandidate(migrationSql, ownerSql, read);
  assert.deepEqual(candidate.routines, [
    "create_class_with_teacher_and_invite",
    "request_class_membership",
  ]);
  assert.equal(candidate.runtimeActivationApplied, false);
  assert.equal(Object.keys(candidate.sourceHashes).length, 5);
  assert.equal((migrationSql.match(/CREATE OR REPLACE DEFINER/gu) ?? []).length, 2);
  assert.ok(migrationSql.split("\n").length < 800);
  assert.match(
    ownerSql,
    /GRANT SELECT \(signup_approved_at\)\s+ON classhub_mariadb_phase1_dev\.users\s+TO 'classhub_routine'@'%';/u,
  );
  assert.equal((ownerSql.match(/GRANT /gu) ?? []).length, 1);
});

for (const [label, before, after] of [
  [
    "actor lock removal",
    "WHERE id = p_actor_user_id\n    FOR UPDATE;",
    "WHERE id = p_actor_user_id;",
  ],
  [
    "eligibility weakened to either missing timestamp",
    "locked_user_verified_at IS NULL AND locked_user_signup_approved_at IS NULL",
    "locked_user_verified_at IS NULL OR locked_user_signup_approved_at IS NULL",
  ],
  ["changed public error", "MYSQL_ERRNO = 30124", "MYSQL_ERRNO = 30199"],
  ["skipped final invariant", "CALL assert_class_invariants(out_class_id);", "SELECT 1;"],
  ["changed definer", "'classhub_routine'@'%'", "'classhub_app'@'%'"],
])
  test(`rejects candidate drift: ${label}`, () => {
    assert.ok(migrationSql.includes(before));
    assert.throws(() =>
      verifyClassAccessApprovalCandidate(migrationSql.replace(before, after), ownerSql, read),
    );
  });

test("rejects added runtime grants or owner DML", () => {
  for (const mutation of [
    ownerSql + "GRANT SELECT ON classhub_mariadb_phase1_dev.users TO 'classhub_app'@'%';\n",
    ownerSql.replace("GRANT SELECT (signup_approved_at)", "GRANT UPDATE (signup_approved_at)"),
  ])
    assert.throws(() => verifyClassAccessApprovalCandidate(migrationSql, mutation, read));
});

test("rejects extra routine definitions and transaction-control statements", () => {
  for (const mutation of [migrationSql + "COMMIT;\n", migrationSql + migrationSql])
    assert.throws(() => verifyClassAccessApprovalCandidate(mutation, ownerSql, read));
});

test("fails closed when a source approval anchor changes or becomes ambiguous", () => {
  for (const mutation of [
    (text) => text.replace("IF locked_user_verified_at IS NULL THEN", "IF FALSE THEN"),
    (text) => text + text,
  ])
    assert.throws(() =>
      buildClassAccessApprovalCandidate((path) =>
        path === classAccessApprovalSources[0] ? mutation(read(path)) : read(path),
      ),
    );
});

test("requires the current application approval policy and phase 0021 column", () => {
  for (const source of [classAccessApprovalSources[3], classAccessApprovalSources[4]])
    assert.throws(() =>
      buildClassAccessApprovalCandidate((path) => (path === source ? "" : read(path))),
    );
});

test("requires the original narrow owner read envelope", () => {
  assert.throws(() =>
    buildClassAccessApprovalCandidate((path) =>
      path === classAccessApprovalSources[2]
        ? read(path).replace(
            "GRANT SELECT (id, is_active, deleted_at, email_verified_at)",
            "GRANT SELECT",
          )
        : read(path),
    ),
  );
});
