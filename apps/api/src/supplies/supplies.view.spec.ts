import { describe, expect, it } from "vitest";

import { supplyCheckState, supplyItemView } from "./supplies.view.js";

describe("supply response views", () => {
  it("derives all three student check states", () => {
    expect(supplyCheckState(null, null, "2")).toBe("unchecked");
    expect(supplyCheckState(false, "2", "2")).toBe("unchecked");
    expect(supplyCheckState(true, "2", "2")).toBe("checked");
    expect(supplyCheckState(true, "1", "2")).toBe("modified_unconfirmed");
  });

  it("carries the category through so the screen can tell homework apart", () => {
    const homework = {
      audience_mode: "legacy_class",
      category: "homework",
      content_revision: "1",
      description: null,
      id: "11",
      needed_on: "2026-07-16",
      row_version: "1",
      title: "수학 익힘책 12–15쪽",
    };
    expect(supplyItemView(homework).category).toBe("homework");
  });

  it("includes check_state only for student views", () => {
    const row = {
      audience_mode: "all_snapshot",
      category: "general",
      content_revision: "2",
      description: "노트와 필기도구",
      id: "10",
      needed_on: "2026-07-15",
      row_version: "3",
      title: "수학 준비물",
    };
    expect(supplyItemView(row)).toEqual({ ...row });
    expect(supplyItemView(row, "modified_unconfirmed")).toEqual({
      ...row,
      check_state: "modified_unconfirmed",
    });
  });
});
