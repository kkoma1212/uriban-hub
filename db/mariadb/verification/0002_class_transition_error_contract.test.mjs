import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const verificationDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(verificationDirectory, "../migrations");
const transitionContract = JSON.parse(
  readFileSync(resolve(verificationDirectory, "0002_class_transition_contract.json"), "utf8"),
);
const errorContract = JSON.parse(
  readFileSync(resolve(verificationDirectory, "0002_class_transition_error_contract.json"), "utf8"),
);
const membershipDdl = readFileSync(
  resolve(migrationsDirectory, "0002_class_membership.sql"),
  "utf8",
);
const routineSql = Object.fromEntries(
  transitionContract.routine_files.map((path) => [
    path,
    readFileSync(resolve(migrationsDirectory, path.split("/").at(-1)), "utf8"),
  ]),
);

function procedureBody(name) {
  const source = Object.values(routineSql).find((sql) =>
    new RegExp(`\\bPROCEDURE\\s+${name}\\s*\\(`, "iu").test(sql),
  );
  assert.ok(source, `missing routine source: ${name}`);
  const match = new RegExp(`\\bPROCEDURE\\s+${name}\\s*\\([\\s\\S]*?\\nEND//`, "iu").exec(source);
  assert.ok(match, `missing routine body: ${name}`);
  return match[0];
}

function directCustomErrnos(body) {
  return [...body.matchAll(/MYSQL_ERRNO\s*=\s*(30\d{3})\s*,\s*MESSAGE_TEXT\s*=\s*'[^']+'/giu)].map(
    (match) => Number(match[1]),
  );
}

test("every direct custom SIGNAL has one procedure-qualified public or internal mapping", () => {
  const expectedProcedures = transitionContract.protected_transitions.map(({ id }) => id).sort();
  assert.deepEqual(Object.keys(errorContract.procedures).sort(), expectedProcedures);

  for (const procedure of expectedProcedures) {
    const body = procedureBody(procedure);
    const propagated = /CALL\s+assert_read_committed_session\s*\(\s*\)/iu.test(body)
      ? [errorContract.helper_propagation.isolation_errno]
      : [];
    const declared = [...new Set([...directCustomErrnos(body), ...propagated])].sort(
      (a, b) => a - b,
    );
    const mapped = Object.keys(errorContract.procedures[procedure])
      .map(Number)
      .sort((a, b) => a - b);
    assert.deepEqual(mapped, declared, procedure);
    for (const result of Object.values(errorContract.procedures[procedure])) {
      assert.match(result, /^[A-Z0-9_]+:(?:400|401|403|404|409|423|500|CLI)$/u, procedure);
    }
  }
});

test("split public branches retain their reviewed exception semantics and precedence", () => {
  const requiredMappings = {
    "create_class_with_teacher_and_invite:30102": "UNAUTHENTICATED:401",
    "create_class_with_teacher_and_invite:30124": "EMAIL_NOT_VERIFIED:403",
    "create_class_with_teacher_and_invite:30106": "SCHOOL_KIND_NOT_SUPPORTED:400",
    "create_class_with_teacher_and_invite:30125": "GRADE_NOT_ALLOWED:400",
    "archive_class:30126": "CLASS_SUSPENDED:423",
    "archive_class:30109": "CLASS_ARCHIVE_CONFLICT:409",
    "rotate_class_invite:30127": "CLASS_SUSPENDED:423",
    "rotate_class_invite:30117": "NOT_FOUND:404",
    "request_class_membership:30202": "UNAUTHENTICATED:401",
    "request_class_membership:30217": "EMAIL_NOT_VERIFIED:403",
    "approve_class_member:30325": "MEMBER_ACCOUNT_INACTIVE:409",
    "approve_class_member:30303": "ROLE_INSUFFICIENT:403",
    "approve_class_member:30326": "MEMBER_NOT_FOUND:404",
    "approve_class_member:30327": "MEMBER_STATUS_CHANGED:409",
    "transfer_class_teacher:30503": "OPERATOR_OUTGOING_USER_NOT_FOUND:CLI",
    "transfer_class_teacher:30510": "OPERATOR_INCOMING_USER_NOT_FOUND:CLI",
    "transfer_class_teacher:30511": "OPERATOR_INCOMING_USER_INACTIVE:CLI",
    "transfer_class_teacher:30512": "OPERATOR_INCOMING_PROFILE_INACTIVE:CLI",
    "transfer_class_teacher:30513": "OPERATOR_TEMPORARY_PASSWORD_UNCHANGED:CLI",
  };
  for (const [key, result] of Object.entries(requiredMappings)) {
    const [procedure, errno] = key.split(":");
    assert.equal(errorContract.procedures[procedure][errno], result, key);
  }

  for (const [procedure, errnos] of Object.entries(errorContract.reviewed_public_precedence)) {
    const body = procedureBody(procedure);
    let previous = -1;
    for (const errno of errnos) {
      const index = body.indexOf(`MYSQL_ERRNO = ${errno}`);
      assert.ok(index > previous, `${procedure}: errno ${errno} precedence drifted`);
      previous = index;
    }
  }
});

test("operator transfer precondition diagnostics retain the reviewed routine order", () => {
  assert.deepEqual(errorContract.reviewed_operator_precondition_precedence, {
    transfer_class_teacher: {
      scope:
        "Domain/operator preconditions after basic argument and isolation guards. The operator adapter prevalidates diagnostics; this order is the routine contract and does not claim source CLI precedence parity.",
      mysql_errnos: [
        30502, 30503, 30510, 30511, 30002, 30501, 30504, 30505, 30506, 30507, 30512, 30513,
      ],
    },
  });

  const body = procedureBody("transfer_class_teacher");
  let previous = -1;
  for (const errno of errorContract.reviewed_operator_precondition_precedence.transfer_class_teacher
    .mysql_errnos) {
    const token = errno === 30002 ? "CALL lock_class_invariant_boundary" : `MYSQL_ERRNO = ${errno}`;
    const index = body.indexOf(token);
    assert.ok(index > previous, `transfer_class_teacher: errno ${errno} precedence drifted`);
    previous = index;
  }
});

test("helper propagation is top-level-procedure qualified and unknown errors fail closed", () => {
  assert.match(
    errorContract.lookup_key,
    /custom SIGNAL.*operation id.*SQLSTATE 45000.*MYSQL_ERRNO/iu,
  );
  assert.match(errorContract.lookup_key, /CALL operation id.*top-level procedure/iu);
  assert.match(
    errorContract.lookup_key,
    /Native errors.*native SQLSTATE.*structured constraint metadata/iu,
  );
  assert.match(errorContract.message_text_parsing, /Forbidden.*routine-internal.*unverified/iu);
  assert.match(errorContract.unknown_error_policy, /Rollback the complete caller transaction/iu);
  assert.match(errorContract.unknown_error_policy, /internal 500/iu);
  assert.match(
    errorContract.unknown_error_policy,
    /different SQLSTATE.*absent or different native constraint metadata.*unknown errno.*helper\/trigger.*deadlock.*timeout/iu,
  );
  assert.match(errorContract.unknown_error_policy, /Never re-query.*never commit/iu);
  assert.deepEqual(errorContract.activation_gates, [
    "mariadb_11_4_parser_semantics_and_concurrency_passed",
    "application_dialect_and_retry_wiring_passed",
  ]);
  for (const gate of errorContract.activation_gates) {
    assert.equal(transitionContract.activation_gate_status[gate], false);
  }
  assert.equal(errorContract.helper_propagation.isolation_errno, 30006);
  assert.equal(errorContract.helper_propagation.isolation_result, "INTERNAL_ADAPTER_CONTRACT:500");
  for (const procedure of transitionContract.protected_transitions.map(({ id }) => id)) {
    assert.equal(
      errorContract.procedures[procedure][errorContract.helper_propagation.isolation_errno],
      errorContract.helper_propagation.isolation_result,
      `${procedure}: propagated isolation error`,
    );
  }
  assert.equal(errorContract.helper_propagation.missing_class_errno, 30002);
  assert.deepEqual(
    Object.keys(errorContract.helper_propagation.missing_class_by_top_level_procedure).sort(),
    transitionContract.protected_transitions.map(({ id }) => id).sort(),
  );
  assert.deepEqual(errorContract.helper_propagation.invariant_errnos, [30003, 30004, 30005]);
  assert.equal(
    errorContract.helper_propagation.invariant_result,
    "INTERNAL_INVARIANT_VIOLATION:500",
  );
  for (const [procedure, cutPoint] of Object.entries(
    transitionContract.runtime_credential_threat_model.fault_injection_matrix
      .late_internal_cut_points,
  )) {
    for (const errno of cutPoint.mysql_errnos) {
      assert.ok(errorContract.procedures[procedure][errno], `${procedure}:${errno}`);
    }
  }
});

test("only two exact native constraint families are publicly translated", () => {
  assert.deepEqual(errorContract.native_constraint_allowlist, [
    {
      operation: "create_class_with_teacher_and_invite",
      mysql_errno: 1062,
      constraint: "classes_active_identity_unique",
      result: "CLASS_ALREADY_EXISTS:409",
    },
    {
      operation: "approve_class_member",
      mysql_errno: 1062,
      constraint: "class_members_student_number_unique",
      result: "STUDENT_NUMBER_ALREADY_IN_USE:409",
    },
    {
      operation: "update_class_details",
      mysql_errno: 1062,
      constraint: "classes_active_identity_unique",
      result: "CLASS_ALREADY_EXISTS:409",
    },
    {
      operation: "update_student_profile",
      mysql_errno: 1062,
      constraint: "class_members_student_number_unique",
      result: "STUDENT_NUMBER_ALREADY_IN_USE:409",
    },
  ]);
  for (const { constraint } of errorContract.native_constraint_allowlist) {
    assert.match(membershipDdl, new RegExp(`\\b${constraint}\\b`, "u"), constraint);
  }
  assert.deepEqual(errorContract.routine_internal_native_retry, {
    procedure: "create_class_with_teacher_and_invite|rotate_class_invite",
    mysql_errno: 1062,
    constraint: "class_invite_codes_code_unique",
    behavior:
      "Retry only inside the five-candidate loop after pinned diagnostics proof; every other 1062 is RESIGNALed and reaches the unknown-error policy unless separately allowlisted.",
  });
});
