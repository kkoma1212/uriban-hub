-- Up Migration

ALTER TABLE meals
  DROP CONSTRAINT meals_source_check,
  ADD COLUMN source_loaded_on DATE,
  ADD CONSTRAINT meals_source_check CHECK (source IN ('seed', 'neis')),
  ADD CONSTRAINT meals_source_metadata_check CHECK (
    (source = 'seed' AND source_loaded_on IS NULL)
    OR
    (source = 'neis' AND source_loaded_on IS NOT NULL)
  );

-- A NEIS sync must be able to distinguish seed rows from previously synced
-- rows and compare the upstream load date. Keep the rest of the table hidden.
GRANT SELECT (source, source_updated_at, source_loaded_on),
  INSERT (source_loaded_on),
  UPDATE (source_loaded_on)
  ON meals TO classhub_operator;

-- Down Migration

DO $neis_meal_source_rollback_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM meals
    WHERE source <> 'seed'
      OR source_loaded_on IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'NEIS meal source rollback requires every meal to remain seed-only';
  END IF;
END
$neis_meal_source_rollback_guard$;

REVOKE SELECT (source, source_updated_at, source_loaded_on),
  INSERT (source_loaded_on),
  UPDATE (source_loaded_on)
  ON meals FROM classhub_operator;

ALTER TABLE meals
  DROP CONSTRAINT meals_source_metadata_check,
  DROP CONSTRAINT meals_source_check,
  DROP COLUMN source_loaded_on,
  ADD CONSTRAINT meals_source_check CHECK (source = 'seed');
