import { RetentionMariaDbError } from "./errors.js";

export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

export function countValue(value: unknown): number {
  if (
    (typeof value !== "string" || !/^\d+$/u.test(value)) &&
    typeof value !== "bigint" &&
    typeof value !== "number"
  ) {
    throw new RetentionMariaDbError("invalid_result");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new RetentionMariaDbError("invalid_result");
  return count;
}

/** Keep the exact DB6 value until an original PG Date boundary deliberately truncates to ms. */
export function dateValue(value: unknown): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(value)) {
    throw new RetentionMariaDbError("invalid_result");
  }
  const iso = `${value.slice(0, 10)}T${value.slice(11, 23)}Z`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso)
    throw new RetentionMariaDbError("invalid_result");
  return date;
}

export function sqlDate(date: Date): string {
  return date.toISOString().slice(0, -1).replace("T", " ");
}
