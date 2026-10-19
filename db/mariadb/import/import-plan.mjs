import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildInstallPostconditionCatalog } from "../ledger/install-postconditions.mjs";
import {
  canonicalDefaultSql,
  canonicalMetadataSql,
} from "../ledger/install-postcondition-source.mjs";
import { encodePostgresImportValue, importFailure } from "./value-codecs.mjs";
import { buildPostgresSequenceContract } from "./sequence-state.mjs";

const requireContract = (condition, coordinate) => {
  if (!condition) importFailure(coordinate);
};
const same = (actual, expected, coordinate) =>
  requireContract(isDeepStrictEqual(actual, expected), coordinate);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const ordered = (values) => [...values].sort();
const name = (value, coordinate) => {
  requireContract(typeof value === "string" && /^[a-z_][a-z0-9_]*$/u.test(value), coordinate);
  return value;
};
const quantity = (value, coordinate) => {
  requireContract(
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
      (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)),
    coordinate,
  );
  const number = Number(value);
  requireContract(Number.isSafeInteger(number), coordinate);
  return number;
};
const blankDefault = (value) => (value === "null" ? null : value);
const excludedFeatureTables = [
  "class_duty_roles",
  "classroom_layout_templates",
  "duty_assignments",
  "duty_rosters",
  "layout_draft_autosaves",
  "seat_draw_assignments",
  "seat_draw_slots",
  "seat_draws",
  "team_draw_assignments",
  "team_draw_groups",
  "team_draws",
];
const integerRanges = {
  int8: ["bigint", "-9223372036854775808", "9223372036854775807"],
  int4: ["int", "-2147483648", "2147483647"],
  int2: ["smallint", "-32768", "32767"],
};
const sourceDataTypes = {
  int8: "bigint",
  int4: "integer",
  int2: "smallint",
  bool: "boolean",
  bytea: "bytea",
  uuid: "uuid",
  timestamptz: "timestamp with time zone",
  date: "date",
  time: "time without time zone",
  text: "text",
  varchar: "character varying",
  jsonb: "jsonb",
  inet: "inet",
};

/** These projections are explicit per PostgreSQL type, not a SQL translation layer.
 * Range guards ensure to_char never turns BC or infinite dates into an ambiguous value.
 */
export function postgresImportProjection(column) {
  const quoted = `"${name(column.name, "projection.column")}"`;
  let expression;
  switch (column.codec) {
    case "bytea_hex":
      expression = `encode(${quoted}, 'hex')`;
      break;
    case "json_raw":
      expression = `to_jsonb(${quoted})::text`;
      break;
    case "inet_host":
      expression = `host(${quoted}) || '/' || masklen(${quoted})::text`;
      break;
    case "utc_datetime6":
      expression = `CASE WHEN ${quoted} >= TIMESTAMPTZ '1000-01-01 00:00:00+00' AND ${quoted} < TIMESTAMPTZ '10000-01-01 00:00:00+00' THEN to_char(${quoted} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') ELSE ${quoted}::text END`;
      break;
    case "date":
      expression = `CASE WHEN ${quoted} >= DATE '1000-01-01' AND ${quoted} < DATE '10000-01-01' THEN to_char(${quoted}, 'YYYY-MM-DD') ELSE ${quoted}::text END`;
      break;
    case "signed_integer":
    case "boolean":
    case "uuid":
    case "text":
    case "time0":
      expression = `${quoted}::text`;
      break;
    default:
      importFailure("projection.codec");
  }
  return `${expression} AS ${quoted}`;
}

/** Mapping is deliberately limited to the actual selected schema's 12 PG types. */
export function mapImportColumn(source, target) {
  const table = name(source.table_name, "mapping.table"),
    column = name(source.column_name, "mapping.column");
  const at = `mapping.${table}.${column}`;
  same(target.table_name, table, `${at}.target_table`);
  same(target.column_name, column, `${at}.target_column`);
  requireContract(Object.hasOwn(sourceDataTypes, source.udt_name), `${at}.unsupported_source_type`);
  same(source.data_type, sourceDataTypes[source.udt_name], `${at}.source_type`);
  requireContract(["YES", "NO"].includes(source.is_identity), `${at}.identity`);
  requireContract(
    ["YES", "NO"].includes(source.is_nullable) && ["YES", "NO"].includes(target.nullable),
    `${at}.nullable`,
  );
  requireContract(
    ["NEVER", "ALWAYS"].includes(source.is_generated) &&
      ["NEVER", "ALWAYS"].includes(target.is_generated),
    `${at}.generated`,
  );
  requireContract(
    source.is_generated === "NEVER" || target.is_generated === "ALWAYS",
    `${at}.source_generated`,
  );
  requireContract(!/\bunsigned\b/iu.test(target.column_type), `${at}.unsigned`);
  const native = {
    type: target.data_type,
    column_type: target.column_type,
    nullable: target.nullable === "YES",
    charset: target.charset_name,
    collation: target.collation_name,
    max_characters: null,
    max_bytes: null,
  };
  let codec;
  if (Object.hasOwn(integerRanges, source.udt_name)) {
    const [type, minimum, maximum] = integerRanges[source.udt_name];
    same(target.data_type, type, `${at}.integer_type`);
    native.minimum = minimum;
    native.maximum = maximum;
    codec = "signed_integer";
  } else
    switch (source.udt_name) {
      case "bool":
        same(target.column_type, "tinyint(1)", `${at}.boolean_type`);
        codec = "boolean";
        break;
      case "bytea":
        requireContract(
          target.data_type === "varbinary" && /^varbinary\([1-9]\d*\)$/u.test(target.column_type),
          `${at}.binary_type`,
        );
        native.max_bytes = quantity(target.max_length, `${at}.byte_length`);
        codec = "bytea_hex";
        break;
      case "uuid":
        same(target.data_type, "uuid", `${at}.uuid_type`);
        codec = "uuid";
        break;
      case "timestamptz":
        same(target.column_type, "datetime(6)", `${at}.timestamp_type`);
        same(quantity(source.datetime_precision, at), 6, `${at}.source_precision`);
        same(quantity(target.datetime_precision, at), 6, `${at}.target_precision`);
        codec = "utc_datetime6";
        break;
      case "date":
        same(target.data_type, "date", `${at}.date_type`);
        codec = "date";
        break;
      case "time":
        same(target.data_type, "time", `${at}.time_type`);
        same(quantity(source.datetime_precision, at), 0, `${at}.source_precision`);
        same(quantity(target.datetime_precision, at), 0, `${at}.target_precision`);
        codec = "time0";
        break;
      case "text":
      case "varchar":
        requireContract(
          ["varchar", "text", "longtext"].includes(target.data_type),
          `${at}.text_type`,
        );
        codec = "text";
        break;
      case "jsonb":
        same(target.data_type, "longtext", `${at}.json_type`);
        codec = "json_raw";
        break;
      case "inet":
        same(target.column_type, "varchar(45)", `${at}.inet_type`);
        same(target.charset_name, "ascii", `${at}.inet_charset`);
        codec = "inet_host";
        break;
      default:
        importFailure(`${at}.unsupported_source_type`);
    }
  if (["text", "json_raw", "inet_host"].includes(codec)) {
    requireContract(["ascii", "utf8mb4"].includes(target.charset_name), `${at}.text_charset`);
    if (target.data_type === "varchar")
      native.max_characters = quantity(target.max_length, `${at}.character_length`);
    native.max_bytes =
      target.data_type === "text"
        ? 65535
        : target.data_type === "longtext"
          ? 4294967295
          : native.max_characters * (target.charset_name === "ascii" ? 1 : 4);
  }
  return {
    table,
    name: column,
    codec,
    source: {
      udt_name: source.udt_name,
      data_type: source.data_type,
      nullable: source.is_nullable === "YES",
      ordinal: quantity(source.ordinal_position, `${at}.source_ordinal`),
      default_sql: source.column_default,
      is_identity: source.is_identity,
      generated: source.is_generated === "ALWAYS",
      generation_expression: source.generation_expression,
      datetime_precision: source.datetime_precision,
    },
    target: {
      ...native,
      ordinal: quantity(target.ordinal, `${at}.target_ordinal`),
      default_sql: target.default_sql,
      auto_increment: /auto_increment/u.test(target.extra),
      generated: target.is_generated === "ALWAYS",
      generation_expression: target.generation_expression,
    },
  };
}

/** Reject omitted/extra columns even when a target DEFAULT could hide the omission. */
export function assertImportColumnCoverage(sourceColumns, targetColumns, coordinate) {
  const sourceNames = sourceColumns.map((column) => column.column_name),
    targetNames = targetColumns.map((column) => column.column_name);
  same(new Set(sourceNames).size, sourceNames.length, `${coordinate}.duplicate_source_column`);
  same(new Set(targetNames).size, targetNames.length, `${coordinate}.duplicate_target_column`);
  requireContract(
    sourceNames.every((column) => targetNames.includes(column)),
    `${coordinate}.unmapped_source_column`,
  );
  requireContract(
    targetColumns.every(
      (column) => column.is_generated === "ALWAYS" || sourceNames.includes(column.column_name),
    ),
    `${coordinate}.missing_source_column`,
  );
}

function verifyTargetColumn(actual, expected, ordinal, coordinate) {
  same(actual.data_type, expected.type, `${coordinate}.type`);
  const columnType =
    { bigint: "bigint(20)", int: "int(11)", smallint: "smallint(6)", tinyint: "tinyint(1)" }[
      expected.type
    ] ??
    (expected.type === "time" && expected.size === "0"
      ? "time"
      : expected.size !== null
        ? `${expected.type}(${expected.size})`
        : expected.type);
  same(actual.column_type, columnType, `${coordinate}.column_type`);
  same(actual.nullable, expected.nullable ? "YES" : "NO", `${coordinate}.nullable`);
  same(actual.charset_name, expected.charset, `${coordinate}.charset`);
  same(actual.collation_name, expected.collation, `${coordinate}.collation`);
  same(quantity(actual.ordinal, coordinate), ordinal, `${coordinate}.ordinal`);
  same(
    /auto_increment/u.test(actual.extra),
    expected.auto_increment,
    `${coordinate}.auto_increment`,
  );
  same(/on update/iu.test(actual.extra), false, `${coordinate}.on_update`);
  same(
    blankDefault(canonicalDefaultSql(actual.default_sql)),
    blankDefault(expected.default_sql),
    `${coordinate}.default`,
  );
  same(actual.is_generated === "ALWAYS", expected.generated !== null, `${coordinate}.generated`);
  same(
    canonicalMetadataSql(actual.generation_expression) || null,
    expected.generated,
    `${coordinate}.generation_expression`,
  );
  if (expected.size !== null && ["varchar", "char", "binary", "varbinary"].includes(expected.type))
    same(String(actual.max_length), expected.size, `${coordinate}.length`);
  if (["datetime", "time"].includes(expected.type))
    same(String(actual.datetime_precision), expected.size ?? "0", `${coordinate}.precision`);
}

function verifyTargetForeignKeys(metadata, expected, table) {
  const actual = metadata.foreign_keys
    .filter((fk) => fk.table_name === table)
    .map((fk) => ({
      ...fk,
      ordinal: String(quantity(fk.ordinal, `schema.${table}.foreign_keys.ordinal`)),
    }));
  const wanted = Object.values(expected.foreign_keys).flatMap((fk) =>
    fk.columns.map((column, index) => ({
      table_name: table,
      constraint_name: fk.name,
      ordinal: String(index + 1),
      column_name: column,
      target_table: fk.target_table,
      target_column: fk.target_columns[index],
      update_rule: fk.update_rule,
      delete_rule: fk.delete_rule,
    })),
  );
  const byCoordinate = (rows) =>
    rows.sort((a, b) =>
      `${a.constraint_name}.${a.ordinal}`.localeCompare(`${b.constraint_name}.${b.ordinal}`),
    );
  same(byCoordinate(actual), byCoordinate(wanted), `schema.${table}.foreign_keys`);
  return Object.values(expected.foreign_keys);
}

/** Read-only mapping plan. It neither connects to a database nor executes its SQL. */
export function buildPostgresMariaDbImportPlan({
  sourceSchema,
  targetMetadata,
  installation = buildInstallPostconditionCatalog(),
}) {
  const runtime = installation.plan;
  const metadata = targetMetadata.metadata ?? targetMetadata;
  requireContract(
    Array.isArray(sourceSchema.columns) &&
      Array.isArray(sourceSchema.constraints) &&
      Array.isArray(metadata.columns) &&
      Array.isArray(metadata.tables) &&
      Array.isArray(metadata.foreign_keys),
    "schema.shape",
  );
  const sourceTables = ordered(new Set(sourceSchema.columns.map((column) => column.table_name)));
  same(
    sourceTables,
    ordered([...runtime.product_tables, ...excludedFeatureTables, "pgmigrations"]),
    "schema.source_table_set",
  );
  const targetTables = metadata.tables.map((table) => table.table_name);
  requireContract(
    runtime.product_tables.every((table) => targetTables.includes(table)) &&
      targetTables.every((table) =>
        [...runtime.product_tables, ...runtime.operational_tables].includes(table),
      ),
    "schema.target_table_set",
  );
  same(new Set(targetTables).size, targetTables.length, "schema.duplicate_target_table");
  const tables = [];
  for (const table of runtime.product_tables) {
    const sourceColumns = sourceSchema.columns
      .filter((column) => column.table_name === table)
      .sort((a, b) => a.ordinal_position - b.ordinal_position);
    const targetColumns = metadata.columns
      .filter((column) => column.table_name === table)
      .sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
    const expected = installation.final.tables[table];
    const foreignKeys = verifyTargetForeignKeys(metadata, expected, table);
    same(
      ordered(targetColumns.map((column) => column.column_name)),
      ordered(Object.keys(expected.columns)),
      `schema.${table}.target_column_set`,
    );
    targetColumns.forEach((column, index) =>
      verifyTargetColumn(
        column,
        expected.columns[column.column_name],
        index + 1,
        `schema.${table}.${column.column_name}`,
      ),
    );
    assertImportColumnCoverage(sourceColumns, targetColumns, `schema.${table}`);
    const columns = sourceColumns.map((source) =>
      mapImportColumn(
        source,
        targetColumns.find((target) => target.column_name === source.column_name),
      ),
    );
    for (const column of columns)
      if (column.codec === "json_raw")
        same(
          expected.checks[column.name],
          `json_valid ( ${column.name} )`,
          `schema.${table}.${column.name}.json_validation`,
        );
    const writable = targetColumns
      .filter((column) => column.is_generated === "NEVER")
      .map((column) => column.column_name);
    const record = {
      schema_version: 1,
      table,
      row_policy: table === "audit_log_actions" ? "compare_existing_seed" : "insert_exact_values",
      columns,
      insert_columns: writable,
      target_generated_columns: targetColumns
        .filter((column) => column.is_generated === "ALWAYS")
        .map((column) => column.column_name),
      generated_compare_columns: columns
        .filter((column) => column.target.generated)
        .map((column) => column.name),
      source_select_sql: `SELECT ${columns.map(postgresImportProjection).join(", ")} FROM "public"."${table}"`,
      target_insert_sql:
        table === "audit_log_actions"
          ? null
          : `INSERT INTO \`${table}\` (${writable.map((column) => `\`${column}\``).join(", ")}) VALUES (${writable.map(() => "?").join(", ")})`,
      foreign_keys: foreignKeys,
      foreign_key_dependencies: ordered(new Set(foreignKeys.map((fk) => fk.target_table))),
      source_constraint_count: sourceSchema.constraints.filter(
        (constraint) => constraint.table_name === table,
      ).length,
    };
    tables.push({ ...record, table_sha256: digest(record) });
  }
  const plan = {
    schema_version: 1,
    status: "postgres_to_mariadb_value_mapping_only",
    installation_attestation: false,
    source_metadata_sha256: digest(sourceSchema),
    target_columns_sha256: digest(
      metadata.columns.filter((column) => runtime.product_tables.includes(column.table_name)),
    ),
    target_foreign_keys_sha256: digest(
      metadata.foreign_keys.filter((fk) => runtime.product_tables.includes(fk.table_name)),
    ),
    runtime_plan_sha256: runtime.plan_sha256,
    source_session_requirements: {
      server_encoding: "UTF8",
      client_encoding: "UTF8",
      DateStyle: "ISO, YMD",
      TimeZone: "UTC",
      transaction: "REPEATABLE READ READ ONLY",
    },
    target_session_requirements: {
      time_zone: "+00:00",
      character_set_connection: "utf8mb4",
      strict_sql_mode_required: true,
      additional_import_sql_modes: ["NO_AUTO_VALUE_ON_ZERO"],
      auto_increment_increment: "1",
      auto_increment_offset: "1",
      automatic_timestamp_or_normalization: false,
    },
    table_count: tables.length,
    source_column_count: tables.reduce((sum, table) => sum + table.columns.length, 0),
    insert_column_count: tables.reduce((sum, table) => sum + table.insert_columns.length, 0),
    generated_column_count: tables.reduce(
      (sum, table) => sum + table.target_generated_columns.length,
      0,
    ),
    preserve_in_source_backup: [
      ...excludedFeatureTables.map((table) => ({ table, reason: "excluded_product_scope" })),
      { table: "pgmigrations", reason: "postgres_installation_ledger" },
    ],
    target_not_imported: runtime.operational_tables,
    seed_catalog: {
      table: "audit_log_actions",
      action: "compare_existing_seed",
      expected_labels: installation.final.seeds.audit_log_actions,
    },
    sequence_contracts: tables
      .flatMap((table) => table.columns)
      .map(buildPostgresSequenceContract)
      .filter((contract) => contract !== null),
    mandatory_post_import_checks: [
      "all_target_constraints_enabled",
      "exact_row_counts",
      "exact_imported_values_without_number_or_timestamp_rounding",
      "two_shared_generated_columns_equal_source",
      "explicit_ids_and_next_auto_increment_safe",
      "source_backup_preserved",
      "no_runtime_activation_by_this_helper",
    ],
    tables,
  };
  same(
    [
      plan.table_count,
      plan.source_column_count,
      plan.insert_column_count,
      plan.generated_column_count,
    ],
    Object.hasOwn(installation.final.tables, "mail_templates")
      ? [56, 571, 569, 13]
      : [54, 554, 552, 13],
    "schema.selected_mapping_counts",
  );
  same(plan.sequence_contracts.length, 38, "schema.selected_sequence_count");
  return { ...plan, plan_sha256: digest(plan) };
}

export function encodePostgresImportRow(tablePlan, row) {
  const { table_sha256, ...body } = tablePlan;
  same(digest(body), table_sha256, "row.table_plan_checksum");
  requireContract(
    row && typeof row === "object" && !Array.isArray(row),
    `row.${tablePlan.table}.shape`,
  );
  same(
    ordered(Object.keys(row)),
    ordered(tablePlan.columns.map((column) => column.name)),
    `row.${tablePlan.table}.column_set`,
  );
  const values = new Map(
    tablePlan.columns.map((column) => [
      column.name,
      encodePostgresImportValue(column, row[column.name]),
    ]),
  );
  return {
    values: tablePlan.insert_columns.map((column) => values.get(column)),
    generated_checks: tablePlan.generated_compare_columns.map((column) => ({
      column,
      value: values.get(column),
    })),
    row_policy: tablePlan.row_policy,
  };
}
