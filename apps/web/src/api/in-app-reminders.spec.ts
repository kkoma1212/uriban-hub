import { describe, expect, it } from "vitest";

import { reminderContentRevision } from "./in-app-reminders";

describe("reminder content revision guard", () => {
  it("parses a positive integer revision", () => {
    expect(reminderContentRevision("1", "공지")).toBe(1);
    expect(reminderContentRevision("42", "준비물")).toBe(42);
  });

  it("rejects zero, negatives, fractions, and non-numeric revisions with the resource label", () => {
    for (const invalid of ["0", "-1", "1.5", "abc", "", "9007199254740993"]) {
      expect(() => reminderContentRevision(invalid, "공지")).toThrow(
        "공지 내용이 방금 바뀌었을 수 있어요. 화면을 새로고침해 주세요.",
      );
    }
    expect(() => reminderContentRevision("x", "준비물")).toThrow(/^준비물 /u);
  });
});
