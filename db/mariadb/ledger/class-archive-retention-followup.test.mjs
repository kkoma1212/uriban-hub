import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  nativeInstalledCatalog,
  verifyNativeInstalledSchema,
} from "../../../OPERATIONS/mariadb-dev/verify-native-installed-schema.mjs";
import {
  firstInstallFeatures,
  buildFirstInstallSql,
  buildCandidateFirstInstallSql,
} from "../../../scripts/generate-first-install-sql.mjs";
import {
  deriveClassArchiveCandidateRestoreCatalog,
  deriveRestoreCatalog,
} from "../../../OPERATIONS/native-runtime/backup-restore-catalog.mjs";
import {
  classArchiveCandidateArtifacts,
  classArchiveRetentionArtifacts,
  readClassArchiveRetentionSql,
  withClassArchiveRetentionPostconditions,
  buildClassArchiveCandidateSql,
  buildClassArchiveRollbackSql,
  rehearseClassArchiveCandidate,
  verifyClassArchiveProbeMetadata,
} from "./class-archive-retention-followup.mjs";

test("candidate probe attests the selected schema and rejects absent or foreign schema grants", async () => {
  const catalog = nativeInstalledCatalog({
    ...firstInstallFeatures,
    classArchiveRetention: "active",
  });
  const observed = {
    accounts: [
      {
        account: catalog.class_archive_candidate.probe.owner,
        host: "%",
        locked: 1,
        is_role: 0,
        ssl_type: 0,
      },
    ],
    routines: [
      {
        routine_name: "class_archive_schema_inventory",
        definer: "classhub_retention_schema@%",
        routine_type: "PROCEDURE",
        security_type: "DEFINER",
        data_access: "READS SQL DATA",
        charset_name: "utf8mb4",
        collation_name: "utf8mb4_bin",
        database_collation: "utf8mb4_bin",
        body_sql: catalog.class_archive_candidate.probe.body,
      },
    ],
    parameters: [],
  };
  const connection = (selected, grants) => ({
    query: async (statement) => {
      if (statement === "SELECT DATABASE() AS database_name") return [selected];
      if (statement.includes("information_schema.USER_PRIVILEGES"))
        return [[{ privilege_name: "REFERENCES", grantable: "NO" }]];
      if (statement.includes("information_schema.SCHEMA_PRIVILEGES"))
        return [[{ database_name: grants, privilege_name: "SELECT", grantable: "NO" }]];
      if (statement.includes("mysql.procs_priv"))
        return [
          [
            {
              database_name: grants,
              routine_name: "class_archive_schema_inventory",
              routine_type: "PROCEDURE",
              privileges: "Execute",
            },
          ],
        ];
      return [[{ n: 0 }]];
    },
  });
  for (const name of ["classhub", "classhub_mariadb_phase1_dev"]) {
    await verifyClassArchiveProbeMetadata(
      connection([{ database_name: name }], name),
      catalog,
      observed,
    );
    await assert.rejects(
      verifyClassArchiveProbeMetadata(
        connection([{ database_name: name }], "foreign_schema"),
        catalog,
        observed,
      ),
    );
  }
  for (const selected of [
    [],
    [{ database_name: null }],
    [{ database_name: "" }],
    [{ database_name: "bad-name" }],
    [{ database_name: "classhub" }, { database_name: "other" }],
  ]) {
    await assert.rejects(
      verifyClassArchiveProbeMetadata(connection(selected, "classhub"), catalog, observed),
    );
  }
});

test("native attestation rejects an absent or malformed selected database before reading the catalog", async () => {
  for (const selected of [
    [],
    [{ database_name: null }],
    [{ database_name: "" }],
    [{ database_name: "bad-name" }],
    [{ database_name: "classhub" }, { database_name: "other" }],
  ]) {
    let queries = 0;
    const connection = {
      query: async (statement) => {
        queries++;
        assert.equal(statement, "SELECT DATABASE() AS database_name");
        return [selected];
      },
    };
    await assert.rejects(verifyNativeInstalledSchema(connection, firstInstallFeatures));
    assert.equal(queries, 1);
  }
});

test("default baseline remains unchanged and candidate versions are separate pinned opt-ins", () => {
  const base = nativeInstalledCatalog(firstInstallFeatures);
  assert.equal(base.plan.ledger.planned_record_count, 95);
  assert.equal(withClassArchiveRetentionPostconditions(base), base);
  assert.deepEqual(classArchiveCandidateArtifacts(), []);
  assert.deepEqual(
    classArchiveCandidateArtifacts("active").map((a) => a.ledger_version),
    [110, 111, 112],
  );
  assert.deepEqual(
    classArchiveCandidateArtifacts("legacy").map((a) => a.ledger_version),
    [110, 111, 112, 113],
  );
  for (const artifact of classArchiveRetentionArtifacts) {
    assert.ok(readClassArchiveRetentionSql(artifact));
    assert.throws(() =>
      readClassArchiveRetentionSql(artifact, (path) =>
        Buffer.concat([readFileSync(path), Buffer.from(" ")]),
      ),
    );
  }
  const selected = withClassArchiveRetentionPostconditions(base, { profile: "active" });
  assert.equal(selected.plan.ledger.planned_record_count, 98);
  assert.equal(selected.final.tables.classes.columns.created_by_user_id.nullable, true);
  assert.equal(selected.class_archive_candidate.defaultEnabled, false);
  assert.throws(() => withClassArchiveRetentionPostconditions(selected, { profile: "active" }));
  assert.throws(() =>
    withClassArchiveRetentionPostconditions(nativeInstalledCatalog(), { profile: "active" }),
  );
});

test("candidate package preserves source hashes and attests transformed SQL independently", () => {
  const baseline = buildFirstInstallSql();
  assert.deepEqual(buildCandidateFirstInstallSql(), baseline);
  const selected = buildCandidateFirstInstallSql({ profile: "active" });
  assert.equal(selected.manifest.baseline_ledger_rows, 95);
  assert.equal(selected.manifest.ledger_rows, 98);
  assert.equal(selected.manifest.baseline_sql_sha256, baseline.manifest.sql_sha256);
  assert.notEqual(selected.manifest.sql_sha256, baseline.manifest.sql_sha256);
  assert.match(selected.sql, /CANDIDATE_SCHEMA_OWNER_CONFLICT/u);
  assert.doesNotMatch(selected.sql, /classhub_mariadb_phase1_dev/u);
  assert.deepEqual(
    selected.manifest.artifacts.slice(0, baseline.manifest.artifacts.length),
    baseline.manifest.artifacts,
  );
  assert.throws(() => buildCandidateFirstInstallSql({ profile: "legacy" }));
  const existing = buildClassArchiveCandidateSql({
    profile: "legacy",
    database: "classhub_archive_qa",
    accountHost: "localhost",
  });
  assert.deepEqual(existing.manifest.ledger_versions, [110, 111, 112, 113]);
  assert(
    existing.manifest.artifacts.some((artifact) => artifact.sha256 !== artifact.emitted_sha256),
  );
  assert.equal(existing.manifest.productionActivationApplied, false);
});

test("restore policy preserves deadlines and declares re-cleanup without pretending to restore erased data", () => {
  assert.deepEqual(deriveClassArchiveCandidateRestoreCatalog(), deriveRestoreCatalog());
  const selected = deriveClassArchiveCandidateRestoreCatalog({ profile: "active" });
  assert.equal(selected.expectedLedgerRows, 96);
  assert.equal(selected.restorePolicy.applicationRestore, false);
  assert.equal(selected.restorePolicy.migrationRollbackRestoresDeletedData, false);
  assert.equal(selected.restorePolicy.clockResetOnRestore, false);
  assert.throws(
    () => deriveClassArchiveCandidateRestoreCatalog({ profile: "legacy" }),
    /Legacy restore is unsupported/u,
  );
  assert.throws(
    () => nativeInstalledCatalog({ ...firstInstallFeatures, classArchiveRetention: "legacy" }),
    /Legacy candidate requires/u,
  );
  assert(selected.restorePolicy.requiredRecleanupTargets.includes("class-archives"));
});

test("schema rollback requires exclusive stopped-runtime conditions and preserves inherited grants", async () => {
  const base = nativeInstalledCatalog(firstInstallFeatures);
  const rollback = buildClassArchiveRollbackSql(base, { profile: "active" });
  assert.equal(rollback.dataRecovery, false);
  assert.deepEqual(rollback.requires, [
    "scheduler_disabled",
    "exclusive_install_lock",
    "no_retention_purged_classes",
    "no_class_linked_assessments",
  ]);
  assert(
    !rollback.statements.some((sql) =>
      /REVOKE.*(?:student_assessment_records|attendance_notifications)/u.test(sql),
    ),
  );
  assert.match(
    rollback.statements.at(-1),
    /edu_office_code varchar\(3\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/u,
  );
  const connection = {
    query: async () => [[{ database_name: "classhub_archive_qa", server_port: 3309 }]],
  };
  await assert.rejects(
    rehearseClassArchiveCandidate(connection, {
      mode: "rollback",
      base,
      profile: "active",
      schedulerDisabled: true,
    }),
    /Shared target/u,
  );
});
