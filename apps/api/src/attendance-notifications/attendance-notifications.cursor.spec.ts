import { describe, expect, it } from "vitest";

import {
  decodeAttendanceTodayCursor,
  encodeAttendanceTodayCursor,
  type AttendanceTodayCursor,
} from "./attendance-notifications.cursor.js";
import { InvalidAttendanceCursorException } from "./attendance-notifications.errors.js";

const cursor: AttendanceTodayCursor = {
  classId: "12",
  displayName: "가나다 학생",
  memberId: "34",
  notificationDate: "2026-07-18",
  status: "all",
  studentNumber: null,
  type: "all",
};

describe("attendance today cursor", () => {
  it("round-trips the complete class, date, filter, and ordering tuple", () => {
    const encoded = encodeAttendanceTodayCursor(cursor);

    expect(
      decodeAttendanceTodayCursor(encoded, {
        classId: cursor.classId,
        notificationDate: cursor.notificationDate,
        status: cursor.status,
        type: cursor.type,
      }),
    ).toEqual(cursor);
    expect(Buffer.from(encoded, "base64url").toString("base64url")).toBe(encoded);
  });

  it.each([
    { classId: "13", notificationDate: "2026-07-18", status: "all" as const, type: "all" as const },
    { classId: "12", notificationDate: "2026-07-17", status: "all" as const, type: "all" as const },
    {
      classId: "12",
      notificationDate: "2026-07-18",
      status: "pending" as const,
      type: "all" as const,
    },
    {
      classId: "12",
      notificationDate: "2026-07-18",
      status: "all" as const,
      type: "late" as const,
    },
  ])("rejects a cursor under a different request binding", (binding) => {
    expect(() => decodeAttendanceTodayCursor(encodeAttendanceTodayCursor(cursor), binding)).toThrow(
      InvalidAttendanceCursorException,
    );
  });

  it.each([
    "",
    "not+base64url",
    Buffer.from("{", "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ ...cursor, unexpected: true }), "utf8").toString("base64url"),
  ])("rejects malformed or non-contract cursors", (encoded) => {
    expect(() =>
      decodeAttendanceTodayCursor(encoded, {
        classId: cursor.classId,
        notificationDate: cursor.notificationDate,
        status: cursor.status,
        type: cursor.type,
      }),
    ).toThrow(InvalidAttendanceCursorException);
  });
});
