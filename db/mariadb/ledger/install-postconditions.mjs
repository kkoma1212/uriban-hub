import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { buildRuntimeInstallPlan, verifyRuntimeInstallPlan } from "./runtime-install-plan.mjs";
import { assertArchiveReasonDelta } from "./archive-reason-followup.mjs";
import {
  applySourcePostcondition,
  canonicalCheckSql,
  canonicalDefaultSql,
  canonicalMetadataSql,
  contractDigest,
  emptyInstallState,
  postconditionFailure,
} from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
const defaultRead = (path) => readFileSync(new URL(path, root));
const clone = (value) => JSON.parse(JSON.stringify(value));
const equal = (actual, expected, coordinate) => {
  if (!isDeepStrictEqual(actual, expected)) postconditionFailure(coordinate);
};
const check = (condition, coordinate) => {
  if (!condition) postconditionFailure(coordinate);
};
const natural = (value, coordinate) => {
  check(
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
      (typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value)),
    coordinate,
  );
  return String(value);
};
const listEqual = (actual, expected, coordinate) =>
  equal([...actual].sort(), [...expected].sort(), coordinate);
const sqlMode =
  "STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_DATE,NO_ZERO_IN_DATE,NO_ENGINE_SUBSTITUTION,ONLY_FULL_GROUP_BY,TIME_ROUND_FRACTIONAL";
const accounts =
  "'classhub_migrator','classhub_app','classhub_operator','classhub_worker','classhub_retention','classhub_routine'";
const grantees = accounts
  .split(",")
  .map((account) => `CONCAT(${account},'@%')`)
  .join(",");
const grantPredicate = `REPLACE(GRANTEE,CHAR(39),'') IN (${grantees})`;
const publicPrivilegeCoordinates = [
  "global_priv",
  "db",
  "tables_priv",
  "columns_priv",
  "procs_priv",
  "roles_mapping",
];

/** SELECTs project only schema/permission metadata. Authentication strings are never selected. */
export const installMetadataQueries = Object.freeze({
  session:
    "SELECT DATABASE() AS database_name, VERSION() AS server_version, @@session.time_zone AS time_zone, @@session.sql_mode AS sql_mode, @@character_set_database AS database_charset, @@collation_database AS database_collation",
  tables:
    "SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type, ENGINE AS engine, TABLE_COLLATION AS collation_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY BINARY TABLE_NAME",
  columns:
    "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, ORDINAL_POSITION AS ordinal, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS default_sql, CHARACTER_MAXIMUM_LENGTH AS max_length, NUMERIC_PRECISION AS numeric_precision, NUMERIC_SCALE AS numeric_scale, DATETIME_PRECISION AS datetime_precision, CHARACTER_SET_NAME AS charset_name, COLLATION_NAME AS collation_name, EXTRA AS extra, IS_GENERATED AS is_generated, GENERATION_EXPRESSION AS generation_expression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY BINARY TABLE_NAME,ORDINAL_POSITION",
  constraints:
    "SELECT TABLE_NAME AS table_name, CONSTRAINT_NAME AS constraint_name, CONSTRAINT_TYPE AS constraint_type FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() ORDER BY BINARY TABLE_NAME,BINARY CONSTRAINT_NAME",
  checks:
    "SELECT TABLE_NAME AS table_name, CONSTRAINT_NAME AS constraint_name, CHECK_CLAUSE AS expression_sql FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() ORDER BY BINARY TABLE_NAME,BINARY CONSTRAINT_NAME",
  indexes:
    "SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, SEQ_IN_INDEX AS ordinal, COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique, COLLATION AS direction, SUB_PART AS prefix_length, INDEX_TYPE AS index_type, IGNORED AS ignored FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() ORDER BY BINARY TABLE_NAME,BINARY INDEX_NAME,SEQ_IN_INDEX",
  foreign_keys:
    "SELECT r.TABLE_NAME AS table_name,r.CONSTRAINT_NAME AS constraint_name,k.ORDINAL_POSITION AS ordinal,k.COLUMN_NAME AS column_name,k.REFERENCED_TABLE_SCHEMA AS target_schema,r.REFERENCED_TABLE_NAME AS target_table,k.REFERENCED_COLUMN_NAME AS target_column,r.UPDATE_RULE AS update_rule,r.DELETE_RULE AS delete_rule FROM information_schema.REFERENTIAL_CONSTRAINTS r JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA=r.CONSTRAINT_SCHEMA AND k.TABLE_NAME=r.TABLE_NAME AND k.CONSTRAINT_NAME=r.CONSTRAINT_NAME WHERE r.CONSTRAINT_SCHEMA=DATABASE() ORDER BY BINARY r.TABLE_NAME,BINARY r.CONSTRAINT_NAME,k.ORDINAL_POSITION",
  // ROUTINE_DEFINITION uses body_utf8, which decodes regex backslashes. Compare
  // mysql.proc.body (the actual source) so changed literal escapes still fail.
  routines:
    "SELECT r.ROUTINE_NAME AS routine_name,r.ROUTINE_TYPE AS routine_type,r.SECURITY_TYPE AS security_type,r.SQL_DATA_ACCESS AS data_access,r.DEFINER AS definer,r.SQL_MODE AS sql_mode,r.CHARACTER_SET_CLIENT AS charset_name,r.COLLATION_CONNECTION AS collation_name,r.DATABASE_COLLATION AS database_collation,CONVERT(p.body USING utf8mb4) AS body_sql FROM information_schema.ROUTINES r LEFT JOIN mysql.proc p ON BINARY p.db=BINARY r.ROUTINE_SCHEMA AND BINARY p.name=BINARY r.ROUTINE_NAME AND p.type=r.ROUTINE_TYPE WHERE r.ROUTINE_SCHEMA=DATABASE() ORDER BY BINARY r.ROUTINE_NAME",
  parameters:
    "SELECT SPECIFIC_NAME AS routine_name,ORDINAL_POSITION AS ordinal,PARAMETER_MODE AS mode,PARAMETER_NAME AS parameter_name,DATA_TYPE AS data_type,DTD_IDENTIFIER AS column_type,CHARACTER_MAXIMUM_LENGTH AS max_length,NUMERIC_PRECISION AS numeric_precision,NUMERIC_SCALE AS numeric_scale,DATETIME_PRECISION AS datetime_precision,CHARACTER_SET_NAME AS charset_name,COLLATION_NAME AS collation_name FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA=DATABASE() ORDER BY BINARY SPECIFIC_NAME,ORDINAL_POSITION",
  triggers:
    "SELECT TRIGGER_NAME AS trigger_name,EVENT_OBJECT_TABLE AS table_name,EVENT_MANIPULATION AS event_name,ACTION_TIMING AS timing_name,ACTION_ORDER AS action_order,DEFINER AS definer,SQL_MODE AS sql_mode,CHARACTER_SET_CLIENT AS charset_name,COLLATION_CONNECTION AS collation_name,DATABASE_COLLATION AS database_collation,ACTION_STATEMENT AS body_sql FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY BINARY TRIGGER_NAME",
  accounts:
    "SELECT User AS account,Host AS host,JSON_UNQUOTE(JSON_EXTRACT(Priv,'$.account_locked')) AS locked,CAST(JSON_EXTRACT(Priv,'$.access') AS CHAR) AS global_access,COALESCE(JSON_VALUE(Priv,'$.ssl_type'),0) AS ssl_type,COALESCE(JSON_VALUE(Priv,'$.is_role'),0) AS is_role FROM mysql.global_priv WHERE LEFT(User,9)='classhub_' ORDER BY BINARY User,BINARY Host",
  table_grants: `SELECT REPLACE(GRANTEE,CHAR(39),'') AS account_host,TABLE_SCHEMA AS database_name,TABLE_NAME AS table_name,PRIVILEGE_TYPE AS privilege_name,IS_GRANTABLE AS grantable FROM information_schema.TABLE_PRIVILEGES WHERE ${grantPredicate} ORDER BY BINARY GRANTEE,BINARY TABLE_SCHEMA,BINARY TABLE_NAME,BINARY PRIVILEGE_TYPE`,
  column_grants: `SELECT REPLACE(GRANTEE,CHAR(39),'') AS account_host,TABLE_SCHEMA AS database_name,TABLE_NAME AS table_name,COLUMN_NAME AS column_name,PRIVILEGE_TYPE AS privilege_name,IS_GRANTABLE AS grantable FROM information_schema.COLUMN_PRIVILEGES WHERE ${grantPredicate} ORDER BY BINARY GRANTEE,BINARY TABLE_SCHEMA,BINARY TABLE_NAME,BINARY COLUMN_NAME,BINARY PRIVILEGE_TYPE`,
  routine_grants: `SELECT User AS account,Host AS host,Db AS database_name,Routine_name AS routine_name,Routine_type AS routine_type,Proc_priv AS privileges FROM mysql.procs_priv WHERE User IN (${accounts}) ORDER BY BINARY User,BINARY Db,BINARY Routine_name`,
  db_flag_columns:
    "SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='mysql' AND TABLE_NAME='db' AND RIGHT(COLUMN_NAME,5)='_priv' ORDER BY ORDINAL_POSITION",
  role_grants: `SELECT User AS account,Host AS host,Role AS role_name,Admin_option AS admin_option FROM mysql.roles_mapping WHERE User IN (${accounts}) ORDER BY BINARY User,BINARY Role`,
  proxy_grants: `SELECT User AS account,Host AS host,Proxied_user AS proxied_account,Proxied_host AS proxied_host FROM mysql.proxies_priv WHERE User IN (${accounts}) ORDER BY BINARY User,BINARY Host`,
  events:
    "SELECT EVENT_NAME AS event_name FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()",
  ambient_grants: [
    "SELECT 'anonymous_global' AS coordinate,COUNT(*) AS row_count FROM mysql.global_priv WHERE User=''",
    "SELECT 'anonymous_db' AS coordinate,COUNT(*) AS row_count FROM mysql.db WHERE User=''",
    ...publicPrivilegeCoordinates.map(
      (table) =>
        `SELECT 'public_${table}' AS coordinate,COUNT(*) AS row_count FROM mysql.${table} WHERE User='PUBLIC'${table === "global_priv" ? " AND COALESCE(JSON_VALUE(Priv,'$.access'),0)<>0" : ""}`,
    ),
  ].join(" UNION ALL "),
});

/** Derive cumulative snapshots from the selected pinned inputs. Unsupported source shapes stop here. */
export function buildInstallPostconditionCatalog({
  readRepoFile = defaultRead,
  archiveReason = true,
} = {}) {
  try {
    const plan = buildRuntimeInstallPlan({ readRepoFile, archiveReason }),
      state = emptyInstallState(),
      steps = [];
    const read = (entry) => {
      const bytes = Buffer.from(readRepoFile(entry.source_path));
      equal(bytes.length, entry.byte_length, `source.${entry.id ?? "ledger"}.length`);
      equal(contractDigest(bytes), entry.sha256, `source.${entry.id ?? "ledger"}.checksum`);
      return bytes.toString("utf8");
    };
    let bootstrap;
    for (const [index, step] of plan.steps.entries()) {
      if (index === 1) {
        applySourcePostcondition(state, read(plan.ledger.bootstrap), "ledger-bootstrap");
        bootstrap = clone(state);
      }
      const beforeArchive = step.id === "archive-reason" ? clone(state) : null;
      applySourcePostcondition(state, read(step), step.id);
      if (beforeArchive) assertArchiveReasonDelta(beforeArchive, state);
      steps.push({ id: step.id, source_sha256: step.sha256, state: clone(state) });
    }
    equal(
      Object.keys(state.tables).sort(),
      [...plan.product_tables, ...plan.operational_tables].sort(),
      "source.final.table_set",
    );
    equal(Object.keys(state.routines).length, 18, "source.final.routine_set");
    equal(Object.keys(state.triggers).length, 6, "source.final.trigger_set");
    for (const [role, expected] of Object.entries(plan.final_runtime_grants))
      equal(state.grants[`classhub_${role}`], expected, `source.final.${role}.grants`);
    equal(state.seeds.audit_log_actions.length, 56, "source.final.audit_seed_count");
    equal(state.seeds.retention_lock_keys.length, 3, "source.final.retention_seed_count");
    return {
      plan,
      steps,
      bootstrap,
      final: clone(state),
      source_contract_sha256: contractDigest(JSON.stringify(steps)),
    };
  } catch (error) {
    if (error?.code === "INSTALL_POSTCONDITION_FAILED") throw error;
    postconditionFailure("source.catalog");
  }
}

async function readRows(queryRows, sql, coordinate) {
  try {
    const rows = await queryRows(sql, []);
    check(
      Array.isArray(rows) &&
        rows.every((row) => row && !Array.isArray(row) && typeof row === "object"),
      coordinate,
    );
    return rows;
  } catch {
    postconditionFailure(coordinate);
  }
}
export async function collectInstallMetadata(queryRows) {
  const result = {};
  for (const [category, sql] of Object.entries(installMetadataQueries))
    result[category] = await readRows(queryRows, sql, `query.${category}`);
  check(result.db_flag_columns.length >= 18, "query.db_flag_columns.count");
  const fields = result.db_flag_columns.map((row) => {
    check(
      typeof row.column_name === "string" && /^[A-Za-z_]+_priv$/u.test(row.column_name),
      "query.db_flag_columns.identifier",
    );
    return row.column_name;
  });
  result.db_flags = await readRows(
    queryRows,
    `SELECT User AS account,Host AS host,Db AS database_name,${fields.map((field) => `\`${field}\``).join(",")} FROM mysql.db WHERE User IN (${accounts}) ORDER BY BINARY User,BINARY Host,BINARY Db`,
    "query.db_flags",
  );
  return result;
}

function verifyType(expected, actual, coordinate) {
  equal(actual.data_type, expected.type, `${coordinate}.type`);
  equal(
    /\bunsigned\b/iu.test(String(actual.column_type)),
    expected.unsigned,
    `${coordinate}.unsigned`,
  );
  equal(actual.charset_name, expected.charset, `${coordinate}.charset`);
  equal(actual.collation_name, expected.collation, `${coordinate}.collation`);
  if (expected.size !== null) {
    if (["datetime", "time"].includes(expected.type))
      equal(
        natural(actual.datetime_precision, coordinate),
        expected.size,
        `${coordinate}.precision`,
      );
    else if (expected.type === "decimal") {
      equal(
        natural(actual.numeric_precision, coordinate),
        expected.size,
        `${coordinate}.precision`,
      );
      equal(
        natural(actual.numeric_scale, coordinate),
        expected.scale ?? "0",
        `${coordinate}.scale`,
      );
    } else if (["varchar", "char", "binary", "varbinary"].includes(expected.type))
      equal(natural(actual.max_length, coordinate), expected.size, `${coordinate}.length`);
  }
}
const rowKey = (row, fields) => fields.map((field) => String(row[field])).join("|");
function sameKeys(actual, expected, fields, coordinate) {
  listEqual(
    actual.map((row) => rowKey(row, fields)),
    expected.map((row) => rowKey(row, fields)),
    `${coordinate}.set`,
  );
}

/** Pure metadata comparison. Error text never embeds returned values or authentication data. */
export function verifyInstallMetadata(
  state,
  observed,
  { artifact = "final", expectedDatabase = "classhub_mariadb_phase1_dev" } = {},
) {
  const at = (category) => `${artifact}.${category}`;
  check(
    typeof expectedDatabase === "string" && /^[a-z][a-z0-9_]*$/u.test(expectedDatabase),
    at("expected_database"),
  );
  for (const category of [...Object.keys(installMetadataQueries), "db_flags"])
    check(Array.isArray(observed[category]), at(`${category}.rows`));
  equal(observed.session.length, 1, at("session.count"));
  const session = observed.session[0];
  equal(session.database_name, expectedDatabase, at("session.database"));
  check(/^11\.4\.13-MariaDB(?:-|$)/u.test(String(session.server_version)), at("session.version"));
  equal(session.time_zone, "+00:00", at("session.time_zone"));
  equal(session.database_charset, "utf8mb4", at("session.charset"));
  equal(session.database_collation, "utf8mb4_bin", at("session.collation"));
  listEqual(String(session.sql_mode).split(","), sqlMode.split(","), at("session.sql_mode"));
  sameKeys(
    observed.tables,
    Object.keys(state.tables).map((table_name) => ({ table_name })),
    ["table_name"],
    at("tables"),
  );
  for (const row of observed.tables) {
    equal(row.table_type, "BASE TABLE", at(`table.${row.table_name}.type`));
    equal(row.engine, "InnoDB", at(`table.${row.table_name}.engine`));
    equal(row.collation_name, "utf8mb4_bin", at(`table.${row.table_name}.collation`));
  }
  const columns = [],
    indexes = [],
    constraints = [],
    foreignKeys = [],
    checks = [];
  for (const table of Object.values(state.tables)) {
    for (const [index, column] of Object.values(table.columns).entries())
      columns.push({
        table_name: table.name,
        column_name: column.name,
        ordinal: String(index + 1),
        column,
      });
    for (const index of Object.values(table.indexes)) {
      if (index.unique)
        constraints.push({
          table_name: table.name,
          constraint_name: index.name,
          constraint_type: index.name === "PRIMARY" ? "PRIMARY KEY" : "UNIQUE",
        });
      index.columns.forEach((column, i) =>
        indexes.push({
          table_name: table.name,
          index_name: index.name,
          ordinal: String(i + 1),
          column_name: column.column,
          non_unique: index.unique ? "0" : "1",
          direction: column.direction,
          prefix_length: column.prefix,
          index_type: index.type,
          ignored: "NO",
        }),
      );
    }
    for (const [name, expression] of Object.entries(table.checks)) {
      checks.push({ table_name: table.name, constraint_name: name, expression_sql: expression });
      constraints.push({ table_name: table.name, constraint_name: name, constraint_type: "CHECK" });
    }
    for (const fk of Object.values(table.foreign_keys)) {
      constraints.push({
        table_name: table.name,
        constraint_name: fk.name,
        constraint_type: "FOREIGN KEY",
      });
      fk.columns.forEach((column, i) =>
        foreignKeys.push({
          table_name: table.name,
          constraint_name: fk.name,
          ordinal: String(i + 1),
          column_name: column,
          target_schema: expectedDatabase,
          target_table: fk.target_table,
          target_column: fk.target_columns[i],
          update_rule: fk.update_rule,
          delete_rule: fk.delete_rule,
        }),
      );
    }
  }
  sameKeys(observed.columns, columns, ["table_name", "column_name", "ordinal"], at("columns"));
  for (const expected of columns) {
    const actual = observed.columns.find(
        (row) => row.table_name === expected.table_name && row.column_name === expected.column_name,
      ),
      coordinate = at(`column.${expected.table_name}.${expected.column_name}`);
    verifyType(expected.column, actual, coordinate);
    equal(actual.nullable, expected.column.nullable ? "YES" : "NO", `${coordinate}.nullable`);
    equal(
      /auto_increment/iu.test(String(actual.extra)),
      expected.column.auto_increment,
      `${coordinate}.auto_increment`,
    );
    equal(/on update/iu.test(String(actual.extra)), false, `${coordinate}.automatic_timestamp`);
    const defaultSql = canonicalDefaultSql(actual.default_sql);
    equal(
      defaultSql === "null" ? null : defaultSql,
      expected.column.default_sql === "null" ? null : expected.column.default_sql,
      `${coordinate}.default`,
    );
    if (expected.column.generated !== null) {
      equal(actual.is_generated, "ALWAYS", `${coordinate}.generated`);
      equal(
        /STORED GENERATED/iu.test(String(actual.extra)),
        expected.column.stored,
        `${coordinate}.stored`,
      );
      equal(
        canonicalMetadataSql(actual.generation_expression),
        expected.column.generated,
        `${coordinate}.expression`,
      );
    } else {
      equal(actual.is_generated, "NEVER", `${coordinate}.generated`);
      check(
        actual.generation_expression === null || actual.generation_expression === "",
        `${coordinate}.expression`,
      );
    }
  }
  sameKeys(
    observed.constraints,
    constraints,
    ["table_name", "constraint_name", "constraint_type"],
    at("constraints"),
  );
  sameKeys(observed.checks, checks, ["table_name", "constraint_name"], at("checks"));
  for (const expected of checks)
    equal(
      canonicalCheckSql(
        observed.checks.find(
          (row) =>
            row.table_name === expected.table_name &&
            row.constraint_name === expected.constraint_name,
        ).expression_sql,
      ),
      expected.expression_sql,
      at(`check.${expected.table_name}.${expected.constraint_name}.expression`),
    );
  sameKeys(observed.indexes, indexes, ["table_name", "index_name", "ordinal"], at("indexes"));
  for (const expected of indexes) {
    const actual = observed.indexes.find(
      (row) =>
        row.table_name === expected.table_name &&
        row.index_name === expected.index_name &&
        String(row.ordinal) === expected.ordinal,
    );
    for (const field of [
      "column_name",
      "non_unique",
      "direction",
      "prefix_length",
      "index_type",
      "ignored",
    ])
      equal(
        actual[field] === null ? null : String(actual[field]),
        expected[field],
        at(`index.${expected.table_name}.${expected.index_name}.${field}`),
      );
  }
  sameKeys(
    observed.foreign_keys,
    foreignKeys,
    ["table_name", "constraint_name", "ordinal"],
    at("foreign_keys"),
  );
  for (const expected of foreignKeys) {
    const actual = observed.foreign_keys.find(
      (row) =>
        row.table_name === expected.table_name &&
        row.constraint_name === expected.constraint_name &&
        String(row.ordinal) === expected.ordinal,
    );
    for (const field of [
      "column_name",
      "target_schema",
      "target_table",
      "target_column",
      "update_rule",
      "delete_rule",
    ])
      equal(
        actual[field],
        expected[field],
        at(`foreign_key.${expected.table_name}.${expected.constraint_name}.${field}`),
      );
  }
  sameKeys(
    observed.routines,
    Object.values(state.routines).map((routine) => ({ routine_name: routine.name })),
    ["routine_name"],
    at("routines"),
  );
  const parameters = [];
  for (const routine of Object.values(state.routines)) {
    const actual = observed.routines.find((row) => row.routine_name === routine.name),
      coordinate = at(`routine.${routine.name}`);
    for (const [field, value] of Object.entries({
      routine_type: "PROCEDURE",
      definer: routine.definer,
      security_type: routine.security,
      data_access: routine.access,
      charset_name: "utf8mb4",
      collation_name: "utf8mb4_bin",
      database_collation: "utf8mb4_bin",
    }))
      equal(actual[field], value, `${coordinate}.${field}`);
    listEqual(String(actual.sql_mode).split(","), sqlMode.split(","), `${coordinate}.sql_mode`);
    equal(canonicalMetadataSql(actual.body_sql), routine.body, `${coordinate}.body`);
    routine.parameters.forEach((parameter, index) =>
      parameters.push({
        routine_name: routine.name,
        parameter_name: parameter.name,
        ordinal: String(index + 1),
        parameter,
      }),
    );
  }
  sameKeys(
    observed.parameters,
    parameters,
    ["routine_name", "parameter_name", "ordinal"],
    at("parameters"),
  );
  for (const expected of parameters) {
    const actual = observed.parameters.find(
        (row) =>
          row.routine_name === expected.routine_name &&
          row.parameter_name === expected.parameter_name,
      ),
      coordinate = at(`parameter.${expected.routine_name}.${expected.parameter_name}`);
    equal(actual.mode, expected.parameter.mode, `${coordinate}.mode`);
    verifyType(expected.parameter, actual, coordinate);
  }
  sameKeys(
    observed.triggers,
    Object.values(state.triggers).map((trigger) => ({ trigger_name: trigger.name })),
    ["trigger_name"],
    at("triggers"),
  );
  for (const trigger of Object.values(state.triggers)) {
    const actual = observed.triggers.find((row) => row.trigger_name === trigger.name),
      coordinate = at(`trigger.${trigger.name}`);
    for (const [field, value] of Object.entries({
      table_name: trigger.table,
      timing_name: trigger.timing,
      event_name: trigger.event,
      definer: trigger.definer,
      charset_name: "utf8mb4",
      collation_name: "utf8mb4_bin",
      database_collation: "utf8mb4_bin",
    }))
      equal(actual[field], value, `${coordinate}.${field}`);
    equal(natural(actual.action_order, coordinate), "1", `${coordinate}.order`);
    listEqual(String(actual.sql_mode).split(","), sqlMode.split(","), `${coordinate}.sql_mode`);
    equal(canonicalMetadataSql(actual.body_sql), trigger.body, `${coordinate}.body`);
  }
  sameKeys(
    observed.accounts,
    Object.values(state.accounts).map((account) => ({ account: account.name, host: account.host })),
    ["account", "host"],
    at("accounts"),
  );
  for (const account of Object.values(state.accounts)) {
    const actual = observed.accounts.find((row) => row.account === account.name);
    check(
      [null, "0", "1", "true", "false", 0, 1, true, false].includes(actual.locked),
      at(`account.${account.name}.lock_type`),
    );
    equal(
      ["1", "true", 1, true].includes(actual.locked),
      account.locked,
      at(`account.${account.name}.locked`),
    );
    equal(
      natural(actual.global_access, at(`account.${account.name}.global`)),
      "0",
      at(`account.${account.name}.global`),
    );
    equal(
      natural(actual.ssl_type, at(`account.${account.name}.ssl_type`)),
      account.require_ssl ? "1" : "0",
      at(`account.${account.name}.ssl_type`),
    );
    check([0, "0", false, "false"].includes(actual.is_role), at(`account.${account.name}.is_role`));
  }
  const grants = Object.fromEntries(Object.keys(state.grants).map((account) => [account, []]));
  for (const category of ["table_grants", "column_grants"])
    for (const row of observed[category]) {
      const account = typeof row.account_host === "string" ? row.account_host.slice(0, -2) : "";
      check(
        Object.hasOwn(grants, account) && row.account_host === `${account}@%`,
        at(`${category}.account`),
      );
      equal(row.database_name, expectedDatabase, at(`${category}.database`));
      equal(row.grantable, "NO", at(`${category}.grantable`));
      grants[account].push(
        `table|${row.table_name}|${row.privilege_name}|${category === "table_grants" ? "*" : row.column_name}`,
      );
    }
  for (const row of observed.routine_grants) {
    check(Object.hasOwn(grants, row.account), at("routine_grants.account"));
    equal(row.host, "%", at("routine_grants.host"));
    equal(row.database_name, expectedDatabase, at("routine_grants.database"));
    equal(String(row.routine_type).toUpperCase(), "PROCEDURE", at("routine_grants.type"));
    equal(String(row.privileges).toUpperCase(), "EXECUTE", at("routine_grants.privileges"));
    grants[row.account].push(`procedure|${row.routine_name}|EXECUTE`);
  }
  for (const [account, expected] of Object.entries(state.grants))
    listEqual(grants[account], expected, at(`grants.${account}.exact`));
  equal(observed.role_grants, [], at("role_grants"));
  equal(observed.proxy_grants, [], at("proxy_grants"));
  equal(observed.events, [], at("events"));
  sameKeys(
    observed.ambient_grants,
    [
      "anonymous_global",
      "anonymous_db",
      ...publicPrivilegeCoordinates.map((table) => `public_${table}`),
    ].map((coordinate) => ({ coordinate })),
    ["coordinate"],
    at("ambient_grants"),
  );
  for (const row of observed.ambient_grants)
    equal(
      natural(row.row_count, at("ambient_grants.count")),
      "0",
      at(`ambient_grants.${row.coordinate}`),
    );
  equal(observed.db_flags.length, state.migrator_schema_all ? 1 : 0, at("schema_grants.count"));
  if (state.migrator_schema_all) {
    const actual = observed.db_flags[0];
    equal(actual.account, "classhub_migrator", at("schema_grants.account"));
    equal(actual.host, "%", at("schema_grants.host"));
    equal(actual.database_name, expectedDatabase, at("schema_grants.database"));
    check(observed.db_flag_columns.length >= 18, at("schema_grants.columns"));
    for (const row of observed.db_flag_columns)
      equal(
        actual[row.column_name],
        row.column_name.toLowerCase() === "grant_priv" ? "N" : "Y",
        at("schema_grants.flags"),
      );
  }
  return {
    verified: true,
    artifact,
    metadata_sha256: contractDigest(JSON.stringify(observed)),
    tables: observed.tables.length,
    columns: observed.columns.length,
    routines: observed.routines.length,
    triggers: observed.triggers.length,
  };
}

async function verifySeeds(state, queryRows, artifact) {
  for (const [table, expected] of Object.entries(state.seeds)) {
    const rows = await readRows(
      queryRows,
      table === "audit_log_actions"
        ? "SELECT action AS seed FROM audit_log_actions ORDER BY BINARY action"
        : "SELECT LOWER(HEX(lock_digest)) AS seed FROM retention_lock_keys ORDER BY lock_digest",
      `${artifact}.query.seed`,
    );
    listEqual(
      rows.map((row) => row.seed),
      expected,
      `${artifact}.seed.${table}`,
    );
  }
}

/** The root adapter supplies its already attested native connection; this module owns no DB. */
export function createInstallPostconditionVerifier({
  plan,
  readRepoFile = defaultRead,
  queryRows,
}) {
  check(typeof queryRows === "function", "adapter.query_rows");
  const catalog = buildInstallPostconditionCatalog({ readRepoFile });
  try {
    verifyRuntimeInstallPlan(plan, { readRepoFile });
  } catch {
    postconditionFailure("adapter.plan");
  }
  equal(plan.plan_sha256, catalog.plan.plan_sha256, "adapter.plan_checksum");
  const verifiedPlan = clone(plan);
  let completed = -1,
    ledgerVerified = false;
  const verify = async (state, artifact) => {
    const result = verifyInstallMetadata(state, await collectInstallMetadata(queryRows), {
      artifact,
    });
    await verifySeeds(state, queryRows, artifact);
    return result;
  };
  return {
    get catalog() {
      return clone(catalog);
    },
    async verifyStep(step) {
      const index = completed + 1,
        expected = verifiedPlan.steps[index];
      check(expected && isDeepStrictEqual(step, expected), "adapter.step_order");
      check(index === 0 || ledgerVerified, "adapter.ledger_bootstrap_unverified");
      equal(
        contractDigest(Buffer.from(readRepoFile(step.source_path))),
        step.sha256,
        `${step.id}.source_checksum`,
      );
      const result = await verify(catalog.steps[index].state, step.id);
      completed = index;
      return { ...result, source_sha256: step.sha256 };
    },
    async verifyLedgerBootstrap() {
      equal(completed, 0, "adapter.ledger_bootstrap_order");
      equal(ledgerVerified, false, "adapter.ledger_bootstrap_repeat");
      const result = await verify(catalog.bootstrap, "ledger-bootstrap");
      const rows = await readRows(
        queryRows,
        "SELECT COUNT(*) AS row_count FROM classhub_schema_migrations",
        "ledger-bootstrap.rows",
      );
      equal(rows.length, 1, "ledger-bootstrap.row_count");
      equal(natural(rows[0].row_count, "ledger-bootstrap.rows"), "0", "ledger-bootstrap.rows");
      ledgerVerified = true;
      return result;
    },
    async verifyFinal(currentPlan) {
      equal(currentPlan, verifiedPlan, "final.plan");
      equal(completed, verifiedPlan.steps.length - 1, "final.step_count");
      const result = await verify(catalog.final, "final");
      const rows = await readRows(
        queryRows,
        "SELECT CAST(version AS CHAR) AS version,description,LOWER(HEX(source_sha256)) AS source_sha256,DATE_FORMAT(applied_at_utc,'%Y-%m-%d %H:%i:%s.%f') AS applied_at_utc,server_version FROM classhub_schema_migrations ORDER BY classhub_schema_migrations.version",
        "final.ledger.query",
      );
      const expected = verifiedPlan.steps
        .filter((step) => step.ledger_version !== null)
        .sort((a, b) => a.ledger_version - b.ledger_version);
      equal(rows.length, expected.length, "final.ledger.count");
      for (const [index, step] of expected.entries()) {
        const actual = rows[index],
          coordinate = `final.ledger.${step.ledger_version}`;
        equal(
          natural(actual.version, coordinate),
          String(step.ledger_version),
          `${coordinate}.version`,
        );
        equal(actual.description, step.id, `${coordinate}.description`);
        equal(actual.source_sha256, step.sha256, `${coordinate}.checksum`);
        check(
          /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/u.test(String(actual.applied_at_utc)),
          `${coordinate}.timestamp`,
        );
        check(
          /^11\.4\.13-MariaDB(?:-|$)/u.test(String(actual.server_version)),
          `${coordinate}.server_version`,
        );
      }
      const nonseed = [...verifiedPlan.product_tables, "worker_security_audit_lock_keys"].filter(
        (table) => table !== "audit_log_actions",
      );
      const counts = await readRows(
        queryRows,
        nonseed
          .map((table) => `SELECT '${table}' AS table_name,COUNT(*) AS row_count FROM \`${table}\``)
          .join(" UNION ALL "),
        "final.product_counts.query",
      );
      sameKeys(
        counts,
        nonseed.map((table_name) => ({ table_name })),
        ["table_name"],
        "final.product_counts",
      );
      for (const row of counts)
        equal(
          natural(row.row_count, "final.product_counts.value"),
          "0",
          "final.product_counts.nonseed",
        );
      return {
        ...result,
        ledger_records: expected.length,
        exact_runtime_grants: Object.fromEntries(
          Object.entries(verifiedPlan.final_runtime_grants).map(([role, entries]) => [
            role,
            entries.length,
          ]),
        ),
        audit_seed_rows: 56,
        retention_seed_rows: 3,
        persistent_nonseed_rows: 0,
        runtimeActivationApplied: false,
      };
    },
  };
}
