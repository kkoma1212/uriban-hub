import { describe, expect, it } from "vitest";

import { stripRichText } from "./rich-text.js";

// 같은 표를 화면 apps/web/src/lib/rich-text.spec.ts에도 둔다 — 두 규칙이 어긋나면 한쪽이 실패한다.
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

describe("stripRichText", () => {
  it.each(STRIP_CASES)("기호를 뺀 글자: %j", (input, stripped) => {
    expect(stripRichText(input)).toBe(stripped);
  });
});
