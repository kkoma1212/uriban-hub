-- ACTIVE-SCOPE CANDIDATE ONLY: isolated synthetic QA; no shared/production application.
-- Historical migrations/0035_retention_lock_keys.sql remains unchanged as four-seed evidence.
-- Operational table outside the 54 retained product tables. Three installer-owned seeds.
-- Identities: classhub.<table>.retention.v1 for attendance_notifications,
-- guardian_consent_requests and student_assessment_records. Layout drafts are retired.
-- SHA256(UTF8('classhub:mariadb:transaction-lock:v1:pg-hashtext') || 0x00 || UTF8(identity)).
-- Commit seeds before runtime; missing seeds fail closed. No runtime INSERT, cleanup or TTL.
-- This artifact is not yet assigned a ledger version or mounted by an active installer.

CREATE TABLE retention_lock_keys (
  lock_digest BINARY(32) NOT NULL,
  PRIMARY KEY (lock_digest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

START TRANSACTION;
INSERT INTO retention_lock_keys (lock_digest) VALUES
  (0xe967e9824bbe6ab21372526c2fb004c0e80e5b80074dcfe2d6b458d83ea99cda),
  (0x5472d4c8402686b5717f88bec7d964a2e33c77a549e5717454458d6df2156d3b),
  (0x456dfbb2db434333933756f2450e0d9c029ae34803c8799f2355d5d28c4b63c5);
COMMIT;
