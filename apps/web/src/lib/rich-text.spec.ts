import { describe, expect, it } from "vitest";

import { hasRichText, parseRichText, stripRichText, wrapSelection } from "./rich-text";

// 같은 표를 서버 apps/api/src/common/text/rich-text.spec.ts에도 둔다 — 두 규칙이 어긋나면 한쪽이 실패한다.
const STRIP_CASES: ReadonlyArray<readonly [string, string]> = [
  ["내일은 **체육복**을 챙겨요", "내일은 체육복을 챙겨요"],
  ["==비가 오면 강당==에서 해요", "비가 오면 강당에서 해요"],
  ["**a** 그리고 ==b==", "a 그리고 b"],
  ["줄1\n**줄2**", "줄1\n줄2"],
  ["a == b == c", "a == b == c"],
  ["2==2", "2==2"],
  ["****", "****"],
  ["** 앞뒤 공백 **", "** 앞뒤 공백 **"],
  ["**줄을\n넘김**", "**줄을\n넘김**"],
  ["==**겹침**==", "**겹침**"],
  ["**<script>alert(1)</script>**", "<script>alert(1)</script>"],
];

describe("rich text markers", () => {
  it.each(STRIP_CASES)("기호를 뺀 글자: %j", (input, stripped) => {
    expect(stripRichText(input)).toBe(stripped);
  });

  it("굵게·형광펜·보통 글자를 순서대로 나눈다", () => {
    expect(parseRichText("내일은 **체육복**을\n==꼭== 챙겨요")).toEqual([
      { text: "내일은 " },
      { style: "bold", text: "체육복" },
      { text: "을" },
      { text: "\n" },
      { style: "mark", text: "꼭" },
      { text: " 챙겨요" },
    ]);
    expect(hasRichText("보통 글")).toBe(false);
    expect(hasRichText("a == b == c")).toBe(false);
    expect(hasRichText("**굵게**")).toBe(true);
  });

  it("고른 글자를 감싸고, 앞뒤 공백은 기호 밖에 두며, 안 고르면 기호 사이에 커서를 둔다", () => {
    expect(wrapSelection("내일 체육복 챙겨", 3, 6, "bold")).toEqual({
      selectionEnd: 8,
      selectionStart: 5,
      value: "내일 **체육복** 챙겨",
    });
    expect(wrapSelection("내일 체육복 챙겨", 2, 7, "mark")).toEqual({
      selectionEnd: 8,
      selectionStart: 5,
      value: "내일 ==체육복== 챙겨",
    });
    expect(wrapSelection("안내", 2, 2, "bold")).toEqual({
      selectionEnd: 4,
      selectionStart: 4,
      value: "안내****",
    });
  });
});
