import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readEvidenceDocument, evidenceDocumentExists } from "./evidence-document.mjs";

const verificationDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(verificationDirectory, "../../..");
const contract = JSON.parse(
  readFileSync(resolve(verificationDirectory, "0002_class_transition_contract.json"), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(resolve(verificationDirectory, "../manifest.json"), "utf8"),
);
const accountProvisioning = readFileSync(
  resolve(verificationDirectory, "../permissions/0002_class_membership_definer_account.sql"),
  "utf8",
);
const helperGrants = readFileSync(
  resolve(verificationDirectory, "../permissions/0002_class_membership_helper_grants.sql"),
  "utf8",
);
const helperExecuteGrants = readFileSync(
  resolve(verificationDirectory, "../permissions/0002_class_membership_helper_execute_grants.sql"),
  "utf8",
);
const transitionOwnerExecuteGrants = readFileSync(
  resolve(
    verificationDirectory,
    "../permissions/0002_class_membership_transition_owner_execute_grants.sql",
  ),
  "utf8",
);
const membershipMigration = readFileSync(
  resolve(verificationDirectory, "../migrations/0002_class_membership.sql"),
  "utf8",
);

const expectedProtectedTransitions = [
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

const expectedTransitionDependencies = {
  create_class_with_teacher_and_invite: {
    caller: ["api_idempotency_keys", "audit_logs"],
    future: ["0004_audit_import_logs"],
    postCommit: [],
  },
  archive_class: { caller: ["audit_logs"], future: ["0004_audit_import_logs"], postCommit: [] },
  rotate_class_invite: {
    caller: ["api_idempotency_keys", "audit_logs"],
    future: ["0004_audit_import_logs"],
    postCommit: [],
  },
  request_class_membership: {
    caller: ["audit_logs"],
    future: ["0004_audit_import_logs"],
    postCommit: [],
  },
  cancel_class_membership_request: {
    caller: ["audit_logs"],
    future: ["0004_audit_import_logs"],
    postCommit: [],
  },
  leave_class: {
    caller: ["audit_logs", "seat_draw_assignments", "team_draw_assignments", "duty_assignments"],
    future: ["0004_audit_import_logs", "0011_seat_draws", "0012_team_draws", "0013_duty_rosters"],
    postCommit: [],
  },
  approve_class_member: {
    caller: ["notice_reads", "supply_checks", "audit_logs"],
    future: ["0003_content_meals", "0004_audit_import_logs"],
    postCommit: [],
  },
  reject_class_member: {
    caller: ["audit_logs"],
    future: ["0004_audit_import_logs"],
    postCommit: [],
  },
  remove_class_member: {
    caller: ["audit_logs", "seat_draw_assignments", "team_draw_assignments", "duty_assignments"],
    future: ["0004_audit_import_logs", "0011_seat_draws", "0012_team_draws", "0013_duty_rosters"],
    postCommit: [],
  },
  allow_class_member_rejoin: {
    caller: ["audit_logs"],
    future: ["0004_audit_import_logs"],
    postCommit: [],
  },
  delete_user_account: {
    caller: [
      "sessions",
      "email_verification_tokens",
      "password_reset_tokens",
      "user_consents",
      "audit_logs",
      "student_assessment_records",
      "poll_votes",
      "seat_draw_assignments",
      "team_draw_assignments",
      "election_participants",
      "election_candidates",
      "duty_assignments",
    ],
    future: [
      "0004_audit_import_logs",
      "0009_student_assessments",
      "0010_polls",
      "0011_seat_draws",
      "0012_team_draws",
      "0013_duty_rosters",
      "0015_elections",
    ],
    postCommit: ["security_audit_event"],
  },
  transfer_class_teacher: {
    caller: ["audit_logs", "operator_audit_logs"],
    future: ["0004_audit_import_logs"],
    postCommit: [],
  },
};

function withoutComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*--.*$/gmu, "");
}

function assertSourceCoordinate(coordinate) {
  const match = /^(.*):(\d+)-(\d+)$/u.exec(coordinate);
  assert.notEqual(match, null, `invalid source coordinate: ${coordinate}`);
  const [, relativePath, firstText, lastText] = match;
  // PRD 등 Markdown 근거는 9/11부터 문서 DB에 같은 경로 이름으로 있다(evidence-document.mjs).
  assert.equal(evidenceDocumentExists(relativePath), true, `missing source file: ${relativePath}`);
  const lineCount = readEvidenceDocument(relativePath).split(/\r?\n/u).length;
  const first = Number(firstText);
  const last = Number(lastText);
  assert.ok(first >= 1 && first <= last, `invalid source range: ${coordinate}`);
  assert.ok(last <= lineCount, `source range exceeds file: ${coordinate}`);
}

test("the contract records approved option A while runtime database apply stays blocked", () => {
  assert.equal(contract.status, "isolated_parser_and_smoke_verified_activation_blocked");
  assert.equal(contract.database_apply_approved, false);
  assert.deepEqual(contract.isolated_qa_evidence, {
    verified_at: "2026-09-05",
    server_version: "11.4.13-MariaDB-ubu2404",
    apply_files: 12,
    installed_total_tables: 13,
    installed_routines: 15,
    installed_triggers: 1,
    semantic_transition_probes: 3,
    successful_transition_routines: 12,
    targeted_concurrency_probes: 4,
    targeted_fault_probes: 5,
    targeted_integrity_probes: 28,
    targeted_text_differential_vectors: 37,
    targeted_text_identity_prechecks: 9,
    targeted_constraint_outcome_probes: 28,
    targeted_constraint_rejection_probes: 24,
    targeted_constraint_acceptance_probes: 4,
    postgres_source_migrations_applied: 47,
    error_then_commit_persistence: "observed_activation_risk",
    synthetic_backup_restore: "schema_content_catalog_privileges_match",
    full_postgresql_differential_gate_closed: false,
    full_concurrency_gate_closed: false,
    production_recovery_gate_closed: false,
    persistent_rows_after_rollback: 0,
    runtime_activation_applied: false,
    scope:
      "Parser, catalog/definer/ACL fingerprint, guard and trigger rejection probes, all twelve successful transition paths with rollback, four targeted lock/clock concurrency races, five caller-failure/timeout/disconnect probes, 28 targeted generated-key/CHECK/trigger/FK/normalization probes, 37 exact UTF-8 normalization vectors plus nine class-identity routine prechecks, and 28 direct constraint outcomes (24 reject and four accept) against all 47 source migrations on disposable PostgreSQL 15.18 en_US.utf8, plus a synthetic schema/content/catalog/privilege backup-restore match. The differential found that the PostgreSQL actor CHECK makes its nominal ON DELETE SET NULL reject a referenced user deletion; the MariaDB FK now preserves that effective outcome with RESTRICT. Error-then-COMMIT persisted earlier routine writes and is an observed activation risk. This is not exhaustive PostgreSQL differential, full concurrency/fault, adapter, activation, production recovery, or production evidence.",
  });
  assert.equal(contract.routine_ownership_decision.status, "approved");
  assert.equal(contract.routine_ownership_decision.approved_option, "invariant_core");
  assert.equal(contract.routine_ownership_decision.approved_at, "2026-08-30");
  assert.equal(contract.routine_ownership_decision.recommended, "invariant_core");
  assert.deepEqual(Object.keys(contract.routine_ownership_decision.options).sort(), [
    "full_domain",
    "invariant_core",
  ]);
  assert.match(
    contract.routine_ownership_decision.options.invariant_core.routine_owns,
    /users lifecycle columns/u,
  );
  assert.equal(contract.routine_interface.timestamp_input_allowed, false);
  assert.equal(contract.routine_interface.timestamp_output, "out_occurred_at");
  assert.equal(contract.routine_interface.invite_candidate_count, 5);
  assert.equal(contract.routine_interface.transaction_control_inside_routine, false);
  assert.equal(
    contract.transaction_boundary.database_clock_activation_gate,
    "mariadb_11_4_parser_semantics_and_concurrency_passed",
  );
  assert.equal(
    contract.activation_gate_status[contract.transaction_boundary.database_clock_activation_gate],
    false,
  );
  assert.match(
    contract.transaction_boundary.database_clock,
    /reviewed transition-specific.*not a blanket claim.*static ordering alone does not prove/iu,
  );
  assert.match(
    contract.transaction_boundary.database_clock_runtime_probe,
    /start request_class_membership.*before invite expiry.*release.*after expiry.*rejects/iu,
  );
  assert.match(
    contract.transaction_boundary.database_clock_runtime_probe,
    /nonexpired control.*out_occurred_at.*no earlier than release.*governing invite lock/iu,
  );
  assert.match(
    contract.transaction_boundary.database_clock_runtime_probe,
    /every routine.*transition-specific.*do not infer stored CALL or UTC_TIMESTAMP\/NOW.*newly inserted row/iu,
  );
  assert.match(
    contract.transaction_boundary.database_clock_runtime_evidence,
    /request_class_membership.*30205.*out_occurred_at.*other eleven routines.*remain open/iu,
  );
  assert.equal(contract.runtime_credential_threat_model.status, "unapproved_for_activation");
  assert.match(contract.runtime_credential_threat_model.option_a_boundary, /trusted.*adapters/iu);
  assert.match(
    contract.runtime_credential_threat_model.measured_fault_evidence,
    /idempotency constraint error.*ROLLBACK.*disconnect.*persisted.*COMMIT.*timeout.*connection kill.*remains open/iu,
  );
  assert.match(
    contract.runtime_credential_threat_model.authorization_boundary,
    /not database-bound.*actor, user, and operator ids.*column-scoped direct UPDATE/iu,
  );
  assert.match(
    contract.runtime_credential_threat_model.authorization_boundary,
    /not proof.*row scope.*CAS/iu,
  );
  assert.match(
    contract.runtime_credential_threat_model.arbitrary_runtime_sql_protection,
    /Not provided.*chosen actor\/user\/operator ids.*direct UPDATEs.*without the application CAS/iu,
  );
  assert.equal(
    contract.runtime_credential_threat_model.activation_gate,
    "runtime_credential_threat_model_approved",
  );
  assert.equal(
    contract.activation_gate_status[contract.runtime_credential_threat_model.activation_gate],
    false,
  );
  assert.equal(
    contract.runtime_credential_threat_model.fault_proof_gate,
    "application_dialect_and_retry_wiring_passed",
  );
  assert.equal(
    contract.activation_gate_status[contract.runtime_credential_threat_model.fault_proof_gate],
    false,
  );
  assert.match(
    contract.runtime_credential_threat_model.required_fault_proof,
    /error-then-COMMIT/iu,
  );
  assert.match(contract.runtime_credential_threat_model.required_fault_proof, /zero persistence/iu);
  assert.match(
    contract.runtime_credential_threat_model.required_fault_proof,
    /pooled-connection reuse/iu,
  );
  assert.deepEqual(
    contract.runtime_credential_threat_model.fault_injection_matrix
      .every_routine_after_successful_call,
    contract.protected_transitions.map(({ id }) => id),
  );
  assert.match(
    contract.runtime_credential_threat_model.fault_injection_matrix
      .caller_owned_failure_requirement,
    /each of the twelve routines.*successful CALL.*before COMMIT.*every named caller-owned audit, idempotency, or cleanup failure.*zero persistence/iu,
  );
  assert.deepEqual(
    contract.runtime_credential_threat_model.fault_injection_matrix
      .column_scoped_after_successful_update,
    ["update_class_details", "update_student_profile"],
  );
  assert.match(
    contract.runtime_credential_threat_model.fault_injection_matrix
      .column_scoped_caller_owned_failure_requirement,
    /each of the two column-scoped transactions.*protected UPDATE succeeds.*before COMMIT.*caller-owned audit failure.*zero persistence.*UPDATE and audit write/iu,
  );
  assert.deepEqual(
    contract.runtime_credential_threat_model.fault_injection_matrix.late_internal_cut_points,
    {
      create_class_with_teacher_and_invite: {
        mysql_errnos: [30108],
        already_written: "class, teacher membership, matching history, and zero invite rows",
      },
      archive_class: {
        mysql_errnos: [30115, 30116],
        already_written:
          "archived class and zero-or-more revoked invites or member/history transitions",
      },
      rotate_class_invite: {
        mysql_errnos: [30123],
        already_written: "the prior open invite revocation and zero new invite rows",
      },
      delete_user_account: {
        mysql_errnos: [30414, 30415],
        already_written:
          "zero-or-more scrubbed member/history rows, including the after-member-loop user compare-and-set cut point",
      },
      transfer_class_teacher: {
        mysql_errnos: [30509],
        already_written:
          "outgoing and incoming teacher membership/history transitions before suspended-class reactivation",
      },
    },
  );
  assert.match(
    contract.runtime_credential_threat_model.fault_injection_matrix.native_and_trigger_requirement,
    /every publicly allowlisted native constraint error.*unknown native.*status-history trigger errors.*complete caller-transaction rollback/iu,
  );
  assert.match(
    contract.runtime_credential_threat_model.if_arbitrary_runtime_sql_is_required,
    /Reopen the ownership decision.*authorization-bearing.*routines and both direct-DML paths.*error atomicity/iu,
  );
  assert.equal(
    contract.sql_deployment_packaging.status,
    "file_level_apply_verified_implicit_commit_ledger_unverified",
  );
  assert.match(contract.sql_deployment_packaging.target_database, /selects.*explicitly/iu);
  assert.match(contract.sql_deployment_packaging.target_database, /no file.*ambient/iu);
  assert.match(contract.sql_deployment_packaging.client_contract, /DELIMITER/iu);
  assert.match(contract.sql_deployment_packaging.client_contract, /generic semicolon parser/iu);
  for (const field of ["server version", "DATABASE()", "sql_mode", "apply identity"]) {
    assert.match(contract.sql_deployment_packaging.session_fingerprint, new RegExp(field, "iu"));
  }
  assert.match(contract.sql_deployment_packaging.implicit_commit_ledger, /source checksum/iu);
  assert.match(contract.sql_deployment_packaging.implicit_commit_ledger, /implicit-commit/iu);
  assert.match(
    contract.sql_deployment_packaging.implicit_commit_ledger,
    /never claim.*transaction/iu,
  );
  assert.deepEqual(contract.sql_deployment_packaging.activation_gates, [
    "mariadb_11_4_parser_semantics_and_concurrency_passed",
    "acl_partial_failure_recovery_passed",
    "security_administrator_stage_proven",
  ]);
  for (const gate of contract.sql_deployment_packaging.activation_gates) {
    assert.equal(contract.activation_gate_status[gate], false, gate);
  }
  assert.deepEqual(contract.routine_interface.fixed_reasons, {
    archive_class: "반 아카이브",
    rotate_class_invite: "재발급",
  });
  assert.equal(
    contract.routine_interface.adapter_wire_format.activation_gate,
    "application_dialect_and_retry_wiring_passed",
  );
  assert.equal(
    contract.activation_gate_status[contract.routine_interface.adapter_wire_format.activation_gate],
    false,
  );
  assert.match(
    contract.routine_interface.adapter_wire_format.datetime6,
    /UTC.*exact canonical value.*six fractional digits.*not pass.*JavaScript Date.*byte\/value equality.*history created_at/iu,
  );
  assert.match(
    contract.routine_interface.adapter_wire_format.signed_bigint,
    /every BIGINT.*string or bigint.*never JavaScript number.*signed BIGINT maximum.*strict numeric ordering.*exact decimal serialization/iu,
  );
  for (const relativePath of contract.routine_files) {
    assert.equal(existsSync(resolve(repositoryRoot, relativePath)), true, relativePath);
  }
});

test("the contract preserves the governing users-to-class lock order", () => {
  assert.match(contract.transaction_boundary.required_isolation, /READ-COMMITTED/iu);
  assert.match(contract.transaction_boundary.required_isolation, /all twelve routines/iu);
  assert.match(contract.transaction_boundary.required_isolation, /fail closed/iu);
  assert.equal(contract.transaction_boundary.isolation_helper, "assert_read_committed_session");
  assert.match(
    contract.transaction_boundary.required_isolation_probe,
    /@@SESSION\.transaction_isolation/iu,
  );
  assert.match(contract.transaction_boundary.required_isolation_probe, /global PROCESS/iu);
  assert.match(contract.transaction_boundary.required_isolation_probe, /PROCESS is forbidden/iu);
  assert.match(
    contract.transaction_boundary.required_isolation_probe,
    /activation remains blocked/iu,
  );
  assert.match(
    contract.transaction_boundary.required_isolation_probe,
    /one-shot SET TRANSACTION/iu,
  );
  assert.match(contract.transaction_boundary.required_isolation_probe, /own-write visibility/iu);
  assert.match(contract.transaction_boundary.required_isolation_probe, /pooled connection/iu);
  assert.equal(
    contract.transaction_boundary.existing_class_lock_order,
    "users in numeric id order when required; then classes in numeric id order; then class_members under their locked parent class",
  );
  assert.match(contract.transaction_boundary.member_cursor_order_semantics, /cursor fetch order/iu);
  assert.match(
    contract.transaction_boundary.member_cursor_order_semantics,
    /physical record-lock/iu,
  );
  assert.match(
    contract.transaction_boundary.member_cursor_order_semantics,
    /not a safety premise/iu,
  );
  assert.match(
    contract.transaction_boundary.two_user_cursor_access_path,
    /four member-admin routines.*transfer_class_teacher.*FORCE INDEX \(PRIMARY\).*ORDER BY id.*FOR UPDATE/iu,
  );
  assert.match(
    contract.transaction_boundary.two_user_cursor_access_path,
    /EXPLAIN.*reversed actor\/target.*actual ascending.*source order alone is not evidence/iu,
  );
  assert.equal(
    contract.transaction_boundary.two_user_cursor_activation_gate,
    "mariadb_11_4_parser_semantics_and_concurrency_passed",
  );
  assert.equal(
    contract.activation_gate_status[contract.transaction_boundary.two_user_cursor_activation_gate],
    false,
  );
  assert.equal(
    contract.transaction_boundary.governing_lock_order_source,
    "PRD/우리반_허브_PRD_FINAL.md:351-353,387-389",
  );
  assert.match(contract.transaction_boundary.membership_request_exception, /PRD.*:481/iu);
  assert.match(
    contract.transaction_boundary.new_class_exception,
    /no target row exists before insert/iu,
  );
  assert.deepEqual(
    contract.protected_transitions
      .find(({ id }) => id === "create_class_with_teacher_and_invite")
      .required_lock_order.slice(0, 5),
    [
      "users:actor",
      "class_members:current-by-user",
      "teacher_profiles:actor",
      "schools:identity",
      "classes:new-row",
    ],
  );
  assert.match(contract.transaction_boundary.caller_pre_call_lock_requirement, /before CALL/iu);
  assert.match(contract.transaction_boundary.caller_pre_call_lock_requirement, /atomically/iu);
  assert.match(
    contract.transaction_boundary.final_assertion_serialization,
    /sole.*serialization fence/iu,
  );
  assert.match(
    contract.transaction_boundary.final_assertion_serialization,
    /nonlocking READ-COMMITTED/iu,
  );
  assert.match(
    contract.transaction_boundary.final_assertion_serialization,
    /never takes.*user\/profile lock/iu,
  );
  assert.match(contract.transaction_boundary.final_assertion_serialization, /atomically/iu);
  assert.deepEqual(
    contract.protected_transitions
      .find(({ id }) => id === "request_class_membership")
      .required_lock_order.slice(0, 4),
    [
      "users:actor",
      "class_members:current-by-user",
      "teacher_profiles:actor-absence",
      "classes:invite-target",
    ],
  );
  for (const transition of contract.protected_transitions.filter(
    ({ id }) => !["create_class_with_teacher_and_invite", "request_class_membership"].includes(id),
  )) {
    assert.match(transition.required_lock_order[0], /^users:/u, transition.id);
    assert.match(transition.required_lock_order[1], /^classes:/u, transition.id);
  }
  for (const transaction of contract.column_scoped_transactions) {
    assert.match(transaction.required_lock_order[0], /^users:/u, transaction.id);
    assert.match(transaction.required_lock_order[1], /^classes:/u, transaction.id);
  }
  assert.match(contract.routine_interface.invite_collision_handling, /last diagnostic condition/iu);
  assert.match(contract.routine_interface.invite_collision_handling, /MYSQL_ERRNO 1062/iu);
  assert.match(contract.routine_interface.invite_collision_handling, /MESSAGE_TEXT suffix/iu);
  assert.match(contract.routine_interface.invite_collision_handling, /RESIGNAL/iu);
  assert.match(
    contract.routine_interface.invite_collision_handling,
    /diagnostic and concurrency proof/iu,
  );
});

test("all twelve protected transitions have owners, evidence, locks, and fail-closed gates", () => {
  assert.deepEqual(
    contract.protected_transitions.map(({ id }) => id),
    expectedProtectedTransitions,
  );
  assert.equal(new Set(expectedProtectedTransitions).size, 12);

  for (const transition of contract.protected_transitions) {
    assert.ok(["classhub_app", "classhub_operator"].includes(transition.runtime_identity));
    transition.sources.forEach(assertSourceCoordinate);
    assert.ok(transition.invariant_writes.length > 0, `${transition.id}: missing writes`);
    assert.ok(transition.required_lock_order.length > 0, `${transition.id}: missing lock order`);
    assert.ok(
      transition.caller_transaction_dependencies.length > 0,
      `${transition.id}: missing caller transaction dependencies`,
    );
    assert.ok(
      transition.future_phase_dependencies.length > 0,
      `${transition.id}: must name its unavailable phase dependency`,
    );
    assert.equal(transition.required_final_assertion, true);
    assert.deepEqual(
      transition.caller_transaction_dependencies,
      expectedTransitionDependencies[transition.id].caller,
    );
    assert.deepEqual(
      transition.future_phase_dependencies,
      expectedTransitionDependencies[transition.id].future,
    );
    assert.deepEqual(
      transition.post_commit_effects ?? [],
      expectedTransitionDependencies[transition.id].postCommit,
    );
  }

  assert.equal(
    contract.protected_transitions.filter(
      ({ runtime_identity }) => runtime_identity === "classhub_operator",
    ).length,
    1,
  );
});

test("exact status transitions include the measured rejoin and approval sequence", () => {
  const transitions = Object.fromEntries(
    contract.protected_transitions.map(({ id, status_transitions: states }) => [id, states]),
  );
  assert.deepEqual(transitions, {
    create_class_with_teacher_and_invite: ["null->approved:teacher"],
    archive_class: [
      "active->archived:class",
      "pending->canceled:student",
      "approved->archived:member",
    ],
    rotate_class_invite: [],
    request_class_membership: [
      "null->pending",
      "rejected->pending",
      "canceled->pending",
      "left->pending",
      "rejoin_allowed->pending",
    ],
    cancel_class_membership_request: ["pending->canceled"],
    leave_class: ["approved->left"],
    approve_class_member: ["pending->approved"],
    reject_class_member: ["pending->rejected"],
    remove_class_member: ["approved->removed"],
    allow_class_member_rejoin: ["removed->rejoin_allowed"],
    delete_user_account: ["pending->account_deleted", "approved->account_deleted"],
    transfer_class_teacher: [
      "approved->transferred:teacher",
      "null->approved:teacher",
      "suspended->active:class",
    ],
  });
});

test("the two direct transactions expose only their reviewed update columns", () => {
  assert.deepEqual(contract.column_scoped_transactions, [
    {
      id: "update_class_details",
      runtime_identity: "classhub_app",
      sources: ["apps/api/src/classes/classes.service.ts:618-816"],
      table: "classes",
      update_columns: ["name", "expected_student_count", "row_version", "updated_at"],
      required_lock_order: [
        "users:actor",
        "classes:target",
        "class_members:actor",
        "teacher_profiles:actor",
      ],
      optimistic_cas: "row_version equals expected_row_version and increments by one on change",
      cas_enforcement:
        "application wiring contract; MariaDB column UPDATE privilege alone does not enforce the WHERE predicate",
      caller_transaction_dependencies: ["audit_logs"],
    },
    {
      id: "update_student_profile",
      runtime_identity: "classhub_app",
      sources: ["apps/api/src/members/members.service.ts:361-572"],
      table: "class_members",
      update_columns: ["display_name_in_class", "student_number", "row_version", "updated_at"],
      required_lock_order: [
        "users:id-ascending",
        "classes:target",
        "class_members:id-ascending",
        "teacher_profiles:actor",
      ],
      optimistic_cas: "row_version equals expected_row_version and increments by one on change",
      cas_enforcement:
        "application wiring contract; MariaDB column UPDATE privilege alone does not enforce the WHERE predicate",
      caller_transaction_dependencies: ["audit_logs"],
    },
  ]);
  contract.column_scoped_transactions
    .flatMap(({ sources }) => sources)
    .forEach(assertSourceCoordinate);
});

test("account deletion stabilizes its affected-class set and revalidates caller security", () => {
  const accountDeletion = contract.protected_transitions.find(
    ({ id }) => id === "delete_user_account",
  );
  assert.equal(
    accountDeletion.lock_set_stabilization,
    "Caller discovers affected class ids. Routine validates a bounded JSON array of positive signed BIGINT ids in strict ascending order, locks the user, locks every listed class, then current-locking-reads all memberships and requires exact distinct set equality before any write.",
  );
  assert.deepEqual(accountDeletion.class_list_bound, {
    maximum_ids: 4096,
    maximum_utf8_bytes: 131072,
    byte_limit_before_json_parse: true,
  });
  assert.match(accountDeletion.all_history_lock_path_proof, /MariaDB 11\.4/iu);
  assert.match(
    accountDeletion.all_history_lock_path_proof,
    /FORCE.*class_members_user_class_id_idx/iu,
  );
  assert.match(accountDeletion.all_history_lock_path_proof, /user_id,class_id,id/iu);
  assert.match(accountDeletion.all_history_lock_path_proof, /SHOW CREATE TABLE/iu);
  assert.match(accountDeletion.all_history_lock_path_proof, /EXPLAIN/iu);
  assert.match(accountDeletion.all_history_lock_path_proof, /concurrency traces/iu);
  assert.equal(
    accountDeletion.all_history_lock_path_activation_gate,
    "mariadb_11_4_parser_semantics_and_concurrency_passed",
  );
  assert.equal(
    contract.activation_gate_status[accountDeletion.all_history_lock_path_activation_gate],
    false,
  );
  assert.deepEqual(accountDeletion.caller_transaction_preconditions, [
    "confirmation literal equals the current API account-deletion token",
    "caller has locked the user before discovering the expected class ids without class or member row locks",
    "current session is valid after the user lock",
    "current password matches the locked users.password_hash",
    "account-deletion rate limiter is available",
    "the user is not an approved teacher of any active or suspended class",
  ]);
  assert.equal(
    accountDeletion.required_final_assertion_scope,
    "Assert every stabilized affected class in ascending class id order after the final invariant-bearing write and before commit",
  );
});

test("later-phase dependencies prevent premature parity claims", () => {
  const accountDeletion = contract.protected_transitions.find(
    ({ id }) => id === "delete_user_account",
  );
  assert.ok(accountDeletion.future_phase_dependencies.includes("0015_elections"));
  assert.deepEqual(accountDeletion.post_commit_effects, ["security_audit_event"]);

  assert.equal(contract.future_phase_activation.status, "unverified");
  assert.deepEqual(contract.future_phase_activation.activation_gates, [
    "application_dialect_and_retry_wiring_passed",
    "runtime_direct_invariant_dml_revoked",
    "runtime_execute_allowlist_proven",
    "acl_partial_failure_recovery_passed",
    "security_administrator_stage_proven",
    "runtime_acl_before_state_fingerprint_proven",
    "runtime_traffic_quiesce_and_connection_drain_proven",
  ]);
  for (const gate of contract.future_phase_activation.activation_gates) {
    assert.equal(contract.activation_gate_status[gate], false);
  }
  assert.match(
    contract.future_phase_activation.requirement,
    /every entry named in caller_transaction_dependencies and future_phase_dependencies.*exact dependency artifact map.*target manifest\/schema.*same caller transaction.*rollback fault proof/iu,
  );
  assert.match(contract.future_phase_activation.requirement, /post_commit_effects.*after-commit/iu);
  assert.match(
    contract.future_phase_activation.requirement,
    /complete desired-state ACL.*nonempty dependency list is not activation evidence.*no partial phase parity/iu,
  );
  const manifestTablesByPhase = Object.fromEntries(
    manifest.phases.map(({ id, tables }) => [id, [...tables].sort()]),
  );
  const artifactMap = contract.future_phase_activation.dependency_artifact_map;
  for (const [phase, tables] of Object.entries(artifactMap)) {
    if (phase.startsWith("post_commit:")) continue;
    for (const table of tables)
      assert.ok(manifestTablesByPhase[phase].includes(table), `${phase}:${table}`);
  }
  const mappedArtifacts = new Set(Object.values(artifactMap).flat());
  for (const dependency of Object.values(expectedTransitionDependencies).flatMap(
    ({ caller }) => caller,
  )) {
    assert.ok(mappedArtifacts.has(dependency), `unmapped caller dependency: ${dependency}`);
  }
  assert.deepEqual(artifactMap["post_commit:security_audit_event"], ["security_audit_logs"]);

  const transfer = contract.protected_transitions.find(({ id }) => id === "transfer_class_teacher");
  assert.match(transfer.cross_class_current_membership_fence, /incoming user lock/iu);
  assert.match(transfer.cross_class_current_membership_fence, /another class/iu);
  assert.match(transfer.cross_class_current_membership_fence, /Class-wide archive/iu);
  assert.ok(transfer.caller_transaction_dependencies.includes("operator_audit_logs"));
  assert.deepEqual(transfer.caller_audit_requirements, [
    "always append class.teacher_transferred and teacher.transferred records in the same transaction",
    "when the locked target was suspended, also append class.reactivated to both class and operator audit logs using the routine timestamp",
  ]);
  assert.deepEqual(transfer.routine_preconditions, [
    "incoming teacher profile is active and temporary_password_must_change is false",
    "incoming user has no current membership",
    "incoming user has no prior member row in the target class",
    "a suspended target is reactivated and all suspended metadata is cleared in the same transaction",
  ]);
});

test("the isolated-QA definer file creates one passwordless locked account and nothing broad", () => {
  const sql = withoutComments(accountProvisioning);
  assert.match(sql, /^\s*CREATE\s+USER\s+'classhub_routine'@'%'\s+ACCOUNT\s+LOCK\s*;\s*$/iu);
  assert.doesNotMatch(sql, /\b(?:IDENTIFIED|PASSWORD|CREATE\s+ROLE|GRANT|REVOKE|DROP)\b/iu);
});

test("the locked-owner read envelope is exact-object and grants no runtime helper execution", () => {
  const readSql = withoutComments(helperGrants);
  const executeSql = withoutComments(helperExecuteGrants);
  const sql = `${readSql}\n${executeSql}`;
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const normalizedStatements = statements.map((statement) => statement.replace(/\s+/gu, " "));
  assert.deepEqual(normalizedStatements, [
    "GRANT SELECT ( id, name, academic_year, grade, edu_office_code, school_code, name_normalized, status, row_version ) ON classhub_mariadb_phase1_dev.classes TO 'classhub_routine'@'%'",
    "GRANT SELECT (id, class_id, user_id, role, status, row_version, current_user_id) ON classhub_mariadb_phase1_dev.class_members TO 'classhub_routine'@'%'",
    "GRANT SELECT (id, is_active, deleted_at, email_verified_at) ON classhub_mariadb_phase1_dev.users TO 'classhub_routine'@'%'",
    "GRANT SELECT (user_id, status, temporary_password_must_change) ON classhub_mariadb_phase1_dev.teacher_profiles TO 'classhub_routine'@'%'",
    "GRANT SELECT (id, class_id, code, expires_at, revoked_at) ON classhub_mariadb_phase1_dev.class_invite_codes TO 'classhub_routine'@'%'",
    "GRANT SELECT (edu_office_code, school_code, school_kind) ON classhub_mariadb_phase1_dev.schools TO 'classhub_routine'@'%'",
    "GRANT SELECT ( member_id, class_id, from_status, to_status, actor_user_id, actor_member_id, actor_operator_id ) ON classhub_mariadb_phase1_dev.class_member_status_history TO 'classhub_routine'@'%'",
    "GRANT TRIGGER ON classhub_mariadb_phase1_dev.class_member_status_history TO 'classhub_routine'@'%'",
    "GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.assert_read_committed_session TO 'classhub_routine'@'%'",
    "GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.lock_class_invariant_boundary TO 'classhub_routine'@'%'",
    "GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.assert_class_invariants TO 'classhub_routine'@'%'",
  ]);
  for (const statement of normalizedStatements) {
    assert.match(statement, /TO\s+'classhub_routine'@'%'\s*$/iu);
    assert.doesNotMatch(statement, /\*\.\*|classhub_mariadb_phase1_dev\.\*/iu);
  }
  assert.equal((readSql.match(/^GRANT\s+SELECT\s*\(/gimu) ?? []).length, 7);
  assert.equal((readSql.match(/^GRANT\s+SELECT\s+ON\s+performance_schema\./gimu) ?? []).length, 0);
  assert.equal((readSql.match(/^GRANT\s+TRIGGER\b/gimu) ?? []).length, 1);
  assert.equal((executeSql.match(/^GRANT\s+EXECUTE\b/gimu) ?? []).length, 3);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT\s+OPTION)\b/iu);
  assert.doesNotMatch(sql, /\bPROCESS\b/iu);
  assert.doesNotMatch(sql, /'classhub_(?:app|operator|worker|retention|migrator)'@'%'/iu);
});

test("the locked owner can enter exactly the twelve transition routines", () => {
  const sql = withoutComments(transitionOwnerExecuteGrants);
  const grants = [
    ...sql.matchAll(
      /GRANT\s+EXECUTE\s+ON\s+PROCEDURE\s+classhub_mariadb_phase1_dev\.([a-z0-9_]+)\s+TO\s+'classhub_routine'@'%'/giu,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(grants.sort(), [...expectedProtectedTransitions].sort());
  assert.equal(grants.length, 12);
  assert.doesNotMatch(sql, /'classhub_(?:app|operator|worker|retention|migrator)'@'%'/iu);
  assert.doesNotMatch(
    sql,
    /\b(?:SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|PROCESS|GRANT\s+OPTION)\b/iu,
  );
});

test("the history trigger uses the same explicit locked-owner identity", () => {
  assert.match(
    membershipMigration,
    /CREATE\s+DEFINER\s*=\s*'classhub_routine'@'%'\s+TRIGGER\s+class_member_status_history_validate/iu,
  );
});

test("activation remains blocked on all eleven measured gates", () => {
  assert.deepEqual(contract.activation_gates, [
    "routine_ownership_decision_approved",
    "runtime_credential_threat_model_approved",
    "twelve_transition_routines_implemented",
    "runtime_direct_invariant_dml_revoked",
    "runtime_execute_allowlist_proven",
    "mariadb_11_4_parser_semantics_and_concurrency_passed",
    "application_dialect_and_retry_wiring_passed",
    "acl_partial_failure_recovery_passed",
    "security_administrator_stage_proven",
    "runtime_acl_before_state_fingerprint_proven",
    "runtime_traffic_quiesce_and_connection_drain_proven",
  ]);
  assert.deepEqual(contract.activation_gate_status, {
    routine_ownership_decision_approved: true,
    runtime_credential_threat_model_approved: false,
    twelve_transition_routines_implemented:
      "parser_installed_single_transition_smoke_verified_full_semantics_blocked",
    runtime_direct_invariant_dml_revoked: false,
    runtime_execute_allowlist_proven: false,
    mariadb_11_4_parser_semantics_and_concurrency_passed: false,
    application_dialect_and_retry_wiring_passed: false,
    acl_partial_failure_recovery_passed: false,
    security_administrator_stage_proven: false,
    runtime_acl_before_state_fingerprint_proven: false,
    runtime_traffic_quiesce_and_connection_drain_proven: false,
  });
  assert.deepEqual(contract.runtime_acl_recovery, {
    dcl_atomic: false,
    mode: "fail_closed_full_runtime_reconcile",
    broad_users_write_restored: false,
    partial_failure_requirement:
      "Exercise the reconcile after failure at every activation statement boundary and prove the exact safe grants fingerprint",
    apply_identity:
      "separate reviewed security administrator; the phase-0001 migrator is insufficient",
    scope:
      "phase-0001 plus phase-0002 exact runtime envelope only; later-phase roles or grants require a regenerated complete desired-state reconcile",
    before_state_requirement:
      "Exact effective grants and assigned roles for all four runtime identities match the approved fingerprint with no out-of-band privilege",
    traffic_transition_requirement:
      "Enter maintenance write-quiesce, prove zero active runtime transactions, drain all four runtime identities' connections, reconcile, open fresh probe connections, prove positive/negative ACL and the exact fingerprint, then explicitly resume traffic",
  });
});
