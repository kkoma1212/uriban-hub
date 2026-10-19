import { createHash } from "node:crypto";
import { importFailure } from "./value-codecs.mjs";

const requireContract = (condition, coordinate) => {
  if (!condition) importFailure(coordinate);
};
const identifier = (value, coordinate) => {
  requireContract(typeof value === "string" && /^[a-z_][a-z0-9_]*$/u.test(value), coordinate);
  return value;
};
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
const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const signed = (value, coordinate) => {
  requireContract(typeof value === "string" && /^(?:0|-?[1-9]\d*)$/u.test(value), coordinate);
  return BigInt(value);
};
const requireHash = (record, field, coordinate) => {
  const { [field]: expected, ...body } = record;
  requireContract(hash(body) === expected, coordinate);
};

/** PG identity columns have no nextval DEFAULT in information_schema. Resolve
 * their owned sequence from the server catalog; never guess a sequence name.
 */
export function buildPostgresSequenceContract(column) {
  const table = identifier(column.table, "sequence.table");
  const name = identifier(column.name, "sequence.column");
  const at = `sequence.${table}.${name}`;
  const serial = /^nextval\('((?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*)'::regclass\)$/u.exec(
    column.source.default_sql ?? "",
  );
  requireContract(
    !/nextval/iu.test(column.source.default_sql ?? "") || serial !== null,
    `${at}.unsupported_serial_reference`,
  );
  const identity = column.source.is_identity === "YES";
  requireContract(
    column.target.auto_increment === (identity || serial !== null),
    `${at}.source_target_generation`,
  );
  if (!column.target.auto_increment) return null;
  requireContract(
    column.codec === "signed_integer" && !column.source.generated && !column.target.generated,
    `${at}.type`,
  );
  requireContract(!identity || column.source.default_sql === null, `${at}.identity_default`);
  const serialParts = serial?.[1].split(".");
  const expectedSerial = serialParts
    ? { schema: serialParts.length === 1 ? "public" : serialParts[0], name: serialParts.at(-1) }
    : null;
  requireContract(
    expectedSerial === null || expectedSerial.schema === "public",
    `${at}.sequence_schema`,
  );
  const record = {
    schema_version: 1,
    table,
    column: name,
    source_generation: identity ? "identity" : "serial",
    expected_serial_sequence: expectedSerial,
    target_integer_minimum: column.target.minimum,
    target_integer_maximum: column.target.maximum,
    discovery_sql: `SELECT ns.nspname::text AS sequence_schema, seq.relname::text AS sequence_name, s.seqtypid::regtype::text AS data_type, s.seqstart::text AS start_value, s.seqincrement::text AS increment_by, s.seqmin::text AS minimum_value, s.seqmax::text AS maximum_value, s.seqcache::text AS cache_size, s.seqcycle::text AS cycle, d.deptype::text AS ownership_dependency, a.attidentity::text AS identity_generation FROM pg_catalog.pg_class tbl JOIN pg_catalog.pg_namespace tns ON tns.oid = tbl.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid = tbl.oid AND a.attname = '${name}' AND a.attnum > 0 AND NOT a.attisdropped JOIN pg_catalog.pg_class seq ON seq.oid = pg_catalog.pg_get_serial_sequence('"public"."${table}"', '${name}')::regclass AND seq.relkind = 'S' JOIN pg_catalog.pg_namespace ns ON ns.oid = seq.relnamespace JOIN pg_catalog.pg_sequence s ON s.seqrelid = seq.oid JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = seq.oid AND d.objsubid = 0 AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = tbl.oid AND d.refobjsubid = a.attnum WHERE tns.nspname = 'public' AND tbl.relname = '${table}' AND tbl.relkind = 'r'`,
    target_max_id_sql: `SELECT CAST(MAX(\`${name}\`) AS CHAR) AS maximum_imported_id FROM \`${table}\``,
    state_source_requirement: "isolated_restored_backup_without_sequence_writers",
  };
  return { ...record, contract_sha256: hash(record) };
}

/** Call with exactly the rows from contract.discovery_sql. No database I/O. */
export function resolvePostgresSequence(contract, rows) {
  requireHash(contract, "contract_sha256", "sequence.contract_checksum");
  const at = `sequence.${contract.table}.${contract.column}`;
  requireContract(Array.isArray(rows) && rows.length === 1, `${at}.discovery_count`);
  const row = rows[0];
  requireContract(row && typeof row === "object", `${at}.discovery_shape`);
  requireContract(row.sequence_schema === "public", `${at}.sequence_schema`);
  const sequenceName = identifier(row.sequence_name, `${at}.sequence_name`);
  if (contract.expected_serial_sequence !== null)
    requireContract(
      sequenceName === contract.expected_serial_sequence.name,
      `${at}.serial_reference`,
    );
  const expectedDataType = {
    "9223372036854775807": "bigint",
    2147483647: "integer",
    32767: "smallint",
  }[contract.target_integer_maximum];
  requireContract(
    expectedDataType !== undefined && row.data_type === expectedDataType,
    `${at}.data_type`,
  );
  requireContract(row.increment_by === "1", `${at}.increment_by`);
  requireContract(row.minimum_value === "1", `${at}.minimum_value`);
  requireContract(row.maximum_value === contract.target_integer_maximum, `${at}.maximum_value`);
  requireContract(row.cycle === "false", `${at}.cycle`);
  const start = signed(row.start_value, `${at}.start_value`);
  requireContract(start >= 1n && start <= BigInt(row.maximum_value), `${at}.start_value`);
  const cache = signed(row.cache_size, `${at}.cache_size`);
  requireContract(cache >= 1n && cache <= 9223372036854775807n, `${at}.cache_size`);
  const identity = contract.source_generation === "identity";
  requireContract(
    row.ownership_dependency === (identity ? "i" : "a"),
    `${at}.ownership_dependency`,
  );
  requireContract(
    identity ? ["a", "d"].includes(row.identity_generation) : row.identity_generation === "",
    `${at}.identity_generation`,
  );
  const record = {
    schema_version: 1,
    table: contract.table,
    column: contract.column,
    sequence_schema: "public",
    sequence_name: sequenceName,
    target_integer_minimum: contract.target_integer_minimum,
    target_integer_maximum: contract.target_integer_maximum,
    source_definition: {
      data_type: row.data_type,
      start_value: row.start_value,
      increment_by: row.increment_by,
      minimum_value: row.minimum_value,
      maximum_value: row.maximum_value,
      cache_size: row.cache_size,
      cycle: row.cycle,
      ownership_dependency: row.ownership_dependency,
      identity_generation: row.identity_generation,
    },
    state_sql: `SELECT last_value::text AS last_value, is_called::text AS is_called FROM "public"."${sequenceName}"`,
    contract_sha256: contract.contract_sha256,
  };
  return { ...record, sequence_sha256: hash(record) };
}

/** The source sequence high water mark is authoritative, including reserved
 * cache values. MAX(id)+1 alone could reuse deleted or already allocated IDs.
 * Any inconsistent/exhausted source state stops before a target ALTER is built.
 */
export function deriveMariaDbAutoIncrement(sequence, stateRows, maximumImportedId) {
  requireHash(sequence, "sequence_sha256", "sequence.definition_checksum");
  const at = `sequence.${sequence.table}.${sequence.column}`;
  requireContract(Array.isArray(stateRows) && stateRows.length === 1, `${at}.state_count`);
  const state = stateRows[0];
  requireContract(state && typeof state === "object", `${at}.state_shape`);
  const last = signed(state.last_value, `${at}.last_value`);
  requireContract(
    last >= 1n && last <= BigInt(sequence.target_integer_maximum),
    `${at}.last_value`,
  );
  requireContract(["true", "false"].includes(state.is_called), `${at}.is_called`);
  const next = last + (state.is_called === "true" ? 1n : 0n);
  requireContract(next <= BigInt(sequence.target_integer_maximum), `${at}.exhausted`);
  if (maximumImportedId !== null) {
    const maximum = signed(maximumImportedId, `${at}.maximum_imported_id`);
    requireContract(
      maximum >= BigInt(sequence.target_integer_minimum) &&
        maximum <= BigInt(sequence.target_integer_maximum),
      `${at}.maximum_imported_id`,
    );
    requireContract(next > maximum, `${at}.source_next_conflicts_with_imported_ids`);
  }
  return {
    schema_version: 1,
    table: sequence.table,
    column: sequence.column,
    next_value: String(next),
    source_last_value: state.last_value,
    source_is_called: state.is_called,
    maximum_imported_id: maximumImportedId,
    sequence_sha256: sequence.sequence_sha256,
    target_alter_sql: `ALTER TABLE \`${sequence.table}\` AUTO_INCREMENT = ${next}`,
    target_verify_sql: `SELECT CAST(AUTO_INCREMENT AS CHAR) AS next_value FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${sequence.table}'`,
    application_boundary: "after_import_commit_before_runtime_activation_ddl_is_not_transactional",
  };
}
