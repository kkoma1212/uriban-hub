import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition, sourceStatements } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
const defaultRead = (path) => readFileSync(new URL(path, root));
export const operatorCommandsFollowup = Object.freeze({
  id: "operator-commands",
  ledger_version: 72,
  source_path: "db/mariadb/migrations/0044_operator_commands.sql",
  byte_length: 1157,
  sha256: "78b1e464248c5e1274f76bd9c8e7d75ba9598733846cebce964702c4a85c8f9c",
});
export function readOperatorCommandsSql(readRepoFile = defaultRead) {
  const source = readRepoFile(operatorCommandsFollowup.source_path);
  assert.equal(source.length, operatorCommandsFollowup.byte_length);
  assert.equal(createHash("sha256").update(source).digest("hex"), operatorCommandsFollowup.sha256);
  return source.toString("utf8");
}
export function withOperatorCommandsPostconditions(base, readRepoFile = defaultRead) {
  assert.ok(base.plan.steps.some((step) => step.ledger_version === 71));
  assert.ok(!base.plan.steps.some((step) => step.ledger_version === 72));
  const final = structuredClone(base.final);
  for (const statement of sourceStatements(readOperatorCommandsSql(readRepoFile))) {
    if (statement.startsWith("INSERT INTO operator_transaction_lock_keys")) {
      const seeds = [...statement.matchAll(/0x([0-9a-f]{64})/gu)].map((match) => match[1]).sort();
      assert.equal(seeds.length, 7);
      assert.equal(new Set(seeds).size, 7);
      final.seeds.operator_transaction_lock_keys = seeds;
    } else applySourcePostcondition(final, statement + ";", operatorCommandsFollowup.id);
  }
  for (const [account, grants] of Object.entries(base.final.grants)) {
    if (account !== "classhub_operator") assert.deepEqual(final.grants[account], grants);
  }
  assert.deepEqual(final.routines, base.final.routines);
  assert.deepEqual(final.triggers, base.final.triggers);
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:operator-commands:v1\0${base.plan.plan_sha256}\0${operatorCommandsFollowup.sha256}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, operatorCommandsFollowup],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + 1,
      },
    },
  };
}
