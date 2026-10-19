-- T-HUB-62 MariaDB phase-0002 class-invariant boundary companion draft.
-- Provisional target: MariaDB 11.4 LTS. Requires the phase-0001 `users` table
-- and all seven tables from `0002_class_membership.sql`.
--
-- ISOLATED SYNTHETIC QA ONLY. DO NOT APPLY TO A SHARED OR PRODUCTION DATABASE.
--
-- The fixed development placeholder definer is `classhub_routine`@`%`.
-- It is deliberately separate from the five login identities in the current
-- operations contract. Unmounted permission drafts express its ACCOUNT LOCK
-- development shape and the exact read/TRIGGER envelope. A reviewed activation
-- stage must still replace `%` with the approved exact private host. This file
-- itself creates no account and grants no privilege.
--
-- PostgreSQL semantic source:
--   db/migrations/1783700001000_class-membership-foundation.sql:302-430
-- MariaDB locking design source:
--   PRD/ADR-002_MariaDB_전환_결정.md:74-86
--
-- Required caller-owned transaction contract for every protected transition:
--   1. Use READ-COMMITTED for the complete caller transaction.
--   2. Perform caller-owned auth and required users-first locks without holding
--      a class/member lock in the opposite order.
--   3. Invoke the reviewed invariant-core routine in that transaction. The
--      routine, not the runtime caller, invokes both low-level helpers.
--   4. Persist caller-owned audit/idempotency/later cleanup in the transaction.
--   5. Commit only after every step succeeds; otherwise roll back the whole unit.
-- Neither procedure starts, commits, or rolls back a transaction.
--
-- FAIL-CLOSED ACTIVATION BLOCKER:
-- These helpers do not prevent direct table DML. Runtime activation remains
-- forbidden until direct writes to protected tables/columns are revoked and
-- EXECUTE is granted only on reviewed protected-transition routines. Of the 14
-- current logical mutation paths, 12 require routines and two may retain exact
-- column-scoped app DML because they cannot change either cross-table invariant:
--   01 ROUTINE create_class_with_teacher_and_invite
--   02 ROUTINE archive_class
--   03 COLUMN_SCOPED_APP_TX update_class_details
--   04 ROUTINE rotate_class_invite
--   05 ROUTINE request_class_membership
--   06 ROUTINE cancel_class_membership_request
--   07 ROUTINE leave_class
--   08 ROUTINE approve_class_member
--   09 COLUMN_SCOPED_APP_TX update_student_profile
--   10 ROUTINE reject_class_member
--   11 ROUTINE remove_class_member
--   12 ROUTINE allow_class_member_rejoin
--   13 ROUTINE delete_user_account
--   14 ROUTINE transfer_class_teacher
-- Future class suspend/reactivate and teacher-profile lifecycle commands also
-- require protected routines before either feature may receive write access.
-- See `verification/0002_class_invariant_boundary_gaps.md` for the remaining
-- ACL, parser, application, and concurrency blockers.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

DELIMITER //

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE assert_read_committed_session()
SQL SECURITY DEFINER
READS SQL DATA
COMMENT 'Fail closed unless the caller session default is READ COMMITTED'
BEGIN
  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30001,
          MESSAGE_TEXT = 'protected transition requires a caller transaction';
  END IF;

  IF BINARY @@SESSION.transaction_isolation <> BINARY 'READ-COMMITTED' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30006,
          MESSAGE_TEXT = 'protected transition requires READ-COMMITTED';
  END IF;
END//

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE lock_class_invariant_boundary(
  IN target_class_id BIGINT
)
SQL SECURITY DEFINER
READS SQL DATA
COMMENT 'Lock one class before an invariant-bearing transition'
BEGIN
  DECLARE locked_class_id BIGINT DEFAULT NULL;
  DECLARE class_not_found BOOLEAN DEFAULT FALSE;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET class_not_found = TRUE;

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30001,
          MESSAGE_TEXT = 'class invariant boundary requires a caller transaction';
  END IF;

  CALL assert_read_committed_session();

  SELECT id
  INTO locked_class_id
  FROM classes
  WHERE id = target_class_id
  FOR UPDATE;

  IF class_not_found OR locked_class_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30002,
          MESSAGE_TEXT = 'class invariant boundary target does not exist';
  END IF;
END//

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE assert_class_invariants(
  IN target_class_id BIGINT
)
SQL SECURITY DEFINER
READS SQL DATA
COMMENT 'Validate the final state of one locked class transition'
BEGIN
  DECLARE locked_class_id BIGINT DEFAULT NULL;
  DECLARE class_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE active_teacher_count BIGINT DEFAULT 0;
  DECLARE current_member_count BIGINT DEFAULT 0;
  DECLARE open_invite_count BIGINT DEFAULT 0;
  DECLARE class_not_found BOOLEAN DEFAULT FALSE;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET class_not_found = TRUE;

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30001,
          MESSAGE_TEXT = 'class invariant assertion requires a caller transaction';
  END IF;

  CALL assert_read_committed_session();

  -- This class row is the transaction-wide serialization fence. The dependent
  -- aggregates below use fresh READ-COMMITTED statement snapshots so they do not
  -- acquire user/profile locks after this class lock.
  SELECT id, status
  INTO locked_class_id, class_status
  FROM classes
  WHERE id = target_class_id
  FOR UPDATE;

  IF class_not_found OR locked_class_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30002,
          MESSAGE_TEXT = 'class invariant assertion target does not exist';
  END IF;

  IF BINARY class_status = BINARY 'active' THEN
    -- The locked class row is the serialization fence for every compliant
    -- invariant writer. Under the enforced READ-COMMITTED isolation this one
    -- statement sees the latest committed dependent rows plus this transaction's
    -- own writes. Deliberately do not lock teacher user/profile rows here: taking
    -- them after the class lock would invert the governing users-before-classes
    -- order and can deadlock with a teacher lifecycle transaction.
    SELECT COUNT(member.id)
    INTO active_teacher_count
    FROM class_members AS member
    INNER JOIN users AS teacher_user
      ON teacher_user.id = member.user_id
    INNER JOIN teacher_profiles AS teacher_profile
      ON teacher_profile.user_id = member.user_id
    WHERE member.class_id = target_class_id
      AND BINARY member.role = BINARY 'teacher'
      AND BINARY member.status = BINARY 'approved'
      AND teacher_user.is_active = TRUE
      AND teacher_user.deleted_at IS NULL
      AND BINARY teacher_profile.status = BINARY 'active';

    IF active_teacher_count <> 1 THEN
      SIGNAL SQLSTATE '45000'
        SET MYSQL_ERRNO = 30003,
            MESSAGE_TEXT = 'active class requires exactly one active approved teacher';
    END IF;
  END IF;

  IF BINARY class_status = BINARY 'archived' THEN
    -- The same class serialization fence makes dependent row locks unnecessary.
    -- A piecemeal caller/ACL cutover would invalidate this assumption and is an
    -- activation blocker, not a supported intermediate state.
    SELECT COUNT(member.id)
    INTO current_member_count
    FROM class_members AS member
    WHERE member.class_id = target_class_id
      AND BINARY member.status IN (BINARY 'pending', BINARY 'approved');

    IF current_member_count <> 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MYSQL_ERRNO = 30004,
            MESSAGE_TEXT = 'archived class cannot retain current members';
    END IF;

    SELECT COUNT(invite.class_id)
    INTO open_invite_count
    FROM class_invite_codes AS invite
    WHERE invite.class_id = target_class_id
      AND invite.revoked_at IS NULL;

    IF open_invite_count <> 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MYSQL_ERRNO = 30005,
            MESSAGE_TEXT = 'archived class cannot retain an open invite';
    END IF;
  END IF;
END//

DELIMITER ;
