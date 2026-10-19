import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  nativeInstalledCatalog,
  nativeFirstInstallCatalog,
  verifyNativeInstalledSchema,
} from "../OPERATIONS/mariadb-dev/verify-native-installed-schema.mjs";
import { buildClassArchiveCandidateSql } from "../db/mariadb/ledger/class-archive-retention-followup.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const preflightAccounts =
  "'classhub_app','classhub_operator','classhub_worker','classhub_retention','classhub_migrator'";
// Read-only anonymous block: no helper routine/table or database is created before rejection.
export const firstInstallPreflightSql = `DELIMITER //
BEGIN NOT ATOMIC
  IF EXISTS (SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='classhub') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='FIRST_INSTALL_TARGET_EXISTS';
  END IF;
  IF (SELECT COUNT(*) FROM mysql.global_priv WHERE User IN (${preflightAccounts}) AND Host='%') <> 5
     OR EXISTS (SELECT 1 FROM mysql.global_priv WHERE User IN (${preflightAccounts}) AND
       (Host<>'%' OR COALESCE(JSON_VALUE(Priv,'$.access'),0)<>0 OR
        COALESCE(JSON_VALUE(Priv,'$.is_role'),0)<>0 OR
        COALESCE(JSON_VALUE(Priv,'$.default_role'),'')<>''))
     OR EXISTS (SELECT 1 FROM mysql.global_priv WHERE User='classhub_routine') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='FIRST_INSTALL_ACCOUNT_CONFLICT';
  END IF;
  IF EXISTS (SELECT 1 FROM mysql.db WHERE User IN (${preflightAccounts},'PUBLIC'))
     OR EXISTS (SELECT 1 FROM mysql.tables_priv WHERE User IN (${preflightAccounts},'PUBLIC'))
     OR EXISTS (SELECT 1 FROM mysql.columns_priv WHERE User IN (${preflightAccounts},'PUBLIC'))
     OR EXISTS (SELECT 1 FROM mysql.procs_priv WHERE User IN (${preflightAccounts},'PUBLIC'))
     OR EXISTS (SELECT 1 FROM mysql.roles_mapping WHERE User IN (${preflightAccounts},'PUBLIC') OR Role IN (${preflightAccounts}))
     OR EXISTS (SELECT 1 FROM mysql.proxies_priv WHERE User IN (${preflightAccounts}) OR Proxied_user IN (${preflightAccounts}))
     OR EXISTS (SELECT 1 FROM mysql.global_priv WHERE User='PUBLIC' AND COALESCE(JSON_VALUE(Priv,'$.access'),0)<>0)
     OR EXISTS (SELECT 1 FROM information_schema.PROCESSLIST WHERE USER IN (${preflightAccounts})) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='FIRST_INSTALL_ACCOUNT_PRIVILEGES_OR_ACTIVITY';
  END IF;
END//
DELIMITER ;
`;
export const firstInstallFeatures = Object.freeze(
  Object.fromEntries(
    [
      "accountExperience",
      "mailManagement",
      "auditHistory",
      "operatorCommands",
      "archiveReason",
      "pollClose",
      "pushSubscriptions",
      "pushDeliveries",
      "scheduleLinks",
      "helpRequests",
      "helpChat",
      "teacherLibrary",
      "adminPasskeys",
      "socialLogin",
      "classChat",
      "profilePhotos",
      "sessionRevoke",
      "birthDates",
      "adminAccessLogs",
      "legalSnapshots",
      "mailLogRetention",
      "auditConsentRetention",
      "adminRecordsRetention",
      "pollEdit",
    ].map((key) => [key, true]),
  ),
);

/** Offline packaging only. Never connects, provisions credentials, or applies a migration.
 * Run from repository root. Source ledger hashes remain the reviewed original hashes;
 * the manifest separately attests the exact database-name-transformed emitted bytes.
 */
export function buildFirstInstallSql({
  readRepoFile = (path) => readFileSync(resolve(root, path)),
  catalog,
} = {}) {
  if (!catalog) {
    assert.equal(
      resolve(process.cwd()),
      resolve(root),
      "Run this generator from the repository root",
    );
    catalog = nativeInstalledCatalog(firstInstallFeatures);
  }
  const plan = catalog.plan;
  const steps = plan.steps.filter((step) => step.ledger_version !== null);
  assert.equal(steps.length, plan.ledger.planned_record_count, "Missing ledger artifacts");
  assert.equal(
    steps.length,
    95,
    "First-install inventory needs explicit review after an extension",
  );
  assert.equal(steps.at(-1).ledger_version, 108);
  const seen = new Set(),
    versions = new Set(),
    paths = new Set(),
    hashes = new Set();
  const artifacts = [];
  const emit = (artifact) => {
    assert.match(artifact.source_path, /^db\/mariadb\/[a-zA-Z0-9_./-]+\.sql$/u);
    assert.ok(!artifact.source_path.split("/").includes(".."));
    const bytes = Buffer.from(readRepoFile(artifact.source_path));
    assert.equal(
      bytes.length,
      artifact.byte_length,
      `Source length changed: ${artifact.source_path}`,
    );
    assert.equal(hash(bytes), artifact.sha256, `Source checksum changed: ${artifact.source_path}`);
    const sql = bytes.toString("utf8").replaceAll("classhub_mariadb_phase1_dev", "classhub");
    assert.doesNotMatch(sql, /\bIDENTIFIED\s+(?:BY|VIA|WITH)\b/iu, "Credential SQL is forbidden");
    assert.doesNotMatch(sql, /\b(?:CREATE|ALTER)\s+DATABASE\b/iu);
    for (const use of sql.matchAll(/^\s*USE\s+([^;]+);/gimu))
      assert.equal(use[1], "classhub", "Unexpected schema selection");
    artifacts.push({
      ...artifact,
      emitted_sha256: hash(sql),
      emitted_byte_length: Buffer.byteLength(sql),
    });
    return `\n-- source: ${artifact.source_path}; original-sha256: ${artifact.sha256}\n${sql}\nDELIMITER ;\n`;
  };
  let sql =
    "-- Fresh empty server only. Pre-provision classhub_app/operator/worker/retention/migrator accounts securely.\n" +
    "-- Execute with the MariaDB client, without --force. Stop on any error; never rerun or auto-resume.\n" +
    "-- DDL is not transactional. Review partial targets separately after failure.\n" +
    "-- The locked classhub_routine definer is created by reviewed schema SQL.\n" +
    "-- Require exclusive DBA installation; five pre-provisioned accounts must have USAGE only, no roles/proxies/other hosts.\n" +
    "-- PUBLIC privileges must be removed by the server owner before installation.\n" +
    firstInstallPreflightSql +
    "CREATE DATABASE classhub CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;\nUSE classhub;\n" +
    "SET time_zone = '+00:00';\nSET NAMES utf8mb4 COLLATE utf8mb4_bin;\n";
  sql += emit(plan.ledger.bootstrap);
  for (const step of steps) {
    assert.ok(
      !versions.has(step.ledger_version) &&
        !paths.has(step.source_path) &&
        !hashes.has(step.sha256),
      "Duplicate ledger version, source path, or checksum",
    );
    for (const dependency of step.requires ?? [])
      assert.ok(
        seen.has(dependency) || dependency === "development-identities",
        `Missing or out-of-order prerequisite: ${dependency}`,
      );
    if (step.id === "current-runtime-acl")
      for (const role of ["app", "operator", "worker", "retention"])
        sql += `REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'classhub_${role}'@'%';\n`;
    sql += emit(step);
    sql += `INSERT INTO classhub_schema_migrations (version,description,source_sha256,applied_at_utc,server_version) VALUES (${step.ledger_version},'${step.id}',UNHEX('${step.sha256}'),UTC_TIMESTAMP(6),VERSION());\n`;
    seen.add(step.id);
    versions.add(step.ledger_version);
    paths.add(step.source_path);
    hashes.add(step.sha256);
  }
  return {
    sql,
    manifest: {
      schema_version: 1,
      database: "classhub",
      source_plan_sha256: plan.plan_sha256,
      transformation: "classhub_mariadb_phase1_dev => classhub; source ledger hashes preserved",
      execution_applied: false,
      ledger_rows: steps.length,
      sql_sha256: hash(sql),
      artifacts,
    },
  };
}

/** Optional separate release artifact. The default 95-row package and its hashes are preserved. */
export function buildCandidateFirstInstallSql({ profile = "none", ...options } = {}) {
  const baseline = buildFirstInstallSql(options);
  if (profile === "none") return baseline;
  assert.equal(profile, "active", "Fresh active-scope installation excludes retired legacy tables");
  const candidate = buildClassArchiveCandidateSql({ profile, database: "classhub" });
  const preflight = `DELIMITER //\nBEGIN NOT ATOMIC\n  IF EXISTS (SELECT 1 FROM mysql.global_priv WHERE User='classhub_retention_schema') THEN\n    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='CANDIDATE_SCHEMA_OWNER_CONFLICT';\n  END IF;\nEND//\nDELIMITER ;\n`;
  const sql = preflight + baseline.sql + candidate.sql;
  return {
    sql,
    manifest: {
      ...baseline.manifest,
      candidateOnly: true,
      candidate_profile: profile,
      baseline_sql_sha256: baseline.manifest.sql_sha256,
      baseline_ledger_rows: baseline.manifest.ledger_rows,
      ledger_rows: baseline.manifest.ledger_rows + candidate.manifest.artifacts.length,
      sql_sha256: hash(sql),
      artifacts: [...baseline.manifest.artifacts, ...candidate.manifest.artifacts],
      candidate: candidate.manifest,
    },
  };
}

/** Separate fresh-install contract; the current PC restore catalog remains independent. */
export function firstInstallCatalog({ profile = "none" } = {}) {
  assert(["none", "active"].includes(profile));
  const generated = buildCandidateFirstInstallSql({ profile });
  const catalog = nativeFirstInstallCatalog({
    ...firstInstallFeatures,
    classArchiveRetention: profile,
  });
  assert.equal(catalog.plan.ledger.planned_record_count, generated.manifest.ledger_rows);
  return { ...catalog, generated_manifest: generated.manifest };
}

export async function verifyFirstInstallSchema(connection, { profile = "none" } = {}) {
  const expected = firstInstallCatalog({ profile });
  const verified = await verifyNativeInstalledSchema(connection, {
    ...firstInstallFeatures,
    classArchiveRetention: profile,
    installationMode: "first-install",
  });
  assert.equal(verified.ledgerRows, expected.generated_manifest.ledger_rows);
  assert.equal(verified.metadata.session[0].database_name, expected.generated_manifest.database);
  return {
    ...verified,
    installationContract: expected.installation_contract,
    sqlSha256: expected.generated_manifest.sql_sha256,
    releaseAuthorized: false,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(
    [3, 4].includes(process.argv.length),
    true,
    "Usage: node scripts/generate-first-install-sql.mjs OUTPUT.sql (writes OUTPUT.sql.manifest.json too)",
  );
  const output = resolve(process.argv[2]);
  assert.ok(output.endsWith(".sql"), "Output must end with .sql");
  assert.ok(!existsSync(output) && !existsSync(output + ".manifest.json"), "Output already exists");
  assert(
    process.argv.length === 3 || process.argv[3] === "--class-archive-candidate=active",
    "Only the explicit active candidate option is supported",
  );
  const result =
    process.argv.length === 3
      ? buildFirstInstallSql()
      : buildCandidateFirstInstallSql({ profile: "active" });
  // Exclusive creation preserves any existing release artifact.
  writeFileSync(output + ".manifest.json", JSON.stringify(result.manifest, null, 2) + "\n", {
    flag: "wx",
  });
  writeFileSync(output, result.sql, { flag: "wx" });
  process.stdout.write(
    JSON.stringify({
      ledgerRows: result.manifest.ledger_rows,
      sqlSha256: result.manifest.sql_sha256,
    }) + "\n",
  );
}
