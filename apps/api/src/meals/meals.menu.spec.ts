import { describe, expect, it } from "vitest";

import { parseMealMenu } from "./meals.menu.js";

describe("meal menu schema", () => {
  it("normalizes names and accepts the fixed allergen code range", () => {
    expect(parseMealMenu([{ allergens: ["1", "19"], name: "  현미밥  " }])).toEqual([
      { allergens: ["1", "19"], name: "현미밥" },
    ]);
  });

  const invalidMenus: Array<[unknown, string]> = [
    [[], "empty menu"],
    [[{ allergens: ["1", "1"], name: "밥" }], "duplicate allergen"],
    [[{ allergens: ["20"], name: "밥" }], "unknown allergen"],
    [[{ allergens: [], extra: true, name: "밥" }], "unknown key"],
    [[{ allergens: [], name: "<b>밥</b>" }], "HTML"],
    [[{ allergens: [], name: "밥\n국" }], "control character"],
  ];

  it.each(invalidMenus)("rejects %s (%s)", (value) => {
    expect(() => parseMealMenu(value)).toThrow();
  });
});
