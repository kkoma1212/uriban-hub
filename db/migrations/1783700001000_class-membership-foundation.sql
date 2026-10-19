-- Up Migration

CREATE TABLE operators (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_normalized TEXT NOT NULL UNIQUE,
  credential_hash BYTEA NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT operators_email_check CHECK (
    email_normalized = lower(btrim(email_normalized)) AND email_normalized <> ''
  ),
  CONSTRAINT operators_credential_hash_check CHECK (octet_length(credential_hash) = 32),
  CONSTRAINT operators_status_check CHECK (status IN ('active', 'revoked')),
  CONSTRAINT operators_revoke_state_check CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE TABLE teacher_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES users (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active',
  temporary_password_must_change BOOLEAN NOT NULL,
  temporary_password_expires_at TIMESTAMPTZ,
  created_by_operator_id BIGINT NOT NULL REFERENCES operators (id) ON DELETE RESTRICT,
  revoked_by_operator_id BIGINT REFERENCES operators (id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  CONSTRAINT teacher_profiles_status_check CHECK (status IN ('active', 'revoked')),
  CONSTRAINT teacher_profiles_temporary_password_check CHECK (
    (temporary_password_must_change AND temporary_password_expires_at IS NOT NULL)
    OR (NOT temporary_password_must_change AND temporary_password_expires_at IS NULL)
  ),
  CONSTRAINT teacher_profiles_revoke_state_check CHECK (
    (
      status = 'active'
      AND revoked_by_operator_id IS NULL
      AND revoked_at IS NULL
      AND revoke_reason IS NULL
    )
    OR
    (
      status = 'revoked'
      AND revoked_by_operator_id IS NOT NULL
      AND revoked_at IS NOT NULL
      AND (revoke_reason IS NULL OR char_length(revoke_reason) <= 300)
    )
  )
);

CREATE TABLE schools (
  edu_office_code TEXT NOT NULL,
  school_code TEXT NOT NULL,
  school_name TEXT NOT NULL,
  school_kind TEXT NOT NULL,
  region_name TEXT NOT NULL,
  edu_office_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (edu_office_code, school_code),
  CONSTRAINT schools_edu_office_code_check CHECK (edu_office_code ~ '^[A-Z][0-9]{2}$'),
  CONSTRAINT schools_school_code_check CHECK (school_code ~ '^[0-9]{7}$'),
  CONSTRAINT schools_kind_check CHECK (school_kind IN ('elementary', 'middle', 'high')),
  CONSTRAINT schools_text_check CHECK (
    char_length(btrim(school_name)) BETWEEN 1 AND 100
    AND char_length(btrim(region_name)) BETWEEN 1 AND 100
    AND char_length(btrim(edu_office_name)) BETWEEN 1 AND 100
  )
);

CREATE TABLE classes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  name_normalized TEXT GENERATED ALWAYS AS (
    lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g'))
  ) STORED,
  academic_year INTEGER NOT NULL,
  grade INTEGER NOT NULL,
  edu_office_code TEXT NOT NULL,
  school_code TEXT NOT NULL,
  expected_student_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  row_version BIGINT NOT NULL DEFAULT 1,
  created_by_user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  suspended_reason TEXT,
  suspended_at TIMESTAMPTZ,
  suspended_by_operator_id BIGINT REFERENCES operators (id) ON DELETE RESTRICT,
  archived_at TIMESTAMPTZ,
  archived_by_user_id BIGINT REFERENCES users (id) ON DELETE RESTRICT,
  archived_by_operator_id BIGINT REFERENCES operators (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (edu_office_code, school_code)
    REFERENCES schools (edu_office_code, school_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT classes_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  CONSTRAINT classes_academic_year_check CHECK (academic_year BETWEEN 2020 AND 2100),
  CONSTRAINT classes_grade_check CHECK (grade BETWEEN 1 AND 6),
  CONSTRAINT classes_expected_student_count_check CHECK (expected_student_count BETWEEN 1 AND 60),
  CONSTRAINT classes_status_check CHECK (status IN ('active', 'suspended', 'archived')),
  CONSTRAINT classes_row_version_check CHECK (row_version >= 1),
  CONSTRAINT classes_lifecycle_metadata_check CHECK (
    (
      status = 'active'
      AND suspended_reason IS NULL AND suspended_at IS NULL
      AND suspended_by_operator_id IS NULL AND archived_at IS NULL
      AND archived_by_user_id IS NULL AND archived_by_operator_id IS NULL
    )
    OR
    (
      status = 'suspended'
      AND suspended_reason IS NOT NULL AND char_length(suspended_reason) <= 300
      AND suspended_at IS NOT NULL AND suspended_by_operator_id IS NOT NULL
      AND archived_at IS NULL AND archived_by_user_id IS NULL
      AND archived_by_operator_id IS NULL
    )
    OR
    (
      status = 'archived'
      AND archived_at IS NOT NULL
      AND num_nonnulls(archived_by_user_id, archived_by_operator_id) = 1
      AND (
        (suspended_reason IS NULL AND suspended_at IS NULL AND suspended_by_operator_id IS NULL)
        OR
        (suspended_reason IS NOT NULL AND suspended_at IS NOT NULL AND suspended_by_operator_id IS NOT NULL)
      )
    )
  )
);

CREATE UNIQUE INDEX classes_active_identity_unique
  ON classes (edu_office_code, school_code, academic_year, grade, name_normalized)
  WHERE status IN ('active', 'suspended');

CREATE TABLE class_members (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  student_number INTEGER,
  display_name_in_class TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT class_members_class_user_unique UNIQUE (class_id, user_id),
  CONSTRAINT class_members_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT class_members_role_status_check CHECK (
    (role = 'teacher' AND status IN ('approved', 'transferred', 'archived'))
    OR
    (
      role = 'student'
      AND status IN (
        'pending', 'approved', 'rejected', 'canceled', 'left', 'removed',
        'rejoin_allowed', 'archived', 'account_deleted'
      )
    )
  ),
  CONSTRAINT class_members_student_number_check CHECK (
    student_number IS NULL
    OR (role = 'student' AND status = 'approved' AND student_number BETWEEN 1 AND 99)
  ),
  CONSTRAINT class_members_display_name_check CHECK (
    display_name_in_class IS NULL
    OR (
      display_name_in_class = btrim(display_name_in_class)
      AND char_length(display_name_in_class) BETWEEN 2 AND 20
    )
  ),
  CONSTRAINT class_members_row_version_check CHECK (row_version >= 1)
);

CREATE UNIQUE INDEX class_members_one_current_per_user
  ON class_members (user_id)
  WHERE status IN ('pending', 'approved');

CREATE UNIQUE INDEX class_members_student_number_unique
  ON class_members (class_id, student_number)
  WHERE student_number IS NOT NULL AND status = 'approved';

CREATE UNIQUE INDEX class_members_one_approved_teacher
  ON class_members (class_id)
  WHERE role = 'teacher' AND status = 'approved';

CREATE TABLE class_member_status_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  actor_member_id BIGINT,
  actor_operator_id BIGINT REFERENCES operators (id) ON DELETE RESTRICT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT class_member_history_transition_check CHECK (
    (from_status IS NULL)
    OR (from_status <> to_status)
  ),
  CONSTRAINT class_member_history_actor_check CHECK (
    (
      actor_operator_id IS NOT NULL
      AND actor_user_id IS NULL
      AND actor_member_id IS NULL
    )
    OR
    (
      actor_operator_id IS NULL
      AND actor_user_id IS NOT NULL
    )
  ),
  CONSTRAINT class_member_history_reason_check CHECK (
    reason IS NULL OR char_length(reason) <= 300
  )
);

CREATE TABLE class_invite_codes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_by_member_id BIGINT NOT NULL,
  revoked_by_member_id BIGINT,
  revoked_by_operator_id BIGINT REFERENCES operators (id) ON DELETE RESTRICT,
  revoke_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT class_invite_codes_id_class_unique UNIQUE (id, class_id),
  FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (revoked_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT class_invite_codes_code_check CHECK (code ~ '^[A-HJ-KM-NP-Z2-9]{8}$'),
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
      AND num_nonnulls(revoked_by_member_id, revoked_by_operator_id) = 1
      AND (revoke_reason IS NULL OR char_length(revoke_reason) <= 300)
    )
  )
);

CREATE UNIQUE INDEX class_invite_codes_one_open_per_class
  ON class_invite_codes (class_id)
  WHERE revoked_at IS NULL;

CREATE FUNCTION validate_member_status_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  member_role TEXT;
  allowed_statuses TEXT[];
BEGIN
  SELECT role INTO member_role
  FROM class_members
  WHERE id = NEW.member_id AND class_id = NEW.class_id;

  IF member_role = 'teacher' THEN
    allowed_statuses := ARRAY['approved', 'transferred', 'archived'];
  ELSE
    allowed_statuses := ARRAY[
      'pending', 'approved', 'rejected', 'canceled', 'left', 'removed',
      'rejoin_allowed', 'archived', 'account_deleted'
    ];
  END IF;

  IF NEW.to_status <> ALL(allowed_statuses) THEN
    RAISE EXCEPTION 'invalid to_status % for member role %', NEW.to_status, member_role;
  END IF;

  IF NEW.from_status IS NULL THEN
    IF (member_role = 'student' AND NEW.to_status <> 'pending')
       OR (member_role = 'teacher' AND NEW.to_status <> 'approved') THEN
      RAISE EXCEPTION 'invalid initial status % for member role %', NEW.to_status, member_role;
    END IF;
  ELSIF NEW.from_status <> ALL(allowed_statuses) THEN
    RAISE EXCEPTION 'invalid from_status % for member role %', NEW.from_status, member_role;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER class_member_status_history_validate
  BEFORE INSERT ON class_member_status_history
  FOR EACH ROW EXECUTE FUNCTION validate_member_status_history();

CREATE FUNCTION assert_class_invariants(target_class_id BIGINT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  class_status TEXT;
  active_teacher_count INTEGER;
BEGIN
  SELECT status INTO class_status FROM classes WHERE id = target_class_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF class_status = 'active' THEN
    SELECT count(*) INTO active_teacher_count
    FROM class_members member
    JOIN users teacher_user ON teacher_user.id = member.user_id
    JOIN teacher_profiles profile ON profile.user_id = member.user_id
    WHERE member.class_id = target_class_id
      AND member.role = 'teacher'
      AND member.status = 'approved'
      AND teacher_user.is_active = TRUE
      AND teacher_user.deleted_at IS NULL
      AND profile.status = 'active';

    IF active_teacher_count <> 1 THEN
      RAISE EXCEPTION 'active class % must have exactly one active approved teacher', target_class_id;
    END IF;
  END IF;

  IF class_status = 'archived' THEN
    IF EXISTS (
      SELECT 1 FROM class_members
      WHERE class_id = target_class_id AND status IN ('pending', 'approved')
    ) THEN
      RAISE EXCEPTION 'archived class % cannot have current members', target_class_id;
    END IF;

    IF EXISTS (
      SELECT 1 FROM class_invite_codes
      WHERE class_id = target_class_id AND revoked_at IS NULL
    ) THEN
      RAISE EXCEPTION 'archived class % cannot have an open invite code', target_class_id;
    END IF;
  END IF;
END
$$;

CREATE FUNCTION enforce_class_row_invariants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_class_invariants(COALESCE(NEW.id, OLD.id));
  RETURN NULL;
END
$$;

CREATE FUNCTION enforce_class_member_invariants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM assert_class_invariants(NEW.class_id);
  END IF;
  IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.class_id <> NEW.class_id) THEN
    PERFORM assert_class_invariants(OLD.class_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION enforce_invite_invariants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_class_invariants(COALESCE(NEW.class_id, OLD.class_id));
  RETURN NULL;
END
$$;

CREATE FUNCTION enforce_user_teacher_invariants() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_class_id BIGINT;
BEGIN
  FOR affected_class_id IN
    SELECT DISTINCT class_id FROM class_members
    WHERE user_id = COALESCE(NEW.id, OLD.id) AND role = 'teacher'
  LOOP
    PERFORM assert_class_invariants(affected_class_id);
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION enforce_profile_teacher_invariants() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_class_id BIGINT;
BEGIN
  FOR affected_class_id IN
    SELECT DISTINCT class_id FROM class_members
    WHERE user_id = COALESCE(NEW.user_id, OLD.user_id) AND role = 'teacher'
  LOOP
    PERFORM assert_class_invariants(affected_class_id);
  END LOOP;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER classes_invariants
  AFTER INSERT OR UPDATE OR DELETE ON classes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_class_row_invariants();

CREATE CONSTRAINT TRIGGER class_members_invariants
  AFTER INSERT OR UPDATE OR DELETE ON class_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_class_member_invariants();

CREATE CONSTRAINT TRIGGER class_invite_codes_invariants
  AFTER INSERT OR UPDATE OR DELETE ON class_invite_codes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_invite_invariants();

CREATE CONSTRAINT TRIGGER users_teacher_invariants
  AFTER UPDATE OR DELETE ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_user_teacher_invariants();

CREATE CONSTRAINT TRIGGER teacher_profiles_invariants
  AFTER INSERT OR UPDATE OR DELETE ON teacher_profiles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_profile_teacher_invariants();

GRANT SELECT, INSERT, UPDATE, DELETE
  ON teacher_profiles, classes, class_members, class_invite_codes
  TO classhub_app;
GRANT SELECT ON schools TO classhub_app;
GRANT SELECT, INSERT ON class_member_status_history TO classhub_app;
REVOKE UPDATE, DELETE ON class_member_status_history FROM classhub_app;

-- Down Migration

DROP TRIGGER teacher_profiles_invariants ON teacher_profiles;
DROP TRIGGER users_teacher_invariants ON users;
DROP TRIGGER class_invite_codes_invariants ON class_invite_codes;
DROP TRIGGER class_members_invariants ON class_members;
DROP TRIGGER classes_invariants ON classes;
DROP FUNCTION enforce_profile_teacher_invariants();
DROP FUNCTION enforce_user_teacher_invariants();
DROP FUNCTION enforce_invite_invariants();
DROP FUNCTION enforce_class_member_invariants();
DROP FUNCTION enforce_class_row_invariants();
DROP FUNCTION assert_class_invariants(BIGINT);
DROP TRIGGER class_member_status_history_validate ON class_member_status_history;
DROP FUNCTION validate_member_status_history();
DROP TABLE class_invite_codes;
DROP TABLE class_member_status_history;
DROP TABLE class_members;
DROP TABLE classes;
DROP TABLE schools;
DROP TABLE teacher_profiles;
DROP TABLE operators;
