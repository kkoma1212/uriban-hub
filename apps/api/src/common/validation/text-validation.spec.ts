import { describe, expect, it } from "vitest";

import { countCodePoints, hasHtmlElement, isAllowedPlainText } from "./text-validation.js";

describe("text validation", () => {
  it("counts Unicode code points without collapsing variation selectors", () => {
    expect(countCodePoints("❤️")).toBe(2);
    expect(countCodePoints("😀")).toBe(1);
    expect(countCodePoints("❤️".repeat(20))).toBe(40);
  });

  it("detects HTML elements without treating ordinary less-than text as markup", () => {
    expect(hasHtmlElement("<b>강조</b>")).toBe(true);
    expect(hasHtmlElement("<script>alert(1)</script>")).toBe(true);
    expect(hasHtmlElement("1 < 3")).toBe(false);
    expect(hasHtmlElement("<3")).toBe(false);
  });

  it("rejects C0 controls and allows LF only when explicitly configured", () => {
    expect(isAllowedPlainText("보통 문자열")).toBe(true);
    expect(isAllowedPlainText("A\u0000B")).toBe(false);
    expect(isAllowedPlainText("A\nB")).toBe(false);
    expect(isAllowedPlainText("A\nB", true)).toBe(true);
    expect(isAllowedPlainText("A\u0085B", true)).toBe(false);
    expect(isAllowedPlainText("A\u2028B", true)).toBe(false);
    expect(isAllowedPlainText("A\u2029B", true)).toBe(false);
    expect(isAllowedPlainText("<b>태그</b>", true)).toBe(false);
  });
});
