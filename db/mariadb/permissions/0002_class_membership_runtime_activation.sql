-- T-HUB-62 phase-0002 runtime least-privilege activation draft.
--
-- DO NOT APPLY THIS FILE YET.
--
-- This is intentionally separate from routine creation and definer grants.
-- Apply remains forbidden until parser, ACL, recovery, concurrency, privileged
-- execution-stage, and app-wiring gates pass on the pinned MariaDB 11.4 image.
-- In particular, column grants below do not force the two caller-owned
-- row_version predicates.
-- Option A also trusts the app/operator adapters to own full rollback. Do not
-- activate while the runtime-credential threat model is unapproved or before
-- cut-point, error-then-COMMIT, rollback-only, and pooled-connection reuse probes
-- pass. If arbitrary SQL with a stolen EXECUTE credential must be contained by
-- the database boundary, reopen the routine ownership design first: actor/user/
-- operator id parameters are not database-bound authorization proof, and the
-- two direct UPDATE grants do not enforce row scope or row-version CAS.
--
-- MariaDB DCL is not caller-transactional. This file is a desired-state
-- reconcile rather than a delta: it first clears every privilege from all four
-- runtime identities in one statement, then rebuilds the complete reviewed
-- phase-0001 + phase-0002 envelope. It is therefore safe to retry after the
-- paired fail-closed reconcile. A security administrator must keep an exact
-- before-state/step ledger and prove recovery after every statement boundary.
-- This phase-scoped file must not run if any later-phase or out-of-band runtime
-- grant/role exists; regenerate and review the complete desired-state envelope
-- instead of erasing privileges that are outside the phase-0002 inventory.
-- Before the first statement, enter maintenance write-quiesce, prove zero active
-- runtime transactions, and drain every connection for these four identities.
-- Do not admit a fresh runtime connection until the complete grant fingerprint
-- and positive/negative probes pass; then resume traffic explicitly.

REVOKE ALL PRIVILEGES, GRANT OPTION
  FROM 'classhub_app'@'%',
       'classhub_operator'@'%',
       'classhub_retention'@'%',
       'classhub_worker'@'%';

-- Rebuild the safe phase-0001 app envelope. Account lifecycle columns are
-- routine-only; the former table-wide users INSERT/UPDATE is never restored.
GRANT SELECT
  ON classhub_mariadb_phase1_dev.users
  TO 'classhub_app'@'%';
GRANT INSERT (email_normalized, display_name, password_hash)
  ON classhub_mariadb_phase1_dev.users
  TO 'classhub_app'@'%';
GRANT SELECT, INSERT, UPDATE
  ON classhub_mariadb_phase1_dev.user_consents
  TO 'classhub_app'@'%';
GRANT SELECT, INSERT, UPDATE
  ON classhub_mariadb_phase1_dev.email_verification_tokens
  TO 'classhub_app'@'%';
GRANT SELECT, INSERT, UPDATE
  ON classhub_mariadb_phase1_dev.password_reset_tokens
  TO 'classhub_app'@'%';
GRANT SELECT, INSERT, UPDATE
  ON classhub_mariadb_phase1_dev.sessions
  TO 'classhub_app'@'%';
GRANT SELECT, INSERT, DELETE
  ON classhub_mariadb_phase1_dev.api_idempotency_keys
  TO 'classhub_app'@'%';
GRANT UPDATE (
    display_name,
    email_verified_at,
    failed_login_attempts,
    locked_until,
    password_hash,
    password_last_changed_at,
    updated_at
  )
  ON classhub_mariadb_phase1_dev.users
  TO 'classhub_app'@'%';

GRANT SELECT
  ON classhub_mariadb_phase1_dev.classes
  TO 'classhub_app'@'%';
GRANT SELECT
  ON classhub_mariadb_phase1_dev.class_members
  TO 'classhub_app'@'%';
GRANT SELECT
  ON classhub_mariadb_phase1_dev.class_member_status_history
  TO 'classhub_app'@'%';
GRANT SELECT
  ON classhub_mariadb_phase1_dev.class_invite_codes
  TO 'classhub_app'@'%';
GRANT SELECT
  ON classhub_mariadb_phase1_dev.teacher_profiles
  TO 'classhub_app'@'%';
GRANT SELECT
  ON classhub_mariadb_phase1_dev.schools
  TO 'classhub_app'@'%';

-- These are the only direct phase-0002 app writes. Their optimistic CAS is an
-- application contract and must be proven by dialect/wiring tests.
GRANT UPDATE (name, expected_student_count, row_version, updated_at)
  ON classhub_mariadb_phase1_dev.classes
  TO 'classhub_app'@'%';
GRANT UPDATE (display_name_in_class, student_number, row_version, updated_at)
  ON classhub_mariadb_phase1_dev.class_members
  TO 'classhub_app'@'%';
GRANT UPDATE (temporary_password_must_change, temporary_password_expires_at)
  ON classhub_mariadb_phase1_dev.teacher_profiles
  TO 'classhub_app'@'%';

GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.create_class_with_teacher_and_invite
  TO 'classhub_app'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.archive_class
  TO 'classhub_app'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.rotate_class_invite
  TO 'classhub_app'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.request_class_membership
  TO 'classhub_app'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.cancel_class_membership_request
  TO 'classhub_app'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.leave_class
  TO 'classhub_app'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.approve_class_member
  TO 'classhub_app'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.reject_class_member
  TO 'classhub_app'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.remove_class_member
  TO 'classhub_app'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.allow_class_member_rejoin
  TO 'classhub_app'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.delete_user_account
  TO 'classhub_app'@'%';

-- Operator onboarding/import and password reissue retain exact column access;
-- class transfer itself is routine-only.
GRANT SELECT (id, credential_hash, status, revoked_at),
  INSERT (email_normalized, credential_hash)
  ON classhub_mariadb_phase1_dev.operators
  TO 'classhub_operator'@'%';
GRANT SELECT (id, email_normalized, is_active, deleted_at),
  INSERT (email_normalized, display_name, password_hash, email_verified_at),
  UPDATE (password_hash)
  ON classhub_mariadb_phase1_dev.users
  TO 'classhub_operator'@'%';
GRANT SELECT (
    user_id,
    status,
    temporary_password_expires_at
  ),
  INSERT (
    user_id,
    temporary_password_must_change,
    temporary_password_expires_at,
    created_by_operator_id
  ),
  UPDATE (temporary_password_must_change, temporary_password_expires_at)
  ON classhub_mariadb_phase1_dev.teacher_profiles
  TO 'classhub_operator'@'%';
GRANT SELECT (
    edu_office_code,
    school_code,
    school_name,
    school_kind,
    region_name,
    edu_office_name,
    road_address,
    road_address_detail,
    phone_number,
    homepage_url
  ),
  INSERT (
    edu_office_code,
    school_code,
    school_name,
    school_kind,
    region_name,
    edu_office_name,
    road_address,
    road_address_detail,
    phone_number,
    homepage_url
  ),
  UPDATE (
    school_name,
    school_kind,
    region_name,
    edu_office_name,
    road_address,
    road_address_detail,
    phone_number,
    homepage_url,
    updated_at
  )
  ON classhub_mariadb_phase1_dev.schools
  TO 'classhub_operator'@'%';
GRANT SELECT (id, status, suspended_reason, edu_office_code, school_code, grade)
  ON classhub_mariadb_phase1_dev.classes
  TO 'classhub_operator'@'%';
GRANT SELECT (id, class_id, user_id, role, status)
  ON classhub_mariadb_phase1_dev.class_members
  TO 'classhub_operator'@'%';
GRANT SELECT (user_id, revoked_at), UPDATE (revoked_at)
  ON classhub_mariadb_phase1_dev.sessions
  TO 'classhub_operator'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.transfer_class_teacher
  TO 'classhub_operator'@'%';

-- Retention can address temporary-password reminders but cannot alter account,
-- membership, class, invite, or transition state.
GRANT SELECT, DELETE
  ON classhub_mariadb_phase1_dev.api_idempotency_keys
  TO 'classhub_retention'@'%';
GRANT SELECT, DELETE
  ON classhub_mariadb_phase1_dev.sessions
  TO 'classhub_retention'@'%';
GRANT SELECT, DELETE
  ON classhub_mariadb_phase1_dev.email_verification_tokens
  TO 'classhub_retention'@'%';
GRANT SELECT, DELETE
  ON classhub_mariadb_phase1_dev.password_reset_tokens
  TO 'classhub_retention'@'%';
GRANT SELECT (id, email_normalized, is_active, deleted_at)
  ON classhub_mariadb_phase1_dev.users
  TO 'classhub_retention'@'%';
GRANT SELECT (
    user_id,
    status,
    temporary_password_must_change,
    temporary_password_expires_at,
    temporary_password_reminder_sent_at
  ),
  UPDATE (temporary_password_reminder_sent_at)
  ON classhub_mariadb_phase1_dev.teacher_profiles
  TO 'classhub_retention'@'%';

-- classhub_worker intentionally receives no phase-0002 privilege.
-- No runtime identity receives EXECUTE on lock_class_invariant_boundary or
-- assert_class_invariants.
