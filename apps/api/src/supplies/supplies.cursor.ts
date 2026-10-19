import { countCodePoints, isAllowedPlainText } from "../common/validation/text-validation.js";
import { InvalidCursorException } from "./supplies.errors.js";
import type {
  SupplyCategory,
  SupplyCheckFilter,
  SupplyDateRange,
  SupplyListScope,
} from "./supplies.types.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_CURSOR_LENGTH = 2048;
const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface SupplyListCursor {
  id: string;
  neededOn: string;
  scope: SupplyListScope;
  /** 검색 중일 때만 담긴다. 커서와 검색어가 어긋나면 서버가 거절한다. */
  search?: string;
  dateRange?: SupplyDateRange;
  category?: SupplyCategory;
  checkState?: SupplyCheckFilter;
}

export interface SupplyChecksCursor {
  displayName: string;
  memberId: string;
  state: SupplyCheckFilter;
  studentNumber: number | null;
  supplyId: string;
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

function isDisplayName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = countCodePoints(value);
  return length >= 2 && length <= 20 && isAllowedPlainText(value);
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
    throw new InvalidCursorException();
  }
}

export function encodeSupplyListCursor(cursor: SupplyListCursor): string {
  const base = {
    id: cursor.id,
    kind: "supplies",
    needed_on: cursor.neededOn,
    scope: cursor.scope,
  };
  if (cursor.checkState !== undefined) {
    if (
      (cursor.scope === "today" || cursor.scope === "this_week") &&
      cursor.dateRange === undefined
    )
      throw new InvalidCursorException();
    return encode({
      ...base,
      v: 4,
      check_state: cursor.checkState,
      search: cursor.search ?? null,
      category: cursor.category ?? null,
      start_date: cursor.dateRange?.start_date ?? null,
      end_date: cursor.dateRange?.end_date ?? null,
    });
  }
  if (cursor.scope === "today" || cursor.scope === "this_week") {
    if (cursor.dateRange === undefined) throw new InvalidCursorException();
    return encode({
      ...base,
      v: 3,
      search: cursor.search ?? null,
      category: cursor.category ?? null,
      start_date: cursor.dateRange.start_date,
      end_date: cursor.dateRange.end_date,
    });
  }
  return cursor.search === undefined
    ? encode({ ...base, v: 1 })
    : encode({ ...base, search: cursor.search, v: 2 });
}

export function decodeSupplyListCursor(
  value: string,
  scope: SupplyListScope,
  search?: string,
  dateRange?: SupplyDateRange,
  category?: SupplyCategory,
  checkState?: SupplyCheckFilter,
): SupplyListCursor {
  const parsed = decode(value);
  const relative = scope === "today" || scope === "this_week";
  /*
   * 검색어도 커서에 묶는다 — 다른 검색어로 다음 쪽을 넘기면 조건이 다른 쪽이 이어
   * 붙는다. 기존 upcoming/past의 미검색 v1·검색 v2는 유지하고 새 기간은 v3에 묶는다.
   */
  const filtered = checkState !== undefined;
  const expectedKeys = filtered
    ? [
        "id",
        "kind",
        "needed_on",
        "scope",
        "v",
        "search",
        "category",
        "start_date",
        "end_date",
        "check_state",
      ]
    : relative
      ? ["id", "kind", "needed_on", "scope", "v", "search", "category", "start_date", "end_date"]
      : search === undefined
        ? ["id", "kind", "needed_on", "scope", "v"]
        : ["id", "kind", "needed_on", "scope", "search", "v"];
  if (
    !hasExactKeys(parsed, expectedKeys) ||
    parsed.kind !== "supplies" ||
    parsed.v !== (filtered ? 4 : relative ? 3 : search === undefined ? 1 : 2) ||
    parsed.search !== (relative || filtered ? (search ?? null) : search) ||
    (filtered &&
      (parsed.check_state !== checkState ||
        parsed.category !== (category ?? null) ||
        parsed.start_date !== (dateRange?.start_date ?? null) ||
        parsed.end_date !== (dateRange?.end_date ?? null))) ||
    (relative &&
      (dateRange === undefined ||
        parsed.start_date !== dateRange.start_date ||
        parsed.end_date !== dateRange.end_date ||
        parsed.category !== (category ?? null))) ||
    parsed.scope !== scope ||
    !isPositiveBigint(parsed.id) ||
    !isCalendarDate(parsed.needed_on)
  ) {
    throw new InvalidCursorException();
  }
  return {
    id: parsed.id,
    neededOn: parsed.needed_on,
    scope,
    ...(search === undefined ? {} : { search }),
    ...(relative && dateRange !== undefined ? { dateRange } : {}),
    ...((relative || filtered) && category !== undefined ? { category } : {}),
    ...(checkState === undefined ? {} : { checkState }),
  };
}

export function encodeSupplyChecksCursor(cursor: SupplyChecksCursor): string {
  return encode({
    display_name: cursor.displayName,
    kind: "supply_checks",
    member_id: cursor.memberId,
    state: cursor.state,
    student_number: cursor.studentNumber,
    supply_id: cursor.supplyId,
    v: 1,
  });
}

export function decodeSupplyChecksCursor(
  value: string,
  supplyId: string,
  state: SupplyCheckFilter,
): SupplyChecksCursor {
  const parsed = decode(value);
  const validStudentNumber =
    parsed.student_number === null ||
    (Number.isInteger(parsed.student_number) &&
      (parsed.student_number as number) >= 1 &&
      (parsed.student_number as number) <= 99);
  if (
    !hasExactKeys(parsed, [
      "display_name",
      "kind",
      "member_id",
      "state",
      "student_number",
      "supply_id",
      "v",
    ]) ||
    parsed.kind !== "supply_checks" ||
    parsed.v !== 1 ||
    parsed.state !== state ||
    parsed.supply_id !== supplyId ||
    !isDisplayName(parsed.display_name) ||
    !isPositiveBigint(parsed.member_id) ||
    !validStudentNumber
  ) {
    throw new InvalidCursorException();
  }
  return {
    displayName: parsed.display_name,
    memberId: parsed.member_id,
    state,
    studentNumber: parsed.student_number as number | null,
    supplyId,
  };
}
