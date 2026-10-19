-- Read-only contract snapshot for the MariaDB phase-0001 synthetic database.
-- The caller must fail unless every returned value matches the expected value documented below.

SET time_zone = '+00:00';
SET SESSION group_concat_max_len = 1048576;

SELECT
  COUNT(*) AS table_count,
  GROUP_CONCAT(table_name ORDER BY BINARY table_name SEPARATOR ',') AS table_names
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_type = 'BASE TABLE';
-- expected table_count: 6
-- expected table_names:
-- api_idempotency_keys,email_verification_tokens,password_reset_tokens,sessions,user_consents,users

SELECT
  COUNT(*) AS generated_column_count,
  GROUP_CONCAT(
    CONCAT(table_name, '.', column_name)
    ORDER BY BINARY table_name, BINARY column_name
    SEPARATOR ','
  ) AS generated_columns
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND extra LIKE '%STORED GENERATED%';
-- expected generated_column_count: 3
-- expected generated_columns:
-- email_verification_tokens.open_user_id,password_reset_tokens.open_user_id,users.active_email_key

SELECT
  COUNT(*) AS non_innodb_table_count
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_type = 'BASE TABLE'
  AND engine <> 'InnoDB';
-- expected: 0

SELECT
  COUNT(*) AS non_binary_utf8mb4_table_count
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_type = 'BASE TABLE'
  AND table_collation <> 'utf8mb4_bin';
-- expected: 0

SELECT
  data_type,
  column_type
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name = 'api_idempotency_keys'
  AND column_name = 'idempotency_key';
-- expected data_type/column_type: uuid

SELECT
  COUNT(*) AS missing_required_constraints
FROM (
  SELECT 'users_active_email_unique' AS constraint_name
  UNION ALL SELECT 'email_verification_tokens_one_open_per_user'
  UNION ALL SELECT 'password_reset_tokens_one_open_per_user'
  UNION ALL SELECT 'user_consents_state_check'
  UNION ALL SELECT 'api_idempotency_keys_response_body_check'
) AS required
LEFT JOIN information_schema.table_constraints AS actual
  ON actual.constraint_schema = DATABASE()
 AND actual.constraint_name = required.constraint_name
WHERE actual.constraint_name IS NULL;
-- expected: 0

SELECT
  @@session.time_zone AS session_time_zone,
  @@session.sql_mode AS session_sql_mode,
  @@character_set_database AS database_character_set,
  @@collation_database AS database_collation;
-- expected time_zone: +00:00; database charset/collation: utf8mb4/utf8mb4_bin

-- Exact MariaDB 11.4.13 catalog fingerprints. Data-dependent statistics such as
-- CARDINALITY are deliberately excluded. Every nullable value has an explicit
-- sentinel and text is hex-encoded before concatenation to avoid delimiter ambiguity.
SELECT
  COUNT(*) AS column_count,
  SHA2(
    GROUP_CONCAT(
      CONCAT_WS(
        '|',
        HEX(table_name),
        ordinal_position,
        HEX(column_name),
        HEX(data_type),
        HEX(column_type),
        is_nullable,
        COALESCE(HEX(column_default), '-'),
        COALESCE(CAST(character_maximum_length AS CHAR), '-'),
        COALESCE(CAST(numeric_precision AS CHAR), '-'),
        COALESCE(CAST(numeric_scale AS CHAR), '-'),
        COALESCE(CAST(datetime_precision AS CHAR), '-'),
        COALESCE(HEX(character_set_name), '-'),
        COALESCE(HEX(collation_name), '-'),
        column_key,
        HEX(extra),
        is_generated,
        COALESCE(HEX(generation_expression), '-')
      )
      ORDER BY BINARY table_name, ordinal_position
      SEPARATOR '\n'
    ),
    256
  ) AS column_contract_sha256
FROM information_schema.columns
WHERE table_schema = DATABASE();
-- expected: 57 baa897a8c2355b6c56e4d90f8c3e0bcf8b0ffc5ee0fd3c4c0cddcc697fbf484b

SELECT
  COUNT(*) AS table_constraint_count,
  SHA2(
    GROUP_CONCAT(
      CONCAT_WS('|', HEX(table_name), HEX(constraint_name), HEX(constraint_type))
      ORDER BY BINARY table_name, BINARY constraint_name
      SEPARATOR '\n'
    ),
    256
  ) AS table_constraint_contract_sha256
FROM information_schema.table_constraints
WHERE constraint_schema = DATABASE();
-- expected: 46 59b8f45ef06b7b5fad4852412bc81e6cede05f3432265e2cbd97a660fdc2b07e

SELECT
  COUNT(*) AS check_constraint_count,
  SHA2(
    GROUP_CONCAT(
      CONCAT_WS('|', HEX(table_name), HEX(constraint_name), HEX(level), HEX(check_clause))
      ORDER BY BINARY table_name, BINARY constraint_name
      SEPARATOR '\n'
    ),
    256
  ) AS check_constraint_contract_sha256
FROM information_schema.check_constraints
WHERE constraint_schema = DATABASE();
-- expected: 27 2e140b0803a9ce27934b533271d8ca1af7afaf18f818ef29829b5e3f337896fe

SELECT
  COUNT(*) AS key_column_count,
  SHA2(
    GROUP_CONCAT(
      CONCAT_WS(
        '|',
        HEX(table_name),
        HEX(constraint_name),
        ordinal_position,
        COALESCE(CAST(position_in_unique_constraint AS CHAR), '-'),
        HEX(column_name),
        COALESCE(HEX(referenced_table_schema), '-'),
        COALESCE(HEX(referenced_table_name), '-'),
        COALESCE(HEX(referenced_column_name), '-')
      )
      ORDER BY BINARY table_name, BINARY constraint_name, ordinal_position
      SEPARATOR '\n'
    ),
    256
  ) AS key_column_contract_sha256
FROM information_schema.key_column_usage
WHERE constraint_schema = DATABASE();
-- expected: 23 41edd5228c483792f87a4887f931950f5f5402106848136e3c6f8630f46eb4fe

SELECT
  COUNT(*) AS referential_constraint_count,
  SHA2(
    GROUP_CONCAT(
      CONCAT_WS(
        '|',
        HEX(table_name),
        HEX(constraint_name),
        HEX(referenced_table_name),
        HEX(match_option),
        HEX(update_rule),
        HEX(delete_rule)
      )
      ORDER BY BINARY table_name, BINARY constraint_name
      SEPARATOR '\n'
    ),
    256
  ) AS referential_constraint_contract_sha256
FROM information_schema.referential_constraints
WHERE constraint_schema = DATABASE();
-- expected: 5 ce8cb49892a2929ee1e77dd8e4f780a810788e69ac7086c001d6594e9ff9719f

SELECT
  COUNT(*) AS index_column_count,
  SHA2(
    GROUP_CONCAT(
      CONCAT_WS(
        '|',
        HEX(table_name),
        HEX(index_name),
        non_unique,
        seq_in_index,
        HEX(column_name),
        COALESCE(HEX(collation), '-'),
        COALESCE(CAST(sub_part AS CHAR), '-'),
        nullable,
        HEX(index_type),
        ignored
      )
      ORDER BY BINARY table_name, BINARY index_name, seq_in_index
      SEPARATOR '\n'
    ),
    256
  ) AS index_contract_sha256
FROM information_schema.statistics
WHERE table_schema = DATABASE();
-- expected: 30 0e21a703e5f015a61d90efb5a70a53c1e4ca8ad612fc9fe921b5a3ae8f955827
