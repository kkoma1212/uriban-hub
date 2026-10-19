import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function verifyTeamDrawEvidence(phase, readRepositoryFile) {
  assert.equal(phase.id, "0012_team_draws", "team draw evidence received another phase");
  for (const [field, expected] of Object.entries({
    apply_file_count: 3,
    installed_total_table_count: 41,
    new_table_count: 3,
    routine_count: 15,
    trigger_count: 11,
    constraint_catalog_entry_count: 21,
    targeted_rejection_probe_count: 66,
    targeted_acceptance_probe_count: 8,
    verification_run: "clean_apply",
    owner_column_read_count: 6,
    owner_trigger_privilege_count: 1,
    application_authorization_scope: "not_verified_schema_only",
    parent_later_change_behavior: "source_boundary_preserved",
    clock_timestamp_parity: "activation_blocker",
  })) {
    assert.equal(phase.verification[field], expected, `${phase.id} lost ${field}`);
  }
  assert.deepEqual(
    phase.verification.adjustment_audit_sources_folded,
    [
      "1783700019000_seat-draw-adjustment-audit.sql",
      "1783700020000_team-draw-adjustment-audit.sql",
    ],
    `${phase.id} lost its adjustment audit source boundary`,
  );
  await readRepositoryFile(phase.verification.semantic_scenarios_file, `${phase.id} scenarios`);
  for (const [field, artifact] of [
    ["migration_sha256", "mariadb_file"],
    ["trigger_sha256", "trigger_file"],
    ["trigger_permissions_sha256", "trigger_permissions_file"],
  ]) {
    const source = await readRepositoryFile(phase[artifact], `${phase.id} ${artifact}`);
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      phase.verification[field],
      `${phase.id} ${artifact} digest drifted`,
    );
  }
}
