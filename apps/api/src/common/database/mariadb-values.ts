import { sql, type KyselyPlugin, type RawBuilder } from "kysely";

type Decoder = (value: unknown) => unknown;
const invalid = () => new Error("Invalid MariaDB application value.");

/** Explicit per-feature result mapping; SQL and unlisted fields are never rewritten. */
export function createMariaDbRowCodec(fields: Readonly<Record<string, Decoder>>): KyselyPlugin {
  const decoders = new Map(Object.entries(fields));
  if ([...decoders.values()].some((decode) => typeof decode !== "function")) throw invalid();
  return {
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => ({
      ...result,
      rows: result.rows.map((row) => {
        const decoded = { ...row };
        for (const [key, decode] of decoders)
          if (Object.hasOwn(row, key)) decoded[key] = decode(row[key]);
        return decoded;
      }),
    }),
  };
}

export function mariaDbNullable<T>(decode: (value: unknown) => T) {
  return (value: unknown): T | null => (value === null ? null : decode(value));
}

/** Already decoded values are supported when services share the same transaction. */
export function mariaDbBoolean(value: unknown): boolean {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  throw invalid();
}

export function mariaDbId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,18}$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw invalid();
  return value;
}

export function mariaDbInsertId(value: unknown): string {
  if (typeof value !== "bigint") throw invalid();
  return mariaDbId(String(value));
}

export function mariaDbCount(value: unknown): number {
  if (
    (typeof value !== "number" && (typeof value !== "string" || !/^(0|[1-9]\d*)$/u.test(value))) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 0
  )
    throw invalid();
  return Number(value);
}

/** Canonical DATE remains a string so the host timezone cannot shift its calendar day. */
export function mariaDbDateOnly(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/u.test(value)) throw invalid();
  const date = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw invalid();
  return value;
}

/** Public Date values retain the existing millisecond contract; SQL writers keep DB6 separately. */
export function mariaDbDateTime(value: unknown): Date {
  if (value instanceof Date) {
    if (
      !Number.isFinite(value.getTime()) ||
      value.getUTCFullYear() < 1000 ||
      value.getUTCFullYear() > 9999
    )
      throw invalid();
    return new Date(value.getTime());
  }
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{3}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(value)
  )
    throw invalid();
  const iso = value.slice(0, 10) + "T" + value.slice(11, 23) + "Z";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) throw invalid();
  return date;
}

/** For parameters, preserve a native DB6 string or encode an existing application Date as UTC3+000. */
export function mariaDbTimestamp(value: unknown): string {
  const date = mariaDbDateTime(value);
  return typeof value === "string"
    ? value
    : date.toISOString().replace("T", " ").replace("Z", "000");
}

export function mariaDbDateBinding(value: unknown): RawBuilder<Date> {
  return sql<Date>`${mariaDbTimestamp(value)}`;
}
