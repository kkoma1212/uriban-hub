import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// 진행 중 투표 내용 수정(2026-10-04 사용자 결정, 제한형). 원장 107: 감사 기록 종류 'poll.updated',
// 원장 108: 앱의 polls 네 칸 UPDATE. 선택지는 기존 poll_options DELETE·INSERT로 바꾼다(0표일 때만 — API가 지킨다).
// 운영 적용은 백업 뒤 사용자 승인.
export const pollEditArtifacts = Object.freeze([
  {
    id: "poll-edit",
    ledger_version: 107,
    source_path: "db/mariadb/migrations/0064_poll_edit.sql",
    byte_length: 155,
    sha256: "df9ac6e095962e34ec11486626adb82331adf1bd94899dac9dea941942d2f361",
  },
  {
    id: "poll-edit-acl",
    ledger_version: 108,
    source_path: "db/mariadb/permissions/0064_poll_edit_acl.sql",
    byte_length: 316,
    sha256: "c845b27e13802df345cf5255471e9426de8f7fd11c7e628a45c2e30ce5484a34",
  },
]);
export const POLL_EDIT_APP_GRANTS = Object.freeze(
  ["title", "description", "option_count", "closes_at"]
    .map((column) => `table|polls|UPDATE|${column}`)
    .sort(),
);

export function readPollEditSql(artifact) {
  assert(pollEditArtifacts.includes(artifact), "Unrecognized poll edit artifact");
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}

export function withPollEditPostconditions(base) {
  assert(base.final.tables.polls, "polls must exist first");
  // 투표 마감(원장 74·75) 위에 쌓는다. 정리 계정 보관 기간(104~106)과는 관계가 없어 따로 설치할 수 있다.
  assert(
    base.plan.steps.some((step) => step.ledger_version === 75),
    "Ledger 75 (poll close) must come first",
  );
  assert(!base.plan.steps.some((step) => [107, 108].includes(step.ledger_version)));
  const final = structuredClone(base.final);
  for (const artifact of pollEditArtifacts)
    applySourcePostcondition(final, readPollEditSql(artifact), artifact.id);
  // 감사 기록 종류 하나와 앱의 polls 네 칸 UPDATE 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const reversed = structuredClone(final);
  assert.equal(
    reversed.seeds.audit_log_actions.filter((action) => action === "poll.updated").length,
    1,
  );
  reversed.seeds.audit_log_actions = reversed.seeds.audit_log_actions.filter(
    (action) => action !== "poll.updated",
  );
  const addedGrants = final.grants.classhub_app.filter(
    (grant) => !base.final.grants.classhub_app.includes(grant),
  );
  assert.deepEqual(
    [...addedGrants].sort(),
    POLL_EDIT_APP_GRANTS,
    "The app may only edit the poll title, description, option count and deadline",
  );
  reversed.grants.classhub_app = base.final.grants.classhub_app;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the poll edit delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:poll-edit:v1\0${base.plan.plan_sha256}\0${pollEditArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...pollEditArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + pollEditArtifacts.length,
      },
    },
  };
}
