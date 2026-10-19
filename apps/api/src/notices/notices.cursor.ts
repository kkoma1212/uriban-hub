import { countCodePoints, isAllowedPlainText } from "../common/validation/text-validation.js";
import { InvalidNoticeCursorException } from "./notices.errors.js";
import type { NoticeConfirmationFilter, NoticeImportance } from "./notices.types.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_CURSOR_LENGTH = 2048;
const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;
const PRECISE_ISO_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface NoticeListCursor {
  id: string;
  importance: NoticeImportance;
  isImportant: boolean;
  publishedAt: string;
  /*
   * 검색어도 커서에 묶는다. 안 묶으면 "숙제"로 첫 쪽을 받고 "준비물"로 다음 쪽을
   * 넘길 때 서버가 그 어긋남을 못 알아채고 엉뚱한 결과를 이어 붙인다.
   * 검색하지 않은 경우 undefined이고, 그때는 옛 커서(v3)와 모양이 같다 —
   * 이미 나가 있는 커서를 깨뜨리지 않기 위해서다(EXECUTION_ROUTINE §4).
   */
  search?: string;
}

export interface NoticeConfirmationsCursor {
  displayName: string;
  memberId: string;
  noticeId: string;
  state: NoticeConfirmationFilter;
  studentNumber: number | null;
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

function isPreciseIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = PRECISE_ISO_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;
  const millisecondTimestamp = `${match[1]}.${match[2]!.slice(0, 3)}Z`;
  const parsed = new Date(millisecondTimestamp);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === millisecondTimestamp;
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
    throw new InvalidNoticeCursorException();
  }
}

export function encodeNoticeListCursor(cursor: NoticeListCursor): string {
  const base = {
    id: cursor.id,
    importance: cursor.importance,
    is_important: cursor.isImportant,
    kind: "notices",
    published_at: cursor.publishedAt,
  };
  /* 검색하지 않았으면 v3 그대로 — 이미 나가 있는 커서와 같은 모양을 유지한다. */
  return cursor.search === undefined
    ? encode({ ...base, v: 3 })
    : encode({ ...base, search: cursor.search, v: 4 });
}

export function decodeNoticeListCursor(
  value: string,
  importance: NoticeImportance,
  search?: string,
): NoticeListCursor {
  const parsed = decode(value);
  /*
   * 검색 중이면 v4(검색어 포함), 아니면 v3이어야 한다. 서로 바꿔 쓰면 다른 조건의
   * 쪽이 이어 붙으므로 여기서 막는다.
   */
  const expectedKeys =
    search === undefined
      ? ["id", "importance", "is_important", "kind", "published_at", "v"]
      : ["id", "importance", "is_important", "kind", "published_at", "search", "v"];
  if (
    !hasExactKeys(parsed, expectedKeys) ||
    parsed.kind !== "notices" ||
    parsed.v !== (search === undefined ? 3 : 4) ||
    parsed.search !== search ||
    parsed.importance !== importance ||
    typeof parsed.is_important !== "boolean" ||
    (importance === "important" && parsed.is_important !== true) ||
    (importance === "regular" && parsed.is_important !== false) ||
    !isPositiveBigint(parsed.id) ||
    !isPreciseIsoTimestamp(parsed.published_at)
  ) {
    throw new InvalidNoticeCursorException();
  }
  return {
    id: parsed.id,
    importance,
    isImportant: parsed.is_important,
    publishedAt: parsed.published_at,
    ...(search === undefined ? {} : { search }),
  };
}

export function encodeNoticeConfirmationsCursor(cursor: NoticeConfirmationsCursor): string {
  return encode({
    display_name: cursor.displayName,
    kind: "notice_confirmations",
    member_id: cursor.memberId,
    notice_id: cursor.noticeId,
    state: cursor.state,
    student_number: cursor.studentNumber,
    v: 1,
  });
}

export function decodeNoticeConfirmationsCursor(
  value: string,
  noticeId: string,
  state: NoticeConfirmationFilter,
): NoticeConfirmationsCursor {
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
      "notice_id",
      "state",
      "student_number",
      "v",
    ]) ||
    parsed.kind !== "notice_confirmations" ||
    parsed.v !== 1 ||
    parsed.notice_id !== noticeId ||
    parsed.state !== state ||
    !isDisplayName(parsed.display_name) ||
    !isPositiveBigint(parsed.member_id) ||
    !validStudentNumber
  ) {
    throw new InvalidNoticeCursorException();
  }
  return {
    displayName: parsed.display_name,
    memberId: parsed.member_id,
    noticeId,
    state,
    studentNumber: parsed.student_number as number | null,
  };
}
