import { describe, expect, it } from "vitest";

import { codePointLength } from "./text";

describe("codePointLength", () => {
  it.each([
    ["a supplementary-plane emoji", "😀", 1],
    ["a heart with a variation selector", "❤️", 2],
  ])("counts %s by Unicode code point", (_name, value, expected) => {
    expect(codePointLength(value)).toBe(expected);
  });
});
