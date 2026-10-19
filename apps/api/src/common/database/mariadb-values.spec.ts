import { DummyDriver, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbCount,
  mariaDbDateBinding,
  mariaDbDateOnly,
  mariaDbDateTime,
  mariaDbId,
  mariaDbInsertId,
  mariaDbNullable,
  mariaDbTimestamp,
} from "./mariadb-values.js";

describe("MariaDB application value boundaries", () => {
  it("preserves signed BIGINT identifiers without a Number conversion", () => {
    expect(mariaDbId("9007199254740993")).toBe("9007199254740993");
    expect(mariaDbId("9223372036854775807")).toBe("9223372036854775807");
    expect(mariaDbInsertId(9007199254740993n)).toBe("9007199254740993");
    for (const value of [0, 1, 1n, "0", "01", "-1", "1.0", "9223372036854775808"])
      expect(() => mariaDbId(value)).toThrow("Invalid MariaDB application value.");
    for (const value of [0n, -1n, 9223372036854775808n, 1, "1"])
      expect(() => mariaDbInsertId(value)).toThrow();
  });

  it("accepts only boolean storage values and counts safe to expose as JSON numbers", () => {
    for (const value of [1, true]) expect(mariaDbBoolean(value)).toBe(true);
    for (const value of [0, false]) expect(mariaDbBoolean(value)).toBe(false);
    for (const value of ["0", "1", 2, null, undefined])
      expect(() => mariaDbBoolean(value)).toThrow();
    for (const value of [0, "0", 42, "42", "9007199254740991"])
      expect(mariaDbCount(value)).toBe(Number(value));
    for (const value of [null, true, "", "01", "1e2", -1, 0.5, NaN, Infinity, "9007199254740992"])
      expect(() => mariaDbCount(value)).toThrow();
  });

  it("keeps DATE calendar strings and validates actual calendar days", () => {
    expect(mariaDbDateOnly("2028-02-29")).toBe("2028-02-29");
    expect(mariaDbDateOnly("2026-09-07")).toBe("2026-09-07");
    for (const value of [
      "2026-02-29",
      "2026-09-31",
      "2026-13-01",
      "0000-01-01",
      "2026-9-7",
      new Date(),
    ])
      expect(() => mariaDbDateOnly(value)).toThrow();
  });

  it("uses UTC and separates public milliseconds from exact database microseconds", () => {
    const native = "2026-09-07 23:59:59.123456";
    const publicDate = mariaDbDateTime(native);
    expect(publicDate.toISOString()).toBe("2026-09-07T23:59:59.123Z");
    expect(mariaDbTimestamp(native)).toBe(native);
    expect(mariaDbTimestamp(publicDate)).toBe("2026-09-07 23:59:59.123000");
    expect(mariaDbDateTime(publicDate)).not.toBe(publicDate);
    expect(mariaDbDateTime(publicDate)).toEqual(publicDate);
    for (const value of [
      "2026-02-29 00:00:00.000000",
      "2026-09-07 24:00:00.000000",
      "2026-09-07 23:59:60.000000",
      "2026-09-07 23:59:59.123",
      "2026-09-07T23:59:59.123456Z",
      new Date(NaN),
    ])
      expect(() => mariaDbDateTime(value)).toThrow();
  });

  it("binds a validated DB6 string as a parameter instead of sending a driver Date", () => {
    const database = new Kysely<object>({
      dialect: {
        createAdapter: () => new MysqlAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new MysqlIntrospector(db),
        createQueryCompiler: () => new MysqlQueryCompiler(),
      },
    });
    expect(mariaDbDateBinding("2026-09-07 09:01:02.000123").compile(database)).toMatchObject({
      sql: "?",
      parameters: ["2026-09-07 09:01:02.000123"],
    });
  });

  it("decodes only explicit fields, keeps result metadata and does not mutate rows or its mapping", async () => {
    const fields = { is_active: mariaDbBoolean, deleted_at: mariaDbNullable(mariaDbDateTime) };
    const codec = createMariaDbRowCodec(fields);
    fields.is_active = () => false;
    const row = { is_active: 1, deleted_at: null, unexpired: 1, response_body_json: '{"ok":true}' };
    const result = await codec.transformResult({
      queryId: {} as never,
      result: { rows: [row], insertId: 17n, numAffectedRows: 2n },
    });
    expect(result).toEqual({
      rows: [{ ...row, is_active: true }],
      insertId: 17n,
      numAffectedRows: 2n,
    });
    expect(row.is_active).toBe(1);
    expect(result.rows[0]).not.toBe(row);
    expect(mariaDbNullable(mariaDbId)(null)).toBeNull();
    expect(() => mariaDbNullable(mariaDbId)(undefined)).toThrow();
  });
});
