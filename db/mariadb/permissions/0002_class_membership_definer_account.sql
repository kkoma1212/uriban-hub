-- T-HUB-62 phase-0002 locked routine owner provisioning draft.
--
-- ISOLATED SYNTHETIC QA ONLY. DO NOT APPLY TO A SHARED OR PRODUCTION DATABASE.
--
-- This file is intentionally not mounted by the phase-0001 Compose project and
-- is a read-only runner input in the phase-2 QA project.
-- It contains the fixed isolated-development host placeholder only. Production
-- provisioning must replace `%` with the approved exact private host before a
-- reviewed run. The account has no password and cannot establish a session.
-- A collision is an error: do not add IF NOT EXISTS and silently inherit an
-- account whose authentication or privileges were not measured.

CREATE USER 'classhub_routine'@'%' ACCOUNT LOCK;
