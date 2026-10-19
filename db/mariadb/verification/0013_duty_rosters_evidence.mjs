import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function verifyDutyRosterEvidence(phase, readRepositoryFile) {
  assert.equal(phase.id, "0013_duty_rosters", "duty evidence received another phase");
  for (const [field, expected] of Object.entries({
    apply_file_count: 1,
    installed_total_table_count: 44,
    new_table_count: 3,
    routine_count: 15,
    trigger_count: 11,
    constraint_catalog_entry_count: 24,
    targeted_rejection_probe_count: 80,
    targeted_acceptance_probe_count: 9,
    verification_run: "clean_apply",
    owner_column_read_count: 0,
    owner_trigger_privilege_count: 0,
    active_name_overflow_errno: 1406,
    application_authorization_scope: "not_verified_schema_only",
    clock_timestamp_parity: "activation_blocker",
  })) {
    assert.equal(phase.verification[field], expected, `${phase.id} lost ${field}`);
  }
  assert.equal(phase.trigger_file, undefined, "source has no duty trigger");
  assert.equal(phase.trigger_permissions_file, undefined, "source needs no duty definer grants");
  await readRepositoryFile(phase.verification.semantic_scenarios_file, `${phase.id} scenarios`);
  const source = await readRepositoryFile(phase.mariadb_file, `${phase.id} source`);
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    phase.verification.migration_sha256,
    `${phase.id} mariadb_file digest drifted`,
  );
}
