import { describe, expect, it } from "vitest";

import {
  decodeSupplyChecksCursor,
  decodeSupplyListCursor,
  encodeSupplyChecksCursor,
  encodeSupplyListCursor,
} from "./supplies.cursor.js";
import { InvalidCursorException } from "./supplies.errors.js";

function rawCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("supply cursors", () => {
  it.each(["upcoming", "today", "this_week", "past"] as const)(
    "binds personal state, category and search to every %s cursor",
    (scope) => {
      const dateRange =
        scope === "today" || scope === "this_week"
          ? { start_date: "2026-09-21", end_date: "2026-09-21" }
          : undefined;
      for (const checkState of ["unchecked", "modified_unconfirmed", "checked"] as const) {
        const value = {
          id: "25",
          neededOn: "2026-09-21",
          scope,
          category: "homework" as const,
          search: "수학",
          checkState,
          ...(dateRange === undefined ? {} : { dateRange }),
        };
        const encoded = encodeSupplyListCursor(value);
        expect(
          decodeSupplyListCursor(encoded, scope, "수학", dateRange, "homework", checkState),
        ).toEqual(value);
        for (const state of [undefined, "unchecked", "modified_unconfirmed", "checked"] as const) {
          if (state === checkState) continue;
          expect(() =>
            decodeSupplyListCursor(encoded, scope, "수학", dateRange, "homework", state),
          ).toThrow(InvalidCursorException);
        }
        expect(() =>
          decodeSupplyListCursor(encoded, scope, "영어", dateRange, "homework", checkState),
        ).toThrow(InvalidCursorException);
        expect(() =>
          decodeSupplyListCursor(encoded, scope, "수학", dateRange, "general", checkState),
        ).toThrow(InvalidCursorException);
        if (dateRange !== undefined) {
          expect(() =>
            decodeSupplyListCursor(
              encoded,
              scope,
              "수학",
              { ...dateRange, end_date: "2026-09-22" },
              "homework",
              checkState,
            ),
          ).toThrow(InvalidCursorException);
        }
        const legacy = encodeSupplyListCursor({
          id: "25",
          neededOn: "2026-09-21",
          scope,
          ...(dateRange === undefined ? {} : { dateRange }),
        });
        expect(() =>
          decodeSupplyListCursor(legacy, scope, undefined, dateRange, undefined, checkState),
        ).toThrow(InvalidCursorException);
        const minimal = {
          id: "25",
          neededOn: "2026-09-21",
          scope,
          checkState,
          ...(dateRange === undefined ? {} : { dateRange }),
        };
        expect(
          decodeSupplyListCursor(
            encodeSupplyListCursor(minimal),
            scope,
            undefined,
            dateRange,
            undefined,
            checkState,
          ),
        ).toEqual(minimal);
      }
    },
  );

  it.each(["today", "this_week"] as const)(
    "binds %s to its range, category and search",
    (scope) => {
      const dateRange = {
        start_date: "2026-09-21",
        end_date: scope === "today" ? "2026-09-21" : "2026-09-27",
      };
      for (const filters of [{}, { category: "homework" as const, search: "수학" }]) {
        const value = { id: "25", neededOn: "2026-09-21", scope, dateRange, ...filters };
        const encoded = encodeSupplyListCursor(value);
        expect(
          decodeSupplyListCursor(encoded, scope, filters.search, dateRange, filters.category),
        ).toEqual(value);
        for (const range of [
          undefined,
          { ...dateRange, start_date: "2026-09-22" },
          { ...dateRange, end_date: "2026-09-28" },
        ]) {
          expect(() =>
            decodeSupplyListCursor(encoded, scope, filters.search, range, filters.category),
          ).toThrow(InvalidCursorException);
        }
        expect(() =>
          decodeSupplyListCursor(encoded, scope, "영어", dateRange, filters.category),
        ).toThrow(InvalidCursorException);
        expect(() =>
          decodeSupplyListCursor(encoded, scope, filters.search, dateRange, "general"),
        ).toThrow(InvalidCursorException);
        expect(() => decodeSupplyListCursor(encoded, "upcoming", filters.search)).toThrow(
          InvalidCursorException,
        );
      }
      expect(() => encodeSupplyListCursor({ id: "1", neededOn: "2026-09-21", scope })).toThrow(
        InvalidCursorException,
      );
      for (const v of [1, 2]) {
        const old = rawCursor({
          id: "1",
          kind: "supplies",
          needed_on: "2026-09-21",
          scope,
          v,
          ...(v === 2 ? { search: "수학" } : {}),
        });
        expect(() =>
          decodeSupplyListCursor(old, scope, v === 2 ? "수학" : undefined, dateRange),
        ).toThrow(InvalidCursorException);
      }
    },
  );

  it("preserves legacy searched cursors and rejects a changed search", () => {
    const value = { id: "25", neededOn: "2026-09-21", scope: "past" as const, search: "수학" };
    const cursor = encodeSupplyListCursor(value);
    expect(decodeSupplyListCursor(cursor, "past", "수학")).toEqual(value);
    expect(() => decodeSupplyListCursor(cursor, "past", "영어")).toThrow(InvalidCursorException);
  });

  it("round-trips supply list cursors and binds them to the requested scope", () => {
    const encoded = encodeSupplyListCursor({
      id: "9223372036854775807",
      neededOn: "2026-07-15",
      scope: "upcoming",
    });
    expect(decodeSupplyListCursor(encoded, "upcoming")).toEqual({
      id: "9223372036854775807",
      neededOn: "2026-07-15",
      scope: "upcoming",
    });
    expect(() => decodeSupplyListCursor(encoded, "past")).toThrow(InvalidCursorException);
  });

  it("rejects malformed, non-canonical, extra-key, and invalid list cursors", () => {
    const base = {
      id: "1",
      kind: "supplies",
      needed_on: "2026-07-15",
      scope: "upcoming",
      v: 1,
    };
    const invalid = [
      "%%%",
      `${rawCursor(base)}=`,
      rawCursor({ ...base, extra: true }),
      rawCursor({ ...base, id: "9223372036854775808" }),
      rawCursor({ ...base, needed_on: "2026-02-30" }),
      rawCursor({ ...base, v: 2 }),
    ];
    for (const cursor of invalid) {
      expect(() => decodeSupplyListCursor(cursor, "upcoming")).toThrow(InvalidCursorException);
    }
  });

  it("round-trips check cursors and binds them to supply and filter", () => {
    const encoded = encodeSupplyChecksCursor({
      displayName: "김학생",
      memberId: "10",
      state: "modified_unconfirmed",
      studentNumber: null,
      supplyId: "20",
    });
    expect(decodeSupplyChecksCursor(encoded, "20", "modified_unconfirmed")).toEqual({
      displayName: "김학생",
      memberId: "10",
      state: "modified_unconfirmed",
      studentNumber: null,
      supplyId: "20",
    });
    expect(() => decodeSupplyChecksCursor(encoded, "21", "modified_unconfirmed")).toThrow(
      InvalidCursorException,
    );
    expect(() => decodeSupplyChecksCursor(encoded, "20", "checked")).toThrow(
      InvalidCursorException,
    );
  });

  it("rejects invalid check cursor keys and sort values", () => {
    const base = {
      display_name: "김학생",
      kind: "supply_checks",
      member_id: "10",
      state: "unchecked",
      student_number: 1,
      supply_id: "20",
      v: 1,
    };
    for (const value of [
      { ...base, extra: true },
      { ...base, display_name: "" },
      { ...base, display_name: "한" },
      { ...base, display_name: "가".repeat(21) },
      { ...base, display_name: "앞\u0000뒤" },
      { ...base, display_name: "앞\u2028뒤" },
      { ...base, member_id: "0" },
      { ...base, student_number: 0 },
      { ...base, student_number: 100 },
      { ...base, supply_id: "9223372036854775808" },
    ]) {
      expect(() => decodeSupplyChecksCursor(rawCursor(value), "20", "unchecked")).toThrow(
        InvalidCursorException,
      );
    }
  });
});
