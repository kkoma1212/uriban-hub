import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";
import { nativeInstalledCatalog } from "../../../OPERATIONS/mariadb-dev/verify-native-installed-schema.mjs";
import { readAuditHistorySql, withAuditHistoryPostconditions } from "./audit-history-followup.mjs";

test("preserved audit history changes only the JSON allowlist and one ledger record", () => {
  const previous = nativeInstalledCatalog({ mailManagement: true });
  const current = withAuditHistoryPostconditions(previous);
  const expected = structuredClone(current.final);
  expected.tables.audit_logs.checks.audit_logs_json_allowlist_check =
    previous.final.tables.audit_logs.checks.audit_logs_json_allowlist_check;
  assert.deepEqual(expected, previous.final);
  assert.deepEqual(current.plan.product_tables, previous.plan.product_tables);
  assert.deepEqual(current.plan.steps.slice(0, -1), previous.plan.steps);
  assert.equal(current.plan.ledger.planned_record_count, 60);
  const original = readFileSync(
    new URL("../migrations/0013_duty_rosters.sql", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const marker = "  ADD CONSTRAINT audit_logs_json_allowlist_check CHECK (";
  assert.equal(
    readAuditHistorySql().slice(readAuditHistorySql().indexOf(marker)).trimEnd(),
    original.slice(original.indexOf(marker)).trimEnd(),
  );
});

test("audit history cannot overwrite an applied step or accept changed SQL", () => {
  const previous = nativeInstalledCatalog({ mailManagement: true });
  assert.throws(() => withAuditHistoryPostconditions(withAuditHistoryPostconditions(previous)));
  assert.throws(() => withAuditHistoryPostconditions(previous, () => Buffer.from("SELECT 1;")));
});
