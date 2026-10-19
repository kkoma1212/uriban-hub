-- Up Migration

ALTER TABLE meals
  ADD COLUMN calorie_kcal_tenths INTEGER,
  ADD CONSTRAINT meals_calorie_kcal_tenths_check CHECK (
    calorie_kcal_tenths BETWEEN 0 AND 99999
  );

-- The operator only needs this column to compare and persist the value received
-- from NEIS. Keep the rest of the table behind the existing column grants.
GRANT SELECT (calorie_kcal_tenths),
  INSERT (calorie_kcal_tenths),
  UPDATE (calorie_kcal_tenths)
  ON meals TO classhub_operator;

-- Down Migration

DO $neis_meal_calorie_rollback_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM meals
    WHERE calorie_kcal_tenths IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'NEIS meal calorie rollback requires every calorie value to be null';
  END IF;
END
$neis_meal_calorie_rollback_guard$;

REVOKE SELECT (calorie_kcal_tenths),
  INSERT (calorie_kcal_tenths),
  UPDATE (calorie_kcal_tenths)
  ON meals FROM classhub_operator;

ALTER TABLE meals
  DROP CONSTRAINT meals_calorie_kcal_tenths_check,
  DROP COLUMN calorie_kcal_tenths;
