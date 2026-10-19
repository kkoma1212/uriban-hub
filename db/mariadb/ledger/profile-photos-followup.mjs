import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// T-PHOTO 프로필 사진(2026-09-29 사용자 1단계 승인). 원장 96·97 — 실제 운영 설치 순서(패스키 90·91 다음)와
// 번호 순서를 맞춘다(86·87은 교사 자료함 예약). 자동 적용하지 않는다 — 운영 적용은 백업·복구 확인 뒤 사용자 승인.
export const profilePhotoArtifacts = Object.freeze([
  {
    id: "profile-photos",
    ledger_version: 96,
    source_path: "db/mariadb/migrations/0053_profile_photos.sql",
    byte_length: 853,
    sha256: "daf3a4a4deb81a2b072ea5b23c4706c6f674a8b2de6c67d9d3946722e1262716",
  },
  {
    id: "profile-photos-acl",
    ledger_version: 97,
    source_path: "db/mariadb/permissions/0053_profile_photos_acl.sql",
    byte_length: 397,
    sha256: "9e75faf6388af5539d4202f91cc58c4d6377d77ead60fec8a6a564941f42fbb2",
  },
]);
const PROFILE_PHOTO_TABLES = ["user_profile_photos"];

export function readProfilePhotoSql(artifact) {
  assert(profilePhotoArtifacts.includes(artifact), "Unrecognized profile photo artifact");
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}

export function withProfilePhotoPostconditions(base) {
  assert(base.plan.steps.some((step) => step.ledger_version === 85));
  assert(!base.plan.steps.some((step) => [96, 97].includes(step.ledger_version)));
  for (const table of PROFILE_PHOTO_TABLES) assert(!base.final.tables[table]);
  const final = structuredClone(base.final);
  for (const artifact of profilePhotoArtifacts)
    applySourcePostcondition(final, readProfilePhotoSql(artifact), artifact.id);
  // 새 표 하나와 그 권한 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const reversed = structuredClone(final);
  for (const table of PROFILE_PHOTO_TABLES) {
    assert(reversed.tables[table], `${table} must be created`);
    delete reversed.tables[table];
  }
  const addedGrants = final.grants.classhub_app.filter(
    (grant) => !base.final.grants.classhub_app.includes(grant),
  );
  assert(addedGrants.length > 0);
  assert(addedGrants.every((grant) => PROFILE_PHOTO_TABLES.includes(String(grant).split("|")[1])));
  reversed.grants.classhub_app = base.final.grants.classhub_app;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the profile photo delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:profile-photos:v1\0${base.plan.plan_sha256}\0${profilePhotoArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...profilePhotoArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + profilePhotoArtifacts.length,
      },
    },
  };
}
