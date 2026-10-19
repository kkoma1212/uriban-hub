import assert from "node:assert/strict";

// Build the reviewed candidate without applying it. PostgreSQL source grants are
// narrowed at the existing MariaDB invariant boundary; all other grants survive.
export function buildSemanticAclCandidate(source) {
  const roles = globalThis.structuredClone(source.roles);
  roles.classhub_app.users.INSERT = [
    "email_normalized",
    "display_name",
    "password_hash",
    "password_input_version",
    "signup_approved_at",
  ];
  roles.classhub_app.users.UPDATE = [
    "display_name",
    "email_verified_at",
    "failed_login_attempts",
    "locked_until",
    "password_hash",
    "password_input_version",
    "password_last_changed_at",
    "signup_approved_at",
    "updated_at",
  ];
  roles.classhub_app.classes = {
    SELECT: "*",
    UPDATE: ["name", "expected_student_count", "row_version", "updated_at"],
  };
  roles.classhub_app.class_members = {
    SELECT: "*",
    UPDATE: ["display_name_in_class", "student_number", "row_version", "updated_at"],
  };
  roles.classhub_app.class_invite_codes = { SELECT: "*" };
  roles.classhub_app.class_member_status_history = { SELECT: "*" };
  delete roles.classhub_operator.class_members.INSERT;
  delete roles.classhub_operator.class_members.UPDATE;
  delete roles.classhub_operator.class_member_status_history;
  const procedures = {
    classhub_app: [
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
    ],
    classhub_operator: ["transfer_class_teacher_checked"],
    classhub_worker: [],
    classhub_retention: [],
  };
  for (const tables of Object.values(roles))
    for (const grants of Object.values(tables))
      for (const value of Object.values(grants)) if (Array.isArray(value)) value.sort();
  return {
    roles,
    procedures,
    activationApplied: false,
    invariantBoundary: "phase0002_direct_lifecycle_writes_remain_forbidden",
    callerAuthorizationAndRollback: "activation_blocker",
    administratorMembershipAdapter: "activation_blocker",
  };
}

export function renderSemanticAcl(candidate, probe = false) {
  const result = [];
  for (const [role, tables] of Object.entries(candidate.roles)) {
    assert.match(role, /^classhub_(?:app|operator|worker|retention)$/u);
    const grantee = `'${probe ? role.replace("classhub_", "classhub_probe_") : role}'@'%'`;
    for (const [table, grants] of Object.entries(tables).sort()) {
      assert.match(table, /^[a-z_]+$/u);
      const clauses = Object.entries(grants)
        .sort()
        .map(([privilege, columns]) => {
          assert.ok(["SELECT", "INSERT", "UPDATE", "DELETE"].includes(privilege));
          if (columns === "*") return privilege;
          assert.ok(Array.isArray(columns) && columns.length > 0);
          for (const column of columns) assert.match(column, /^[a-z_][a-z0-9_]*$/u);
          return `${privilege} (${columns.map((column) => `\`${column}\``).join(", ")})`;
        });
      result.push(
        `GRANT ${clauses.join(", ")} ON classhub_mariadb_phase1_dev.\`${table}\` TO ${grantee};`,
      );
    }
    for (const procedure of candidate.procedures[role]) {
      assert.match(procedure, /^[a-z_]+$/u);
      result.push(
        `GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.${procedure} TO ${grantee};`,
      );
    }
  }
  return result.join("\n") + "\n";
}
