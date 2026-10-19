import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
export const pollCloseArtifacts = Object.freeze([
  {
    id: "poll-manual-close",
    ledger_version: 74,
    source_path: "db/mariadb/migrations/0046_poll_manual_close.sql",
    byte_length: 337,
    sha256: "d0dea30703ffaf7cab94e573f1ffbf4877bb45678ed713ddc9bcd98c9e23f360",
  },
  {
    id: "poll-manual-close-acl",
    ledger_version: 75,
    source_path: "db/mariadb/permissions/0046_poll_manual_close_acl.sql",
    byte_length: 185,
    sha256: "ce6112a926fc5b0d669960ef8e701857f2a683158c5924ff8ccd206a6373db2d",
  },
]);
export function readPollCloseSql(artifact) {
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}
export function withPollClosePostconditions(base) {
  assert(base.plan.steps.some((step) => step.ledger_version === 72));
  assert(!base.plan.steps.some((step) => [74, 75].includes(step.ledger_version)));
  const final = structuredClone(base.final);
  for (const artifact of pollCloseArtifacts)
    applySourcePostcondition(final, readPollCloseSql(artifact), artifact.id);
  const reversed = structuredClone(final);
  assert.equal(reversed.tables.polls.columns.closed_at.nullable, true);
  delete reversed.tables.polls.columns.closed_at;
  assert(reversed.tables.polls.checks.polls_closed_at_check);
  delete reversed.tables.polls.checks.polls_closed_at_check;
  assert.equal(
    reversed.seeds.audit_log_actions.filter((action) => action === "poll.closed").length,
    1,
  );
  reversed.seeds.audit_log_actions = reversed.seeds.audit_log_actions.filter(
    (action) => action !== "poll.closed",
  );
  assert.equal(final.grants.classhub_app.length, base.final.grants.classhub_app.length + 2);
  assert(
    base.final.grants.classhub_app.every((grant) => final.grants.classhub_app.includes(grant)),
  );
  reversed.grants.classhub_app = base.final.grants.classhub_app;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the poll closure delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:poll-close:v1\0${base.plan.plan_sha256}\0${pollCloseArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...pollCloseArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + 2,
      },
    },
  };
}
