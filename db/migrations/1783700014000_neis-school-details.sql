-- Up Migration

ALTER TABLE schools
  ADD COLUMN road_address TEXT,
  ADD COLUMN road_address_detail TEXT,
  ADD COLUMN phone_number TEXT,
  ADD COLUMN homepage_url TEXT,
  ADD CONSTRAINT schools_road_address_check CHECK (
    road_address IS NULL
    OR (
      road_address = btrim(road_address)
      AND char_length(road_address) BETWEEN 1 AND 200
      AND road_address !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT schools_road_address_detail_check CHECK (
    road_address_detail IS NULL
    OR (
      road_address_detail = btrim(road_address_detail)
      AND char_length(road_address_detail) BETWEEN 1 AND 200
      AND road_address_detail !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT schools_phone_number_check CHECK (
    phone_number IS NULL
    OR (
      phone_number = btrim(phone_number)
      AND char_length(phone_number) BETWEEN 3 AND 50
      AND phone_number !~ '[[:cntrl:]]'
      AND char_length(regexp_replace(phone_number, '[^0-9]', '', 'g')) BETWEEN 3 AND 20
    )
  ),
  ADD CONSTRAINT schools_homepage_url_check CHECK (
    homepage_url IS NULL
    OR (
      homepage_url = btrim(homepage_url)
      AND char_length(homepage_url) BETWEEN 8 AND 500
      AND homepage_url ~ '^https?://[^[:space:]]+$'
    )
  );

-- Existing application table-level SELECT already covers these read-only
-- columns. The operator receives only the columns needed by school import.
GRANT SELECT (road_address, road_address_detail, phone_number, homepage_url),
  INSERT (road_address, road_address_detail, phone_number, homepage_url),
  UPDATE (road_address, road_address_detail, phone_number, homepage_url)
  ON schools TO classhub_operator;

-- Down Migration

DO $neis_school_details_rollback_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM schools
    WHERE road_address IS NOT NULL
      OR road_address_detail IS NOT NULL
      OR phone_number IS NOT NULL
      OR homepage_url IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'NEIS school details rollback requires every detail value to be null';
  END IF;
END
$neis_school_details_rollback_guard$;

REVOKE SELECT (road_address, road_address_detail, phone_number, homepage_url),
  INSERT (road_address, road_address_detail, phone_number, homepage_url),
  UPDATE (road_address, road_address_detail, phone_number, homepage_url)
  ON schools FROM classhub_operator;

ALTER TABLE schools
  DROP CONSTRAINT schools_homepage_url_check,
  DROP CONSTRAINT schools_phone_number_check,
  DROP CONSTRAINT schools_road_address_detail_check,
  DROP CONSTRAINT schools_road_address_check,
  DROP COLUMN homepage_url,
  DROP COLUMN phone_number,
  DROP COLUMN road_address_detail,
  DROP COLUMN road_address;
