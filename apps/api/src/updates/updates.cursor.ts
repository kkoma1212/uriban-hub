import { InvalidUpdatesCursorException } from "./updates.errors.js";
import type { UpdateItemKind, UpdatesFilter } from "./updates.types.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_CURSOR_LENGTH = 2048;
const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;
const PRECISE_ISO_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface UpdatesCursor {
  filter: UpdatesFilter;
  id: string;
  itemKind: UpdateItemKind;
  publishedAt: string;
  /** 검색 중일 때만 담긴다. 검색어가 어긋나면 서버가 거절한다. */
  search?: string;
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
    throw new InvalidUpdatesCursorException();
  }
}

export function encodeUpdatesCursor(cursor: UpdatesCursor): string {
  const base = {
    filter: cursor.filter,
    id: cursor.id,
    item_kind: cursor.itemKind,
    kind: "updates",
    published_at: cursor.publishedAt,
  };
  /* 검색하지 않았으면 v1 그대로 — 이미 나가 있는 커서를 깨뜨리지 않는다. */
  const payload =
    cursor.search === undefined ? { ...base, v: 1 } : { ...base, search: cursor.search, v: 2 };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeUpdatesCursor(
  value: string,
  filter: UpdatesFilter,
  search?: string,
): UpdatesCursor {
  const parsed = decode(value);
  /* 검색어도 묶는다 — 다른 검색어로 다음 쪽을 넘기면 조건이 다른 쪽이 이어 붙는다. */
  const expectedKeys =
    search === undefined
      ? ["filter", "id", "item_kind", "kind", "published_at", "v"]
      : ["filter", "id", "item_kind", "kind", "published_at", "search", "v"];
  if (
    !hasExactKeys(parsed, expectedKeys) ||
    parsed.kind !== "updates" ||
    parsed.v !== (search === undefined ? 1 : 2) ||
    parsed.search !== search ||
    parsed.filter !== filter ||
    !["notice", "supply"].includes(String(parsed.item_kind)) ||
    !isPositiveBigint(parsed.id) ||
    !isPreciseIsoTimestamp(parsed.published_at)
  ) {
    throw new InvalidUpdatesCursorException();
  }

  return {
    filter,
    id: parsed.id,
    itemKind: parsed.item_kind as UpdateItemKind,
    publishedAt: parsed.published_at,
    ...(search === undefined ? {} : { search }),
  };
}
