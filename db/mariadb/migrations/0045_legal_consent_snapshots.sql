-- Additive candidate only. Existing records are intentionally not backfilled.
ALTER TABLE user_consents
  MODIFY COLUMN policy_version VARCHAR(80) NOT NULL,
  ADD COLUMN document_snapshot JSON NULL,
  ADD CONSTRAINT user_consents_snapshot_check CHECK (
    document_snapshot IS NULL OR (
      JSON_TYPE(document_snapshot) = 'OBJECT'
      AND JSON_LENGTH(document_snapshot) = 4
      AND JSON_CONTAINS_PATH(document_snapshot, 'all',
        '$.terms', '$.privacy_consent', '$.privacy_policy', '$.guardian_consent')
    )
  );
ALTER TABLE guardian_consent_requests
  ADD COLUMN document_snapshot JSON NULL,
  ADD CONSTRAINT guardian_consent_snapshot_check CHECK (
    document_snapshot IS NULL OR (
      JSON_TYPE(document_snapshot) = 'OBJECT'
      AND JSON_LENGTH(document_snapshot) = 4
      AND JSON_CONTAINS_PATH(document_snapshot, 'all',
        '$.terms', '$.privacy_consent', '$.privacy_policy', '$.guardian_consent')
    )
  );
