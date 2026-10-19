import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// 생년월일(2026-10-01 사용자 결정). 원장 99: users에 두 칸과 익명 처리 트리거, 원장 100: 그 권한.
// 자동 적용하지 않는다 — 운영 적용은 백업·복구 확인 뒤 사용자 승인.
export const userBirthDateArtifacts = Object.freeze([
  {
    id: "user-birth-dates",
    ledger_version: 99,
    source_path: "db/mariadb/migrations/0059_user_birth_dates.sql",
    byte_length: 1092,
    sha256: "bebe2b6beba2660de3941fc1f18500d08c275df90e001acad1529788928e665c",
  },
  {
    id: "user-birth-dates-acl",
    ledger_version: 100,
    source_path: "db/mariadb/permissions/0059_user_birth_dates_acl.sql",
    byte_length: 583,
    sha256: "72fa2906407af3c62f9c51b3a1c0dbf4bc3004e642f899cd552e42a9a33524a6",
  },
]);
const TABLE = "users";
const COLUMNS = ["birth_date", "birthday_shared"];
const CHECKS = ["users_birth_date_check", "users_birthday_shared_check"];
const TRIGGER = "users_birth_date_anonymize_guard";
const GRANTEES = ["classhub_app", "classhub_routine"];

export function readUserBirthDateSql(artifact) {
  assert(userBirthDateArtifacts.includes(artifact), "Unrecognized birth date artifact");
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}

export function withUserBirthDatePostconditions(base) {
  assert(base.final.tables[TABLE], "Users table must exist first");
  assert(!base.plan.steps.some((step) => [99, 100].includes(step.ledger_version)));
  for (const column of COLUMNS) assert(!base.final.tables[TABLE].columns[column]);
  const final = structuredClone(base.final);
  for (const artifact of userBirthDateArtifacts)
    applySourcePostcondition(final, readUserBirthDateSql(artifact), artifact.id);
  // 두 칸·두 검사·트리거 하나와 users 권한 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const reversed = structuredClone(final);
  const table = reversed.tables[TABLE];
  for (const column of COLUMNS) {
    assert(table.columns[column], `${column} must be added`);
    delete table.columns[column];
  }
  for (const check of CHECKS) {
    assert(table.checks[check], `${check} must be added`);
    delete table.checks[check];
  }
  assert(reversed.triggers[TRIGGER], "Anonymize trigger must be created");
  delete reversed.triggers[TRIGGER];
  for (const grantee of GRANTEES) {
    const added = (final.grants[grantee] ?? []).filter(
      (grant) => !(base.final.grants[grantee] ?? []).includes(grant),
    );
    assert(added.length > 0, `${grantee} must receive birth date grants`);
    assert(added.every((grant) => String(grant).split("|")[1] === TABLE));
    reversed.grants[grantee] = base.final.grants[grantee];
  }
  assert.deepEqual(reversed, base.final, "Unexpected change outside the birth date delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:user-birth-dates:v1\0${base.plan.plan_sha256}\0${userBirthDateArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...userBirthDateArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + userBirthDateArtifacts.length,
      },
    },
  };
}
