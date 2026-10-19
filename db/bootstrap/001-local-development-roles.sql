-- Local Docker Compose bootstrap only. Deployed environments must provision
-- equivalent least-privilege roles through their secret-management process.

DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'classhub_migrator') THEN
    EXECUTE 'CREATE ROLE classhub_migrator LOGIN PASSWORD ''local_migrator_password'' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'classhub_app') THEN
    EXECUTE 'CREATE ROLE classhub_app LOGIN PASSWORD ''local_app_password'' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'classhub_local_admin') THEN
    EXECUTE 'CREATE ROLE classhub_local_admin LOGIN PASSWORD ''local_admin_db_password'' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'classhub_worker') THEN
    EXECUTE 'CREATE ROLE classhub_worker LOGIN PASSWORD ''local_worker_password'' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'classhub_retention') THEN
    EXECUTE 'CREATE ROLE classhub_retention LOGIN PASSWORD ''local_retention_password'' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'classhub_operator') THEN
    EXECUTE 'CREATE ROLE classhub_operator LOGIN PASSWORD ''local_operator_password'' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;
END
$bootstrap$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT CONNECT ON DATABASE classhub_dev
  TO classhub_migrator, classhub_app, classhub_local_admin, classhub_worker, classhub_retention, classhub_operator;
GRANT USAGE, CREATE ON SCHEMA public TO classhub_migrator;
GRANT USAGE ON SCHEMA public
  TO classhub_app, classhub_local_admin, classhub_worker, classhub_retention, classhub_operator;

-- Every migration grants only the privileges its runtime role needs. Keeping
-- app privileges out of the migrator defaults makes new tables fail closed.
