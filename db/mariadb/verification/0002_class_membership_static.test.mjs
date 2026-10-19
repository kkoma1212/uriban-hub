import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readEvidenceDocument } from "./evidence-document.mjs";

const verificationDirectory = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(verificationDirectory, "../migrations/0002_class_membership.sql"),
  "utf8",
);
const gaps = readEvidenceDocument("db/mariadb/verification/0002_class_membership_gaps.md");
const sqlWithoutComments = migration.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*--.*$/gmu, "");

const expectedTables = [
  "class_invite_codes",
  "class_member_status_history",
  "class_members",
  "classes",
  "operators",
  "schools",
  "teacher_profiles",
];

test("phase 0002 draft creates exactly its seven declared product tables", () => {
  const tables = [...sqlWithoutComments.matchAll(/^CREATE TABLE\s+([a-z0-9_]+)/gimu)].map(
    (match) => match[1],
  );
  assert.deepEqual(tables.sort(), expectedTables);
  assert.equal((sqlWithoutComments.match(/ENGINE=InnoDB/giu) ?? []).length, 7);
  assert.equal(
    (sqlWithoutComments.match(/DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin/giu) ?? []).length,
    7,
  );
});

test("all five PostgreSQL partial unique indexes use nullable generated keys", () => {
  for (const contract of [
    "classes_active_identity_unique",
    "class_members_one_current_per_user",
    "class_members_student_number_unique",
    "class_members_one_approved_teacher",
    "class_invite_codes_one_open_per_class",
  ]) {
    assert.match(sqlWithoutComments, new RegExp(`CONSTRAINT ${contract} UNIQUE`, "u"));
  }
  for (const generatedKey of [
    "active_identity_name_key",
    "current_user_id",
    "approved_student_number_key",
    "approved_teacher_class_id",
    "open_class_id",
  ]) {
    assert.match(
      sqlWithoutComments,
      new RegExp(`${generatedKey}[\\s\\S]{0,260}GENERATED ALWAYS AS`, "u"),
    );
  }
});

test("class normalization pins PostgreSQL whitespace and Unicode case-fold semantics", () => {
  const postgresSpacePattern = String.raw`'[\\x{0009}-\\x{000D}\\x{0020}\\x{0085}\\x{2000}-\\x{2006}\\x{2008}-\\x{200A}\\x{2028}-\\x{2029}\\x{205F}\\x{3000}]+'`;
  assert.ok(sqlWithoutComments.includes(postgresSpacePattern));
  assert.equal((sqlWithoutComments.match(/COLLATE\s+utf8mb4_uca1400_as_ci/giu) ?? []).length, 1);
  assert.match(
    sqlWithoutComments,
    /name_normalized\s+VARCHAR\(40\)[\s\S]{0,700}REGEXP_REPLACE[\s\S]{0,700}COLLATE\s+utf8mb4_uca1400_as_ci[\s\S]{0,80}\)\s+STORED/iu,
  );
});

test("account deletion has an explicit ordered user-history access path", () => {
  assert.match(
    sqlWithoutComments,
    /INDEX\s+class_members_user_class_id_idx\s*\(\s*user_id\s*,\s*class_id\s*,\s*id\s*\)/iu,
  );
});

test("final school and temporary-password columns are folded into the baseline", () => {
  for (const column of [
    "road_address",
    "road_address_detail",
    "phone_number",
    "homepage_url",
    "temporary_password_reminder_sent_at",
  ]) {
    assert.match(sqlWithoutComments, new RegExp(`\\b${column}\\b`, "u"));
  }
});

test("the locked-owner history trigger preserves actor and role/status validation", () => {
  const triggers = [
    ...sqlWithoutComments.matchAll(/\bTRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/giu),
  ].map((match) => match[1]);
  assert.deepEqual(triggers, ["class_member_status_history_validate"]);
  assert.match(
    sqlWithoutComments,
    /CREATE\s+DEFINER\s*=\s*'classhub_routine'@'%'\s+TRIGGER\s+class_member_status_history_validate/iu,
  );
  assert.doesNotMatch(sqlWithoutComments, /CONSTRAINT\s+class_member_history_actor_check/iu);
  assert.match(
    sqlWithoutComments,
    /NEW\.actor_operator_id\s+IS\s+NOT\s+NULL[\s\S]{0,180}NEW\.actor_user_id\s+IS\s+NULL[\s\S]{0,180}NEW\.actor_member_id\s+IS\s+NULL/iu,
  );
  assert.match(
    sqlWithoutComments,
    /NEW\.actor_operator_id\s+IS\s+NULL[\s\S]{0,180}NEW\.actor_user_id\s+IS\s+NOT\s+NULL/iu,
  );
  assert.match(sqlWithoutComments, /status history requires one supported actor type/iu);
  assert.match(
    sqlWithoutComments,
    /CONSTRAINT\s+class_member_history_actor_user_fk[\s\S]{0,180}ON\s+UPDATE\s+RESTRICT\s+ON\s+DELETE\s+RESTRICT/iu,
  );
  assert.doesNotMatch(
    sqlWithoutComments,
    /(?:classes|class_members|class_invite_codes|users|teacher_profiles)_invariants/iu,
  );
});

test("unsafe operations stay out and all four parity blockers stay explicit", () => {
  for (const pattern of [
    /\bDROP\b/iu,
    /\bGRANT\b/iu,
    /\bREVOKE\b/iu,
    /\bCREATE\s+USER\b/iu,
    /\bIDENTIFIED\s+BY\b/iu,
  ]) {
    assert.doesNotMatch(sqlWithoutComments, pattern);
  }
  for (const blocker of ["B-01", "B-02", "B-03", "B-04"]) {
    assert.match(gaps, new RegExp(`### ${blocker}`, "u"));
  }
  assert.match(
    gaps,
    /approved only for the guarded,[\s\S]*?not a shared\/runtime or production-ready migration/u,
  );
});
