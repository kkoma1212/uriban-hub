import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// T-HELP-CHAT 도움 요청 자유 대화(2026-09-27 사용자 결정). 도움 요청(82·83) 다음 원장 번호를 쓰고,
// 아직 운영에 없는 교사 자료함은 그 뒤(86·87)로 미뤘다(사용자 선택 A).
export const helpChatArtifacts = Object.freeze([
  {
    id: "help-chat",
    ledger_version: 84,
    source_path: "db/mariadb/migrations/0052_help_chat.sql",
    byte_length: 3253,
    sha256: "b2c802dcd027a3b776959039f41a0bc2fc8d4f63357359746142ad7dc078f293",
  },
  {
    id: "help-chat-acl",
    ledger_version: 85,
    source_path: "db/mariadb/permissions/0052_help_chat_acl.sql",
    byte_length: 185,
    sha256: "a996b284e343c1bebee79e46afffcd444d9b3d6373413d1830d6430de694cf95",
  },
]);
export function readHelpChatSql(artifact) {
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}
export function withHelpChatPostconditions(base) {
  assert(base.plan.steps.some((step) => step.ledger_version === 83));
  assert(!base.plan.steps.some((step) => [84, 85].includes(step.ledger_version)));
  assert(base.final.tables.help_requests && base.final.tables.push_deliveries);
  assert(!base.final.tables.help_request_messages);
  const final = structuredClone(base.final);
  for (const artifact of helpChatArtifacts)
    applySourcePostcondition(final, readHelpChatSql(artifact), artifact.id);
  // 두 기존 표의 제약 변경·새 표 하나·그 권한 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const reversed = structuredClone(final);
  assert(reversed.tables.help_request_messages);
  delete reversed.tables.help_request_messages;
  for (const table of ["help_requests", "push_deliveries"]) {
    assert.notDeepEqual(final.tables[table], base.final.tables[table], `${table} must change`);
    reversed.tables[table] = base.final.tables[table];
  }
  const addedGrants = final.grants.classhub_app.filter(
    (grant) => !base.final.grants.classhub_app.includes(grant),
  );
  assert(addedGrants.length > 0);
  assert(addedGrants.every((grant) => JSON.stringify(grant).includes("help_request_messages")));
  reversed.grants.classhub_app = base.final.grants.classhub_app;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the help chat delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:help-chat:v1\0${base.plan.plan_sha256}\0${helpChatArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...helpChatArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + 2,
      },
    },
  };
}
