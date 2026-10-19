import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeInstalledCatalog } from "../../../OPERATIONS/mariadb-dev/verify-native-installed-schema.mjs";

test("installed archive contract includes the API reason, preserving data schema and privileges", () => {
  const before = nativeInstalledCatalog({ operatorCommands: true });
  const after = nativeInstalledCatalog({ operatorCommands: true, archiveReason: true });
  assert.equal(before.final.routines.archive_class.body.includes("'반 아카이브'"), true);
  assert.equal(after.final.routines.archive_class.body.includes("'반 아카이브'"), false);
  assert.equal(after.final.routines.archive_class.body.split("'반 운영 종료'").length, 3);
  assert.deepEqual(after.final.tables, before.final.tables);
  assert.deepEqual(after.final.grants, before.final.grants);
  assert.deepEqual(after.final.triggers, before.final.triggers);
  assert.equal(after.plan.ledger.planned_record_count, 62);
  assert.equal(after.plan.steps.filter((step) => step.ledger_version === 57).length, 1);
});
