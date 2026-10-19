import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { argv } from "node:process";
import { test } from "node:test";
import {
  assertImportColumnCoverage,
  buildPostgresMariaDbImportPlan,
  encodePostgresImportRow,
  mapImportColumn,
  postgresImportProjection,
} from "./import-plan.mjs";
import { assertLosslessJson, encodePostgresImportValue } from "./value-codecs.mjs";
import {
  buildPostgresSequenceContract,
  deriveMariaDbAutoIncrement,
  resolvePostgresSequence,
} from "./sequence-state.mjs";

const copy = (value) => JSON.parse(JSON.stringify(value));
const types = {
  int8: ["bigint", "bigint", "bigint(20)"],
  int4: ["integer", "int", "int(11)"],
  int2: ["smallint", "smallint", "smallint(6)"],
  bool: ["boolean", "tinyint", "tinyint(1)"],
  bytea: ["bytea", "varbinary", "varbinary(32)"],
  uuid: ["uuid", "uuid", "uuid"],
  timestamptz: ["timestamp with time zone", "datetime", "datetime(6)"],
  date: ["date", "date", "date"],
  time: ["time without time zone", "time", "time"],
  text: ["text", "varchar", "varchar(320)"],
  jsonb: ["jsonb", "longtext", "longtext"],
  inet: ["inet", "varchar", "varchar(45)"],
};
function metadata(kind, nullable = false) {
  const [pgType, type, columnType] = types[kind];
  const character = ["text", "jsonb", "inet"].includes(kind);
  return {
    source: {
      table_name: "example",
      column_name: "value",
      ordinal_position: 1,
      udt_name: kind,
      data_type: pgType,
      is_nullable: nullable ? "YES" : "NO",
      is_identity: "NO",
      is_generated: "NEVER",
      column_default: null,
      generation_expression: null,
      datetime_precision: kind === "timestamptz" ? 6 : kind === "time" ? 0 : null,
    },
    target: {
      table_name: "example",
      column_name: "value",
      ordinal: "1",
      data_type: type,
      column_type: columnType,
      nullable: nullable ? "YES" : "NO",
      default_sql: null,
      extra: "",
      is_generated: "NEVER",
      generation_expression: null,
      datetime_precision: kind === "timestamptz" ? "6" : kind === "time" ? "0" : null,
      max_length: kind === "bytea" ? "32" : kind === "inet" ? "45" : kind === "text" ? "320" : null,
      charset_name: character ? (kind === "inet" ? "ascii" : "utf8mb4") : null,
      collation_name: character ? (kind === "inet" ? "ascii_bin" : "utf8mb4_bin") : null,
    },
  };
}
const column = (kind, nullable) => {
  const row = metadata(kind, nullable);
  return mapImportColumn(row.source, row.target);
};
const encode = (kind, value) => encodePostgresImportValue(column(kind), value);
const rejected = (suffix) => (error) => {
  assert.equal(error.code, "PG_MARIADB_IMPORT_REJECTED");
  assert.ok(error.message.endsWith(suffix), error.message);
  assert.ok(!error.message.includes("private-value"));
  return true;
};

test("all selected PG type families map explicitly and never rely on target defaults", () => {
  for (const kind of Object.keys(types)) assert.ok(column(kind).codec);
  const row = metadata("text");
  row.source.udt_name = "_text";
  row.source.data_type = "ARRAY";
  assert.throws(() => mapImportColumn(row.source, row.target), rejected("unsupported_source_type"));
  row.source = metadata("int8").source;
  assert.throws(() => mapImportColumn(row.source, row.target), rejected("integer_type"));
  row.source.data_type = "text";
  assert.throws(() => mapImportColumn(row.source, row.target), rejected("source_type"));
});

for (const [kind, minimum, maximum] of [
  ["int8", "-9223372036854775808", "9223372036854775807"],
  ["int4", "-2147483648", "2147483647"],
  ["int2", "-32768", "32767"],
])
  test(`${kind} retains signed endpoints as strings and rejects overflow`, () => {
    assert.equal(encode(kind, minimum), minimum);
    assert.equal(encode(kind, maximum), maximum);
    assert.throws(() => encode(kind, String(BigInt(minimum) - 1n)), rejected("integer_range"));
    assert.throws(() => encode(kind, String(BigInt(maximum) + 1n)), rejected("integer_range"));
  });

test("integers beyond JS precision remain exact and permissive numeric conversions are rejected", () => {
  assert.equal(encode("int8", "9007199254740993"), "9007199254740993");
  for (const value of ["01", "+1", "-0", "1.0", "1e3", " 1", "1 ", "private-value"])
    assert.throws(() => encode("int8", value), rejected("integer_format"));
  for (const value of [1, 1n, true, undefined, new Date("2026-01-01T00:00:00Z")])
    assert.throws(() => encode("int8", value), rejected("wire_type"));
});

test("boolean text has two exact representations and SQL NULL stays distinct", () => {
  assert.equal(encode("bool", "true"), 1);
  assert.equal(encode("bool", "false"), 0);
  for (const value of ["1", "0", "TRUE", "false ", "t"])
    assert.throws(() => encode("bool", value), rejected("boolean"));
  assert.equal(encodePostgresImportValue(column("bool", true), null), null);
  assert.throws(() => encode("bool", null), rejected("nullability"));
});

test("bytea hex preserves every MFA/key/hash byte and does not truncate malformed input", () => {
  const value = "00ff80010a0d00";
  assert.deepEqual(encode("bytea", value), Buffer.from([0, 255, 128, 1, 10, 13, 0]));
  assert.equal(encode("bytea", value).toString("hex"), value);
  assert.equal(encode("bytea", "").length, 0);
  for (const value of ["f", "aaZZ", "AA", "\\x00", "00 "])
    assert.throws(() => encode("bytea", value), rejected("hex"));
  assert.throws(() => encode("bytea", "00".repeat(33)), rejected("byte_length"));
});

test("UUID text is preserved independently of UUID version rather than regenerated", () => {
  for (const value of [
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "12345678-abcd-1234-5678-abcdef012345",
  ])
    assert.equal(encode("uuid", value), value);
  for (const value of [
    "12345678abcd12345678abcdef012345",
    "12345678-ABCD-1234-5678-abcdef012345",
    "private-value",
  ])
    assert.throws(() => encode("uuid", value), rejected("uuid"));
});

test("UTC timestamps preserve all six fraction digits without Date or timezone conversion", () => {
  for (const value of [
    "1000-01-01 00:00:00.000000",
    "2000-02-29 23:59:59.123456",
    "9999-12-31 23:59:59.999999",
  ])
    assert.equal(encode("timestamptz", value), value);
  for (const value of [
    "2026-01-01 00:00:00.123",
    "2026-01-01T00:00:00.123456Z",
    "2026-01-01 00:00:00.123456+09",
    "infinity",
    "-infinity",
    "0999-12-31 23:59:59.999999",
    "10000-01-01 00:00:00.000000",
    "2026-01-01 24:00:00.000000",
  ])
    assert.throws(() => encode("timestamptz", value), rejected("utc_datetime6"));
  assert.throws(() => encode("timestamptz", "1900-02-29 00:00:00.000001"), rejected("date_range"));
});

test("calendar and time0 boundaries remain strings; 24:00 is not silently changed", () => {
  assert.equal(encode("date", "2000-02-29"), "2000-02-29");
  for (const value of ["2026-02-29", "2026-04-31", "2026-00-01", "2026-12-00"])
    assert.throws(() => encode("date", value), rejected("date_range"));
  assert.throws(() => encode("date", "1500-01-01 BC"), rejected("date_format"));
  assert.equal(encode("time", "24:00:00"), "24:00:00");
  assert.equal(encode("time", "23:59:59"), "23:59:59");
  for (const value of ["24:00:01", "25:00:00", "00:00:00.000001", "-01:00:00"])
    assert.throws(() => encode("time", value), rejected("time0"));
});

test("inet projection retains mask until codec proves it is a single host", () => {
  assert.equal(encode("inet", "192.0.2.9/32"), "192.0.2.9");
  assert.equal(encode("inet", "2001:db8::1/128"), "2001:db8::1");
  for (const value of [
    "192.0.2.9/24",
    "192.0.2.9/128",
    "2001:db8::1/32",
    "192.0.2.9",
    "999.1.1.1/32",
  ])
    assert.throws(() => encode("inet", value), rejected("inet_host_mask"));
  assert.match(postgresImportProjection(column("inet")), /host\("value"\).*masklen\("value"\)/u);
});

test("email, password hash and signup role strings are never trimmed, cased or backfilled", () => {
  for (const value of [
    "  Email+Tag@Example.invalid  ",
    "$argon2id$v=19$m=65536,t=3,p=4$ABCdef$xyz",
    "student",
    "teacher",
    "",
    "\nline\tvalue\r",
  ])
    assert.equal(encode("text", value), value);
  const small = column("text");
  small.target.max_characters = 3;
  small.target.max_bytes = 12;
  assert.equal(encodePostgresImportValue(small, "😀😀😀"), "😀😀😀");
  assert.throws(() => encodePostgresImportValue(small, "😀😀😀😀"), rejected("character_length"));
  assert.throws(() => encode("text", "\ud800"), rejected("text"));
  assert.throws(() => encode("text", "a\0b"), rejected("nul"));
  const ascii = column("text");
  ascii.target.charset = "ascii";
  assert.throws(() => encodePostgresImportValue(ascii, "한글"), rejected("ascii"));
  const byteLimited = column("text");
  byteLimited.target.max_characters = null;
  byteLimited.target.max_bytes = 65535;
  assert.throws(
    () => encodePostgresImportValue(byteLimited, "😀".repeat(16384)),
    rejected("byte_length"),
  );
});

test("JSON numbers and whitespace are preserved raw, including beyond Number range", () => {
  const raw =
    ' { "integer": 9007199254740993, "decimal": 0.123456789012345678901234567890, "exponent": 1e1000, "negative": -0, "array": [true,null,"😀"] }\n';
  assert.equal(encode("jsonb", raw), raw);
  assert.equal(encode("jsonb", "null"), "null");
  assert.equal(encodePostgresImportValue(column("jsonb", true), null), null);
  assert.equal(assertLosslessJson('"\\uD83D\\uDE00"'), '"\\uD83D\\uDE00"');
});

for (const [index, raw] of [
  "",
  "01",
  "1e",
  "[1,]",
  '{"a":1,}',
  '{"a" 1}',
  "NaN",
  "Infinity",
  '"bad\ntext"',
  '"\\uD800"',
  '"\\uDE00"',
  '"\\x41"',
  "true false",
].entries())
  test(`malformed JSON ${index + 1} is rejected without value disclosure`, () => {
    assert.throws(() => encode("jsonb", raw), rejected("json"));
  });

test("source extraction is explicit UTC6 and rejects out-of-range/BC values through the codec", () => {
  const sql = postgresImportProjection(column("timestamptz"));
  assert.match(sql, /AT TIME ZONE 'UTC'/u);
  assert.match(sql, /HH24:MI:SS\.US/u);
  assert.match(sql, /TIMESTAMPTZ '1000-01-01/u);
  assert.match(sql, /TIMESTAMPTZ '10000-01-01/u);
  assert.match(sql, /ELSE "value"::text END/u);
  assert.match(postgresImportProjection(column("bytea")), /^encode\("value", 'hex'\)/u);
  assert.match(postgresImportProjection(column("jsonb")), /^to_jsonb\("value"\)::text/u);
});

test("missing/extra columns fail even if MariaDB can supply a default, generated-only additions are explicit", () => {
  const source = [{ column_name: "id" }],
    targets = [
      { column_name: "id", is_generated: "NEVER" },
      { column_name: "status", is_generated: "NEVER", default_sql: "'active'" },
    ];
  assert.throws(
    () => assertImportColumnCoverage(source, targets, "test"),
    rejected("missing_source_column"),
  );
  assert.throws(
    () =>
      assertImportColumnCoverage([...source, { column_name: "private-value" }], targets, "test"),
    rejected("unmapped_source_column"),
  );
  targets[1].is_generated = "ALWAYS";
  assert.doesNotThrow(() => assertImportColumnCoverage(source, targets, "test"));
  assert.throws(
    () => assertImportColumnCoverage([...source, ...source], targets, "test"),
    rejected("duplicate_source_column"),
  );
});

function sequenceFixture() {
  const id = column("int8");
  id.table = "example";
  id.name = "id";
  id.source.is_identity = "YES";
  id.target.auto_increment = true;
  const contract = buildPostgresSequenceContract(id);
  const discovery = {
    sequence_schema: "public",
    sequence_name: "actual_owned_sequence",
    data_type: "bigint",
    start_value: "1",
    increment_by: "1",
    minimum_value: "1",
    maximum_value: "9223372036854775807",
    cache_size: "1",
    cycle: "false",
    ownership_dependency: "i",
    identity_generation: "d",
  };
  return { id, contract, discovery };
}

test("identity sequence is discovered through exact owned-column catalog references without guessing its name", () => {
  const { contract, discovery } = sequenceFixture();
  assert.equal(contract.expected_serial_sequence, null);
  assert.match(contract.discovery_sql, /pg_get_serial_sequence\('"public"\."example"', 'id'\)/u);
  assert.match(contract.discovery_sql, /d\.refobjsubid = a\.attnum/u);
  assert.doesNotMatch(contract.discovery_sql, /\b(?:nextval|setval)\(/u);
  const resolved = resolvePostgresSequence(contract, [discovery]);
  assert.equal(
    resolved.state_sql,
    'SELECT last_value::text AS last_value, is_called::text AS is_called FROM "public"."actual_owned_sequence"',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(resolved)), resolved);
  assert.throws(() => resolvePostgresSequence(contract, []), rejected("discovery_count"));
  assert.throws(
    () => resolvePostgresSequence(contract, [discovery, discovery]),
    rejected("discovery_count"),
  );
});

test("serial defaults require the same owned sequence; non-auto columns cannot silently lose generation", () => {
  const { id, discovery } = sequenceFixture();
  id.source.is_identity = "NO";
  id.source.default_sql = "nextval('public.actual_owned_sequence'::regclass)";
  const serial = buildPostgresSequenceContract(id);
  const serialDiscovery = { ...discovery, ownership_dependency: "a", identity_generation: "" };
  assert.equal(
    resolvePostgresSequence(serial, [serialDiscovery]).sequence_name,
    "actual_owned_sequence",
  );
  assert.throws(
    () =>
      resolvePostgresSequence(serial, [{ ...serialDiscovery, sequence_name: "other_sequence" }]),
    rejected("serial_reference"),
  );
  id.source.default_sql = "nextval('other.actual_owned_sequence'::regclass)";
  assert.throws(() => buildPostgresSequenceContract(id), rejected("sequence_schema"));
  id.source.default_sql = "nextval('quoted sequence'::regclass)";
  assert.throws(() => buildPostgresSequenceContract(id), rejected("unsupported_serial_reference"));
  id.source.default_sql = null;
  assert.throws(() => buildPostgresSequenceContract(id), rejected("source_target_generation"));
  id.source.is_identity = "YES";
  id.target.auto_increment = false;
  assert.throws(() => buildPostgresSequenceContract(id), rejected("source_target_generation"));
  assert.equal(buildPostgresSequenceContract(column("text")), null);
});

test("sequence gaps and cached high water marks are preserved instead of reusing MAX(id)+1", () => {
  const { contract, discovery } = sequenceFixture();
  const sequence = resolvePostgresSequence(contract, [{ ...discovery, cache_size: "32" }]);
  const next = deriveMariaDbAutoIncrement(
    sequence,
    [{ last_value: "2048", is_called: "true" }],
    "3",
  );
  assert.equal(next.next_value, "2049");
  assert.equal(next.target_alter_sql, "ALTER TABLE `example` AUTO_INCREMENT = 2049");
  assert.equal(next.source_last_value, "2048");
  assert.match(next.application_boundary, /after_import_commit/u);
  assert.equal(
    deriveMariaDbAutoIncrement(
      sequence,
      [{ last_value: "9007199254740993", is_called: "true" }],
      "9007199254740992",
    ).next_value,
    "9007199254740994",
  );
});

test("uncalled sequence state is preserved for empty or previously reserved ranges", () => {
  const { contract, discovery } = sequenceFixture();
  const sequence = resolvePostgresSequence(contract, [discovery]);
  assert.equal(
    deriveMariaDbAutoIncrement(sequence, [{ last_value: "1", is_called: "false" }], null)
      .next_value,
    "1",
  );
  assert.equal(
    deriveMariaDbAutoIncrement(sequence, [{ last_value: "100", is_called: "false" }], "99")
      .next_value,
    "100",
  );
  assert.equal(
    deriveMariaDbAutoIncrement(sequence, [{ last_value: "1", is_called: "false" }], "-1")
      .next_value,
    "1",
  );
});

test("source sequence collisions and exhausted bigint range stop without generating an ALTER", () => {
  const { contract, discovery } = sequenceFixture();
  const sequence = resolvePostgresSequence(contract, [discovery]);
  assert.throws(
    () => deriveMariaDbAutoIncrement(sequence, [{ last_value: "100", is_called: "false" }], "100"),
    rejected("source_next_conflicts_with_imported_ids"),
  );
  assert.throws(
    () => deriveMariaDbAutoIncrement(sequence, [{ last_value: "2", is_called: "true" }], "100"),
    rejected("source_next_conflicts_with_imported_ids"),
  );
  assert.throws(
    () =>
      deriveMariaDbAutoIncrement(
        sequence,
        [{ last_value: "9223372036854775807", is_called: "true" }],
        null,
      ),
    rejected("exhausted"),
  );
  assert.throws(
    () =>
      deriveMariaDbAutoIncrement(
        sequence,
        [{ last_value: "9223372036854775808", is_called: "false" }],
        null,
      ),
    rejected("last_value"),
  );
});

test("non-unit, descending, cycling, differently bounded or unowned sequences fail closed", () => {
  const { contract, discovery } = sequenceFixture();
  for (const [field, value] of [
    ["increment_by", "2"],
    ["increment_by", "-1"],
    ["cycle", "true"],
    ["minimum_value", "0"],
    ["maximum_value", "2147483647"],
    ["ownership_dependency", "a"],
    ["identity_generation", ""],
    ["sequence_schema", "other"],
    ["data_type", "integer"],
    ["cache_size", "0"],
    ["start_value", "0"],
  ])
    assert.throws(
      () => resolvePostgresSequence(contract, [{ ...discovery, [field]: value }]),
      rejected(field),
    );
  assert.throws(
    () =>
      resolvePostgresSequence(contract, [
        { ...discovery, sequence_name: "private-value; SELECT 1" },
      ]),
    rejected("sequence_name"),
  );
});

test("sequence state rejects numbers, missing cardinality and unsafe mutation without leaking values", () => {
  const { contract, discovery } = sequenceFixture();
  const sequence = resolvePostgresSequence(contract, [discovery]);
  assert.throws(() => deriveMariaDbAutoIncrement(sequence, [], null), rejected("state_count"));
  assert.throws(
    () =>
      deriveMariaDbAutoIncrement(
        sequence,
        [{ last_value: Number("9007199254740993"), is_called: "true" }],
        null,
      ),
    rejected("last_value"),
  );
  assert.throws(
    () => deriveMariaDbAutoIncrement(sequence, [{ last_value: "1", is_called: false }], null),
    rejected("is_called"),
  );
  assert.throws(
    () =>
      deriveMariaDbAutoIncrement(sequence, [{ last_value: "1", is_called: "false" }], undefined),
    rejected("maximum_imported_id"),
  );
  assert.throws(
    () => resolvePostgresSequence({ ...contract, table: "different" }, [discovery]),
    rejected("contract_checksum"),
  );
  assert.throws(
    () =>
      deriveMariaDbAutoIncrement(
        { ...sequence, target_integer_maximum: "99999" },
        [{ last_value: "1", is_called: "true" }],
        null,
      ),
    rejected("definition_checksum"),
  );
});

if (argv[2] && argv[3]) {
  const sourceSchema = JSON.parse(readFileSync(argv[2], "utf8"));
  const targetMetadata = JSON.parse(readFileSync(argv[3], "utf8"));
  test("actual schema plan maps54 tables/554 source/552 explicit inputs/13 generated without source values", () => {
    const plan = buildPostgresMariaDbImportPlan({ sourceSchema, targetMetadata });
    assert.deepEqual(
      [
        plan.table_count,
        plan.source_column_count,
        plan.insert_column_count,
        plan.generated_column_count,
      ],
      [54, 554, 552, 13],
    );
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
    assert.equal(plan.preserve_in_source_backup.length, 12);
    assert.equal(plan.seed_catalog.expected_labels.length, 56);
    assert.equal(plan.sequence_contracts.length, 38);
    assert.ok(
      plan.sequence_contracts.every((contract) => contract.source_generation === "identity"),
    );
    assert.deepEqual(plan.target_session_requirements.additional_import_sql_modes, [
      "NO_AUTO_VALUE_ON_ZERO",
    ]);
    assert.equal(
      plan.tables.find((table) => table.table === "audit_log_actions").target_insert_sql,
      null,
    );
    assert.equal(plan.tables.flatMap((table) => table.generated_compare_columns).length, 2);
    for (const table of plan.tables)
      for (const generated of table.target_generated_columns)
        assert.ok(!table.insert_columns.includes(generated));
    const audit = plan.tables.find((table) => table.table === "audit_log_actions");
    assert.deepEqual(encodePostgresImportRow(audit, { action: "class.created" }).values, [
      "class.created",
    ]);
    assert.throws(() => encodePostgresImportRow(audit, {}), rejected("column_set"));
    assert.throws(
      () => encodePostgresImportRow(audit, { action: "class.created", unknown: "private-value" }),
      rejected("column_set"),
    );
    const altered = copy(audit);
    altered.row_policy = "insert_exact_values";
    assert.throws(
      () => encodePostgresImportRow(altered, { action: "class.created" }),
      rejected("table_plan_checksum"),
    );
  });
  for (const [label, mutate, suffix] of [
    [
      "new source column",
      (source) =>
        source.columns.push({
          ...source.columns.find((column) => column.table_name === "users"),
          column_name: "private_value",
        }),
      "unmapped_source_column",
    ],
    [
      "missing source column",
      (source) => {
        source.columns = source.columns.filter(
          (column) => !(column.table_name === "users" && column.column_name === "signup_role"),
        );
      },
      "missing_source_column",
    ],
    [
      "target type drift",
      (_source, target) => {
        target.metadata.columns.find(
          (column) => column.table_name === "users" && column.column_name === "id",
        ).column_type = "int(11)";
      },
      "column_type",
    ],
    [
      "target default drift",
      (_source, target) => {
        target.metadata.columns.find(
          (column) => column.table_name === "users" && column.column_name === "signup_role",
        ).default_sql = "'student'";
      },
      "default",
    ],
    [
      "target FK removal",
      (_source, target) => {
        target.metadata.foreign_keys = target.metadata.foreign_keys.filter(
          (fk) => fk.table_name !== "class_members",
        );
      },
      "foreign_keys",
    ],
    [
      "target FK action drift",
      (_source, target) => {
        target.metadata.foreign_keys.find((fk) => fk.table_name === "class_members").delete_rule =
          "CASCADE";
      },
      "foreign_keys",
    ],
  ])
    test(`actual mapping rejects ${label}`, () => {
      const source = copy(sourceSchema),
        target = copy(targetMetadata);
      mutate(source, target);
      assert.throws(
        () => buildPostgresMariaDbImportPlan({ sourceSchema: source, targetMetadata: target }),
        rejected(suffix),
      );
    });
}
