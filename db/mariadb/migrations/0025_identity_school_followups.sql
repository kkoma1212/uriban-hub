-- T-HUB-64 phase 0025; isolated synthetic development only. Runtime ACLs are separate.
-- PostgreSQL sources: 1783700014000, 1783700023000 and 1783700040000 (Up only).
-- Phase 0002 already folded in four school columns/CHECKs and the reminder column.
-- Actual delta: four school column/CHECK replacements; one users column/CHECK addition.
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

-- LONGTEXT lets the source CHECK see overlong values, including trailing spaces.
ALTER TABLE schools
  DROP CONSTRAINT schools_road_address_check,
  DROP CONSTRAINT schools_road_address_detail_check,
  DROP CONSTRAINT schools_phone_number_check,
  DROP CONSTRAINT schools_homepage_url_check,
  MODIFY COLUMN road_address LONGTEXT COLLATE utf8mb4_nopad_bin NULL,
  MODIFY COLUMN road_address_detail LONGTEXT COLLATE utf8mb4_nopad_bin NULL,
  MODIFY COLUMN phone_number LONGTEXT COLLATE utf8mb4_nopad_bin NULL,
  MODIFY COLUMN homepage_url LONGTEXT COLLATE utf8mb4_nopad_bin NULL,
  ADD CONSTRAINT schools_road_address_check CHECK (
    road_address IS NULL OR (
      BINARY road_address = BINARY TRIM(road_address)
      AND CHAR_LENGTH(road_address) BETWEEN 1 AND 200
      AND road_address NOT REGEXP '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT schools_road_address_detail_check CHECK (
    road_address_detail IS NULL OR (
      BINARY road_address_detail = BINARY TRIM(road_address_detail)
      AND CHAR_LENGTH(road_address_detail) BETWEEN 1 AND 200
      AND road_address_detail NOT REGEXP '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT schools_phone_number_check CHECK (
    phone_number IS NULL OR (
      BINARY phone_number = BINARY TRIM(phone_number)
      AND CHAR_LENGTH(phone_number) BETWEEN 3 AND 50
      AND phone_number NOT REGEXP '[[:cntrl:]]'
      -- MariaDB REGEXP_REPLACE replaces every match; PostgreSQL requires its fourth 'g' argument.
      AND CHAR_LENGTH(REGEXP_REPLACE(phone_number, '[^0-9]', '')) BETWEEN 3 AND 20
    )
  ),
  ADD CONSTRAINT schools_homepage_url_check CHECK (
    homepage_url IS NULL OR (
      BINARY homepage_url = BINARY TRIM(homepage_url)
      AND CHAR_LENGTH(homepage_url) BETWEEN 8 AND 500
      -- Reuse phase 0002's measured PostgreSQL en_US.utf8 whitespace set.
      -- NUL is also excluded because PostgreSQL TEXT cannot store it.
      -- The source permits non-space control characters and does not validate a hostname.
      AND homepage_url REGEXP '(?-i)\\Ahttps?://[^\\x{0000}\\x{0009}-\\x{000D}\\x{0020}\\x{0085}\\x{2000}-\\x{2006}\\x{2008}-\\x{200A}\\x{2028}-\\x{2029}\\x{205F}\\x{3000}]+\\z'
    )
  );

-- Source 0023 is already present as nullable DATETIME(6) without a default or time-order CHECK.
-- Preserve that folded column and its data; it is verified by the phase 0025 probes.

ALTER TABLE users
  ADD COLUMN password_input_version LONGTEXT COLLATE utf8mb4_nopad_bin
    NOT NULL DEFAULT 'legacy_exact_v0',
  ADD CONSTRAINT users_password_input_version_check CHECK (
    password_input_version IN ('legacy_exact_v0', 'nfc_v1')
  );
