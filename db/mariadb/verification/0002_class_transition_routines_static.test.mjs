import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const verificationDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(verificationDirectory, "../migrations");
const permissionsDirectory = resolve(verificationDirectory, "../permissions");

const routineFileNames = [
  "0002_class_transition_lifecycle_routines.sql",
  "0002_class_transition_membership_routines.sql",
  "0002_class_transition_member_admin_routines.sql",
  "0002_class_transition_account_routine.sql",
  "0002_class_transition_operator_routine.sql",
];
const expectedAppRoutines = [
  "allow_class_member_rejoin",
  "approve_class_member",
  "archive_class",
  "cancel_class_membership_request",
  "create_class_with_teacher_and_invite",
  "delete_user_account",
  "leave_class",
  "reject_class_member",
  "remove_class_member",
  "request_class_membership",
  "rotate_class_invite",
];
const expectedRoutines = [...expectedAppRoutines, "transfer_class_teacher"].sort();

function readMigration(name) {
  return readFileSync(resolve(migrationsDirectory, name), "utf8");
}

function readPermission(name) {
  return readFileSync(resolve(permissionsDirectory, name), "utf8");
}

function withoutComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*--.*$/gmu, "");
}

const routineFiles = Object.fromEntries(
  routineFileNames.map((name) => [name, readMigration(name)]),
);
const routineSql = Object.values(routineFiles).join("\n");
const executableRoutineSql = withoutComments(routineSql);
const definerDml = withoutComments(readPermission("0002_class_membership_definer_dml_grants.sql"));
const helperGrants = withoutComments(readPermission("0002_class_membership_helper_grants.sql"));
const transitionOwnerExecuteGrants = withoutComments(
  readPermission("0002_class_membership_transition_owner_execute_grants.sql"),
);
const runtimeActivation = withoutComments(
  readPermission("0002_class_membership_runtime_activation.sql"),
);
const runtimeRollback = withoutComments(
  readPermission("0002_class_membership_runtime_activation_rollback.sql"),
);
const invariantBoundary = withoutComments(readMigration("0002_class_invariant_boundary.sql"));

function procedureNames(sql) {
  return [
    ...sql.matchAll(
      /CREATE\s+DEFINER\s*=\s*'classhub_routine'@'%'\s+PROCEDURE\s+([a-z0-9_]+)\s*\(/giu,
    ),
  ].map((match) => match[1]);
}

function procedureBody(name) {
  const match = new RegExp(
    `CREATE\\s+DEFINER\\s*=\\s*'classhub_routine'@'%'\\s+PROCEDURE\\s+${name}\\b([\\s\\S]*?)END//`,
    "iu",
  ).exec(executableRoutineSql);
  assert.notEqual(match, null, `missing routine body: ${name}`);
  return match[0];
}

test("five bounded files define exactly the twelve approved option-A routines", () => {
  for (const [name, sql] of Object.entries(routineFiles)) {
    const lineCount = sql.split(/\r?\n/u).length;
    assert.ok(lineCount <= 800, `${name} exceeds the reviewed 800-line split: ${lineCount}`);
    assert.match(
      sql,
      /ISOLATED SYNTHETIC QA ONLY\. DO NOT APPLY TO A SHARED OR PRODUCTION DATABASE\./u,
    );
  }
  assert.deepEqual(procedureNames(executableRoutineSql).sort(), expectedRoutines);
  assert.equal(new Set(procedureNames(executableRoutineSql)).size, 12);
});

test("class creation precheck uses the same measured normalization as the generated key", () => {
  const createBody = procedureBody("create_class_with_teacher_and_invite");
  const postgresSpacePattern = String.raw`'[\\x{0009}-\\x{000D}\\x{0020}\\x{0085}\\x{2000}-\\x{2006}\\x{2008}-\\x{200A}\\x{2028}-\\x{2029}\\x{205F}\\x{3000}]+'`;
  assert.ok(createBody.includes(postgresSpacePattern));
  assert.equal((createBody.match(/COLLATE\s+utf8mb4_uca1400_as_ci/giu) ?? []).length, 1);
  assert.match(
    createBody,
    /BINARY\s+name_normalized\s*=\s*BINARY\s+LOWER\([\s\S]{0,700}COLLATE\s+utf8mb4_uca1400_as_ci/iu,
  );
});

test("every routine has the fixed definer envelope, DB timestamp output, and no transaction escape", () => {
  for (const name of expectedRoutines) {
    const body = procedureBody(name);
    assert.match(body, /SQL\s+SECURITY\s+DEFINER/iu, name);
    assert.match(body, /MODIFIES\s+SQL\s+DATA/iu, name);
    assert.match(body, /OUT\s+out_occurred_at\s+DATETIME\(6\)/iu, name);
    assert.equal(
      (body.match(/SET\s+out_occurred_at\s*=\s*UTC_TIMESTAMP\(6\)/giu) ?? []).length,
      1,
      `${name}: timestamp capture count`,
    );
    assert.match(body, /CALL\s+assert_class_invariants\s*\(/iu, name);
    const transactionGuardIndex = body.search(/@@SESSION\.in_transaction\s*=\s*0/iu);
    const isolationGuardIndex = body.search(/CALL\s+assert_read_committed_session\s*\(\s*\)/iu);
    const firstProtectedWrite = body.search(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:classes|class_members|class_member_status_history|class_invite_codes|users)\b/iu,
    );
    assert.ok(transactionGuardIndex >= 0, `${name}: missing caller transaction guard`);
    assert.ok(
      isolationGuardIndex > transactionGuardIndex,
      `${name}: isolation guard must follow the transaction guard`,
    );
    assert.ok(
      firstProtectedWrite > isolationGuardIndex,
      `${name}: protected write precedes isolation guard`,
    );
    assert.doesNotMatch(body, /\bIN\s+p_occurred_at\b/iu, name);
    assert.doesNotMatch(
      body,
      /\b(?:START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|SET\s+autocommit|PREPARE|EXECUTE\s+IMMEDIATE|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/iu,
      name,
    );
    assert.doesNotMatch(
      body,
      /\b(?:audit_logs|operator_audit_logs|security_audit_logs|api_idempotency_keys|sessions|email_verification_tokens|password_reset_tokens|user_consents|notice_reads|supply_checks|student_assessment_records|poll_votes|seat_draw_assignments|team_draw_assignments|duty_assignments|election_participants|election_candidates)\b/iu,
      name,
    );
  }
});

test("existing-class routines lock users before class and before a protected write", () => {
  const protectedWrite =
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:classes|class_members|class_member_status_history|class_invite_codes|users)\b/iu;
  for (const name of expectedRoutines.filter(
    (candidate) => candidate !== "create_class_with_teacher_and_invite",
  )) {
    const body = procedureBody(name);
    const transactionGuardIndex = body.search(/@@SESSION\.in_transaction\s*=\s*0/iu);
    const isolationGuardIndex = body.search(/CALL\s+assert_read_committed_session\s*\(\s*\)/iu);
    const userLockIndex = body.search(/FROM\s+users[\s\S]*?FOR\s+UPDATE/iu);
    const lockIndex = body.search(/CALL\s+lock_class_invariant_boundary\s*\(/iu);
    const writeIndex = body.search(protectedWrite);
    assert.ok(transactionGuardIndex >= 0, `${name}: missing caller transaction guard`);
    assert.ok(
      isolationGuardIndex > transactionGuardIndex && userLockIndex > isolationGuardIndex,
      `${name}: user lock precedes a transaction/isolation guard`,
    );
    assert.ok(lockIndex > userLockIndex, `${name}: class lock precedes governing user lock`);
    assert.ok(lockIndex >= 0, `${name}: missing class lock`);
    assert.ok(writeIndex > lockIndex, `${name}: protected write precedes class lock`);
  }

  const createBody = procedureBody("create_class_with_teacher_and_invite");
  const classInsert = createBody.search(/INSERT\s+INTO\s+classes\b/iu);
  const isolationGuard = createBody.search(/CALL\s+assert_read_committed_session\s*\(\s*\)/iu);
  const newClassLock = createBody.search(
    /CALL\s+lock_class_invariant_boundary\s*\(\s*out_class_id\s*\)/iu,
  );
  const childInsert = createBody.search(/INSERT\s+INTO\s+class_members\b/iu);
  assert.ok(
    isolationGuard >= 0 &&
      classInsert > isolationGuard &&
      newClassLock > classInsert &&
      childInsert > newClassLock,
  );

  const requestBody = procedureBody("request_class_membership");
  const requestUserLock = requestBody.search(/FROM\s+users[\s\S]*?FOR\s+UPDATE/iu);
  const requestCurrentMembershipLock = requestBody.search(
    /FROM\s+class_members\s+WHERE\s+current_user_id\s*=\s*p_user_id\s+FOR\s+UPDATE/iu,
  );
  const requestClassLock = requestBody.search(/CALL\s+lock_class_invariant_boundary\s*\(/iu);
  assert.ok(
    requestUserLock >= 0 &&
      requestCurrentMembershipLock > requestUserLock &&
      requestClassLock > requestCurrentMembershipLock,
    "request_class_membership: PRD 6.3 user/current-membership/class order changed",
  );
});

test("all two-user cursors pin PRIMARY and retain numeric fetch order", () => {
  for (const name of [
    "approve_class_member",
    "reject_class_member",
    "remove_class_member",
    "allow_class_member_rejoin",
    "transfer_class_teacher",
  ]) {
    assert.match(
      procedureBody(name),
      /SELECT\s+id\s*,\s*is_active\s*,\s*deleted_at\s+FROM\s+users\s+FORCE\s+INDEX\s*\(PRIMARY\)[\s\S]*?WHERE\s+id\s+IN\s*\([^)]*\)[\s\S]*?ORDER\s+BY\s+id[\s\S]*?FOR\s+UPDATE/iu,
      name,
    );
  }
});

test("current-membership fences use the exact generated unique key", () => {
  for (const [name, parameter] of [
    ["create_class_with_teacher_and_invite", "p_actor_user_id"],
    ["request_class_membership", "p_user_id"],
    ["transfer_class_teacher", "p_incoming_user_id"],
  ]) {
    const body = procedureBody(name);
    assert.match(
      body,
      new RegExp(
        `FROM\\s+class_members\\s+WHERE\\s+current_user_id\\s*=\\s*${parameter}\\s+FOR\\s+UPDATE`,
        "iu",
      ),
      name,
    );
    assert.doesNotMatch(
      body,
      new RegExp(
        `FROM\\s+class_members\\s+WHERE\\s+user_id\\s*=\\s*${parameter}[\\s\\S]*?status\\s+IN`,
        "iu",
      ),
      name,
    );
  }
  assert.match(
    helperGrants,
    /GRANT\s+SELECT\s*\(id,\s*class_id,\s*user_id,\s*role,\s*status,\s*row_version,\s*current_user_id\)\s+ON\s+classhub_mariadb_phase1_dev\.class_members/iu,
  );
});

test("account deletion forces the explicit ordered user-history access path", () => {
  const accountBody = procedureBody("delete_user_account");
  const orderedHistoryReads =
    accountBody.match(
      /FROM\s+class_members\s+FORCE\s+INDEX\s*\(\s*class_members_user_class_id_idx\s*\)\s+WHERE\s+user_id\s*=\s*p_user_id\s+ORDER\s+BY\s+class_id\s*,\s*id\s+FOR\s+UPDATE/giu,
    ) ?? [];
  assert.equal(orderedHistoryReads.length, 2);
  assert.doesNotMatch(accountBody, /DECLARE\s+current_role\b/iu);
  assert.equal((accountBody.match(/DECLARE\s+member_role_value\b/giu) ?? []).length, 2);
});

test("invite creation uses five caller candidates and only narrow 1062 retries", () => {
  const createBody = procedureBody("create_class_with_teacher_and_invite");
  const rotateBody = procedureBody("rotate_class_invite");
  for (const [body, prefix] of [
    [createBody, "p_invite_code_"],
    [rotateBody, "p_new_code_"],
  ]) {
    for (let candidate = 1; candidate <= 5; candidate += 1) {
      assert.match(body, new RegExp(`${prefix}${candidate}\\s+VARCHAR\\(8\\)`, "iu"));
    }
    assert.match(body, /DECLARE\s+CONTINUE\s+HANDLER\s+FOR\s+1062/iu);
    assert.match(body, /GET\s+DIAGNOSTICS\s+diagnostic_count\s*=\s*NUMBER/iu);
    assert.match(
      body,
      /GET\s+DIAGNOSTICS\s+CONDITION\s+diagnostic_count\s+duplicate_errno\s*=\s*MYSQL_ERRNO\s*,\s*duplicate_message\s*=\s*MESSAGE_TEXT/iu,
    );
    assert.match(body, /duplicate_errno\s+IS\s+NULL[\s\S]*?duplicate_errno\s*<>\s*1062/iu);
    assert.match(body, /duplicate_message\s+IS\s+NULL/iu);
    assert.match(body, /for key ''class_invite_codes_code_unique''\$/iu);
    assert.match(body, /RESIGNAL/iu);
    assert.match(body, /exhausted five invite code candidates/iu);
    assert.doesNotMatch(body, /INSERT\s+IGNORE|ON\s+DUPLICATE\s+KEY/iu);
    assert.match(body, /DATE_ADD\s*\(\s*out_occurred_at\s*,\s*INTERVAL\s+14\s+DAY\s*\)/iu);
  }
  assert.equal((executableRoutineSql.match(/HANDLER\s+FOR\s+1062/giu) ?? []).length, 2);
  assert.equal((executableRoutineSql.match(/\bRESIGNAL\b/giu) ?? []).length, 2);
});

test("lifecycle routines pin source reasons and avoid mutable cursor predicates", () => {
  const createBody = procedureBody("create_class_with_teacher_and_invite");
  const archiveBody = procedureBody("archive_class");
  const rotateBody = procedureBody("rotate_class_invite");

  assert.match(
    createBody,
    /INTO\s+duplicate_class_id[\s\S]*?AND\s+BINARY\s+status\s+IN[\s\S]*?LIMIT\s+1\s*;/iu,
  );
  assert.doesNotMatch(createBody, /INTO\s+duplicate_class_id[\s\S]*?LIMIT\s+1\s+FOR\s+UPDATE/iu);
  assert.doesNotMatch(archiveBody, /\bIN\s+p_reason\b/iu);
  assert.doesNotMatch(rotateBody, /\bIN\s+p_reason\b/iu);
  assert.match(archiveBody, /revoke_reason\s*=\s*'반 아카이브'/iu);
  assert.match(archiveBody, /NULL\s*,\s*'반 아카이브'\s*,\s*out_occurred_at/iu);
  assert.match(rotateBody, /revoke_reason\s*=\s*'재발급'/iu);
  assert.match(
    archiveBody,
    /SELECT\s+id\s*,\s*revoked_at\s+FROM\s+class_invite_codes\s+WHERE\s+class_id\s*=\s*p_class_id\s+ORDER\s+BY\s+id/iu,
  );
  assert.match(
    archiveBody,
    /SELECT\s+id\s*,\s*status\s+FROM\s+class_members\s+WHERE\s+class_id\s*=\s*p_class_id\s+ORDER\s+BY\s+id/iu,
  );
});

test("membership request validates expiry after all locks and distinguishes removed", () => {
  const body = procedureBody("request_class_membership");
  const inviteLock = body.search(
    /SELECT\s+id\s*,\s*expires_at\s*,\s*revoked_at[\s\S]*?FOR\s+UPDATE/iu,
  );
  const existingLock = body.search(
    /SELECT\s+id\s*,\s*role\s*,\s*status[\s\S]*?class_id\s*=\s*p_class_id\s+AND\s+user_id\s*=\s*p_user_id[\s\S]*?FOR\s+UPDATE/iu,
  );
  const clock = body.search(/SET\s+out_occurred_at\s*=\s*UTC_TIMESTAMP\(6\)/iu);
  const expiryCheck = body.search(/locked_invite_expires_at\s*<=\s*out_occurred_at/iu);
  assert.ok(
    inviteLock >= 0 && existingLock > inviteLock && clock > existingLock && expiryCheck > clock,
  );
  assert.match(body, /existing_status\s*=\s*BINARY\s*'removed'[\s\S]*?MYSQL_ERRNO\s*=\s*30216/iu);
});

test("nullable reasons are canonical and transfer follows the PRD-only incoming path", () => {
  for (const name of ["reject_class_member", "remove_class_member", "allow_class_member_rejoin"]) {
    const body = procedureBody(name);
    assert.match(
      body,
      /SET\s+transition_reason\s*=\s*NULLIF\s*\(\s*TRIM\s*\(\s*p_reason\s*\)/iu,
      name,
    );
    assert.match(body, /NULL\s*,\s*transition_reason\s*,\s*out_occurred_at/iu, name);
  }

  const transferBody = procedureBody("transfer_class_teacher");
  assert.match(
    transferBody,
    /SET\s+transition_reason\s*=\s*NULLIF\s*\(\s*TRIM\s*\(\s*p_reason\s*\)/iu,
  );
  assert.match(
    transferBody,
    /NULL\s*,\s*NULL\s*,\s*p_operator_id\s*,\s*transition_reason\s*,\s*out_occurred_at/iu,
  );
  assert.match(
    transferBody,
    /SELECT\s+user_id\s*,\s*status\s*,\s*temporary_password_must_change[\s\S]*?profile_temporary\s*=\s*TRUE/iu,
  );
  assert.match(transferBody, /requires no prior membership in the target class/iu);
  assert.equal((transferBody.match(/INSERT\s+INTO\s+class_members\b/giu) ?? []).length, 1);
  assert.doesNotMatch(
    transferBody,
    /UPDATE\s+class_members[\s\S]*?SET\s+status\s*=\s*'approved'/iu,
  );
  for (const column of ["suspended_reason", "suspended_at", "suspended_by_operator_id"]) {
    assert.match(transferBody, new RegExp(`${column}\\s*=\\s*NULL`, "iu"));
  }
  assert.match(
    transferBody,
    /WHERE\s+id\s*=\s*p_class_id\s+AND\s+BINARY\s+status\s*=\s*BINARY\s*'suspended'/iu,
  );
});

test("account deletion validates and rechecks an exact sorted class set before writes", () => {
  const body = procedureBody("delete_user_account");
  for (const pattern of [
    /JSON_VALID\s*\(/iu,
    /JSON_TYPE\s*\(/iu,
    /expected_class_count\s*>\s*4096/iu,
    /strictly ascending/iu,
    /CALL\s+lock_class_invariant_boundary\s*\(\s*expected_class_id\s*\)/iu,
    /ORDER\s+BY\s+class_id\s*,\s*id\s+FOR\s+UPDATE/iu,
    /actual class set does not match caller list/iu,
    /actual_class_count\s*<>\s*expected_class_count/iu,
    /blocked by a live class teacher/iu,
  ]) {
    assert.match(body, pattern);
  }
  const exactSetCheck = body.search(/actual_class_count\s*<>\s*expected_class_count/iu);
  const firstWrite = body.search(/UPDATE\s+class_members\b/iu);
  const isolationGuard = body.search(/CALL\s+assert_read_committed_session\s*\(\s*\)/iu);
  const byteBound = body.search(
    /OCTET_LENGTH\s*\(\s*p_expected_class_ids_json\s*\)\s*>\s*131072/iu,
  );
  const jsonValidation = body.search(/JSON_VALID\s*\(\s*p_expected_class_ids_json\s*\)/iu);
  const jsonType = body.search(/JSON_TYPE\s*\(\s*p_expected_class_ids_json\s*\)/iu);
  assert.ok(
    isolationGuard >= 0 &&
      byteBound > isolationGuard &&
      jsonValidation > byteBound &&
      jsonType > jsonValidation,
  );
  assert.ok(exactSetCheck >= 0 && firstWrite > exactSetCheck);
});

test("status updates are fail-closed and append matching history before final assertion", () => {
  const transitionBodies = expectedRoutines
    .filter((name) => name !== "rotate_class_invite")
    .map(procedureBody);
  for (const body of transitionBodies) {
    assert.match(body, /INSERT\s+INTO\s+class_member_status_history\b/iu);
    assert.ok(
      body.lastIndexOf("CALL assert_class_invariants") >
        body.lastIndexOf("INSERT INTO class_member_status_history"),
    );
  }
  for (const name of [
    "archive_class",
    "request_class_membership",
    "cancel_class_membership_request",
    "leave_class",
    "approve_class_member",
    "reject_class_member",
    "remove_class_member",
    "allow_class_member_rejoin",
    "delete_user_account",
    "transfer_class_teacher",
  ]) {
    assert.match(procedureBody(name), /IF\s+ROW_COUNT\(\)\s*<>\s*1\s+THEN/iu, name);
  }
});

test("the locked owner DML envelope is exact and contains no broad or destructive grant", () => {
  const normalized = definerDml.replace(/\s+/gu, " ");
  assert.equal((definerDml.match(/^GRANT\b/gimu) ?? []).length, 5);
  for (const table of [
    "classes",
    "class_members",
    "class_member_status_history",
    "class_invite_codes",
    "users",
  ]) {
    assert.match(normalized, new RegExp(`ON classhub_mariadb_phase1_dev\\.${table} `, "iu"));
  }
  assert.doesNotMatch(
    definerDml,
    /\b(?:DELETE|GRANT\s+ALL|GRANT\s+OPTION|teacher_profiles|schools|operators|audit_logs|api_idempotency_keys)\b/iu,
  );
  assert.doesNotMatch(
    normalized,
    /UPDATE\s*\([^)]*\)\s+ON\s+classhub_mariadb_phase1_dev\.class_member_status_history/iu,
  );
  for (const column of ["suspended_reason", "suspended_at", "suspended_by_operator_id"]) {
    assert.match(normalized, new RegExp(`UPDATE \\([^)]*${column}`, "iu"));
  }
});

test("runtime EXECUTE and direct-DML grants match the reviewed identity matrix", () => {
  const grants = [
    ...runtimeActivation.matchAll(
      /GRANT\s+EXECUTE\s+ON\s+PROCEDURE\s+classhub_mariadb_phase1_dev\.([a-z0-9_]+)\s+TO\s+'(classhub_[a-z]+)'@'%'/giu,
    ),
  ].map((match) => ({ identity: match[2], routine: match[1] }));
  assert.deepEqual(
    grants
      .filter(({ identity }) => identity === "classhub_app")
      .map(({ routine }) => routine)
      .sort(),
    expectedAppRoutines,
  );
  assert.deepEqual(
    grants.filter(({ identity }) => identity === "classhub_operator"),
    [{ identity: "classhub_operator", routine: "transfer_class_teacher" }],
  );
  assert.equal(grants.length, 12);
  assert.doesNotMatch(runtimeActivation, /lock_class_invariant_boundary|assert_class_invariants/iu);
  assert.doesNotMatch(
    runtimeActivation,
    /TO\s+'classhub_(?:worker|retention)'@'%'[\s\S]*?EXECUTE/iu,
  );
  assert.match(
    runtimeActivation,
    /REVOKE\s+ALL\s+PRIVILEGES\s*,\s*GRANT\s+OPTION\s+FROM\s+'classhub_app'@'%'\s*,\s*'classhub_operator'@'%'\s*,\s*'classhub_retention'@'%'\s*,\s*'classhub_worker'@'%'/iu,
  );
  assert.doesNotMatch(
    runtimeActivation,
    /GRANT\s+INSERT\s*,\s*UPDATE\s+ON\s+classhub_mariadb_phase1_dev\.users/iu,
  );
  assert.match(
    runtimeActivation,
    /GRANT\s+UPDATE\s*\(name,\s*expected_student_count,\s*row_version,\s*updated_at\)\s+ON\s+classhub_mariadb_phase1_dev\.classes/iu,
  );
  assert.match(
    runtimeActivation,
    /GRANT\s+UPDATE\s*\(display_name_in_class,\s*student_number,\s*row_version,\s*updated_at\)\s+ON\s+classhub_mariadb_phase1_dev\.class_members/iu,
  );
  assert.doesNotMatch(
    runtimeActivation,
    /GRANT\s+(?:INSERT|DELETE)\b[^;]*ON\s+classhub_mariadb_phase1_dev\.(?:classes|class_members|class_invite_codes|class_member_status_history)[\s\S]*?TO\s+'classhub_app'@'%'/iu,
  );
  assert.match(
    runtimeActivation,
    /GRANT\s+SELECT\s*\(id,\s*credential_hash,\s*status,\s*revoked_at\)\s*,\s*INSERT\s*\(email_normalized,\s*credential_hash\)[\s\S]*?ON\s+classhub_mariadb_phase1_dev\.operators/iu,
  );
  assert.match(
    runtimeActivation,
    /GRANT\s+SELECT\s*\(id,\s*class_id,\s*user_id,\s*role,\s*status\)[\s\S]*?ON\s+classhub_mariadb_phase1_dev\.class_members[\s\S]*?TO\s+'classhub_operator'@'%'/iu,
  );
  assert.match(
    runtimeActivation,
    /GRANT\s+SELECT\s*\(id,\s*status,\s*suspended_reason,\s*edu_office_code,\s*school_code,\s*grade\)[\s\S]*?ON\s+classhub_mariadb_phase1_dev\.classes[\s\S]*?TO\s+'classhub_operator'@'%'/iu,
  );
  assert.match(
    runtimeActivation,
    /GRANT\s+SELECT\s*\(user_id,\s*revoked_at\)\s*,\s*UPDATE\s*\(revoked_at\)[\s\S]*?ON\s+classhub_mariadb_phase1_dev\.sessions/iu,
  );
});

test("foreign locked definer receives exact self-execute and no runtime grant", () => {
  const grants = [
    ...transitionOwnerExecuteGrants.matchAll(
      /GRANT\s+EXECUTE\s+ON\s+PROCEDURE\s+classhub_mariadb_phase1_dev\.([a-z0-9_]+)\s+TO\s+'classhub_routine'@'%'/giu,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(grants.sort(), expectedRoutines);
  assert.equal(grants.length, 12);
  assert.doesNotMatch(
    transitionOwnerExecuteGrants,
    /'classhub_(?:app|operator|worker|retention|migrator)'@'%'/iu,
  );
});

test("helper reads and rollback draft preserve fail-closed boundaries", () => {
  assert.match(
    helperGrants.replace(/\s+/gu, " "),
    /GRANT SELECT \( member_id, class_id, from_status, to_status, actor_user_id, actor_member_id, actor_operator_id \) ON classhub_mariadb_phase1_dev\.class_member_status_history/iu,
  );
  assert.doesNotMatch(invariantBoundary, /COUNT\s*\(\s*\*\s*\)/iu);
  for (const envelope of [runtimeActivation, runtimeRollback]) {
    assert.equal(
      (envelope.match(/^REVOKE\s+ALL\s+PRIVILEGES\s*,\s*GRANT\s+OPTION/gimu) ?? []).length,
      1,
    );
    for (const identity of ["app", "operator", "retention", "worker"]) {
      assert.match(envelope, new RegExp(`'classhub_${identity}'@'%'`, "iu"));
    }
    assert.doesNotMatch(envelope, /TO\s+'classhub_worker'@'%'/iu);
    for (const table of [
      "user_consents",
      "email_verification_tokens",
      "password_reset_tokens",
      "sessions",
    ]) {
      assert.match(
        envelope,
        new RegExp(
          `GRANT\\s+SELECT\\s*,\\s*INSERT\\s*,\\s*UPDATE[\\s\\S]*?ON\\s+classhub_mariadb_phase1_dev\\.${table}[\\s\\S]*?TO\\s+'classhub_app'@'%'`,
          "iu",
        ),
      );
    }
    assert.match(
      envelope,
      /GRANT\s+SELECT\s*,\s*INSERT\s*,\s*DELETE[\s\S]*?ON\s+classhub_mariadb_phase1_dev\.api_idempotency_keys[\s\S]*?TO\s+'classhub_app'@'%'/iu,
    );
    assert.match(
      envelope,
      /GRANT\s+INSERT\s*\(email_normalized,\s*display_name,\s*password_hash\)[\s\S]*?ON\s+classhub_mariadb_phase1_dev\.users[\s\S]*?TO\s+'classhub_app'@'%'/iu,
    );
  }
  assert.doesNotMatch(
    runtimeRollback,
    /GRANT\s+INSERT\s*,\s*UPDATE\s+ON\s+classhub_mariadb_phase1_dev\.users/iu,
  );
  assert.doesNotMatch(
    runtimeRollback,
    /\b(?:classes|class_members|class_invite_codes|class_member_status_history|teacher_profiles)\b/iu,
  );
  assert.doesNotMatch(runtimeRollback, /\b(?:DROP|TRUNCATE|ALTER)\b|DELETE\s+FROM/iu);
});
