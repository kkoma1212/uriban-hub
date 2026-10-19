import { describe, expect, it } from "vitest";

import { decodeScheduleListCursor, encodeScheduleListCursor } from "./schedules.cursor.js";
import { InvalidScheduleCursorException } from "./schedules.errors.js";

function rawCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("schedule cursors", () => {
  it.each(["today", "this_week"] as const)(
    "binds %s to its exact date range and lookup conditions",
    (scope) => {
      const dateRange = {
        start_date: "2026-09-21",
        end_date: scope === "today" ? "2026-09-21" : "2026-09-27",
      };
      for (const filters of [{}, { scheduleType: "assignment" as const, search: "수학" }]) {
        const value = { dueDate: "2026-09-21", id: "25", scope, dateRange, ...filters };
        const encoded = encodeScheduleListCursor(value);
        expect(
          decodeScheduleListCursor(encoded, scope, filters.scheduleType, filters.search, dateRange),
        ).toEqual(value);
        for (const range of [
          undefined,
          { ...dateRange, start_date: "2026-09-22" },
          { ...dateRange, end_date: "2026-09-28" },
        ]) {
          expect(() =>
            decodeScheduleListCursor(encoded, scope, filters.scheduleType, filters.search, range),
          ).toThrow(InvalidScheduleCursorException);
        }
        expect(() =>
          decodeScheduleListCursor(encoded, scope, "exam", filters.search, dateRange),
        ).toThrow(InvalidScheduleCursorException);
        expect(() =>
          decodeScheduleListCursor(encoded, scope, filters.scheduleType, "영어", dateRange),
        ).toThrow(InvalidScheduleCursorException);
        expect(() =>
          decodeScheduleListCursor(encoded, "upcoming", filters.scheduleType, filters.search),
        ).toThrow(InvalidScheduleCursorException);
      }
      expect(() => encodeScheduleListCursor({ dueDate: "2026-09-21", id: "1", scope })).toThrow(
        InvalidScheduleCursorException,
      );
      for (const v of [1, 2]) {
        const legacy = rawCursor({
          due_date: "2026-09-21",
          id: "1",
          kind: "schedules",
          scope,
          v,
          ...(v === 2 ? { schedule_type: null, search: null } : {}),
        });
        expect(() =>
          decodeScheduleListCursor(legacy, scope, undefined, undefined, dateRange),
        ).toThrow(InvalidScheduleCursorException);
      }
    },
  );

  it.each([
    { scheduleType: "performance" as const },
    { search: "수학 %_!" },
    { scheduleType: "assignment" as const, search: "수학" },
  ])("binds the cursor to both lookup conditions: %j", (filters) => {
    const value = { dueDate: "2026-09-23", id: "25", scope: "upcoming" as const, ...filters };
    const encoded = encodeScheduleListCursor(value);
    const scheduleType = "scheduleType" in filters ? filters.scheduleType : undefined;
    const search = "search" in filters ? filters.search : undefined;
    expect(decodeScheduleListCursor(encoded, "upcoming", scheduleType, search)).toEqual(value);
    for (const [type, term] of [
      ["exam", search],
      [scheduleType, "영어"],
      [undefined, undefined],
    ] as const) {
      expect(() => decodeScheduleListCursor(encoded, "upcoming", type, term)).toThrow(
        InvalidScheduleCursorException,
      );
    }
    const oldCursor = encodeScheduleListCursor({
      dueDate: value.dueDate,
      id: value.id,
      scope: value.scope,
    });
    expect(() => decodeScheduleListCursor(oldCursor, "upcoming", scheduleType, search)).toThrow(
      InvalidScheduleCursorException,
    );
  });

  it("round-trips list cursors and binds them to scope", () => {
    const encoded = encodeScheduleListCursor({
      dueDate: "2026-07-15",
      id: "9223372036854775807",
      scope: "upcoming",
    });
    expect(decodeScheduleListCursor(encoded, "upcoming")).toEqual({
      dueDate: "2026-07-15",
      id: "9223372036854775807",
      scope: "upcoming",
    });
    expect(() => decodeScheduleListCursor(encoded, "past")).toThrow(InvalidScheduleCursorException);
  });

  it("rejects malformed, non-canonical, extra-key, and invalid sort values", () => {
    const base = {
      due_date: "2026-07-15",
      id: "1",
      kind: "schedules",
      scope: "upcoming",
      v: 1,
    };
    for (const cursor of [
      "%%%",
      `${rawCursor(base)}=`,
      rawCursor({ ...base, extra: true }),
      rawCursor({ ...base, due_date: "2026-02-30" }),
      rawCursor({ ...base, id: "9223372036854775808" }),
      rawCursor({ ...base, kind: "supplies" }),
      rawCursor({ ...base, v: 2 }),
    ]) {
      expect(() => decodeScheduleListCursor(cursor, "upcoming")).toThrow(
        InvalidScheduleCursorException,
      );
    }
  });
});
