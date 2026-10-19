import { describe, expect, it } from "vitest";

import { containsBlockedDisplayNameWord } from "./display-name-policy";

describe("containsBlockedDisplayNameWord", () => {
  it("catches listed words with spacing, digits and consonant shorthand", () => {
    for (const name of ["씨발", "시 발", "시1발", "ㅅㅂ맨", "F U C K"]) {
      expect(containsBlockedDisplayNameWord(name), name).toBe(true);
    }
  });

  it("keeps ordinary names", () => {
    for (const name of [
      "김민준",
      "시바견",
      "애비게일",
      "Essex",
      "보람",
      "Harshit",
      "Pornchai",
      "에밀 졸라",
    ]) {
      expect(containsBlockedDisplayNameWord(name), name).toBe(false);
    }
  });
});
