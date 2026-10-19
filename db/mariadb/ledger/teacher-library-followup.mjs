import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// S2 교사 자료함(P-024). 도움 요청 자유 대화(84·85) 다음 원장 번호를 쓴다(2026-09-27 사용자 선택 A로 밀림).
export const teacherLibraryArtifacts = Object.freeze([
  {
    id: "teacher-library",
    ledger_version: 86,
    source_path: "db/mariadb/migrations/0051_teacher_library.sql",
    byte_length: 2385,
    sha256: "346039322590f72abe589e8c3e26d1d8af7fc4d43c7e7d6153e905a12a514e7c",
  },
  {
    id: "teacher-library-acl",
    ledger_version: 87,
    source_path: "db/mariadb/permissions/0051_teacher_library_acl.sql",
    byte_length: 276,
    sha256: "fcc362979a50b396dee02e3df22b817edd1cd029a9f8ab638b781b18615bbfca",
  },
]);
export function readTeacherLibrarySql(artifact) {
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}
export function withTeacherLibraryPostconditions(base) {
  assert(base.plan.steps.some((step) => step.ledger_version === 85));
  assert(!base.plan.steps.some((step) => [86, 87].includes(step.ledger_version)));
  assert(!base.final.tables.teacher_library_items);
  const final = structuredClone(base.final);
  for (const artifact of teacherLibraryArtifacts)
    applySourcePostcondition(final, readTeacherLibrarySql(artifact), artifact.id);
  // 새 테이블 하나와 그 권한 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const reversed = structuredClone(final);
  assert(reversed.tables.teacher_library_items);
  delete reversed.tables.teacher_library_items;
  const addedGrants = final.grants.classhub_app.filter(
    (grant) => !base.final.grants.classhub_app.includes(grant),
  );
  assert(addedGrants.length > 0);
  assert(addedGrants.every((grant) => JSON.stringify(grant).includes("teacher_library_items")));
  reversed.grants.classhub_app = base.final.grants.classhub_app;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the teacher library delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:teacher-library:v1\0${base.plan.plan_sha256}\0${teacherLibraryArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...teacherLibraryArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + 2,
      },
    },
  };
}
