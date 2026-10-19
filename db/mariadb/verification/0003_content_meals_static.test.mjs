import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readEvidenceDocument } from "./evidence-document.mjs";

const verificationDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(verificationDirectory, "../../..");
const migration = readFileSync(
  resolve(repositoryRoot, "db/mariadb/migrations/0003_content_meals.sql"),
  "utf8",
);
const gaps = readEvidenceDocument("db/mariadb/verification/0003_content_meals_gaps.md");

const expectedTables = [
  "notices",
  "notice_reads",
  "supplies",
  "supply_checks",
  "schedules",
  "meals",
];

test("phase 0003 draft creates exactly its six declared product tables", () => {
  const actualTables = [...migration.matchAll(/^CREATE TABLE ([a-z_]+) \(/gmu)].map(
    (match) => match[1],
  );
  assert.deepEqual(actualTables, expectedTables);
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE)\b/iu);
  assert.doesNotMatch(migration, /\b(?:GRANT|REVOKE|CREATE USER|ALTER USER)\b/iu);
  assert.doesNotMatch(migration, /^\s*USE\b/imu);
});

test("phase 0003 folds only its reviewed later semantic columns", () => {
  for (const required of [
    "source_loaded_on DATE",
    "calorie_kcal_tenths INT",
    "category VARCHAR(16)",
    "meals_source_metadata_check",
    "meals_calorie_kcal_tenths_check",
    "supplies_category_check",
  ]) {
    assert.ok(migration.includes(required), `missing folded phase-0003 source: ${required}`);
  }
  assert.doesNotMatch(migration, /\baudience_mode\b/u);
  assert.doesNotMatch(migration, /\bnotice_recipients\b|\bsupply_recipients\b/u);
  assert.match(gaps, /belong to phase 0007/u);
});

test("content foreign keys and delete state remain class-bound and fail closed", () => {
  for (const constraint of [
    "notices_created_by_member_fk",
    "notices_updated_by_member_fk",
    "notices_deleted_by_member_fk",
    "notice_reads_notice_fk",
    "notice_reads_member_fk",
    "supplies_created_by_member_fk",
    "supplies_updated_by_member_fk",
    "supplies_deleted_by_member_fk",
    "supply_checks_supply_fk",
    "supply_checks_member_fk",
    "schedules_created_by_member_fk",
    "schedules_updated_by_member_fk",
    "schedules_deleted_by_member_fk",
  ]) {
    assert.match(migration, new RegExp(`CONSTRAINT ${constraint}\\s+FOREIGN KEY`, "u"));
  }
  assert.equal((migration.match(/ON DELETE RESTRICT/gu) ?? []).length, 17);
  for (const constraint of [
    "notices_delete_state_check",
    "supplies_delete_state_check",
    "schedules_delete_state_check",
  ]) {
    assert.ok(migration.includes(constraint));
  }
});

test("MariaDB boolean, JSON, enum and revision domains are explicit", () => {
  for (const required of [
    "subject TEXT",
    "schedules_subject_check CHECK (subject IS NULL OR CHAR_LENGTH(subject) <= 30)",
    "notices_is_important_check CHECK (is_important IN (FALSE, TRUE))",
    "supply_checks_is_checked_check CHECK (is_checked IN (FALSE, TRUE))",
    "JSON_VALID(menu_json)",
    "JSON_TYPE(menu_json) = 'ARRAY'",
    "JSON_LENGTH(menu_json) BETWEEN 1 AND 50",
    "content_revision >= 1 AND row_version >= 1",
    "confirmed_revision >= 1",
    "row_version >= 1",
  ]) {
    assert.ok(migration.includes(required), `missing explicit domain: ${required}`);
  }
  for (const domain of ["schedule_type", "meal_type", "source", "category"]) {
    assert.match(migration, new RegExp(`BINARY ${domain}`, "u"));
  }
});

test("partial list indexes become live-row equality-prefix indexes", () => {
  for (const index of [
    "notices_list_index (class_id, deleted_at, published_at DESC, id DESC)",
    "class_id, deleted_at, is_important, published_at DESC, id DESC",
    "supplies_list_index (class_id, deleted_at, needed_on, id)",
    "schedules_list_index (class_id, deleted_at, due_date, id)",
  ]) {
    assert.ok(migration.includes(index), `missing translated index: ${index}`);
  }
  assert.match(gaps, /no PostgreSQL partial index equivalent/u);
  assert.match(gaps, /representative `EXPLAIN`/u);
});
