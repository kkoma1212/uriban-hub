import { URL } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
const defaultRead = (path) => readFileSync(new URL(path, root));
export const mailManagementFollowup = Object.freeze({
  id: "signup-email-management",
  ledger_version: 70,
  source_path: "db/mariadb/migrations/0042_signup_email_management.sql",
  byte_length: 3444,
  sha256: "cac0fbd9d991165cfeb3fcbf93e9ced5dc61643e30166cf77162a545d1a12c68",
});
export function readMailManagementSql(readRepoFile = defaultRead) {
  const source = readRepoFile(mailManagementFollowup.source_path);
  assert.equal(source.length, mailManagementFollowup.byte_length);
  assert.equal(createHash("sha256").update(source).digest("hex"), mailManagementFollowup.sha256);
  return source.toString("utf8");
}
export function withMailManagementPostconditions(base, readRepoFile = defaultRead) {
  assert.ok(base.plan.steps.some((step) => step.ledger_version === 69));
  assert.ok(!base.plan.steps.some((step) => step.ledger_version === 70));
  const final = structuredClone(base.final);
  applySourcePostcondition(final, readMailManagementSql(readRepoFile), mailManagementFollowup.id);
  for (const [account, grants] of Object.entries(base.final.grants)) {
    if (account !== "classhub_app") assert.deepEqual(final.grants[account], grants);
    else assert.ok(grants.every((grant) => final.grants[account].includes(grant)));
  }
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:mail-management:v1\0${base.plan.plan_sha256}\0${mailManagementFollowup.sha256}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, mailManagementFollowup],
      product_tables: [...base.plan.product_tables, "mail_delivery_logs", "mail_templates"].sort(),
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + 1,
      },
    },
  };
}
