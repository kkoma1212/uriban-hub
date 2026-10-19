import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import { verifyFeaturePhaseEvidence } from "./feature_phase_evidence.mjs";
import {
  probeCounts,
  rejectionScenarios,
  acceptanceScenarios,
} from "../../../OPERATIONS/mariadb-dev/phase21-24-scenarios.mjs";

const read = async (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
test("shared evidence cannot claim activation or count the same run four times", async () => {
  const manifest = JSON.parse(await read("db/mariadb/manifest.json"));
  const phases = manifest.phases.filter((phase) => Number(phase.id.slice(0, 4)) >= 21);
  assert.equal(phases.length, 4);
  for (const phase of phases) {
    await verifyFeaturePhaseEvidence(phase, read);
    const count = probeCounts[`phase${Number(phase.id.slice(0, 4))}`];
    assert.equal(phase.verification.targeted_rejection_probe_count, count.rejection);
    assert.equal(phase.verification.targeted_acceptance_probe_count, count.acceptance);
    for (const [field, bad] of [
      ["persistent_row_count", 0],
      ["runtime_activation_applied", true],
      ["group_rejection_probe_count", 908],
      ["history_actor_update_parity", "verified"],
      ["inquiry_respondent_delete_mapping", "identical_errors"],
    ]) {
      await assert.rejects(
        verifyFeaturePhaseEvidence(
          { ...phase, verification: { ...phase.verification, [field]: bad } },
          read,
        ),
      );
    }
    const corrupted = {
      ...phase,
      verification: {
        ...phase.verification,
        group_migration_sha256: {
          ...phase.verification.group_migration_sha256,
          [phase.mariadb_file]: "0".repeat(64),
        },
        migration_sha256: "0".repeat(64),
      },
    };
    await assert.rejects(verifyFeaturePhaseEvidence(corrupted, read), /digest drifted/u);
  }
});
test("probe IDs remain unique across phases and state matrices stay complete", () => {
  const all = [...rejectionScenarios, ...acceptanceScenarios];
  assert.equal(rejectionScenarios.length, 227);
  assert.equal(acceptanceScenarios.length, 80);
  assert.equal(new Set(all.map(([id]) => id)).size, 307);
  for (const [prefix, count] of [
    ["approval_event_pair_", 48],
    ["approval_terminal_", 8],
    ["inquiry_response_state_", 8],
    ["terms_lifecycle_", 12],
    ["history_actor_", 16],
  ]) {
    assert.equal(all.filter(([id]) => id.startsWith(prefix)).length, count, prefix);
  }
});
