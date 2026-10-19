import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";
import { argv } from "node:process";
import {
  applySourcePostcondition,
  canonicalCheckSql,
  canonicalDefaultSql,
  canonicalMetadataSql,
  contractDigest,
  emptyInstallState,
  sourceStatements,
} from "./install-postcondition-source.mjs";
import {
  buildInstallPostconditionCatalog,
  collectInstallMetadata,
  createInstallPostconditionVerifier,
  installMetadataQueries,
  verifyInstallMetadata,
} from "./install-postconditions.mjs";

const copy = (value) => JSON.parse(JSON.stringify(value));
const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const catalog = buildInstallPostconditionCatalog();
const mode =
  "ONLY_FULL_GROUP_BY,STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,TIME_ROUND_FRACTIONAL";

test("selected database comparison preserves the dev default and rejects foreign grants", () => {
  const actual = observation(catalog.final);
  assert.equal(verifyInstallMetadata(catalog.final, actual).verified, true);
  const fresh = copy(actual);
  for (const row of fresh.foreign_keys) row.target_schema = "classhub";
  for (const category of ["session", "table_grants", "column_grants", "routine_grants", "db_flags"])
    for (const row of fresh[category]) row.database_name = "classhub";
  assert.equal(
    verifyInstallMetadata(catalog.final, fresh, { expectedDatabase: "classhub" }).verified,
    true,
  );
  assert.throws(() => verifyInstallMetadata(catalog.final, fresh));
  for (const category of [
    "session",
    "table_grants",
    "column_grants",
    "routine_grants",
    "db_flags",
  ]) {
    if (!fresh[category].length) continue;
    const wrong = copy(fresh);
    wrong[category][0].database_name = "foreign_schema";
    assert.throws(() =>
      verifyInstallMetadata(catalog.final, wrong, { expectedDatabase: "classhub" }),
    );
  }
  for (const expectedDatabase of [null, "", "bad-name"])
    assert.throws(() => verifyInstallMetadata(catalog.final, fresh, { expectedDatabase }));
});

test("fresh provisioning requires zero migrator schema grants while the dev catalog still requires its exact grant", () => {
  const fresh = { ...catalog.final, migrator_schema_all: false };
  const actual = observation(fresh);
  assert.equal(verifyInstallMetadata(fresh, actual).verified, true);
  assert.throws(() => verifyInstallMetadata(catalog.final, actual));
  const added = observation(catalog.final);
  assert.throws(() => verifyInstallMetadata(fresh, added));
});

test("foreign keys must reference the selected schema even when table and column names match", () => {
  assert.match(installMetadataQueries.foreign_keys, /k\.REFERENCED_TABLE_SCHEMA AS target_schema/u);
  for (const targetSchema of ["foreign_schema", "CLASSHUB_MARIADB_PHASE1_DEV", null, undefined]) {
    const actual = observation(catalog.final);
    actual.foreign_keys[0].target_schema = targetSchema;
    assert.throws(() => verifyInstallMetadata(catalog.final, actual), /target_schema/u);
  }
});
const dbPrivileges = [
  "Select_priv",
  "Insert_priv",
  "Update_priv",
  "Delete_priv",
  "Create_priv",
  "Drop_priv",
  "Grant_priv",
  "References_priv",
  "Index_priv",
  "Alter_priv",
  "Create_tmp_table_priv",
  "Lock_tables_priv",
  "Create_view_priv",
  "Show_view_priv",
  "Create_routine_priv",
  "Alter_routine_priv",
  "Execute_priv",
  "Event_priv",
  "Trigger_priv",
  "Delete_history_priv",
];
const ambient = [
  "anonymous_global",
  "anonymous_db",
  "public_global_priv",
  "public_db",
  "public_tables_priv",
  "public_columns_priv",
  "public_procs_priv",
  "public_roles_mapping",
];

// A transport model for corruption tests. Fixed contracts below independently assert
// source facts; this projection is not claimed to prove MariaDB's metadata formatting.
function observation(state) {
  const rows = Object.fromEntries(Object.keys(installMetadataQueries).map((key) => [key, []]));
  rows.session = [
    {
      database_name: "classhub_mariadb_phase1_dev",
      server_version: "11.4.13-MariaDB",
      time_zone: "+00:00",
      sql_mode: mode,
      database_charset: "utf8mb4",
      database_collation: "utf8mb4_bin",
    },
  ];
  const type = (column) => ({
    data_type: column.type,
    column_type: column.type + (column.unsigned ? " unsigned" : ""),
    max_length: column.size,
    numeric_precision: column.size,
    numeric_scale: column.scale,
    datetime_precision: column.size,
    charset_name: column.charset,
    collation_name: column.collation,
  });
  for (const table of Object.values(state.tables)) {
    const table_name = table.name;
    rows.tables.push({
      table_name,
      table_type: "BASE TABLE",
      engine: "InnoDB",
      collation_name: "utf8mb4_bin",
    });
    Object.values(table.columns).forEach((column, index) =>
      rows.columns.push({
        table_name,
        column_name: column.name,
        ordinal: String(index + 1),
        ...type(column),
        nullable: column.nullable ? "YES" : "NO",
        default_sql: column.default_sql,
        extra: column.auto_increment
          ? "auto_increment"
          : column.generated
            ? column.stored
              ? "STORED GENERATED"
              : "VIRTUAL GENERATED"
            : "",
        is_generated: column.generated ? "ALWAYS" : "NEVER",
        generation_expression: column.generated ?? "",
      }),
    );
    for (const index of Object.values(table.indexes)) {
      if (index.unique)
        rows.constraints.push({
          table_name,
          constraint_name: index.name,
          constraint_type: index.name === "PRIMARY" ? "PRIMARY KEY" : "UNIQUE",
        });
      index.columns.forEach((column, ordinal) =>
        rows.indexes.push({
          table_name,
          index_name: index.name,
          ordinal: String(ordinal + 1),
          column_name: column.column,
          non_unique: index.unique ? "0" : "1",
          direction: column.direction,
          prefix_length: column.prefix,
          index_type: index.type,
          ignored: "NO",
        }),
      );
    }
    for (const [constraint_name, expression_sql] of Object.entries(table.checks)) {
      rows.constraints.push({ table_name, constraint_name, constraint_type: "CHECK" });
      rows.checks.push({ table_name, constraint_name, expression_sql });
    }
    for (const fk of Object.values(table.foreign_keys)) {
      rows.constraints.push({
        table_name,
        constraint_name: fk.name,
        constraint_type: "FOREIGN KEY",
      });
      fk.columns.forEach((column_name, index) =>
        rows.foreign_keys.push({
          table_name,
          constraint_name: fk.name,
          ordinal: String(index + 1),
          column_name,
          target_schema: "classhub_mariadb_phase1_dev",
          target_table: fk.target_table,
          target_column: fk.target_columns[index],
          update_rule: fk.update_rule,
          delete_rule: fk.delete_rule,
        }),
      );
    }
  }
  const stored = {
    charset_name: "utf8mb4",
    collation_name: "utf8mb4_bin",
    database_collation: "utf8mb4_bin",
    sql_mode: mode,
  };
  for (const routine of Object.values(state.routines)) {
    rows.routines.push({
      routine_name: routine.name,
      routine_type: "PROCEDURE",
      security_type: routine.security,
      data_access: routine.access,
      definer: routine.definer,
      body_sql: routine.body,
      ...stored,
    });
    routine.parameters.forEach((parameter, index) =>
      rows.parameters.push({
        routine_name: routine.name,
        ordinal: String(index + 1),
        parameter_name: parameter.name,
        mode: parameter.mode,
        ...type(parameter),
      }),
    );
  }
  for (const trigger of Object.values(state.triggers))
    rows.triggers.push({
      trigger_name: trigger.name,
      table_name: trigger.table,
      event_name: trigger.event,
      timing_name: trigger.timing,
      action_order: "1",
      definer: trigger.definer,
      body_sql: trigger.body,
      ...stored,
    });
  for (const account of Object.values(state.accounts))
    rows.accounts.push({
      account: account.name,
      host: account.host,
      locked: account.locked ? "true" : null,
      global_access: "0",
      ssl_type: account.require_ssl ? "1" : "0",
      is_role: "0",
    });
  for (const [account, grants] of Object.entries(state.grants))
    for (const grant of grants) {
      const [kind, object, privilege, column] = grant.split("|");
      if (kind === "procedure")
        rows.routine_grants.push({
          account,
          host: "%",
          database_name: "classhub_mariadb_phase1_dev",
          routine_name: object,
          routine_type: "PROCEDURE",
          privileges: "Execute",
        });
      else
        rows[column === "*" ? "table_grants" : "column_grants"].push({
          account_host: `${account}@%`,
          database_name: "classhub_mariadb_phase1_dev",
          table_name: object,
          privilege_name: privilege,
          grantable: "NO",
          ...(column !== "*" ? { column_name: column } : {}),
        });
    }
  rows.db_flag_columns = dbPrivileges.map((column_name) => ({ column_name }));
  rows.db_flags = state.migrator_schema_all
    ? [
        {
          account: "classhub_migrator",
          host: "%",
          database_name: "classhub_mariadb_phase1_dev",
          ...Object.fromEntries(
            dbPrivileges.map((name) => [name, name === "Grant_priv" ? "N" : "Y"]),
          ),
        },
      ]
    : [];
  rows.ambient_grants = ambient.map((coordinate) => ({ coordinate, row_count: "0" }));
  return rows;
}

const cleanFinal = observation(catalog.final);
const expectedFailure = (coordinate) => (error) => {
  assert.equal(error.code, "INSTALL_POSTCONDITION_FAILED");
  assert.ok(error.message.endsWith(coordinate), error.message);
  assert.ok(!error.message.includes("private-value"));
  return true;
};

test("all 59 pinned sources yield exact selected object, owner and maintenance profiles", () => {
  assert.equal(catalog.steps.length, 59);
  assert.equal(Object.keys(catalog.final.tables).length, 57);
  assert.equal(
    Object.values(catalog.final.tables).reduce(
      (n, table) => n + Object.keys(table.columns).length,
      0,
    ),
    572,
  );
  assert.equal(Object.keys(catalog.final.routines).length, 18);
  assert.equal(Object.keys(catalog.final.triggers).length, 6);
  assert.equal(
    Object.values(catalog.final.tables).reduce(
      (count, table) => count + Object.keys(table.checks).length,
      0,
    ),
    252,
  );
  assert.equal(Object.keys(catalog.final.accounts).length, 6);
  assert.equal(catalog.final.accounts.classhub_routine.locked, true);
  assert.equal(catalog.final.accounts.classhub_routine.require_ssl, false);
  assert.deepEqual(
    ["app", "operator", "worker", "retention"].map(
      (role) => catalog.final.grants[`classhub_${role}`].length,
    ),
    [251, 195, 4, 44],
  );
  assert.equal(catalog.final.seeds.audit_log_actions.length, 56);
  assert.equal(catalog.final.seeds.retention_lock_keys.length, 3);
  assert.equal(catalog.final.tables.users.columns.signup_role.type, "varchar");
  assert.equal(catalog.final.tables.users.columns.signup_role.nullable, true);
  assert.equal(
    Object.values(catalog.final.tables.admin_terms_versions.indexes).filter((index) =>
      index.columns.some((column) => column.prefix === "80"),
    ).length,
    1,
  );
  assert.equal(catalog.final.tables.admin_accounts.indexes.email_normalized.type, "HASH");
  assert.match(
    catalog.final.tables.admin_terms_versions.columns.id.default_sql,
    /^concat \( hex \( random_bytes \( 4 \)/u,
  );
  assert.match(
    catalog.final.tables.admin_terms_versions.columns.id.default_sql,
    /random_bytes \( 6 \) \) \)$/u,
  );
  assert.equal(catalog.final.tables.admin_sessions.columns.absolute_expires_at.size, "6");
  assert.ok(!Object.hasOwn(catalog.final.tables, "seat_draws"));
});

test("quoted semicolons/comments cannot cross statement boundaries or weaken parenthesized predicates", () => {
  assert.deepEqual(
    sourceStatements("-- ordinary ; comment\nSELECT 'a;-- b'; /* ; */ SELECT 'it''s;ok';"),
    ["SELECT 'a;-- b'", "SELECT 'it''s;ok'"],
  );
  assert.deepEqual(
    sourceStatements(
      "DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT ';'; END//\nDELIMITER ;\nSELECT 1;",
    ),
    ["CREATE PROCEDURE p() BEGIN SELECT ';'; END", "SELECT 1"],
  );
  assert.equal(canonicalMetadataSql("((`x` = TRUE)) /* regular metadata comment */"), "x = 1");
  assert.equal(canonicalMetadataSql("a = 'KEEP -- /* ; Case'"), "a = 'KEEP -- /* ; Case'");
  assert.notEqual(canonicalMetadataSql("a AND (b OR c)"), canonicalMetadataSql("(a AND b) OR c"));
  assert.notEqual(canonicalMetadataSql("a='A'"), canonicalMetadataSql("a='a'"));
  assert.throws(
    () => sourceStatements("/*! DROP TABLE x */;"),
    expectedFailure("source.executable_comment"),
  );
  assert.throws(
    () => canonicalMetadataSql("'unfinished"),
    expectedFailure("metadata.unterminated_quote"),
  );
  assert.throws(
    () => applySourcePostcondition(emptyInstallState(), "DROP TABLE x;", "test"),
    expectedFailure("source.test.statement_kind"),
  );
});

test("generated expression IS NOT NULL does not change the generated column's nullability", () => {
  const state = emptyInstallState();
  applySourcePostcondition(
    state,
    "CREATE TABLE example (id BIGINT PRIMARY KEY, helper BIGINT GENERATED ALWAYS AS (CASE WHEN id IS NOT NULL THEN id ELSE NULL END) STORED) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;",
    "test",
  );
  assert.equal(state.tables.example.columns.id.nullable, false);
  assert.equal(state.tables.example.columns.helper.nullable, true);
  assert.equal(
    state.tables.example.columns.helper.generated,
    "case when id is not null then id else null end",
  );
});

test("native BINARY and LOWER aliases preserve every email normalization predicate", () => {
  const source = catalog.steps.find((step) => step.id === "identity-foundation").state.tables.users
    .checks.users_email_normalized_check;
  const native =
    "octet_length(`email_normalized`) = octet_length(trim(`email_normalized`)) and cast(`email_normalized` as char charset binary) = cast(lcase(`email_normalized`) as char charset binary) and `email_normalized` <> ''";
  assert.equal(canonicalCheckSql(native), source);
  assert.equal(canonicalCheckSql(canonicalCheckSql(native)), source);
  for (const changed of [
    native.replace("cast(`email_normalized` as char charset binary)", "`email_normalized`"),
    native.replaceAll("charset binary", "charset utf8mb4"),
    native.replaceAll("as char charset binary", "as char(5) charset binary"),
    native.replace("lcase(`email_normalized`)", "`email_normalized`"),
    native.replace(" and `email_normalized` <> ''", ""),
    native.replace(" and `email_normalized` <> ''", " or `email_normalized` <> ''"),
    native.replace("trim(`email_normalized`)", "`email_normalized`"),
  ])
    assert.notEqual(canonicalCheckSql(changed), source);
  assert.notEqual(
    canonicalMetadataSql("CAST(a + b AS CHAR CHARSET binary)"),
    canonicalMetadataSql("BINARY a + b"),
  );
  assert.equal(
    canonicalMetadataSql("CAST((a + b) AS CHAR CHARSET binary)"),
    canonicalMetadataSql("BINARY (a + b)"),
  );
  assert.notEqual(canonicalMetadataSql("'lcase(x)'"), canonicalMetadataSql("'lower(x)'"));
});

test("CHECK grouping accepts only the same boolean precedence, including BETWEEN and CASE", () => {
  for (const [source, native] of [
    ["a OR (b AND c)", "a OR b AND c"],
    ["(a AND b) OR (c AND d)", "a AND b OR c AND d"],
    ["a AND (b AND c)", "a AND b AND c"],
    ["a OR (x BETWEEN 2 AND 20 AND y)", "a OR x BETWEEN 2 AND 20 AND y"],
    [
      "x = CASE WHEN a OR b THEN 1 ELSE 0 END AND c",
      "(x = CASE WHEN a OR b THEN 1 ELSE 0 END) AND c",
    ],
  ])
    assert.equal(canonicalCheckSql(source), canonicalCheckSql(native));
  for (const [source, changed] of [
    ["a OR (b AND c)", "(a OR b) AND c"],
    ["NOT (a AND b)", "NOT a AND b"],
    ["(a IS NOT NULL) + (b IS NOT NULL) = 1", "a IS NOT NULL + b IS NOT NULL = 1"],
    ["x BETWEEN 2 AND 20 AND y", "x BETWEEN 2 AND (20 AND y)"],
    [
      "x = CASE WHEN a OR b THEN 1 ELSE 0 END AND c",
      "x = CASE WHEN a AND b THEN 1 ELSE 0 END AND c",
    ],
    ["a = 'OR (b AND c)'", "a = 'OR b AND c'"],
  ])
    assert.notEqual(canonicalCheckSql(source), canonicalCheckSql(changed));
});

test("native NOT REGEXP output preserves negation, exact pattern and boolean grouping", () => {
  const source = catalog.steps.find((step) => step.id === "class-membership").state.tables.schools
    .checks.schools_road_address_check;
  const native =
    "`road_address` is null or octet_length(`road_address`) = octet_length(trim(`road_address`)) and char_length(`road_address`) between 1 and 200 and !(`road_address` regexp '[[:cntrl:]]')";
  assert.equal(canonicalCheckSql(native), source);
  assert.equal(canonicalCheckSql(canonicalCheckSql(native)), source);
  assert.equal(
    canonicalCheckSql("a NOT REGEXP 'pattern'"),
    canonicalCheckSql("NOT (a REGEXP 'pattern')"),
  );
  for (const changed of [
    native.replace("!(`road_address` regexp '[[:cntrl:]]')", "`road_address` regexp '[[:cntrl:]]'"),
    native.replace("[[:cntrl:]]", "[[:space:]]"),
    native.replace(" and !(`road_address` regexp '[[:cntrl:]]')", ""),
    native.replace(
      " and !(`road_address` regexp '[[:cntrl:]]')",
      " or !(`road_address` regexp '[[:cntrl:]]')",
    ),
  ])
    assert.notEqual(canonicalCheckSql(changed), source);
  assert.notEqual(canonicalCheckSql("!(a OR b) AND c"), canonicalCheckSql("!(a OR (b AND c))"));
  assert.notEqual(
    canonicalCheckSql("!a REGEXP 'pattern'"),
    canonicalCheckSql("a NOT REGEXP 'pattern'"),
  );
  assert.notEqual(canonicalCheckSql("a NOT REGEXP 'A'"), canonicalCheckSql("a NOT REGEXP 'a'"));
});

test("routine regex literals keep source escapes and reject changed escape depth or whitespace ranges", () => {
  assert.match(installMetadataQueries.routines, /CONVERT\(p\.body USING utf8mb4\) AS body_sql/u);
  assert.doesNotMatch(installMetadataQueries.routines, /ROUTINE_DEFINITION|body_utf8/u);
  const state = catalog.steps.find(
    (step) => step.id === "class-transition-lifecycle-routines",
  ).state;
  const actual = observation(state);
  const routine = actual.routines.find(
    (row) => row.routine_name === "create_class_with_teacher_and_invite",
  );
  assert.ok(routine.body_sql.includes(String.raw`\\x{0009}`));
  routine.body_sql = routine.body_sql.replace(String.raw`\\x{0009}`, String.raw`\x{0009}`);
  assert.throws(
    () => verifyInstallMetadata(state, actual),
    expectedFailure("routine.create_class_with_teacher_and_invite.body"),
  );
  routine.body_sql = state.routines.create_class_with_teacher_and_invite.body.replace(
    "0009",
    "0008",
  );
  assert.throws(
    () => verifyInstallMetadata(state, actual),
    expectedFailure("routine.create_class_with_teacher_and_invite.body"),
  );
});

test("inline column CHECKs are part of the exact contract, including nullable text and primary keys", () => {
  const table = catalog.final.tables.admin_inquiries;
  assert.equal(table.checks.subject, canonicalCheckSql("CHAR_LENGTH(subject) BETWEEN 1 AND 200"));
  assert.equal(
    table.checks.internal_note,
    canonicalCheckSql("internal_note IS NULL OR CHAR_LENGTH(internal_note) <= 5000"),
  );
  assert.equal(table.columns.internal_note.nullable, true);
  assert.equal(
    catalog.final.tables.admin_system_state.checks.key,
    canonicalCheckSql("`key` IN ('maintenance_mode','announcement')"),
  );
  const observed = copy(cleanFinal);
  observed.checks.find(
    (row) => row.table_name === "admin_inquiries" && row.constraint_name === "subject",
  ).expression_sql = "CHAR_LENGTH(subject) BETWEEN 1 AND 201";
  assert.throws(
    () => verifyInstallMetadata(catalog.final, observed),
    expectedFailure("check.admin_inquiries.subject.expression"),
  );
  observed.checks = observed.checks.filter(
    (row) => !(row.table_name === "admin_system_state" && row.constraint_name === "key"),
  );
  assert.throws(
    () => verifyInstallMetadata(catalog.final, observed),
    expectedFailure("checks.set"),
  );
});

test("CASE branches normalize grouping without changing selected branch, order, else or allowed JSON keys", () => {
  const source =
    "CASE WHEN action LIKE 'class.%' THEN (payload IS NULL OR (JSON_TYPE(payload) = 'OBJECT' AND JSON_CONTAINS('[\"id\"]',JSON_KEYS(payload)) = 1)) ELSE FALSE END";
  const native =
    "case when action like 'class.%' then payload is null or json_type(payload) = 'OBJECT' and json_contains('[\"id\"]',json_keys(payload)) = 1 else 0 end";
  assert.equal(canonicalCheckSql(source), canonicalCheckSql(native));
  assert.equal(canonicalCheckSql(canonicalCheckSql(source)), canonicalCheckSql(native));
  for (const altered of [
    native.replace("class.%", "member.%"),
    native.replace("'[\"id\"]'", '\'["id","secret"]\''),
    native.replace(" and ", " or "),
    native.replace("else 0", "else 1"),
    native.replace(" else 0", ""),
  ])
    assert.notEqual(canonicalCheckSql(source), canonicalCheckSql(altered));
  assert.notEqual(
    canonicalCheckSql("CASE WHEN a THEN b WHEN c THEN d ELSE 0 END"),
    canonicalCheckSql("CASE WHEN c THEN d WHEN a THEN b ELSE 0 END"),
  );
});

test("UUID-v4 variant grouping preserves bit masks, random-byte length and string literal contents", () => {
  const source = "HEX(8 | (ORD(RANDOM_BYTES(1)) & 3))";
  const native = "hex(8 | ord(random_bytes(1)) & 3)";
  assert.equal(canonicalDefaultSql(source), canonicalDefaultSql(native));
  assert.equal(canonicalDefaultSql(canonicalDefaultSql(source)), canonicalDefaultSql(native));
  for (const altered of [
    "HEX((8 | ORD(RANDOM_BYTES(1))) & 3)",
    "HEX(8 | (ORD(RANDOM_BYTES(1)) & 7))",
    "HEX(8 | (ORD(RANDOM_BYTES(2)) & 3))",
    "HEX(9 | (ORD(RANDOM_BYTES(1)) & 3))",
  ])
    assert.notEqual(canonicalDefaultSql(source), canonicalDefaultSql(altered));
  assert.notEqual(canonicalDefaultSql(`'${source}'`), canonicalDefaultSql(`'${native}'`));
});

test("comparison operands accept redundant outer parentheses while actor sum and logic stay exact", () => {
  const source = "((actor_user IS NOT NULL) + (actor_operator IS NOT NULL)) = 1";
  assert.equal(
    canonicalCheckSql(source),
    canonicalCheckSql("(actor_user IS NOT NULL) + (actor_operator IS NOT NULL) = 1"),
  );
  assert.equal(canonicalCheckSql("((a + b) * c) = 1"), canonicalCheckSql("(a + b) * c = 1"));
  assert.notEqual(
    canonicalCheckSql(source),
    canonicalCheckSql("actor_user IS NOT NULL + actor_operator IS NOT NULL = 1"),
  );
  assert.notEqual(
    canonicalCheckSql(source),
    canonicalCheckSql("((actor_user IS NOT NULL) + (actor_operator IS NOT NULL)) <= 1"),
  );
  assert.notEqual(canonicalCheckSql("((a + b) * c) = 1"), canonicalCheckSql("a + b * c = 1"));
  assert.notEqual(canonicalCheckSql("(a OR b) = 1"), canonicalCheckSql("a OR b = 1"));
  assert.notEqual(canonicalCheckSql("(a OR b) = 1"), canonicalCheckSql("(a AND b) = 1"));
  assert.equal(canonicalCheckSql("NOT a = b"), canonicalCheckSql("NOT (a = b)"));
  assert.notEqual(canonicalCheckSql("NOT a = b"), canonicalCheckSql("(NOT a) = b"));
  assert.notEqual(canonicalCheckSql("!a = b"), canonicalCheckSql("!(a = b)"));
});

function readSnapshot(path, rawPath) {
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  if (rawPath) {
    const captured = JSON.parse(readFileSync(rawPath, "utf8"));
    const rows = captured.routines ?? captured.metadata.routines;
    assert.deepEqual(
      rows.map((row) => row.routine_name).sort(),
      snapshot.metadata.routines.map((row) => row.routine_name).sort(),
    );
    for (const row of rows) {
      assert.equal(
        contractDigest(row.raw_body_sql),
        row.raw_sha256,
        `captured raw body hash: ${row.routine_name}`,
      );
      snapshot.metadata.routines.find(
        (routine) => routine.routine_name === row.routine_name,
      ).body_sql = row.raw_body_sql;
    }
  }
  return snapshot;
}
if (argv[2] && argv[3] === "--expressions-only") {
  const snapshot = readSnapshot(argv[2], argv[4]);
  assert.equal(snapshot.status, "existing_complete_schema_metadata_read_only");
  assert.equal(snapshot.installationPass, false);
  const actual = snapshot.metadata;
  for (const category of ["checks", "defaults", "generated", "routines", "triggers"])
    test(`existing schema ${category} expression comparison only; not installation attestation`, () => {
      const differences = [];
      if (category === "checks")
        for (const row of actual.checks) {
          const expected = catalog.final.tables[row.table_name]?.checks[row.constraint_name];
          if (expected === undefined || canonicalCheckSql(row.expression_sql) !== expected)
            differences.push(`check.${row.table_name}.${row.constraint_name}`);
        }
      if (category === "defaults" || category === "generated")
        for (const row of actual.columns) {
          const expected = catalog.final.tables[row.table_name]?.columns[row.column_name];
          const value = category === "defaults" ? row.default_sql : row.generation_expression;
          const normalized =
            category === "defaults" ? canonicalDefaultSql(value) : canonicalMetadataSql(value);
          const nil = (expression) => ([null, "null", ""].includes(expression) ? null : expression);
          if (
            !expected ||
            nil(normalized) !==
              nil(category === "defaults" ? expected.default_sql : expected.generated)
          )
            differences.push(`${category}.${row.table_name}.${row.column_name}`);
        }
      if (category === "routines")
        for (const row of actual.routines)
          if (canonicalMetadataSql(row.body_sql) !== catalog.final.routines[row.routine_name]?.body)
            differences.push(`routine.${row.routine_name}.body`);
      if (category === "triggers")
        for (const row of actual.triggers)
          if (canonicalMetadataSql(row.body_sql) !== catalog.final.triggers[row.trigger_name]?.body)
            differences.push(`trigger.${row.trigger_name}.body`);
      assert.deepEqual(differences, []);
    });
} else if (argv[2])
  test("the provided native metadata snapshot satisfies its entire cumulative source state", () => {
    const snapshot = readSnapshot(argv[2], argv[3]);
    const expected = catalog.steps.find((step) => step.id === snapshot.artifact);
    assert.ok(expected, "snapshot artifact must be one of the pinned steps");
    assert.equal(
      verifyInstallMetadata(expected.state, snapshot.metadata, { artifact: expected.id }).verified,
      true,
    );
  });

test("every cumulative step and bootstrap accepts its complete metadata, including string BIGINTs", () => {
  for (const step of catalog.steps)
    assert.equal(
      verifyInstallMetadata(step.state, observation(step.state), { artifact: step.id }).verified,
      true,
    );
  assert.equal(
    verifyInstallMetadata(catalog.bootstrap, observation(catalog.bootstrap)).verified,
    true,
  );
  const numbers = copy(cleanFinal);
  for (const row of numbers.indexes) {
    row.ordinal = Number(row.ordinal);
    row.non_unique = Number(row.non_unique);
    if (row.prefix_length !== null) row.prefix_length = Number(row.prefix_length);
  }
  for (const row of numbers.accounts) {
    row.global_access = 0;
    row.ssl_type = Number(row.ssl_type);
    row.is_role = false;
  }
  assert.equal(verifyInstallMetadata(catalog.final, numbers).verified, true);
});

const corruptions = [
  ["missing table", (x) => x.tables.pop(), "tables.set"],
  ["unexpected retired table", (x) => x.tables.push({ table_name: "seat_draws" }), "tables.set"],
  ["missing column", (x) => x.columns.pop(), "columns.set"],
  [
    "microseconds lost",
    (x) => {
      x.columns.find(
        (r) => r.table_name === "admin_sessions" && r.column_name === "absolute_expires_at",
      ).datetime_precision = "0";
    },
    "column.admin_sessions.absolute_expires_at.precision",
  ],
  [
    "nullability relaxed",
    (x) => {
      x.columns.find((r) => r.table_name === "users" && r.column_name === "id").nullable = "YES";
    },
    "column.users.id.nullable",
  ],
  [
    "email comparison collation",
    (x) => {
      x.columns.find(
        (r) => r.table_name === "users" && r.column_name === "email_normalized",
      ).collation_name = "utf8mb4_general_ci";
    },
    "column.users.email_normalized.collation",
  ],
  [
    "implicit update clock",
    (x) => {
      x.columns.find((r) => r.table_name === "users" && r.column_name === "id").extra +=
        " on update current_timestamp(6)";
    },
    "column.users.id.automatic_timestamp",
  ],
  [
    "changed generated predicate",
    (x) => {
      x.columns.find(
        (r) => r.table_name === "admin_mfa_factors" && r.column_name === "current_admin_account_id",
      ).generation_expression = "NULL";
    },
    "column.admin_mfa_factors.current_admin_account_id.expression",
  ],
  ["missing constraint", (x) => x.constraints.pop(), "constraints.set"],
  [
    "weakened check",
    (x) => {
      x.checks[0].expression_sql = "1";
    },
    null,
  ],
  [
    "changed index order",
    (x) => {
      x.indexes[0].direction = "D";
    },
    null,
  ],
  [
    "changed index prefix",
    (x) => {
      x.indexes.find((r) => r.prefix_length === "80").prefix_length = "79";
    },
    null,
  ],
  [
    "changed FK action",
    (x) => {
      x.foreign_keys[0].delete_rule =
        x.foreign_keys[0].delete_rule === "CASCADE" ? "RESTRICT" : "CASCADE";
    },
    null,
  ],
  [
    "changed FK target",
    (x) => {
      x.foreign_keys[0].target_table = "private-value";
    },
    null,
  ],
  [
    "routine body removed",
    (x) => {
      x.routines[0].body_sql = "BEGIN END";
    },
    null,
  ],
  [
    "routine owner changed",
    (x) => {
      x.routines[0].definer = "private-value";
    },
    null,
  ],
  [
    "routine invoker substituted",
    (x) => {
      x.routines[0].security_type = "INVOKER";
    },
    null,
  ],
  [
    "routine parameter direction",
    (x) => {
      x.parameters[0].mode = "INOUT";
    },
    null,
  ],
  ["missing trigger", (x) => x.triggers.pop(), "triggers.set"],
  [
    "trigger body changed",
    (x) => {
      x.triggers[0].body_sql = "BEGIN END";
    },
    null,
  ],
  [
    "unexpected product principal",
    (x) => x.accounts.push({ account: "classhub_private_value", host: "%" }),
    "accounts.set",
  ],
  [
    "unlocked definer",
    (x) => {
      x.accounts.find((r) => r.account === "classhub_routine").locked = "false";
    },
    "account.classhub_routine.locked",
  ],
  [
    "SSL removed",
    (x) => {
      x.accounts.find((r) => r.account === "classhub_app").ssl_type = "0";
    },
    "account.classhub_app.ssl_type",
  ],
  [
    "unexpected global privilege",
    (x) => {
      x.accounts[0].global_access = "1";
    },
    null,
  ],
  [
    "account replaced by role",
    (x) => {
      x.accounts[0].is_role = "true";
    },
    null,
  ],
  [
    "broadened app column grant",
    (x) =>
      x.table_grants.push({
        account_host: "classhub_app@%",
        database_name: "classhub_mariadb_phase1_dev",
        table_name: "users",
        privilege_name: "UPDATE",
        grantable: "NO",
      }),
    "grants.classhub_app.exact",
  ],
  ["missing exact routine ACL", (x) => x.routine_grants.pop(), null],
  [
    "delegatable ACL",
    (x) => {
      x.table_grants[0].grantable = "YES";
    },
    "table_grants.grantable",
  ],
  [
    "cross database ACL",
    (x) => {
      x.table_grants[0].database_name = "private-value";
    },
    "table_grants.database",
  ],
  ["role inheritance", (x) => x.role_grants.push({ account: "private-value" }), "role_grants"],
  ["proxy inheritance", (x) => x.proxy_grants.push({ account: "private-value" }), "proxy_grants"],
  ["scheduled event", (x) => x.events.push({ event_name: "private-value" }), "events"],
  [
    "migrator grant option",
    (x) => {
      x.db_flags[0].Grant_priv = "Y";
    },
    "schema_grants.flags",
  ],
  [
    "app schema-wide grant",
    (x) => x.db_flags.push({ account: "classhub_app" }),
    "schema_grants.count",
  ],
  ["unmeasured ambient privileges", (x) => x.ambient_grants.pop(), "ambient_grants.set"],
  ...ambient.map((key) => [
    `ambient ${key}`,
    (x) => {
      x.ambient_grants.find((r) => r.coordinate === key).row_count = "1";
    },
    `ambient_grants.${key}`,
  ]),
];
for (const [name, corrupt, coordinate] of corruptions)
  test(`rejects ${name} without exposing returned values`, () => {
    const observed = copy(cleanFinal);
    corrupt(observed);
    assert.throws(
      () => verifyInstallMetadata(catalog.final, observed),
      expectedFailure(coordinate ?? ""),
    );
  });

function transport() {
  const ctx = {
    state: catalog.steps[0].state,
    rows: null,
    ledger: [],
    seeds: null,
    count: "0",
    calls: [],
  };
  ctx.query = async (sql, params) => {
    assert.deepEqual(params, []);
    assert.match(sql, /^SELECT /u);
    ctx.calls.push(sql);
    const category = Object.entries(installMetadataQueries).find(([, query]) => query === sql)?.[0];
    const rows = ctx.rows ?? observation(ctx.state);
    if (category) return copy(rows[category]);
    if (sql.startsWith("SELECT User AS account,Host AS host,Db AS database_name,"))
      return copy(rows.db_flags);
    if (sql.startsWith("SELECT action AS seed"))
      return (ctx.seeds ?? ctx.state.seeds.audit_log_actions).map((seed) => ({ seed }));
    if (sql.startsWith("SELECT LOWER(HEX(lock_digest))"))
      return ctx.state.seeds.retention_lock_keys.map((seed) => ({ seed }));
    if (sql === "SELECT COUNT(*) AS row_count FROM classhub_schema_migrations")
      return [{ row_count: ctx.count }];
    if (sql.startsWith("SELECT CAST(version AS CHAR)")) {
      // MariaDB resolves the bare name to the projected CHAR alias; the qualified
      // base column retains numeric order. Model that distinction for versions 2/10.
      const rows = copy(ctx.ledger);
      if (sql.endsWith("ORDER BY classhub_schema_migrations.version"))
        return rows.sort((a, b) => Number(a.version) - Number(b.version));
      if (sql.endsWith("ORDER BY version"))
        return rows.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
      throw new Error("unexpected ledger ordering");
    }
    if (sql.includes(" AS table_name,COUNT(*) AS row_count FROM "))
      return [...sql.matchAll(/SELECT '([a-z_]+)' AS table_name/gu)].map((match) => ({
        table_name: match[1],
        row_count: ctx.count,
      }));
    throw new Error("unrecognized SELECT");
  };
  return ctx;
}

test("ledger string projection must use the qualified numeric column to order versions 2 and 10", async () => {
  const ctx = transport();
  ctx.ledger = Array.from({ length: 14 }, (_, index) => ({ version: String(index + 1) }));
  const query = "SELECT CAST(version AS CHAR) AS version FROM classhub_schema_migrations ORDER BY ";
  const aliases = await ctx.query(query + "version", []);
  const numeric = await ctx.query(query + "classhub_schema_migrations.version", []);
  assert.deepEqual(
    aliases.slice(0, 6).map((row) => row.version),
    ["1", "10", "11", "12", "13", "14"],
  );
  assert.deepEqual(
    numeric.slice(0, 6).map((row) => row.version),
    ["1", "2", "3", "4", "5", "6"],
  );
});

test("collector uses metadata SELECT only, rejects injected catalog identifiers, sanitizes adapter errors", async () => {
  const ctx = transport();
  assert.deepEqual(await collectInstallMetadata(ctx.query), observation(ctx.state));
  assert.ok(ctx.calls.every((sql) => !/authentication_string|password|IDENTIFIED/iu.test(sql)));
  ctx.rows = observation(ctx.state);
  ctx.rows.db_flag_columns[0].column_name = "private-value; SELECT 1";
  await assert.rejects(
    collectInstallMetadata(ctx.query),
    expectedFailure("query.db_flag_columns.identifier"),
  );
  await assert.rejects(
    collectInstallMetadata(async () => {
      throw new Error("private-value");
    }),
    expectedFailure("query.session"),
  );
});

test("step verifier refuses out of order, repeated, unbootstrapped and changed pinned input", async () => {
  const ctx = transport();
  let altered = false;
  const verifier = createInstallPostconditionVerifier({
    plan: catalog.plan,
    queryRows: ctx.query,
    readRepoFile: (path) =>
      altered && path === catalog.plan.steps[1].source_path ? "changed private-value" : read(path),
  });
  await assert.rejects(
    verifier.verifyStep(catalog.plan.steps[1]),
    expectedFailure("adapter.step_order"),
  );
  await assert.rejects(
    verifier.verifyLedgerBootstrap(),
    expectedFailure("adapter.ledger_bootstrap_order"),
  );
  assert.equal((await verifier.verifyStep(catalog.plan.steps[0])).verified, true);
  await assert.rejects(
    verifier.verifyStep(catalog.plan.steps[0]),
    expectedFailure("adapter.step_order"),
  );
  await assert.rejects(
    verifier.verifyStep(catalog.plan.steps[1]),
    expectedFailure("adapter.ledger_bootstrap_unverified"),
  );
  ctx.state = catalog.bootstrap;
  ctx.count = "1";
  await assert.rejects(verifier.verifyLedgerBootstrap(), expectedFailure("ledger-bootstrap.rows"));
  ctx.count = "0";
  assert.equal((await verifier.verifyLedgerBootstrap()).verified, true);
  await assert.rejects(
    verifier.verifyLedgerBootstrap(),
    expectedFailure("adapter.ledger_bootstrap_repeat"),
  );
  altered = true;
  await assert.rejects(
    verifier.verifyStep(catalog.plan.steps[1]),
    expectedFailure(`${catalog.plan.steps[1].id}.source_checksum`),
  );
  await assert.rejects(verifier.verifyFinal(catalog.plan), expectedFailure("final.step_count"));
});

test("full execution requires 59 observed steps, exact58 ledger, both seed sets and zero nonseed rows", async () => {
  const ctx = transport(),
    plan = copy(catalog.plan);
  const verifier = createInstallPostconditionVerifier({ plan, queryRows: ctx.query });
  verifier.catalog.steps[0].state.accounts = {}; // A returned copy cannot weaken the verifier.
  await verifier.verifyStep(plan.steps[0]);
  ctx.state = catalog.bootstrap;
  await verifier.verifyLedgerBootstrap();
  for (const [index, step] of plan.steps.entries()) {
    if (index === 0) continue;
    ctx.state = catalog.steps[index].state;
    if (step.id === "audit-action-catalog") {
      ctx.seeds = [];
      await assert.rejects(
        verifier.verifyStep(step),
        expectedFailure(`${step.id}.seed.audit_log_actions`),
      );
      ctx.seeds = null;
    }
    await verifier.verifyStep(step);
  }
  ctx.ledger = plan.steps
    .filter((step) => step.ledger_version !== null)
    .sort((a, b) => a.ledger_version - b.ledger_version)
    .map((step) => ({
      version: String(step.ledger_version),
      description: step.id,
      source_sha256: step.sha256,
      applied_at_utc: "2026-09-08 00:00:00.123456",
      server_version: "11.4.13-MariaDB",
    }));
  const success = await verifier.verifyFinal(plan);
  assert.equal(success.verified, true);
  assert.equal(success.ledger_records, 58);
  assert.deepEqual(success.exact_runtime_grants, {
    app: 251,
    operator: 195,
    worker: 4,
    retention: 44,
  });
  assert.equal(success.persistent_nonseed_rows, 0);
  assert.equal(success.runtimeActivationApplied, false);
  const saved = copy(ctx.ledger);
  ctx.ledger.pop();
  await assert.rejects(verifier.verifyFinal(plan), expectedFailure("final.ledger.count"));
  ctx.ledger = copy(saved);
  ctx.ledger[0].source_sha256 = "private-value";
  await assert.rejects(
    verifier.verifyFinal(plan),
    expectedFailure(`final.ledger.${ctx.ledger[0].version}.checksum`),
  );
  ctx.ledger = copy(saved);
  ctx.ledger[0].applied_at_utc = "2026-09-08 00:00:00";
  await assert.rejects(
    verifier.verifyFinal(plan),
    expectedFailure(`final.ledger.${ctx.ledger[0].version}.timestamp`),
  );
  ctx.ledger = saved;
  ctx.count = "1";
  await assert.rejects(verifier.verifyFinal(plan), expectedFailure("final.product_counts.nonseed"));
  ctx.count = "0";
  ctx.state = copy(catalog.final);
  ctx.state.seeds.retention_lock_keys.pop();
  await assert.rejects(
    verifier.verifyFinal(plan),
    expectedFailure("final.seed.retention_lock_keys"),
  );
  plan.product_tables.pop();
  await assert.rejects(verifier.verifyFinal(plan), expectedFailure("final.plan"));
});
