import { describe, expect, it } from "vitest";

import { noticeConfirmationState, noticeItemView } from "./notices.view.js";

describe("notice response views", () => {
  it("derives all three student confirmation states", () => {
    expect(noticeConfirmationState(null, "2")).toBe("unread");
    expect(noticeConfirmationState("2", "2")).toBe("confirmed");
    expect(noticeConfirmationState("1", "2")).toBe("modified_unconfirmed");
  });

  it("includes confirmation_state only for student views", () => {
    const row = {
      audience_mode: "selected_snapshot",
      category: "performance",
      content: "제출일은 금요일입니다.",
      content_revision: "2",
      id: "10",
      is_important: true,
      published_at: "2026-07-14T03:00:00.000Z",
      row_version: "3",
      title: "수행평가 안내",
    };
    expect(noticeItemView(row)).toEqual(row);
    expect(noticeItemView(row, "modified_unconfirmed")).toEqual({
      ...row,
      confirmation_state: "modified_unconfirmed",
    });
  });
});
