-- Up Migration
-- Existing evidence remains NULL: a later document must never be attributed
-- to a consent collected before this schema existed.
ALTER TABLE user_consents ADD COLUMN document_snapshot JSONB;
ALTER TABLE guardian_consent_requests ADD COLUMN document_snapshot JSONB;

ALTER TABLE user_consents ADD CONSTRAINT user_consents_snapshot_check CHECK (
  document_snapshot IS NULL OR (
    jsonb_typeof(document_snapshot) = 'object'
    AND document_snapshot ?& ARRAY['terms', 'privacy_consent', 'privacy_policy', 'guardian_consent']
    AND document_snapshot - ARRAY['terms', 'privacy_consent', 'privacy_policy', 'guardian_consent'] = '{}'::jsonb
  )
);
ALTER TABLE guardian_consent_requests ADD CONSTRAINT guardian_consent_snapshot_check CHECK (
  document_snapshot IS NULL OR (
    jsonb_typeof(document_snapshot) = 'object'
    AND document_snapshot ?& ARRAY['terms', 'privacy_consent', 'privacy_policy', 'guardian_consent']
    AND document_snapshot - ARRAY['terms', 'privacy_consent', 'privacy_policy', 'guardian_consent'] = '{}'::jsonb
  )
);

-- Down Migration
-- Refuse to erase collected evidence. Roll back application activation first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM user_consents WHERE document_snapshot IS NOT NULL)
    OR EXISTS (SELECT 1 FROM guardian_consent_requests WHERE document_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'Legal consent evidence exists; retain the additive columns';
  END IF;
END $$;
ALTER TABLE guardian_consent_requests DROP COLUMN document_snapshot;
ALTER TABLE user_consents DROP COLUMN document_snapshot;
