import { InvalidScheduleCursorException } from "./schedules.errors.js";
import type { ScheduleDateRange, ScheduleListScope, ScheduleType } from "./schedules.types.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_CURSOR_LENGTH = 2048;
const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ScheduleListCursor {
  dueDate: string;
  id: string;
  scope: ScheduleListScope;
  scheduleType?: ScheduleType;
  search?: string;
  dateRange?: ScheduleDateRange;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPositiveBigint(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_DATABASE_ID;
  } catch {
    return false;
  }
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value: string): Record<string, unknown> {
  try {
    if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !BASE64URL_PATTERN.test(value)) {
      throw new Error("invalid cursor alphabet");
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("non-canonical cursor");
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (!isRecord(parsed)) throw new Error("cursor is not an object");
    return parsed;
  } catch {
    throw new InvalidScheduleCursorException();
  }
}

export function encodeScheduleListCursor(cursor: ScheduleListCursor): string {
  const base = {
    due_date: cursor.dueDate,
    id: cursor.id,
    kind: "schedules",
    scope: cursor.scope,
  };
  if (cursor.scope === "today" || cursor.scope === "this_week") {
    if (cursor.dateRange === undefined) throw new InvalidScheduleCursorException();
    return encode({
      ...base,
      v: 3,
      schedule_type: cursor.scheduleType ?? null,
      search: cursor.search ?? null,
      start_date: cursor.dateRange.start_date,
      end_date: cursor.dateRange.end_date,
    });
  }
  return cursor.scheduleType === undefined && cursor.search === undefined
    ? encode({ ...base, v: 1 })
    : encode({
        ...base,
        v: 2,
        schedule_type: cursor.scheduleType ?? null,
        search: cursor.search ?? null,
      });
}

export function decodeScheduleListCursor(
  value: string,
  scope: ScheduleListScope,
  scheduleType?: ScheduleType,
  search?: string,
  dateRange?: ScheduleDateRange,
): ScheduleListCursor {
  const parsed = decode(value);
  const relative = scope === "today" || scope === "this_week";
  const filtered = scheduleType !== undefined || search !== undefined;
  if (
    !hasExactKeys(
      parsed,
      relative
        ? [
            "due_date",
            "id",
            "kind",
            "scope",
            "v",
            "schedule_type",
            "search",
            "start_date",
            "end_date",
          ]
        : filtered
          ? ["due_date", "id", "kind", "scope", "v", "schedule_type", "search"]
          : ["due_date", "id", "kind", "scope", "v"],
    ) ||
    parsed.kind !== "schedules" ||
    parsed.v !== (relative ? 3 : filtered ? 2 : 1) ||
    (relative &&
      (dateRange === undefined ||
        parsed.start_date !== dateRange.start_date ||
        parsed.end_date !== dateRange.end_date)) ||
    ((filtered || relative) &&
      (parsed.schedule_type !== (scheduleType ?? null) || parsed.search !== (search ?? null))) ||
    parsed.scope !== scope ||
    !isPositiveBigint(parsed.id) ||
    !isCalendarDate(parsed.due_date)
  ) {
    throw new InvalidScheduleCursorException();
  }
  return {
    dueDate: parsed.due_date,
    id: parsed.id,
    scope,
    ...(scheduleType === undefined ? {} : { scheduleType }),
    ...(search === undefined ? {} : { search }),
    ...(relative && dateRange !== undefined ? { dateRange } : {}),
  };
}
