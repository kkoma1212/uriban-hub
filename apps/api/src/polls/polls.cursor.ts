import { InvalidPollCursorException } from "./polls.errors.js";
import type { PollListScope } from "./polls.types.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_CURSOR_LENGTH = 2048;
const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;
const PRECISE_ISO_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface PollListCursor {
  closesAt: string;
  id: string;
  scope: PollListScope;
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

// 커서 비교는 DB의 마이크로초 정밀도로 이뤄진다. JS Date는 밀리초까지만 담으므로
// 값을 문자열 그대로 넘겨야 같은 밀리초 안의 투표를 건너뛰지 않는다.
function isPreciseIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = PRECISE_ISO_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;
  const millisecondTimestamp = `${match[1]}.${match[2]!.slice(0, 3)}Z`;
  const parsed = new Date(millisecondTimestamp);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === millisecondTimestamp;
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
    throw new InvalidPollCursorException();
  }
}

export function encodePollListCursor(cursor: PollListCursor): string {
  return encode({
    closes_at: cursor.closesAt,
    id: cursor.id,
    kind: "polls",
    scope: cursor.scope,
    v: 1,
  });
}

// scope를 커서에 실어 요청 scope와 대조한다. open과 closed는 정렬 방향이 반대라
// 커서를 서로 넘겨쓰면 비교식이 뒤집혀 항목을 건너뛰거나 중복해서 보낸다.
export function decodePollListCursor(value: string, scope: PollListScope): PollListCursor {
  const parsed = decode(value);
  if (
    !hasExactKeys(parsed, ["closes_at", "id", "kind", "scope", "v"]) ||
    parsed.kind !== "polls" ||
    parsed.v !== 1 ||
    parsed.scope !== scope ||
    !isPositiveBigint(parsed.id) ||
    !isPreciseIsoTimestamp(parsed.closes_at)
  ) {
    throw new InvalidPollCursorException();
  }
  return { closesAt: parsed.closes_at, id: parsed.id, scope };
}
