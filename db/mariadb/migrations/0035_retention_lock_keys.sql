-- REVIEW CANDIDATE ONLY: isolated synthetic QA; no shared/production application.
-- runtimeActivationApplied=false; existing manifests/mounts/0032 seeds remain unchanged.
-- Operational table outside the 65 product tables. Four immutable installer-owned rows.
-- Source identities: classhub.<table>.retention.v1 for attendance_notifications,
-- guardian_consent_requests, layout_draft_autosaves and student_assessment_records.
-- Source algorithm is PostgreSQL hashtext, NOT hashtextextended(seed=0) or direct bigint.
-- SHA256(UTF8('classhub:mariadb:transaction-lock:v1:pg-hashtext') || 0x00 || UTF8(identity)).
-- Runtime SELECT FOR UPDATE owns each lock until COMMIT/ROLLBACK; missing seeds fail closed.
-- Installer must commit all seeds before runtime starts. No runtime INSERT, cleanup or TTL.

CREATE TABLE retention_lock_keys (
  lock_digest BINARY(32) NOT NULL,
  PRIMARY KEY (lock_digest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

START TRANSACTION;
INSERT INTO retention_lock_keys (lock_digest) VALUES
  (0xe967e9824bbe6ab21372526c2fb004c0e80e5b80074dcfe2d6b458d83ea99cda),
  (0x5472d4c8402686b5717f88bec7d964a2e33c77a549e5717454458d6df2156d3b),
  (0x00c6c3eef786715bdc445ec4e48e8446bf2a06930f3b0e68a8943e869d491301),
  (0x456dfbb2db434333933756f2450e0d9c029ae34803c8799f2355d5d28c4b63c5);
COMMIT;
