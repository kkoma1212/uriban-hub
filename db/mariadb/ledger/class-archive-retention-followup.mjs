import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  applySourcePostcondition,
  canonicalMetadataSql,
  sourceStatements,
} from "./install-postcondition-source.mjs";
import registry from "./class-archive-retention-artifacts.json" with { type: "json" };

const root = new URL("../../../", import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const classArchiveRetentionArtifacts = Object.freeze(registry.artifacts.map(Object.freeze));
export function classArchiveCandidateArtifacts(profile = "none") {
  assert(["none", "active", "legacy"].includes(profile), "Invalid class archive candidate profile");
  return profile === "none"
    ? []
    : classArchiveRetentionArtifacts.filter(
        (entry) => profile === "legacy" || entry.ledger_version !== 113,
      );
}
export function readClassArchiveRetentionSql(
  artifact,
  read = (path) => readFileSync(new URL(path, root)),
) {
  assert(classArchiveRetentionArtifacts.includes(artifact), "Unrecognized class archive artifact");
  const bytes = Buffer.from(read(artifact.source_path));
  assert.equal(bytes.length, artifact.byte_length, `Changed artifact length: ${artifact.id}`);
  assert.equal(digest(bytes), artifact.sha256, `Changed artifact checksum: ${artifact.id}`);
  return bytes.toString("utf8");
}

/** Explicit candidate only. Existing baseline and installation hashes remain unchanged. */
export function withClassArchiveRetentionPostconditions(
  base,
  { profile = "none", readRepoFile } = {},
) {
  const artifacts = classArchiveCandidateArtifacts(profile);
  if (!artifacts.length) return base;
  if (profile === "legacy") {
    const legacy = [
      "seat_draw_assignments",
      "seat_draw_slots",
      "seat_draws",
      "team_draw_assignments",
      "team_draw_groups",
      "team_draws",
      "duty_assignments",
      "duty_rosters",
      "class_duty_roles",
      "layout_draft_autosaves",
      "classroom_layout_templates",
    ];
    assert(
      legacy.every((table) => base.final.tables[table]),
      "Legacy candidate requires a separately reviewed legacy-11 baseline; active-only catalog cannot attest legacy installation or restoration",
    );
  }
  assert(
    base.plan.steps.some((step) => step.ledger_version === 106),
    "Admin retention ledger 106 must exist first",
  );
  assert(
    !base.plan.steps.some((step) =>
      artifacts.some((entry) => entry.ledger_version === step.ledger_version),
    ),
    "Candidate ledger version already selected",
  );
  const final = structuredClone(base.final);
  for (const artifact of artifacts) {
    const sql = readClassArchiveRetentionSql(artifact, readRepoFile);
    if (artifact.ledger_version !== 111) applySourcePostcondition(final, sql, artifact.id);
  }
  const probeSql = readClassArchiveRetentionSql(classArchiveRetentionArtifacts[1], readRepoFile);
  const probeStatements = sourceStatements(probeSql);
  assert.equal(probeStatements.length, 5);
  assert.equal(probeStatements[0], "CREATE USER 'classhub_retention_schema'@'%' ACCOUNT LOCK");
  assert.equal(
    probeStatements[1],
    "GRANT SELECT ON classhub_mariadb_phase1_dev.* TO 'classhub_retention_schema'@'%'",
  );
  assert.equal(probeStatements[2], "GRANT REFERENCES ON *.* TO 'classhub_retention_schema'@'%'");
  const procedure = probeStatements[3];
  assert.match(
    procedure,
    /^CREATE DEFINER='classhub_retention_schema'@'%' PROCEDURE class_archive_schema_inventory\(\)\s+SQL SECURITY DEFINER\s+READS SQL DATA\s+BEGIN/u,
  );
  assert.equal(
    probeStatements[4],
    "GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.class_archive_schema_inventory TO 'classhub_retention_schema'@'%'",
  );
  const probe = {
    owner: "classhub_retention_schema",
    host: "%",
    locked: true,
    body: canonicalMetadataSql(procedure.slice(procedure.indexOf("BEGIN"))),
    source_sha256: classArchiveRetentionArtifacts[1].sha256,
  };
  const steps = [
    ...base.plan.steps,
    ...artifacts.map((artifact, index) => ({
      ...artifact,
      after: index ? artifacts[index - 1].id : base.plan.steps.at(-1).id,
    })),
  ];
  return {
    ...base,
    final,
    class_archive_candidate: {
      profile,
      probe,
      defaultEnabled: false,
      automaticResume: false,
      productionActivationApplied: false,
    },
    source_contract_sha256: digest(
      `${base.source_contract_sha256}\0${artifacts.map((entry) => entry.sha256).join("\0")}`,
    ),
    plan: {
      ...base.plan,
      steps,
      plan_sha256: digest(
        `classhub:mariadb:class-archive-candidate:v1\0${base.plan.plan_sha256}\0${profile}\0${artifacts.map((entry) => entry.sha256).join("\0")}`,
      ),
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + artifacts.length,
      },
    },
  };
}

/** Separately verify the pinned metadata owner; generic runtime grant grammar stays restrictive. */
export async function verifyClassArchiveProbeMetadata(connection, catalog, observed) {
  const candidate = catalog.class_archive_candidate;
  assert(candidate, "Candidate metadata contract missing");
  const owner = observed.accounts.filter((row) => row.account === candidate.probe.owner);
  assert.equal(owner.length, 1);
  assert.equal(owner[0].host, "%");
  assert([1, "1", true, "true"].includes(owner[0].locked));
  assert([0, "0", false, "false"].includes(owner[0].is_role));
  assert.equal(String(owner[0].ssl_type), "0");
  const routine = observed.routines.filter(
    (row) => row.routine_name === "class_archive_schema_inventory",
  );
  assert.equal(routine.length, 1);
  assert.equal(routine[0].definer, "classhub_retention_schema@%");
  assert.equal(routine[0].routine_type, "PROCEDURE");
  assert.equal(routine[0].security_type, "DEFINER");
  assert.equal(routine[0].data_access, "READS SQL DATA");
  assert.equal(routine[0].charset_name, "utf8mb4");
  assert.equal(routine[0].collation_name, "utf8mb4_bin");
  assert.equal(routine[0].database_collation, "utf8mb4_bin");
  assert.equal(canonicalMetadataSql(routine[0].body_sql), candidate.probe.body);
  assert(!observed.parameters.some((row) => row.routine_name === "class_archive_schema_inventory"));
  const rows = async (sql) => (await connection.query(sql))[0];
  const selected = await rows("SELECT DATABASE() AS database_name");
  assert.equal(selected.length, 1, "One selected candidate database required");
  const databaseName = selected[0]?.database_name;
  assert.equal(typeof databaseName, "string", "Selected candidate database required");
  assert(/^[a-z][a-z0-9_]*$/u.test(databaseName), "Invalid selected candidate database");
  const global = await rows(
    "SELECT PRIVILEGE_TYPE AS privilege_name,IS_GRANTABLE AS grantable FROM information_schema.USER_PRIVILEGES WHERE REPLACE(GRANTEE,CHAR(39),'')='classhub_retention_schema@%' AND PRIVILEGE_TYPE<>'USAGE'",
  );
  assert.deepEqual(global, [{ privilege_name: "REFERENCES", grantable: "NO" }]);
  const schema = await rows(
    "SELECT TABLE_SCHEMA AS database_name,PRIVILEGE_TYPE AS privilege_name,IS_GRANTABLE AS grantable FROM information_schema.SCHEMA_PRIVILEGES WHERE REPLACE(GRANTEE,CHAR(39),'')='classhub_retention_schema@%'",
  );
  assert.deepEqual(schema, [
    { database_name: databaseName, privilege_name: "SELECT", grantable: "NO" },
  ]);
  const procedure = await rows(
    "SELECT Db AS database_name,Routine_name AS routine_name,Routine_type AS routine_type,Proc_priv AS privileges FROM mysql.procs_priv WHERE User='classhub_retention_schema' AND Host='%'",
  );
  assert.deepEqual(procedure, [
    {
      database_name: databaseName,
      routine_name: "class_archive_schema_inventory",
      routine_type: "PROCEDURE",
      privileges: "Execute",
    },
  ]);
  for (const table of ["tables_priv", "columns_priv", "roles_mapping", "proxies_priv"]) {
    const incoming =
      table === "roles_mapping"
        ? " OR Role='classhub_retention_schema'"
        : table === "proxies_priv"
          ? " OR Proxied_user='classhub_retention_schema'"
          : "";
    assert.equal(
      Number(
        (
          await rows(
            `SELECT COUNT(*) AS n FROM mysql.${table} WHERE User='classhub_retention_schema'${incoming}`,
          )
        )[0].n,
      ),
      0,
    );
  }
  // Do not mutate the collected evidence. The generic verifier checks the rest independently.
  return {
    ...observed,
    accounts: observed.accounts.filter((row) => row.account !== candidate.probe.owner),
    routines: observed.routines.filter(
      (row) => row.routine_name !== "class_archive_schema_inventory",
    ),
  };
}

export function buildClassArchiveRollbackSql(
  base,
  { profile, database = "classhub_mariadb_phase1_dev", accountHost = "%" } = {},
) {
  assert(["active", "legacy"].includes(profile));
  assert(/^[a-z][a-z0-9_]*$/u.test(database));
  assert(/^[A-Za-z0-9_.%]+$/u.test(accountHost));
  const candidate = withClassArchiveRetentionPostconditions(base, { profile });
  const delta = candidate.final.grants.classhub_retention.filter(
    (grant) => !base.final.grants.classhub_retention.includes(grant),
  );
  const grouped = new Map();
  for (const grant of delta) {
    const [kind, object, privilege, column] = grant.split("|");
    const key = `${kind}|${object}|${privilege}`;
    grouped.set(key, [...(grouped.get(key) ?? []), column]);
  }
  const statements = [];
  for (const [key, columns] of grouped) {
    const [kind, object, privilege] = key.split("|");
    const restriction =
      kind === "procedure" || columns.includes("*") ? "" : ` (${columns.join(", ")})`;
    statements.push(
      `REVOKE ${privilege}${restriction} ON ${kind === "procedure" ? "PROCEDURE " : ""}${database}.${object} FROM 'classhub_retention'@'${accountHost}'`,
    );
  }
  statements.push(
    "DROP PROCEDURE class_archive_schema_inventory",
    "DROP USER 'classhub_retention_schema'@'%'",
  );
  statements.push(
    "ALTER TABLE student_assessment_records DROP CONSTRAINT student_assessment_records_class_fk, DROP INDEX student_assessment_records_class_index, DROP COLUMN class_id",
  );
  const nullable = [
    "academic_year",
    "grade",
    "edu_office_code",
    "school_code",
    "expected_student_count",
    "created_by_user_id",
  ];
  const changes = nullable.map((name) => {
    const column = base.final.tables.classes.columns[name];
    const collation = column.charset
      ? ` CHARACTER SET ${column.charset} COLLATE ${column.collation}`
      : "";
    const type =
      column.type +
      (column.size ? `(${column.size}${column.scale ? `,${column.scale}` : ""})` : "");
    return `MODIFY COLUMN ${name} ${type}${collation} NOT NULL`;
  });
  statements.push(
    `ALTER TABLE classes DROP CONSTRAINT classes_lifecycle_metadata_check, DROP INDEX classes_retention_index, ${changes.join(", ")}, DROP COLUMN retention_purged_at, ADD CONSTRAINT classes_lifecycle_metadata_check CHECK (${base.final.tables.classes.checks.classes_lifecycle_metadata_check})`,
  );
  return {
    statements,
    dataRecovery: false,
    requires: [
      "scheduler_disabled",
      "exclusive_install_lock",
      "no_retention_purged_classes",
      "no_class_linked_assessments",
    ],
    sql_sha256: digest(statements.join(";\n")),
  };
}

export async function assertClassArchiveRollbackSafe(connection) {
  const [rows] = await connection.query(
    "SELECT (SELECT COUNT(*) FROM classes WHERE retention_purged_at IS NOT NULL) AS purged,(SELECT COUNT(*) FROM student_assessment_records WHERE class_id IS NOT NULL) AS linked",
  );
  assert.equal(
    Number(rows[0].purged),
    0,
    "Erased content cannot be recovered by schema rollback; restore a verified backup separately",
  );
  assert.equal(
    Number(rows[0].linked),
    0,
    "Explicit assessment linkage must be preserved; candidate rollback is unsafe",
  );
}

/** Reviewable SQL package only. Source hashes and transformed emitted bytes are separate evidence. */
export function buildClassArchiveCandidateSql({
  profile = "none",
  database = "classhub_mariadb_phase1_dev",
  accountHost = "%",
} = {}) {
  assert(/^[a-z][a-z0-9_]*$/u.test(database));
  assert(/^[A-Za-z0-9_.%]+$/u.test(accountHost));
  const artifacts = classArchiveCandidateArtifacts(profile);
  const emitted = [];
  let sql =
    "-- Candidate opt-in only; stop on error, no automatic resume. DDL is not transactional.\n-- Existing target requires verified baseline, exclusive installation and separately verified backup.\n";
  for (const artifact of artifacts) {
    const source = readClassArchiveRetentionSql(artifact);
    const transformed = source
      .replaceAll("classhub_mariadb_phase1_dev", database)
      .replaceAll("'classhub_retention'@'%'", `'classhub_retention'@'${accountHost}'`);
    emitted.push({
      ...artifact,
      emitted_sha256: digest(transformed),
      emitted_byte_length: Buffer.byteLength(transformed),
    });
    sql += `\n-- source: ${artifact.source_path}; original-sha256: ${artifact.sha256}\n${transformed}\nDELIMITER ;\n`;
    sql += `INSERT INTO classhub_schema_migrations(version,description,source_sha256,applied_at_utc,server_version) VALUES(${artifact.ledger_version},'${artifact.id}',UNHEX('${artifact.sha256}'),UTC_TIMESTAMP(6),VERSION());\n`;
  }
  return {
    sql,
    manifest: {
      schema_version: 1,
      candidateOnly: true,
      profile,
      database,
      productionActivationApplied: false,
      automaticResume: false,
      ledger_versions: artifacts.map((entry) => entry.ledger_version),
      artifacts: emitted,
      sql_sha256: digest(sql),
      requiredRuntimeFlag: `RETENTION_CLASS_ARCHIVES_GRANT_INSTALLED=${profile}`,
      requiredScheduleFlag: "RETENTION_CLASS_ARCHIVES_SCHEDULE_ENABLED=false",
    },
  };
}

/** Only the caller's separately owned synthetic server can use this rehearsal executor. */
export async function rehearseClassArchiveCandidate(
  connection,
  { mode, base, profile, schedulerDisabled = false } = {},
) {
  assert(["apply", "rollback"].includes(mode));
  const [identity] = await connection.query(
    "SELECT DATABASE() AS database_name,@@port AS server_port",
  );
  const database = identity[0].database_name;
  assert(
    /^classhub_archive_qa(?:_[a-z0-9]+)?$/u.test(database),
    "Rehearsal requires the owned synthetic database",
  );
  assert(
    ![3306, 3307, 3308, 3309, 13307].includes(Number(identity[0].server_port)),
    "Shared target is prohibited",
  );
  assert.equal(schedulerDisabled, true, "Disable candidate scheduling before schema changes");
  const [locks] = await connection.query(
    "SELECT GET_LOCK('classhub-class-archive-candidate-install',0) AS acquired",
  );
  assert.equal(Number(locks[0].acquired), 1, "Exclusive candidate installation lock unavailable");
  try {
    const artifacts = classArchiveCandidateArtifacts(profile);
    assert(artifacts.length);
    if (mode === "apply") {
      const [existing] = await connection.query(
        "SELECT COUNT(*) AS n FROM classhub_schema_migrations WHERE version IN (110,111,112,113)",
      );
      assert.equal(
        Number(existing[0].n),
        0,
        "Already installed or partial candidate: automatic resume is prohibited",
      );
      const [columns] = await connection.query(
        "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='classes' AND COLUMN_NAME='retention_purged_at') OR (TABLE_NAME='student_assessment_records' AND COLUMN_NAME='class_id'))",
      );
      assert.equal(
        Number(columns[0].n),
        0,
        "Unrecorded partial candidate schema requires independent recovery",
      );
      for (const artifact of artifacts) {
        const source = readClassArchiveRetentionSql(artifact)
          .replaceAll("classhub_mariadb_phase1_dev", database)
          .replaceAll("'classhub_retention'@'%'", "'classhub_retention'@'localhost'");
        for (const statement of sourceStatements(source)) await connection.query(statement);
        await connection.query(
          "INSERT INTO classhub_schema_migrations(version,description,source_sha256,applied_at_utc,server_version) VALUES(?,?,UNHEX(?),UTC_TIMESTAMP(6),VERSION())",
          [artifact.ledger_version, artifact.id, artifact.sha256],
        );
      }
    } else {
      const [installed] = await connection.query(
        "SELECT version,description,LOWER(HEX(source_sha256)) AS sha256 FROM classhub_schema_migrations WHERE version IN (110,111,112,113) ORDER BY version",
      );
      assert.deepEqual(
        installed.map((row) => ({
          version: Number(row.version),
          description: row.description,
          sha256: row.sha256,
        })),
        artifacts.map((entry) => ({
          version: entry.ledger_version,
          description: entry.id,
          sha256: entry.sha256,
        })),
      );
      const [sessions] = await connection.query(
        "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE USER='classhub_retention'",
      );
      assert.equal(Number(sessions[0].n), 0, "Runtime leases must stop before candidate rollback");
      await assertClassArchiveRollbackSafe(connection);
      const rollback = buildClassArchiveRollbackSql(base, {
        profile,
        database,
        accountHost: "localhost",
      });
      for (const statement of rollback.statements) await connection.query(statement);
      await connection.query(
        `DELETE FROM classhub_schema_migrations WHERE version IN (${artifacts.map((entry) => entry.ledger_version).join(",")})`,
      );
    }
    return {
      status: `candidate_${mode}_rehearsed`,
      productionActivationApplied: false,
      dataRecovery: false,
      ledgerVersions: artifacts.map((entry) => entry.ledger_version),
    };
  } finally {
    await connection.query("SELECT RELEASE_LOCK('classhub-class-archive-candidate-install')");
  }
}
