import { describe, expect, it } from "vitest";

import { parseMealSeedJson } from "./meal-seed.js";

function seed(items: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema_version: 1, items, ...extra });
}

const valid = {
  operation: "upsert",
  edu_office_code: "B10",
  school_code: "7010123",
  meal_date: "2026-07-14",
  meal_type: "lunch",
  menu_json: [{ name: "  현미밥  ", allergens: ["1", "19"] }],
};

describe("meal seed schema", () => {
  it("normalizes an exact upsert and accepts the exact delete shape", () => {
    const result = parseMealSeedJson(
      seed([
        valid,
        {
          operation: "delete",
          edu_office_code: "B10",
          school_code: "7010123",
          meal_date: "2026-07-15",
          meal_type: "lunch",
        },
      ]),
    );
    expect(result.items[0]).toMatchObject({
      menuJson: [{ allergens: ["1", "19"], name: "현미밥" }],
    });
    expect(result.items[1]).not.toHaveProperty("menuJson");
  });

  it.each([
    [seed([valid], { unexpected: true }), "unknown top-level key"],
    [seed([{ ...valid, source: "seed" }]), "unknown item key"],
    [seed([{ ...valid, school_code: "123" }]), "bad school code"],
    [seed([{ ...valid, meal_date: "2026-02-30" }]), "invalid date"],
    [
      seed([{ ...valid, menu_json: [{ name: "밥", allergens: ["1", "1"] }] }]),
      "duplicate allergen",
    ],
    [seed([{ ...valid, menu_json: [{ name: "<b>밥</b>", allergens: [] }] }]), "HTML name"],
    [seed([valid, { ...valid, operation: "delete", menu_json: undefined }]), "duplicate meal key"],
  ] as Array<[string, string]>)("rejects %s (%s)", (input) => {
    expect(() => parseMealSeedJson(input)).toThrow();
  });
});
