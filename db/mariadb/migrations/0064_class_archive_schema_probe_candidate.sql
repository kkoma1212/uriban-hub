-- Review candidate only; never activate against shared/production data implicitly.
-- A login-locked owner can read schema metadata for tables hidden from the least-privilege
-- retention account. This fixed, parameter-free procedure returns no product rows or secrets.
CREATE USER 'classhub_retention_schema'@'%' ACCOUNT LOCK;
GRANT SELECT ON classhub_mariadb_phase1_dev.* TO 'classhub_retention_schema'@'%';
-- REFERENCES exposes inbound FK metadata, including foreign schemas, without granting
-- row reads there or INSERT/UPDATE/DELETE/CREATE/ALTER or runtime login. The procedure
-- filters to references into its own database and returns metadata only.
GRANT REFERENCES ON *.* TO 'classhub_retention_schema'@'%';
DELIMITER //
CREATE DEFINER='classhub_retention_schema'@'%' PROCEDURE class_archive_schema_inventory()
SQL SECURITY DEFINER
READS SQL DATA
BEGIN
  SELECT
    DATABASE() AS database_name,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('version',version,'description',description,
      'sha256',LOWER(HEX(source_sha256)))) FROM classhub_schema_migrations
      WHERE version IN (110,111,112,113)) AS installation_json,
    (SELECT JSON_ARRAYAGG(TABLE_NAME) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE()) AS tables_json,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT(
      'table_schema',k.TABLE_SCHEMA,'table_name',k.TABLE_NAME,'constraint_name',k.CONSTRAINT_NAME,
      'column_name',k.COLUMN_NAME,'referenced_table',k.REFERENCED_TABLE_NAME,
      'referenced_column',k.REFERENCED_COLUMN_NAME,'delete_rule',r.DELETE_RULE))
      FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON k.CONSTRAINT_SCHEMA=r.CONSTRAINT_SCHEMA AND k.TABLE_NAME=r.TABLE_NAME AND k.CONSTRAINT_NAME=r.CONSTRAINT_NAME
      WHERE k.REFERENCED_TABLE_SCHEMA=DATABASE()) AS references_json;
END//
DELIMITER ;
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.class_archive_schema_inventory TO 'classhub_retention_schema'@'%';
