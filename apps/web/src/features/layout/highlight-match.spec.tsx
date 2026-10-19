import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HighlightMatch, searchExcerpt } from "./highlight-match";

describe("HighlightMatch", () => {
  it("marks every occurrence regardless of letter case", () => {
    render(<HighlightMatch term="우유" text="우유 준비물 안내 — 우유는 내일까지" />);

    const marks = screen.getAllByText("우유");
    expect(marks).toHaveLength(2);
    for (const mark of marks) expect(mark.tagName).toBe("MARK");
  });

  it("leaves the text alone when nothing is searched", () => {
    const { container } = render(<HighlightMatch term={undefined} text="우유 준비물" />);

    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe("우유 준비물");
  });

  /*
   * 사용자가 검색창에 `(` 하나만 쳐도 정규식이 깨지면 화면 전체가 죽는다.
   * 이스케이프를 빼면 이 시험이 예외로 실패한다 — 그게 이 시험의 목적이다.
   */
  it("survives search terms that look like regular expressions", () => {
    const dangerous = ["(", "[a-z", "*", "\\", "a)b"];

    for (const term of dangerous) {
      expect(() => render(<HighlightMatch term={term} text={`앞 ${term} 뒤`} />)).not.toThrow();
    }
  });

  it("keeps the whole text intact around the marks", () => {
    const { container } = render(<HighlightMatch term="준비" text="내일 준비물 안내" />);

    expect(container.textContent).toBe("내일 준비물 안내");
  });
});

describe("searchExcerpt", () => {
  it("cuts to the match when it sits past the visible lines", () => {
    const text = `${"가".repeat(300)}우유${"나".repeat(300)}`;

    const excerpt = searchExcerpt(text, "우유");

    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).toContain("우유");
    expect(excerpt.length).toBeLessThan(text.length);
    // 좁은 준비물 카드에서는 앞 문맥 없이 검색어부터 보여 잘리지 않게 한다.
    expect(searchExcerpt(text, "우유", 0).startsWith("…우유")).toBe(true);
    expect(searchExcerpt("앞문장 우유 안내", "우유", 0)).toBe("…우유 안내");
  });

  it("returns the text untouched when the match is already near the top", () => {
    const text = "우유를 가져오세요";

    expect(searchExcerpt(text, "우유")).toBe(text);
    expect(searchExcerpt(text, undefined)).toBe(text);
    expect(searchExcerpt(text, "없는말")).toBe(text);
    expect(searchExcerpt(text, undefined, 0)).toBe(text);
    expect(searchExcerpt(text, "없는말", 0)).toBe(text);
  });
});
