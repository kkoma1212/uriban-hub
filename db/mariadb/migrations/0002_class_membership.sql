-- T-HUB-62 MariaDB baseline phase 0002 draft (development only).
-- Provisional target: MariaDB 11.4 LTS. Requires phase 0001 `users`.
-- Apply only through the guarded phase-2 runner to its labeled, tmpfs-backed,
-- synthetic QA database. Production/runtime activation remains blocked by
-- `db/mariadb/verification/0002_class_membership_gaps.md`.
--
-- PostgreSQL final-state source map:
--   - db/migrations/1783700001000_class-membership-foundation.sql:3-300
--     (seven tables, partial unique indexes, status-history validation trigger)
--   - db/migrations/1783700014000_neis-school-details.sql:3-40
--     (final `schools` detail columns and checks)
--   - db/migrations/1783700023000_temporary-password-reminder.sql:10-11
--     (final `teacher_profiles.temporary_password_reminder_sent_at` column)
-- PostgreSQL deferred cross-table invariants at 1783700001000:302-430 are not
-- silently weakened here; their fail-closed disposition is recorded in the gaps file.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

-- PostgreSQL source: 1783700001000:3-19.
CREATE TABLE operators (
  id BIGINT NOT NULL AUTO_INCREMENT,
  email_normalized VARCHAR(320) NOT NULL,
  credential_hash VARBINARY(32) NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active',
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  revoked_at DATETIME(6),
  PRIMARY KEY (id),
  CONSTRAINT operators_email_normalized_unique UNIQUE (email_normalized),
  CONSTRAINT operators_credential_hash_unique UNIQUE (credential_hash),
  CONSTRAINT operators_email_check CHECK (
    OCTET_LENGTH(email_normalized) = OCTET_LENGTH(TRIM(email_normalized))
    AND BINARY email_normalized = BINARY LOWER(email_normalized)
    AND email_normalized <> ''
  ),
  CONSTRAINT operators_credential_hash_check CHECK (
    OCTET_LENGTH(credential_hash) = 32
  ),
  CONSTRAINT operators_status_check CHECK (
    BINARY status IN (BINARY 'active', BINARY 'revoked')
  ),
  CONSTRAINT operators_revoke_state_check CHECK (
    (BINARY status = BINARY 'active' AND revoked_at IS NULL)
    OR (BINARY status = BINARY 'revoked' AND revoked_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- PostgreSQL sources: 1783700001000:21-51; final column 1783700023000:10-11.
CREATE TABLE teacher_profiles (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active',
  temporary_password_must_change BOOLEAN NOT NULL,
  temporary_password_expires_at DATETIME(6),
  temporary_password_reminder_sent_at DATETIME(6),
  created_by_operator_id BIGINT NOT NULL,
  revoked_by_operator_id BIGINT,
  revoked_at DATETIME(6),
  revoke_reason VARCHAR(300),
  PRIMARY KEY (id),
  CONSTRAINT teacher_profiles_user_unique UNIQUE (user_id),
  CONSTRAINT teacher_profiles_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT teacher_profiles_created_by_operator_fk
    FOREIGN KEY (created_by_operator_id) REFERENCES operators (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT teacher_profiles_revoked_by_operator_fk
    FOREIGN KEY (revoked_by_operator_id) REFERENCES operators (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT teacher_profiles_status_check CHECK (
    BINARY status IN (BINARY 'active', BINARY 'revoked')
  ),
  CONSTRAINT teacher_profiles_temporary_password_boolean_check CHECK (
    temporary_password_must_change IN (FALSE, TRUE)
  ),
  CONSTRAINT teacher_profiles_temporary_password_check CHECK (
    (
      temporary_password_must_change = TRUE
      AND temporary_password_expires_at IS NOT NULL
    )
    OR
    (
      temporary_password_must_change = FALSE
      AND temporary_password_expires_at IS NULL
    )
  ),
  CONSTRAINT teacher_profiles_revoke_state_check CHECK (
    (
      BINARY status = BINARY 'active'
      AND revoked_by_operator_id IS NULL
      AND revoked_at IS NULL
      AND revoke_reason IS NULL
    )
    OR
    (
      BINARY status = BINARY 'revoked'
      AND revoked_by_operator_id IS NOT NULL
      AND revoked_at IS NOT NULL
      AND (revoke_reason IS NULL OR CHAR_LENGTH(revoke_reason) <= 300)
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- PostgreSQL sources: 1783700001000:53-71; final columns/checks 1783700014000:3-40.
CREATE TABLE schools (
  edu_office_code VARCHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  school_code VARCHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  school_name TEXT NOT NULL,
  school_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  region_name TEXT NOT NULL,
  edu_office_name TEXT NOT NULL,
  road_address VARCHAR(200),
  road_address_detail VARCHAR(200),
  phone_number VARCHAR(50),
  homepage_url VARCHAR(500),
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (edu_office_code, school_code),
  CONSTRAINT schools_edu_office_code_check CHECK (
    OCTET_LENGTH(edu_office_code) = 3
    AND edu_office_code REGEXP '^[A-Z][0-9]{2}$'
  ),
  CONSTRAINT schools_school_code_check CHECK (
    OCTET_LENGTH(school_code) = 7
    AND school_code REGEXP '^[0-9]{7}$'
  ),
  CONSTRAINT schools_kind_check CHECK (
    BINARY school_kind IN (BINARY 'elementary', BINARY 'middle', BINARY 'high')
  ),
  CONSTRAINT schools_text_check CHECK (
    CHAR_LENGTH(TRIM(school_name)) BETWEEN 1 AND 100
    AND CHAR_LENGTH(TRIM(region_name)) BETWEEN 1 AND 100
    AND CHAR_LENGTH(TRIM(edu_office_name)) BETWEEN 1 AND 100
  ),
  CONSTRAINT schools_road_address_check CHECK (
    road_address IS NULL
    OR (
      OCTET_LENGTH(road_address) = OCTET_LENGTH(TRIM(road_address))
      AND CHAR_LENGTH(road_address) BETWEEN 1 AND 200
      AND road_address NOT REGEXP '[[:cntrl:]]'
    )
  ),
  CONSTRAINT schools_road_address_detail_check CHECK (
    road_address_detail IS NULL
    OR (
      OCTET_LENGTH(road_address_detail) = OCTET_LENGTH(TRIM(road_address_detail))
      AND CHAR_LENGTH(road_address_detail) BETWEEN 1 AND 200
      AND road_address_detail NOT REGEXP '[[:cntrl:]]'
    )
  ),
  CONSTRAINT schools_phone_number_check CHECK (
    phone_number IS NULL
    OR (
      OCTET_LENGTH(phone_number) = OCTET_LENGTH(TRIM(phone_number))
      AND CHAR_LENGTH(phone_number) BETWEEN 3 AND 50
      AND phone_number NOT REGEXP '[[:cntrl:]]'
      AND CHAR_LENGTH(REGEXP_REPLACE(phone_number, '[^0-9]', '')) BETWEEN 3 AND 20
    )
  ),
  CONSTRAINT schools_homepage_url_check CHECK (
    homepage_url IS NULL
    OR (
      OCTET_LENGTH(homepage_url) = OCTET_LENGTH(TRIM(homepage_url))
      AND CHAR_LENGTH(homepage_url) BETWEEN 8 AND 500
      AND homepage_url REGEXP '^https?://[^[:space:]]+$'
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- PostgreSQL source: 1783700001000:73-135.
-- `active_identity_name_key` is the nullable generated-key equivalent of the
-- PostgreSQL partial unique index. VARBINARY prevents PAD SPACE collation from
-- collapsing a normalized value ending in a significant space.
-- MariaDB's broad `[[:space:]]` set folds NBSP, OGHAM SPACE MARK, FIGURE SPACE,
-- and NARROW NO-BREAK SPACE while the pinned PostgreSQL en_US.utf8 source does
-- not. Keep the source's measured set explicit. UCA 14 accent-sensitive case
-- folding also preserves PostgreSQL behavior for capital sharp S and Deseret.
CREATE TABLE classes (
  id BIGINT NOT NULL AUTO_INCREMENT,
  name TEXT NOT NULL,
  name_normalized VARCHAR(40)
    GENERATED ALWAYS AS (
      LOWER(
        REGEXP_REPLACE(
          TRIM(name),
          '[\\x{0009}-\\x{000D}\\x{0020}\\x{0085}\\x{2000}-\\x{2006}\\x{2008}-\\x{200A}\\x{2028}-\\x{2029}\\x{205F}\\x{3000}]+',
          ' '
        ) COLLATE utf8mb4_uca1400_as_ci
      )
    ) STORED,
  academic_year INT NOT NULL,
  grade INT NOT NULL,
  edu_office_code VARCHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  school_code VARCHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expected_student_count INT NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active',
  row_version BIGINT NOT NULL DEFAULT 1,
  created_by_user_id BIGINT NOT NULL,
  suspended_reason TEXT,
  suspended_at DATETIME(6),
  suspended_by_operator_id BIGINT,
  archived_at DATETIME(6),
  archived_by_user_id BIGINT,
  archived_by_operator_id BIGINT,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  active_identity_name_key VARBINARY(160)
    GENERATED ALWAYS AS (
      CASE
        WHEN BINARY status IN (BINARY 'active', BINARY 'suspended')
          THEN CONVERT(name_normalized USING binary)
        ELSE NULL
      END
    ) STORED,
  PRIMARY KEY (id),
  CONSTRAINT classes_active_identity_unique UNIQUE (
    edu_office_code,
    school_code,
    academic_year,
    grade,
    active_identity_name_key
  ),
  CONSTRAINT classes_school_fk
    FOREIGN KEY (edu_office_code, school_code)
    REFERENCES schools (edu_office_code, school_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT classes_created_by_user_fk
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT classes_suspended_by_operator_fk
    FOREIGN KEY (suspended_by_operator_id) REFERENCES operators (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT classes_archived_by_user_fk
    FOREIGN KEY (archived_by_user_id) REFERENCES users (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT classes_archived_by_operator_fk
    FOREIGN KEY (archived_by_operator_id) REFERENCES operators (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT classes_name_check CHECK (
    CHAR_LENGTH(TRIM(name)) BETWEEN 1 AND 40
  ),
  CONSTRAINT classes_academic_year_check CHECK (academic_year BETWEEN 2020 AND 2100),
  CONSTRAINT classes_grade_check CHECK (grade BETWEEN 1 AND 6),
  CONSTRAINT classes_expected_student_count_check CHECK (
    expected_student_count BETWEEN 1 AND 60
  ),
  CONSTRAINT classes_status_check CHECK (
    BINARY status IN (BINARY 'active', BINARY 'suspended', BINARY 'archived')
  ),
  CONSTRAINT classes_row_version_check CHECK (row_version >= 1),
  CONSTRAINT classes_lifecycle_metadata_check CHECK (
    (
      BINARY status = BINARY 'active'
      AND suspended_reason IS NULL
      AND suspended_at IS NULL
      AND suspended_by_operator_id IS NULL
      AND archived_at IS NULL
      AND archived_by_user_id IS NULL
      AND archived_by_operator_id IS NULL
    )
    OR
    (
      BINARY status = BINARY 'suspended'
      AND suspended_reason IS NOT NULL
      AND CHAR_LENGTH(suspended_reason) <= 300
      AND suspended_at IS NOT NULL
      AND suspended_by_operator_id IS NOT NULL
      AND archived_at IS NULL
      AND archived_by_user_id IS NULL
      AND archived_by_operator_id IS NULL
    )
    OR
    (
      BINARY status = BINARY 'archived'
      AND archived_at IS NOT NULL
      AND (
        (archived_by_user_id IS NOT NULL)
        + (archived_by_operator_id IS NOT NULL)
      ) = 1
      AND (
        (
          suspended_reason IS NULL
          AND suspended_at IS NULL
          AND suspended_by_operator_id IS NULL
        )
        OR
        (
          suspended_reason IS NOT NULL
          AND suspended_at IS NOT NULL
          AND suspended_by_operator_id IS NOT NULL
        )
      )
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- PostgreSQL source: 1783700001000:137-186.
-- The three nullable generated keys are concurrency-safe equivalents of the
-- source partial unique indexes; MariaDB UNIQUE permits multiple NULL values.
CREATE TABLE class_members (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  role VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  student_number INT,
  display_name_in_class VARCHAR(20),
  row_version BIGINT NOT NULL DEFAULT 1,
  status_changed_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  current_user_id BIGINT
    GENERATED ALWAYS AS (
      CASE
        WHEN BINARY status IN (BINARY 'pending', BINARY 'approved') THEN user_id
        ELSE NULL
      END
    ) STORED,
  approved_student_number_key INT
    GENERATED ALWAYS AS (
      CASE
        WHEN BINARY status = BINARY 'approved' AND student_number IS NOT NULL
          THEN student_number
        ELSE NULL
      END
    ) STORED,
  approved_teacher_class_id BIGINT
    GENERATED ALWAYS AS (
      CASE
        WHEN BINARY role = BINARY 'teacher' AND BINARY status = BINARY 'approved'
          THEN class_id
        ELSE NULL
      END
    ) STORED,
  PRIMARY KEY (id),
  CONSTRAINT class_members_class_user_unique UNIQUE (class_id, user_id),
  CONSTRAINT class_members_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT class_members_one_current_per_user UNIQUE (current_user_id),
  INDEX class_members_user_class_id_idx (user_id, class_id, id),
  CONSTRAINT class_members_student_number_unique UNIQUE (
    class_id, approved_student_number_key
  ),
  CONSTRAINT class_members_one_approved_teacher UNIQUE (approved_teacher_class_id),
  CONSTRAINT class_members_class_fk
    FOREIGN KEY (class_id) REFERENCES classes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT class_members_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT class_members_role_status_check CHECK (
    (
      BINARY role = BINARY 'teacher'
      AND BINARY status IN (
        BINARY 'approved', BINARY 'transferred', BINARY 'archived'
      )
    )
    OR
    (
      BINARY role = BINARY 'student'
      AND BINARY status IN (
        BINARY 'pending', BINARY 'approved', BINARY 'rejected', BINARY 'canceled',
        BINARY 'left', BINARY 'removed', BINARY 'rejoin_allowed', BINARY 'archived',
        BINARY 'account_deleted'
      )
    )
  ),
  CONSTRAINT class_members_student_number_check CHECK (
    student_number IS NULL
    OR (
      BINARY role = BINARY 'student'
      AND BINARY status = BINARY 'approved'
      AND student_number BETWEEN 1 AND 99
    )
  ),
  CONSTRAINT class_members_display_name_check CHECK (
    display_name_in_class IS NULL
    OR (
      OCTET_LENGTH(display_name_in_class) = OCTET_LENGTH(TRIM(display_name_in_class))
      AND CHAR_LENGTH(display_name_in_class) BETWEEN 2 AND 20
    )
  ),
  CONSTRAINT class_members_row_version_check CHECK (row_version >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- PostgreSQL table source: 1783700001000:188-222.
CREATE TABLE class_member_status_history (
  id BIGINT NOT NULL AUTO_INCREMENT,
  member_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  from_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin,
  to_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_user_id BIGINT,
  actor_member_id BIGINT,
  actor_operator_id BIGINT,
  reason VARCHAR(300),
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT class_member_history_member_fk
    FOREIGN KEY (member_id, class_id) REFERENCES class_members (id, class_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT class_member_history_actor_user_fk
    FOREIGN KEY (actor_user_id) REFERENCES users (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT class_member_history_actor_member_fk
    FOREIGN KEY (actor_member_id, class_id) REFERENCES class_members (id, class_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT class_member_history_actor_operator_fk
    FOREIGN KEY (actor_operator_id) REFERENCES operators (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT class_member_history_transition_check CHECK (
    from_status IS NULL OR BINARY from_status <> BINARY to_status
  ),
  -- MariaDB error 1901 forbids the source CHECK together with ON DELETE SET NULL.
  -- A pinned PostgreSQL differential proved that the source CHECK makes that
  -- nominal SET NULL delete fail. RESTRICT preserves the effective source outcome;
  -- the append-only INSERT trigger below preserves the actor-shape predicate.
  CONSTRAINT class_member_history_reason_check CHECK (
    reason IS NULL OR CHAR_LENGTH(reason) <= 300
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- PostgreSQL source: 1783700001000:224-260.
CREATE TABLE class_invite_codes (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  code VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6),
  created_by_member_id BIGINT NOT NULL,
  revoked_by_member_id BIGINT,
  revoked_by_operator_id BIGINT,
  revoke_reason VARCHAR(300),
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  open_class_id BIGINT
    GENERATED ALWAYS AS (
      CASE WHEN revoked_at IS NULL THEN class_id ELSE NULL END
    ) STORED,
  PRIMARY KEY (id),
  CONSTRAINT class_invite_codes_code_unique UNIQUE (code),
  CONSTRAINT class_invite_codes_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT class_invite_codes_one_open_per_class UNIQUE (open_class_id),
  CONSTRAINT class_invite_codes_class_fk
    FOREIGN KEY (class_id) REFERENCES classes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT class_invite_codes_created_by_member_fk
    FOREIGN KEY (created_by_member_id, class_id) REFERENCES class_members (id, class_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT class_invite_codes_revoked_by_member_fk
    FOREIGN KEY (revoked_by_member_id, class_id) REFERENCES class_members (id, class_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT class_invite_codes_revoked_by_operator_fk
    FOREIGN KEY (revoked_by_operator_id) REFERENCES operators (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT class_invite_codes_code_check CHECK (
    OCTET_LENGTH(code) = 8
    AND code REGEXP '^[A-HJ-KM-NP-Z2-9]{8}$'
  ),
  CONSTRAINT class_invite_codes_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT class_invite_codes_revoke_state_check CHECK (
    (
      revoked_at IS NULL
      AND revoked_by_member_id IS NULL
      AND revoked_by_operator_id IS NULL
      AND revoke_reason IS NULL
    )
    OR
    (
      revoked_at IS NOT NULL
      AND (
        (revoked_by_member_id IS NOT NULL)
        + (revoked_by_operator_id IS NOT NULL)
      ) = 1
      AND (revoke_reason IS NULL OR CHAR_LENGTH(revoke_reason) <= 300)
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- PostgreSQL trigger source: 1783700001000:262-300.
-- This row-local cross-table lookup is safe as an immediate MariaDB trigger.
DELIMITER //

CREATE DEFINER = 'classhub_routine'@'%' TRIGGER class_member_status_history_validate
BEFORE INSERT ON class_member_status_history
FOR EACH ROW
BEGIN
  DECLARE member_role VARCHAR(16);

  IF NOT (
    (
      NEW.actor_operator_id IS NOT NULL
      AND NEW.actor_user_id IS NULL
      AND NEW.actor_member_id IS NULL
    )
    OR
    (
      NEW.actor_operator_id IS NULL
      AND NEW.actor_user_id IS NOT NULL
    )
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'status history requires one supported actor type';
  END IF;

  SET member_role = (
    SELECT role
    FROM class_members
    WHERE id = NEW.member_id AND class_id = NEW.class_id
  );

  IF member_role IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'status history references an unknown class member';
  ELSEIF BINARY member_role = BINARY 'teacher' THEN
    IF NOT (
      BINARY NEW.to_status IN (
        BINARY 'approved', BINARY 'transferred', BINARY 'archived'
      )
    ) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'invalid teacher to_status in class member history';
    END IF;

    IF NEW.from_status IS NULL THEN
      IF BINARY NEW.to_status <> BINARY 'approved' THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'teacher history must start at approved';
      END IF;
    ELSEIF NOT (
      BINARY NEW.from_status IN (
        BINARY 'approved', BINARY 'transferred', BINARY 'archived'
      )
    ) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'invalid teacher from_status in class member history';
    END IF;
  ELSEIF BINARY member_role = BINARY 'student' THEN
    IF NOT (
      BINARY NEW.to_status IN (
        BINARY 'pending', BINARY 'approved', BINARY 'rejected', BINARY 'canceled',
        BINARY 'left', BINARY 'removed', BINARY 'rejoin_allowed', BINARY 'archived',
        BINARY 'account_deleted'
      )
    ) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'invalid student to_status in class member history';
    END IF;

    IF NEW.from_status IS NULL THEN
      IF BINARY NEW.to_status <> BINARY 'pending' THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'student history must start at pending';
      END IF;
    ELSEIF NOT (
      BINARY NEW.from_status IN (
        BINARY 'pending', BINARY 'approved', BINARY 'rejected', BINARY 'canceled',
        BINARY 'left', BINARY 'removed', BINARY 'rejoin_allowed', BINARY 'archived',
        BINARY 'account_deleted'
      )
    ) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'invalid student from_status in class member history';
    END IF;
  ELSE
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'status history references a member with an unknown role';
  END IF;
END//

DELIMITER ;
