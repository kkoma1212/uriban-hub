import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { requiredMariaDbRuntimeGrants } from "@classhub/db";
import { describe, expect, it } from "vitest";
import { operatorLockNames } from "./operator-lock.js";
import { operatorTimestamp, parseOperatorJson } from "./operator-query.js";

describe("operator MariaDB conversion boundaries", () => {
  it("interprets MariaDB expiry timestamps as UTC, including fractional seconds", () => {
    expect(operatorTimestamp("2026-09-09 23:59:59.123456").toISOString()).toBe(
      "2026-09-09T23:59:59.123Z",
    );
    const original = new Date("2026-09-09T00:00:00Z");
    expect(operatorTimestamp(original)).toBe(original);
    expect(() => operatorTimestamp("2026-09-09T00:00:00+09:00")).toThrow();
  });
  it("reads menu JSON in both engines and rejects broken stored JSON", () => {
    const value = [{ name: "밥", allergens: ["1"] }];
    expect(parseOperatorJson(value)).toBe(value);
    expect(parseOperatorJson(JSON.stringify(value))).toEqual(value);
    expect(() => parseOperatorJson("{broken")).toThrow();
  });
  it("installs exactly the runtime lock identities and grants only two extra operator privileges", () => {
    const sql = readFileSync(
      new URL("../../../db/mariadb/migrations/0044_operator_commands.sql", import.meta.url),
      "utf8",
    );
    const actual = [...sql.matchAll(/0x([0-9a-f]{64})/gu)].map((match) => match[1]).sort();
    const expected = operatorLockNames
      .map((name) =>
        createHash("sha256")
          .update("classhub:mariadb:operator-lock:v1\0" + name)
          .digest("hex"),
      )
      .sort();
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(7);
    const baseline = requiredMariaDbRuntimeGrants("operator", undefined)!;
    const extended = requiredMariaDbRuntimeGrants("operator", "operator_commands_v1")!;
    expect(extended.filter((entry) => !baseline.includes(entry))).toEqual([
      "table|operator_transaction_lock_keys|SELECT|*",
      "table|public_holidays|DELETE|*",
    ]);
    expect(requiredMariaDbRuntimeGrants("app", "operator_commands_v1")).toBeUndefined();
  });
});
