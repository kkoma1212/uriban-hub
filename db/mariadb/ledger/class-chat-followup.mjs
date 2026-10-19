import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// T-CLASS-CHAT 반 단체 대화(선생님 관리형, 2026-09-28). 원장 94·95를 예약해 인증 확장(90~93) 뒤에 둔다.
// 자동 적용하지 않는다 — 운영 적용은 백업·복구 확인 뒤 사용자 승인.
export const classChatArtifacts = Object.freeze([
  {
    id: "class-chat",
    ledger_version: 94,
    source_path: "db/mariadb/migrations/0056_class_chat.sql",
    byte_length: 3818,
    sha256: "26d7c3ca09277828d3fcc47d4fee5404e1925af11132c93ae85377d91d4c18bb",
  },
  {
    id: "class-chat-acl",
    ledger_version: 95,
    source_path: "db/mariadb/permissions/0056_class_chat_acl.sql",
    byte_length: 664,
    sha256: "979d5b9c2ab8d9665e423193bf702895451b3911e3be7dfd51837c2f93cf4da5",
  },
]);
const CLASS_CHAT_TABLES = [
  "class_chat_rooms",
  "class_chat_messages",
  "class_chat_mutes",
  "class_chat_reports",
];

export function readClassChatSql(artifact) {
  assert(classChatArtifacts.includes(artifact), "Unrecognized class chat artifact");
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}

export function withClassChatPostconditions(base) {
  assert(base.plan.steps.some((step) => step.ledger_version === 85));
  assert(!base.plan.steps.some((step) => [94, 95].includes(step.ledger_version)));
  for (const table of CLASS_CHAT_TABLES) assert(!base.final.tables[table]);
  const final = structuredClone(base.final);
  for (const artifact of classChatArtifacts)
    applySourcePostcondition(final, readClassChatSql(artifact), artifact.id);
  // 새 표 넷과 그 권한 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const reversed = structuredClone(final);
  for (const table of CLASS_CHAT_TABLES) {
    assert(reversed.tables[table], `${table} must be created`);
    delete reversed.tables[table];
  }
  const addedGrants = final.grants.classhub_app.filter(
    (grant) => !base.final.grants.classhub_app.includes(grant),
  );
  assert(addedGrants.length > 0);
  assert(addedGrants.every((grant) => CLASS_CHAT_TABLES.includes(String(grant).split("|")[1])));
  reversed.grants.classhub_app = base.final.grants.classhub_app;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the class chat delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:class-chat:v1\0${base.plan.plan_sha256}\0${classChatArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...classChatArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + classChatArtifacts.length,
      },
    },
  };
}
