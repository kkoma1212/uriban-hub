import { countCodePoints, isAllowedPlainText } from "../common/validation/text-validation.js";
import { InvalidAttendanceCursorException } from "./attendance-notifications.errors.js";
import type {
  AttendanceNotificationStatusFilter,
  AttendanceNotificationTypeFilter,
} from "./attendance-notifications.types.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MAX_CURSOR_LENGTH = 2048;
const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface AttendanceTodayCursor {
  classId: string;
  displayName: string;
  memberId: string;
  notificationDate: string;
  status: AttendanceNotificationStatusFilter;
  studentNumber: number | null;
  type: AttendanceNotificationTypeFilter;
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
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isDisplayName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = countCodePoints(value);
  return length >= 2 && length <= 20 && isAllowedPlainText(value);
}

function isStudentNumber(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 99);
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
    throw new InvalidAttendanceCursorException();
  }
}

export function encodeAttendanceTodayCursor(cursor: AttendanceTodayCursor): string {
  return Buffer.from(
    JSON.stringify({
      class_id: cursor.classId,
      display_name: cursor.displayName,
      kind: "attendance_today",
      member_id: cursor.memberId,
      notification_date: cursor.notificationDate,
      status: cursor.status,
      student_number: cursor.studentNumber,
      type: cursor.type,
      v: 1,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeAttendanceTodayCursor(
  value: string,
  binding: Pick<AttendanceTodayCursor, "classId" | "notificationDate" | "status" | "type">,
): AttendanceTodayCursor {
  const parsed = decode(value);
  if (
    !hasExactKeys(parsed, [
      "class_id",
      "display_name",
      "kind",
      "member_id",
      "notification_date",
      "status",
      "student_number",
      "type",
      "v",
    ]) ||
    parsed.kind !== "attendance_today" ||
    parsed.v !== 1 ||
    parsed.class_id !== binding.classId ||
    parsed.notification_date !== binding.notificationDate ||
    parsed.type !== binding.type ||
    parsed.status !== binding.status ||
    !isPositiveBigint(parsed.class_id) ||
    !isPositiveBigint(parsed.member_id) ||
    !isCalendarDate(parsed.notification_date) ||
    !isDisplayName(parsed.display_name) ||
    !isStudentNumber(parsed.student_number)
  ) {
    throw new InvalidAttendanceCursorException();
  }

  return {
    classId: binding.classId,
    displayName: parsed.display_name,
    memberId: parsed.member_id,
    notificationDate: binding.notificationDate,
    status: binding.status,
    studentNumber: parsed.student_number,
    type: binding.type,
  };
}
