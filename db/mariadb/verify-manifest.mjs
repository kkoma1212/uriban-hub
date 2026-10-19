import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verifyFeaturePhaseEvidence } from "./verification/feature_phase_evidence.mjs";
import * as semanticEvidence from "./verification/semantic_followups_evidence.mjs";
import {
  adminSessionRenewalAclOverlay,
  assertAdminSessionRenewalAclSource,
} from "./permissions/active_runtime_acl.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const manifestPath = path.join(scriptDirectory, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const sourceDirectory = path.join(repositoryRoot, manifest.source.migration_directory);
const allowedPhaseStatuses = new Set([
  "planned",
  "draft_blocked_unverified_on_container",
  "isolated_parser_and_smoke_verified_activation_blocked",
  "implemented_unverified_on_container",
  "verified_on_container",
]);
const allowedSemanticStatuses = new Set([
  "planned_unimplemented",
  "implemented_unverified_on_container",
  "verified_on_container",
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right, "en"));
}

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*--.*$/gmu, "");
}

async function readRepositoryFile(relativePath, description) {
  assert(
    typeof relativePath === "string" && relativePath.length > 0,
    `${description} has no repository path`,
  );
  const resolvedPath = path.resolve(repositoryRoot, relativePath);
  assert(
    resolvedPath.startsWith(`${repositoryRoot}${path.sep}`),
    `${description} resolves outside the repository`,
  );
  return readFile(resolvedPath, "utf8");
}

const currentSourceFiles = sorted(
  (await readdir(sourceDirectory)).filter((name) => name.endsWith(".sql")),
);
// Preserve historical source47 evidence; current additions carry independent, exact provenance.
const schemaFollowups = JSON.parse(
  await readRepositoryFile(
    "db/mariadb/verification/current-schema-followups.json",
    "current schema follow-ups",
  ),
);
assert(
  schemaFollowups.schema_version === 1 && schemaFollowups.runtime_activation_applied === false,
  "schema follow-up catalog must not claim activation",
);
assert(schemaFollowups.followups.length === 1, "unreviewed schema follow-up inventory");
for (const followup of schemaFollowups.followups) {
  for (const engine of ["postgres", "mariadb"]) {
    const bytes = await readRepositoryFile(
      followup[`${engine}_source`],
      `${engine} schema follow-up`,
    );
    assert(
      createHash("sha256").update(bytes).digest("hex") === followup[`${engine}_sha256`],
      `${engine} schema follow-up differs from its reviewed source`,
    );
  }
}
const renewalSource = path.basename(adminSessionRenewalAclOverlay.sourcePath);
const followupNames = schemaFollowups.followups.map((followup) =>
  path.basename(followup.postgres_source),
);
const sourceFiles = currentSourceFiles.filter(
  (name) => name !== renewalSource && !followupNames.includes(name),
);
assert(
  currentSourceFiles.includes(renewalSource) &&
    followupNames.every((name) => currentSourceFiles.includes(name)) &&
    currentSourceFiles.length === sourceFiles.length + 1 + followupNames.length,
  "current source inventory must contain the reviewed administrator session renewal overlay",
);
assertAdminSessionRenewalAclSource(
  await readRepositoryFile(
    adminSessionRenewalAclOverlay.sourcePath,
    "administrator renewal ACL overlay",
  ),
);
assert(
  sourceFiles.length === manifest.source.migration_count,
  `source migration count mismatch: expected ${manifest.source.migration_count}, got ${sourceFiles.length}`,
);
assert(
  sourceFiles.at(-1) === manifest.source.latest_migration,
  `latest source migration mismatch: expected ${manifest.source.latest_migration}, got ${sourceFiles.at(-1)}`,
);

const tablePattern = /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-zA-Z0-9_]+)/gimu;
const sourceTables = [];
for (const sourceFile of sourceFiles) {
  const sql = stripSqlComments(
    (await readFile(path.join(sourceDirectory, sourceFile), "utf8")).split("-- Down Migration")[0],
  );
  sourceTables.push(...[...sql.matchAll(tablePattern)].map((match) => match[1]));
}

const manifestTables = manifest.phases.flatMap((phase) => phase.tables);
assert(
  new Set(manifestTables).size === manifestTables.length,
  "manifest contains duplicate product tables",
);
assert(
  manifestTables.length === manifest.source.product_table_count,
  `manifest product table count mismatch: expected ${manifest.source.product_table_count}, got ${manifestTables.length}`,
);
assert(
  JSON.stringify(sorted(sourceTables)) === JSON.stringify(sorted(manifestTables)),
  "manifest product table set does not match PostgreSQL CREATE TABLE sources",
);

const representedSourceMigrations = [
  ...manifest.phases.flatMap((phase) => phase.source_migrations),
  ...manifest.semantic_migrations.map((migration) => migration.source),
];
assert(
  new Set(representedSourceMigrations).size === representedSourceMigrations.length,
  "source migration is represented more than once",
);
assert(
  JSON.stringify(sorted(representedSourceMigrations)) === JSON.stringify(sourceFiles),
  "manifest does not represent every PostgreSQL source migration exactly once",
);

let implementedTableCount = 0;
let draftTableCount = 0;
let parserVerifiedBlockedTableCount = 0;
let verifiedTableCount = 0;
let implementedSemanticMigrationCount = 0;
const referenceSeedRows = {
  "0014": 51,
  "0015": 56,
  "0016": 56,
  "0017": 56,
  "0018": 56,
  "0019": 56,
  "0020": 56,
  "0021": 56,
  "0022": 56,
  "0023": 56,
  "0024": 56,
};
for (const phase of manifest.phases) {
  assert(allowedPhaseStatuses.has(phase.status), `phase ${phase.id} has an invalid status`);
  const isParserSmokeVerified =
    phase.status === "isolated_parser_and_smoke_verified_activation_blocked";
  const isDraft = phase.status === "draft_blocked_unverified_on_container" || isParserSmokeVerified;
  const isImplemented =
    phase.status === "implemented_unverified_on_container" ||
    phase.status === "verified_on_container";
  const artifactFields = [
    "mariadb_file",
    "permissions_file",
    "contract_file",
    "semantics_file",
    "verification",
    "gaps_file",
    "static_test_file",
    "invariant_boundary_file",
    "definer_account_draft_file",
    "helper_permissions_draft_file",
    "helper_execute_permissions_draft_file",
    "transition_owner_execute_draft_file",
    "invariant_boundary_static_test_file",
    "transition_contract_file",
    "transition_contract_test_file",
    "transition_error_contract_file",
    "transition_error_contract_test_file",
    "transition_routine_files",
    "definer_dml_draft_file",
    "runtime_activation_draft_file",
    "runtime_rollback_draft_file",
    "runtime_acl_recovery_mode",
    "activation_gate_count",
    "transition_routines_static_test_file",
    "qa_contract_test_file",
    "trigger_file",
    "trigger_permissions_file",
  ];
  if (phase.status === "planned") {
    for (const artifactField of artifactFields) {
      assert(
        phase[artifactField] === undefined,
        `planned phase ${phase.id} must not claim ${artifactField}`,
      );
    }
    continue;
  }

  if (isDraft) {
    for (const forbiddenField of ["permissions_file", "contract_file", "semantics_file"]) {
      assert(
        phase[forbiddenField] === undefined,
        `blocked draft phase ${phase.id} must not claim ${forbiddenField}`,
      );
    }
    if (isParserSmokeVerified) {
      assert(
        typeof phase.verification === "object" && phase.verification !== null,
        `parser-smoke-verified phase ${phase.id} has no verification evidence`,
      );
      assert(
        /^\d{4}-\d{2}-\d{2}$/u.test(phase.verification.verified_at ?? ""),
        `parser-smoke-verified phase ${phase.id} has no verification date`,
      );
      assert(
        typeof phase.verification.server_version === "string" &&
          phase.verification.server_version.startsWith("11.4.13-MariaDB"),
        `parser-smoke-verified phase ${phase.id} has an unexpected server version`,
      );
      assert(
        /^mariadb@sha256:[0-9a-f]{64}$/u.test(phase.verification.image_index_digest ?? ""),
        `parser-smoke-verified phase ${phase.id} has no pinned image digest evidence`,
      );
      for (const evidenceFile of ["compose_file", "apply_file", "preflight_file"]) {
        await readRepositoryFile(
          phase.verification[evidenceFile],
          `parser-smoke-verified phase ${phase.id} ${evidenceFile}`,
        );
      }
      assert(
        phase.verification.runtime_activation_applied === false,
        `parser-smoke-verified phase ${phase.id} must retain the runtime activation block`,
      );
      assert(
        phase.verification.one_shot_isolation_guard_gap === "activation_blocker",
        `parser-smoke-verified phase ${phase.id} lost its one-shot isolation blocker`,
      );
      assert(
        phase.verification.persistent_row_count === (referenceSeedRows[phase.id.slice(0, 4)] ?? 0),
        `parser-smoke-verified phase ${phase.id} left unexpected persistent product rows`,
      );
      assert(
        phase.verification.full_postgresql_differential_gate_closed === false &&
          phase.verification.full_concurrency_gate_closed === false &&
          phase.verification.production_recovery_gate_closed === false,
        `parser-smoke-verified phase ${phase.id} overclaims a full differential, concurrency, or recovery gate`,
      );
      if (phase.id === "0002_class_membership") {
        for (const evidenceFile of [
          "routine_semantics_file",
          "targeted_concurrency_file",
          "targeted_fault_file",
          "targeted_integrity_file",
          "targeted_text_differential_file",
          "targeted_constraint_differential_file",
          "backup_restore_file",
        ]) {
          await readRepositoryFile(
            phase.verification[evidenceFile],
            `parser-smoke-verified phase ${phase.id} ${evidenceFile}`,
          );
        }
        assert(
          phase.verification.successful_transition_routine_count === 12,
          `parser-smoke-verified phase ${phase.id} must retain twelve successful routine probes`,
        );
        assert(
          phase.verification.targeted_concurrency_probe_count === 4,
          `parser-smoke-verified phase ${phase.id} must retain four targeted concurrency probes`,
        );
        assert(
          phase.verification.targeted_fault_probe_count === 5 &&
            phase.verification.error_then_commit_persistence === "observed_activation_risk",
          `parser-smoke-verified phase ${phase.id} lost its targeted fault evidence`,
        );
        assert(
          phase.verification.targeted_integrity_probe_count === 28,
          `parser-smoke-verified phase ${phase.id} lost its targeted integrity evidence`,
        );
        assert(
          phase.verification.targeted_text_differential_vector_count === 37 &&
            phase.verification.targeted_text_identity_precheck_count === 9,
          `parser-smoke-verified phase ${phase.id} lost its targeted text differential evidence`,
        );
        assert(
          phase.verification.targeted_constraint_outcome_probe_count === 28 &&
            phase.verification.targeted_constraint_rejection_probe_count === 24 &&
            phase.verification.targeted_constraint_acceptance_probe_count === 4 &&
            phase.verification.postgres_source_migration_count_applied ===
              manifest.source.migration_count,
          `parser-smoke-verified phase ${phase.id} lost its targeted constraint differential evidence`,
        );
        assert(
          phase.verification.synthetic_backup_restore_status ===
            "schema_content_catalog_privileges_match",
          `parser-smoke-verified phase ${phase.id} lost its synthetic recovery evidence`,
        );
      } else if (phase.id === "0003_content_meals") {
        assert(
          phase.verification.apply_file_count === 1 &&
            phase.verification.installed_total_table_count === 19 &&
            phase.verification.new_table_count === 6 &&
            phase.verification.routine_count === 15 &&
            phase.verification.trigger_count === 1 &&
            phase.verification.constraint_catalog_entry_count === 55,
          `parser-smoke-verified phase ${phase.id} lost its catalog evidence`,
        );
        assert(
          phase.verification.targeted_rejection_probe_count === 15 &&
            phase.verification.targeted_acceptance_probe_count === 1,
          `parser-smoke-verified phase ${phase.id} lost its targeted semantic evidence`,
        );
        assert(
          /^[0-9a-f]{64}$/u.test(phase.verification.migration_sha256 ?? ""),
          `parser-smoke-verified phase ${phase.id} lost its source digest`,
        );
        const phaseSource = await readRepositoryFile(
          phase.mariadb_file,
          `parser-smoke-verified phase ${phase.id} mariadb_file digest`,
        );
        assert(
          createHash("sha256").update(phaseSource).digest("hex") ===
            phase.verification.migration_sha256,
          `parser-smoke-verified phase ${phase.id} source digest drifted`,
        );
      } else if (phase.id === "0004_audit_import_logs") {
        assert(
          phase.verification.apply_file_count === 3 &&
            phase.verification.installed_total_table_count === 24 &&
            phase.verification.new_table_count === 5 &&
            phase.verification.routine_count === 15 &&
            phase.verification.trigger_count === 2 &&
            phase.verification.constraint_catalog_entry_count === 46,
          `parser-smoke-verified phase ${phase.id} lost its catalog evidence`,
        );
        assert(
          phase.verification.targeted_rejection_probe_count === 15 &&
            phase.verification.targeted_acceptance_probe_count === 1,
          `parser-smoke-verified phase ${phase.id} lost its targeted semantic evidence`,
        );
        for (const [field, artifactField] of [
          ["migration_sha256", "mariadb_file"],
          ["trigger_permissions_sha256", "trigger_permissions_file"],
          ["trigger_sha256", "trigger_file"],
        ]) {
          assert(
            /^[0-9a-f]{64}$/u.test(phase.verification[field] ?? ""),
            `parser-smoke-verified phase ${phase.id} lost ${field}`,
          );
          const source = await readRepositoryFile(
            phase[artifactField],
            `parser-smoke-verified phase ${phase.id} ${artifactField} digest`,
          );
          assert(
            createHash("sha256").update(source).digest("hex") === phase.verification[field],
            `parser-smoke-verified phase ${phase.id} ${artifactField} digest drifted`,
          );
        }
      } else if (phase.id === "0005_attendance_notifications") {
        assert(
          phase.verification.apply_file_count === 1 &&
            phase.verification.installed_total_table_count === 25 &&
            phase.verification.new_table_count === 1 &&
            phase.verification.routine_count === 15 &&
            phase.verification.trigger_count === 2 &&
            phase.verification.constraint_catalog_entry_count === 12,
          `parser-smoke-verified phase ${phase.id} lost its catalog evidence`,
        );
        assert(
          phase.verification.targeted_rejection_probe_count === 24 &&
            phase.verification.targeted_acceptance_probe_count === 1 &&
            phase.verification.fractional_time_rounding ===
              "verified_requires_TIME_ROUND_FRACTIONAL",
          `parser-smoke-verified phase ${phase.id} lost its targeted semantic evidence`,
        );
        const source = await readRepositoryFile(phase.mariadb_file, `${phase.id} source digest`);
        assert(
          createHash("sha256").update(source).digest("hex") === phase.verification.migration_sha256,
          `parser-smoke-verified phase ${phase.id} source digest drifted`,
        );
      } else if (phase.id === "0006_in_app_reminders") {
        assert(
          phase.verification.apply_file_count === 3 &&
            phase.verification.installed_total_table_count === 27 &&
            phase.verification.new_table_count === 2 &&
            phase.verification.routine_count === 15 &&
            phase.verification.trigger_count === 3 &&
            phase.verification.constraint_catalog_entry_count === 12,
          `parser-smoke-verified phase ${phase.id} lost its catalog evidence`,
        );
        assert(
          phase.verification.targeted_rejection_probe_count === 33 &&
            phase.verification.targeted_acceptance_probe_count === 3 &&
            phase.verification.json_numeric_lexical_parity === "activation_blocker" &&
            phase.verification.source_sql_null_audit_shape === "preserved",
          `parser-smoke-verified phase ${phase.id} lost its semantic boundary`,
        );
        await readRepositoryFile(
          phase.verification.semantic_scenarios_file,
          `${phase.id} scenarios`,
        );
        for (const [field, artifactField] of [
          ["migration_sha256", "mariadb_file"],
          ["trigger_permissions_sha256", "trigger_permissions_file"],
          ["trigger_sha256", "trigger_file"],
        ]) {
          const source = await readRepositoryFile(
            phase[artifactField],
            `${phase.id} ${artifactField}`,
          );
          assert(
            createHash("sha256").update(source).digest("hex") === phase.verification[field],
            `parser-smoke-verified phase ${phase.id} ${artifactField} digest drifted`,
          );
        }
      } else if (
        ["0007_content_audiences", "0008_school_schedules", "0009_student_assessments"].includes(
          phase.id,
        )
      ) {
        const [files, total, added, constraints, rejected, accepted] = {
          "0007_content_audiences": [3, 29, 2, 6, 17, 3],
          "0008_school_schedules": [1, 31, 2, 16, 13, 2],
          "0009_student_assessments": [1, 32, 1, 15, 17, 2],
        }[phase.id];
        assert(
          phase.verification.apply_file_count === files &&
            phase.verification.installed_total_table_count === total &&
            phase.verification.shared_qa_total_table_count === 32 &&
            phase.verification.new_table_count === added &&
            phase.verification.routine_count === 15 &&
            phase.verification.trigger_count === 5 &&
            phase.verification.constraint_catalog_entry_count === constraints &&
            phase.verification.targeted_rejection_probe_count === rejected &&
            phase.verification.targeted_acceptance_probe_count === accepted,
          `parser-smoke-verified phase ${phase.id} lost its shared QA evidence`,
        );
        await readRepositoryFile(
          phase.verification.semantic_scenarios_file,
          `${phase.id} scenarios`,
        );
        const digests = [["migration_sha256", "mariadb_file"]];
        if (phase.id === "0007_content_audiences") {
          digests.push(
            ["trigger_permissions_sha256", "trigger_permissions_file"],
            ["trigger_sha256", "trigger_file"],
          );
          assert(
            phase.verification.audience_visibility_scope === "db_predicate_only",
            `${phase.id} overclaims API visibility`,
          );
        } else if (phase.id === "0008_school_schedules") {
          assert(
            phase.verification.long_unique_index_type === "HASH" &&
              phase.verification.trailing_space_identity === "targeted_verified_nopad",
            `${phase.id} lost its text identity evidence`,
          );
        } else {
          assert(
            phase.verification.clock_timestamp_parity === "activation_blocker",
            `${phase.id} lost its timestamp blocker`,
          );
        }
        for (const [field, artifactField] of digests) {
          const source = await readRepositoryFile(
            phase[artifactField],
            `${phase.id} ${artifactField}`,
          );
          assert(
            createHash("sha256").update(source).digest("hex") === phase.verification[field],
            `parser-smoke-verified phase ${phase.id} ${artifactField} digest drifted`,
          );
        }
      } else if (phase.id === "0010_polls") {
        for (const [field, expected] of Object.entries({
          apply_file_count: 1,
          installed_total_table_count: 35,
          new_table_count: 3,
          routine_count: 15,
          trigger_count: 5,
          constraint_catalog_entry_count: 23,
          targeted_rejection_probe_count: 44,
          targeted_acceptance_probe_count: 6,
          normalized_label_vector_count: 8,
          generated_label_overflow_errno: 1406,
          verification_run: "post_apply_after_errno_expectation_correction",
          application_authorization_scope: "not_verified_schema_only",
          clock_timestamp_parity: "activation_blocker",
        })) {
          assert(
            phase.verification[field] === expected,
            `${phase.id} lost its ${field} evidence boundary`,
          );
        }
        await readRepositoryFile(
          phase.verification.semantic_scenarios_file,
          `${phase.id} scenarios`,
        );
        const source = await readRepositoryFile(phase.mariadb_file, `${phase.id} source digest`);
        assert(
          createHash("sha256").update(source).digest("hex") === phase.verification.migration_sha256,
          `parser-smoke-verified phase ${phase.id} source digest drifted`,
        );
      } else if (phase.id === "0011_seat_draws") {
        for (const [field, expected] of Object.entries({
          apply_file_count: 3,
          installed_total_table_count: 38,
          new_table_count: 3,
          routine_count: 15,
          trigger_count: 9,
          constraint_catalog_entry_count: 25,
          targeted_rejection_probe_count: 59,
          targeted_acceptance_probe_count: 7,
          owner_column_read_count: 13,
          owner_trigger_privilege_count: 2,
          verification_run: "post_apply_after_catalog_order_correction",
          application_authorization_scope: "not_verified_schema_only",
          parent_later_change_behavior: "source_boundary_preserved",
          clock_timestamp_parity: "activation_blocker",
        })) {
          assert(phase.verification[field] === expected, `${phase.id} lost ${field}`);
        }
        await readRepositoryFile(
          phase.verification.semantic_scenarios_file,
          `${phase.id} scenarios`,
        );
        for (const [field, artifact] of [
          ["migration_sha256", "mariadb_file"],
          ["trigger_sha256", "trigger_file"],
          ["trigger_permissions_sha256", "trigger_permissions_file"],
        ]) {
          const source = await readRepositoryFile(phase[artifact], `${phase.id} ${artifact}`);
          assert(
            createHash("sha256").update(source).digest("hex") === phase.verification[field],
            `${phase.id} ${artifact} digest drifted`,
          );
        }
      } else {
        await verifyFeaturePhaseEvidence(phase, readRepositoryFile);
      }
    } else {
      assert(
        phase.verification === undefined,
        `unverified blocked draft phase ${phase.id} must not claim verification evidence`,
      );
    }
    const draftSql = stripSqlComments(
      await readRepositoryFile(phase.mariadb_file, `draft phase ${phase.id} mariadb_file`),
    );
    const draftTables = [...draftSql.matchAll(tablePattern)].map((match) => match[1]);
    assert(
      JSON.stringify(sorted(draftTables)) === JSON.stringify(sorted(phase.tables)),
      `draft phase ${phase.id} table set does not match its manifest entry`,
    );
    assert(
      (draftSql.match(/ENGINE\s*=\s*InnoDB/giu) ?? []).length === draftTables.length,
      `${phase.id} draft must declare InnoDB on every table`,
    );
    assert(
      (draftSql.match(/DEFAULT\s+CHARSET\s*=\s*utf8mb4\s+COLLATE\s*=\s*utf8mb4_bin/giu) ?? [])
        .length === draftTables.length,
      `${phase.id} draft must declare utf8mb4_bin on every table`,
    );
    // Only these phase-owned existing indexes/checks may be replaced; other DROP stays forbidden.
    let boundedDraftSql = draftSql;
    if (phase.id === "0014_audit_action_catalog") {
      boundedDraftSql = boundedDraftSql.replace(/DROP CONSTRAINT audit_logs_action_check,/u, "");
    }
    if (phase.id === "0005_attendance_notifications") {
      boundedDraftSql = boundedDraftSql.replace(
        /ALTER TABLE notices\s+DROP INDEX notices_importance_index,/u,
        "ALTER TABLE notices",
      );
    }
    if (
      [
        "0005_attendance_notifications",
        "0006_in_app_reminders",
        "0010_polls",
        "0011_seat_draws",
        "0012_team_draws",
        "0013_duty_rosters",
      ].includes(phase.id)
    ) {
      boundedDraftSql = boundedDraftSql.replace(
        /ALTER TABLE audit_logs\s+DROP CONSTRAINT audit_logs_action_check,\s+DROP CONSTRAINT audit_logs_json_allowlist_check,/u,
        "ALTER TABLE audit_logs",
      );
    }
    if (phase.id === "0007_content_audiences") {
      boundedDraftSql = boundedDraftSql.replace(
        /ALTER TABLE audit_logs\s+DROP CONSTRAINT audit_logs_json_allowlist_check,/u,
        "ALTER TABLE audit_logs",
      );
    }
    if (["0008_school_schedules", "0018_public_holidays", "0020_admin_auth"].includes(phase.id)) {
      boundedDraftSql = boundedDraftSql.replace(
        /ALTER TABLE operator_audit_logs\s+DROP CONSTRAINT operator_audit_logs_action_check,\s+DROP CONSTRAINT operator_audit_logs_json_allowlist_check,/u,
        "ALTER TABLE operator_audit_logs",
      );
    }
    for (const pattern of [
      /\bDROP\b/iu,
      /(?:^|[;\n])\s*GRANT\b/iu,
      /(?:^|[;\n])\s*REVOKE\b/iu,
      /\bCREATE\s+USER\b/iu,
      /\bIDENTIFIED\s+BY\b/iu,
    ]) {
      assert(
        !pattern.test(boundedDraftSql),
        `${phase.id} draft contains forbidden SQL: ${pattern}`,
      );
    }
    const gaps = await readRepositoryFile(
      phase.gaps_file,
      `blocked draft phase ${phase.id} gaps_file`,
    );
    for (const blocker of ["B-01", "B-02", "B-03", "B-04"]) {
      assert(gaps.includes(`### ${blocker}`), `${phase.id} draft is missing blocker ${blocker}`);
    }
    await readRepositoryFile(
      phase.static_test_file,
      `blocked draft phase ${phase.id} static_test_file`,
    );
    for (const draftArtifactField of [
      "invariant_boundary_file",
      "definer_account_draft_file",
      "helper_permissions_draft_file",
      "helper_execute_permissions_draft_file",
      "transition_owner_execute_draft_file",
      "invariant_boundary_static_test_file",
      "transition_contract_file",
      "transition_contract_test_file",
      "definer_dml_draft_file",
      "runtime_activation_draft_file",
      "runtime_rollback_draft_file",
      "transition_routines_static_test_file",
      "qa_contract_test_file",
      "trigger_file",
      "trigger_permissions_file",
    ]) {
      if (phase[draftArtifactField] !== undefined) {
        await readRepositoryFile(
          phase[draftArtifactField],
          `blocked draft phase ${phase.id} ${draftArtifactField}`,
        );
      }
    }
    if (phase.transition_routine_files !== undefined) {
      assert(
        Array.isArray(phase.transition_routine_files) &&
          phase.transition_routine_files.length === 5 &&
          new Set(phase.transition_routine_files).size === 5,
        `blocked draft phase ${phase.id} must name five distinct transition routine files`,
      );
      for (const routineFile of phase.transition_routine_files) {
        await readRepositoryFile(
          routineFile,
          `blocked draft phase ${phase.id} transition_routine_files`,
        );
      }
    }
    if (phase.runtime_acl_recovery_mode !== undefined) {
      assert(
        phase.runtime_acl_recovery_mode === "fail_closed_full_runtime_reconcile",
        `blocked draft phase ${phase.id} has an unknown runtime ACL recovery mode`,
      );
      assert(
        phase.activation_gate_count === 11,
        `blocked draft phase ${phase.id} must retain all eleven activation gates`,
      );
    }
    draftTableCount += draftTables.length;
    if (isParserSmokeVerified) parserVerifiedBlockedTableCount += draftTables.length;
    continue;
  }

  assert(isImplemented, `phase ${phase.id} status handling is incomplete`);

  const mariaSql = await readRepositoryFile(
    phase.mariadb_file,
    `implemented phase ${phase.id} mariadb_file`,
  );
  const sqlWithoutComments = stripSqlComments(mariaSql);
  const mariaTables = [...sqlWithoutComments.matchAll(tablePattern)].map((match) => match[1]);
  assert(
    JSON.stringify(sorted(mariaTables)) === JSON.stringify(sorted(phase.tables)),
    `implemented phase ${phase.id} table set does not match its manifest entry`,
  );

  const forbiddenPatterns = [
    /\bDROP\b/iu,
    /\bCREATE\s+USER\b/iu,
    /\bIDENTIFIED\s+BY\b/iu,
    /\bGRANT\s+ALL\b/iu,
    /\bpgmigrations\b/iu,
  ];
  for (const pattern of forbiddenPatterns) {
    assert(!pattern.test(sqlWithoutComments), `${phase.id} contains forbidden SQL: ${pattern}`);
  }

  const innodbDeclarations = sqlWithoutComments.match(/ENGINE\s*=\s*InnoDB/giu) ?? [];
  const charsetDeclarations =
    sqlWithoutComments.match(/DEFAULT\s+CHARSET\s*=\s*utf8mb4\s+COLLATE\s*=\s*utf8mb4_bin/giu) ??
    [];
  assert(
    innodbDeclarations.length === mariaTables.length,
    `${phase.id} must declare InnoDB on every table`,
  );
  assert(
    charsetDeclarations.length === mariaTables.length,
    `${phase.id} must declare utf8mb4_bin on every table`,
  );
  const permissionsSql = stripSqlComments(
    await readRepositoryFile(
      phase.permissions_file,
      `implemented phase ${phase.id} permissions_file`,
    ),
  );
  assert(!/\bIDENTIFIED\s+BY\b/iu.test(permissionsSql), `${phase.id} grants contain a password`);
  assert(!/\bGRANT\s+ALL\b/iu.test(permissionsSql), `${phase.id} grants contain GRANT ALL`);
  assert(
    !/TO\s+'classhub_(?:worker|operator)'@'%'/iu.test(permissionsSql),
    `${phase.id} grants accidentally open identity tables to worker/operator`,
  );

  const contractSql = stripSqlComments(
    await readRepositoryFile(phase.contract_file, `implemented phase ${phase.id} contract_file`),
  );
  for (const pattern of [
    /\bINSERT\b/iu,
    /\bUPDATE\b/iu,
    /\bDELETE\b/iu,
    /\bCREATE\b/iu,
    /\bDROP\b/iu,
    /\bALTER\b/iu,
    /\bTRUNCATE\b/iu,
    /\bGRANT\b/iu,
    /\bREVOKE\b/iu,
    /\bCALL\b/iu,
  ]) {
    assert(!pattern.test(contractSql), `${phase.id} contract is not read-only: ${pattern}`);
  }
  await readRepositoryFile(phase.semantics_file, `implemented phase ${phase.id} semantics_file`);
  implementedTableCount += mariaTables.length;
  if (phase.status === "verified_on_container") {
    assert(
      typeof phase.verification === "object" && phase.verification !== null,
      `verified phase ${phase.id} has no verification evidence`,
    );
    assert(
      /^\d{4}-\d{2}-\d{2}$/u.test(phase.verification.verified_at ?? ""),
      `verified phase ${phase.id} has no verification date`,
    );
    assert(
      typeof phase.verification.server_version === "string" &&
        phase.verification.server_version.startsWith("11.4.13-MariaDB"),
      `verified phase ${phase.id} has an unexpected server version`,
    );
    assert(
      /^mariadb@sha256:[0-9a-f]{64}$/u.test(phase.verification.image_index_digest ?? ""),
      `verified phase ${phase.id} has no pinned image digest evidence`,
    );
    await readRepositoryFile(
      phase.verification.preflight_file,
      `verified phase ${phase.id} preflight_file`,
    );
    assert(
      Number.isInteger(phase.verification.semantic_rejection_count) &&
        phase.verification.semantic_rejection_count > 0,
      `verified phase ${phase.id} has no semantic rejection count`,
    );
    verifiedTableCount += mariaTables.length;
  } else {
    assert(
      phase.verification === undefined,
      `unverified phase ${phase.id} must not claim verification evidence`,
    );
  }
}

for (const migration of manifest.semantic_migrations) {
  assert(
    allowedSemanticStatuses.has(migration.status),
    `semantic migration ${migration.source} has an invalid status`,
  );
  assert(
    Array.isArray(migration.target_phases) && migration.target_phases.length > 0,
    `semantic migration ${migration.source} has no target phases`,
  );
  assert(
    new Set(migration.target_phases).size === migration.target_phases.length,
    `semantic migration ${migration.source} repeats a target phase`,
  );
  if (migration.status === "planned_unimplemented") {
    assert(
      migration.artifacts === undefined,
      `planned semantic migration ${migration.source} must not claim artifacts`,
    );
    continue;
  }
  assert(
    Array.isArray(migration.artifacts) && migration.artifacts.length > 0,
    `implemented semantic migration ${migration.source} has no artifacts`,
  );
  for (const artifact of migration.artifacts) {
    await readRepositoryFile(artifact, `semantic migration ${migration.source} artifact`);
  }
  implementedSemanticMigrationCount += 1;
}

const productSchemaComplete = implementedTableCount === manifest.source.product_table_count;
await semanticEvidence.verifySemanticFollowupEvidence(manifest, readRepositoryFile);
assert(
  manifest.status === "development_only_incomplete" && !productSchemaComplete,
  "manifest completion status is inconsistent with implemented tables",
);

process.stdout.write(
  `${JSON.stringify({
    latestSourceMigration: currentSourceFiles.at(-1),
    latestHistoricalSourceMigration: sourceFiles.at(-1),
    mariaDbDraftTables: draftTableCount,
    mariaDbParserVerifiedBlockedTables: parserVerifiedBlockedTableCount,
    mariaDbImplementedTables: implementedTableCount,
    mariaDbVerifiedTables: verifiedTableCount,
    mariaDbImplementedSemanticMigrations: implementedSemanticMigrationCount,
    productTables: manifestTables.length,
    productSchemaComplete,
    sourceMigrations: currentSourceFiles.length,
    historicalSourceMigrations: sourceFiles.length,
    sourceOverlays: [adminSessionRenewalAclOverlay.sourcePath],
    schemaFollowups: schemaFollowups.followups,
    status: "inventory_pass_schema_incomplete",
  })}\n`,
);
