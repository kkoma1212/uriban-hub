-- Review candidate. Isolated synthetic QA only; no production DDL/ACL activation.
-- Existing baseline migrations remain immutable. Independent audits retain their own expiry.
-- Student assessment class linkage is explicit and nullable: never infer existing ownership from membership.
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;
ALTER TABLE classes
 ADD COLUMN retention_purged_at DATETIME(6) NULL,
 DROP CONSTRAINT classes_lifecycle_metadata_check,
 MODIFY COLUMN academic_year INT NULL,
 MODIFY COLUMN grade INT NULL,
 MODIFY COLUMN edu_office_code VARCHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL,
 MODIFY COLUMN school_code VARCHAR(7) CHARACTER SET ascii COLLATE ascii_bin NULL,
 MODIFY COLUMN expected_student_count INT NULL,
 MODIFY COLUMN created_by_user_id BIGINT NULL,
 ADD CONSTRAINT classes_lifecycle_metadata_check CHECK ((retention_purged_at IS NULL AND academic_year IS NOT NULL AND grade IS NOT NULL AND edu_office_code IS NOT NULL AND school_code IS NOT NULL AND expected_student_count IS NOT NULL AND created_by_user_id IS NOT NULL AND ((
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
  )) OR (retention_purged_at IS NOT NULL AND BINARY status=BINARY 'archived' AND BINARY name=BINARY '종료된 반' AND archived_at IS NOT NULL AND retention_purged_at >= archived_at + INTERVAL 365 DAY AND academic_year IS NULL AND grade IS NULL AND edu_office_code IS NULL AND school_code IS NULL AND expected_student_count IS NULL AND created_by_user_id IS NULL AND archived_by_user_id IS NULL AND archived_by_operator_id IS NULL AND suspended_reason IS NULL AND suspended_at IS NULL AND suspended_by_operator_id IS NULL)),
 ADD INDEX classes_retention_index (status, retention_purged_at, archived_at, id);
ALTER TABLE student_assessment_records
 ADD COLUMN class_id BIGINT NULL,
 ADD CONSTRAINT student_assessment_records_class_fk FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT,
 ADD INDEX student_assessment_records_class_index (class_id, expires_at, id);
