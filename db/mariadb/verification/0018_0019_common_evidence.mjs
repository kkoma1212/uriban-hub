import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function verifyCommonEvidence(phase, readRepositoryFile) {
  const counts = {
    "0018_public_holidays": [4, 84, 25],
    "0019_guardian_consent_requests": [13, 100, 15],
  };
  assert.ok(Object.hasOwn(counts, phase.id), "common evidence received another phase");
  const [constraints, rejected, accepted] = counts[phase.id];
  for (const [field, expected] of Object.entries({
    verification_group: "phase18_19_common",
    verification_run: "clean_apply",
    apply_file_count: 2,
    installed_total_table_count: 53,
    new_table_count: 1,
    group_new_table_count: 2,
    routine_count: 15,
    trigger_count: 12,
    constraint_catalog_entry_count: constraints,
    targeted_rejection_probe_count: rejected,
    targeted_acceptance_probe_count: accepted,
    group_rejection_probe_count: 184,
    group_acceptance_probe_count: 40,
    catalog_seed_row_count: 56,
    persistent_row_count: 56,
    persistent_nonseed_row_count: 0,
    owner_column_read_count: 0,
    owner_trigger_privilege_count: 0,
    application_authorization_scope: "not_verified_schema_only",
    timestamp_parity: "activation_blocker",
    unicode_differential: "not_verified_targeted_samples_only",
    system_job_actor_parity: "activation_blocker_pending_semantic_migrations",
  }))
    assert.equal(phase.verification[field], expected, `${phase.id} lost ${field}`);
  if (phase.id === "0019_guardian_consent_requests") {
    assert.equal(phase.verification.uuid_default, "random_bytes_v4_targeted_verified");
    assert.equal(
      phase.verification.partial_index_mapping,
      "unique_hash_and_composite_predicate_indexes",
    );
    assert.equal(phase.verification.transaction_time_binding, "activation_blocker");
  }
  assert.equal(phase.trigger_file, undefined);
  assert.equal(phase.trigger_permissions_file, undefined);
  await readRepositoryFile(phase.verification.semantic_scenarios_file, `${phase.id} scenarios`);
  const source = await readRepositoryFile(phase.mariadb_file, `${phase.id} source`);
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    phase.verification.migration_sha256,
    `${phase.id} mariadb_file digest drifted`,
  );
  const groupFiles = phase.verification.group_migration_sha256;
  assert.deepEqual(Object.keys(groupFiles).sort(), [
    "db/mariadb/migrations/0018_public_holidays.sql",
    "db/mariadb/migrations/0019_guardian_consent_requests.sql",
  ]);
  for (const [file, digest] of Object.entries(groupFiles)) {
    const body = await readRepositoryFile(file, `${phase.id} group source`);
    assert.equal(
      createHash("sha256").update(body).digest("hex"),
      digest,
      `${phase.id} group digest drifted`,
    );
  }
}
