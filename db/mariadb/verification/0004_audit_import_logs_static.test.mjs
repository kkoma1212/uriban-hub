import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readEvidenceDocument } from "./evidence-document.mjs";

const verificationDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(verificationDirectory, "../../..");
const migration = readFileSync(
  resolve(repositoryRoot, "db/mariadb/migrations/0004_audit_import_logs.sql"),
  "utf8",
);
const trigger = readFileSync(
  resolve(repositoryRoot, "db/mariadb/migrations/0004_audit_actor_trigger.sql"),
  "utf8",
);
const grants = readFileSync(
  resolve(repositoryRoot, "db/mariadb/permissions/0004_audit_trigger_grants.sql"),
  "utf8",
);
const gaps = readEvidenceDocument("db/mariadb/verification/0004_audit_import_logs_gaps.md");

test("phase 0004 table draft creates exactly five schema-only product tables", () => {
  assert.deepEqual(
    [...migration.matchAll(/^CREATE TABLE ([a-z_]+) \(/gmu)].map((match) => match[1]),
    [
      "operator_audit_logs",
      "school_import_logs",
      "meal_import_logs",
      "audit_logs",
      "security_audit_logs",
    ],
  );
  assert.equal(
    (migration.match(/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin/gu) ?? []).length,
    5,
  );
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE)\b/iu);
  assert.doesNotMatch(migration, /\b(?:GRANT|REVOKE|CREATE USER|ALTER USER)\b/iu);
});

test("JSON allowlists use only built-in object and subset predicates", () => {
  assert.doesNotMatch(migration, /\bjsonb_has_only_keys\b/iu);
  assert.ok((migration.match(/JSON_TYPE\(/gu) ?? []).length >= 22);
  assert.ok((migration.match(/JSON_KEYS\(/gu) ?? []).length >= 22);
  assert.ok((migration.match(/JSON_CONTAINS\(/gu) ?? []).length >= 22);
  for (const key of [
    "operator_id",
    "teacher_user_id",
    "cutoff_at",
    "invite_code_id",
    "member_id",
    "notice_id",
    "supply_id",
    "schedule_id",
  ]) {
    assert.match(migration, new RegExp(`"${key}"`, "u"));
  }
});

test("operator audit identity and indexed text narrowing fail closed", () => {
  for (const required of [
    "target_type VARCHAR(128) NOT NULL",
    "target_id VARCHAR(512) NOT NULL",
    "operator_audit_logs_run_action_target_unique",
    "operator_audit_logs_actor_check",
    "operator_audit_logs_checksum_check",
  ]) {
    assert.ok(migration.includes(required), `missing operator audit boundary: ${required}`);
  }
  assert.match(gaps, /Migration must scan real source maxima and stop on overflow/u);
});

test("import, class audit, security, UUID and canonical IP domains stay explicit", () => {
  for (const required of [
    "school_import_logs_counts_check",
    "school_import_logs_time_check",
    "meal_import_logs_counts_check",
    "meal_import_logs_time_check",
    "audit_logs_actor_role_check",
    "audit_logs_target_check",
    "audit_logs_reason_check",
    "security_audit_logs_hmac_check",
    "security_audit_logs_actor_ip_check",
    "INET6_ATON(actor_ip)",
  ]) {
    assert.ok(migration.includes(required), `missing phase-0004 domain: ${required}`);
  }
  assert.equal((migration.match(/\bUUID NOT NULL\b/gu) ?? []).length, 6);
});

test("audit actor/class enforcement is a locked-definer insert trigger", () => {
  assert.match(
    trigger,
    /CREATE DEFINER=`classhub_routine`@`%` TRIGGER audit_logs_actor_class_validate/u,
  );
  assert.match(trigger, /BEFORE INSERT ON audit_logs/u);
  assert.match(trigger, /NEW\.actor_member_id IS NOT NULL/u);
  assert.match(trigger, /id = NEW\.actor_member_id AND class_id = NEW\.class_id/u);
  assert.match(trigger, /MYSQL_ERRNO = 30601/u);
  assert.doesNotMatch(trigger, /\bUPDATE\b|\bDELETE\b/iu);
});

test("locked trigger grants are exact and no runtime identity is activated", () => {
  assert.match(grants, /GRANT SELECT \(class_id, actor_member_id\)/u);
  assert.match(grants, /GRANT TRIGGER/u);
  assert.equal((grants.match(/TO 'classhub_routine'@'%'/gu) ?? []).length, 2);
  assert.doesNotMatch(grants, /TO 'classhub_(?:app|operator|worker|retention|migrator)'@'%'/u);
  assert.doesNotMatch(grants, /\bGRANT ALL\b|\bIDENTIFIED BY\b/iu);
  for (const blocker of ["B-01", "B-02", "B-03", "B-04"]) {
    assert.match(gaps, new RegExp(`### ${blocker}`, "u"));
  }
});
