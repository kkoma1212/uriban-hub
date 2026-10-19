import { countCodePoints, isAllowedPlainText } from "../common/validation/text-validation.js";
import type { AllergenCode, MealMenuItem } from "./meals.types.js";

const ALLERGEN_CODES = new Set<string>(Array.from({ length: 19 }, (_, index) => String(index + 1)));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseMealMenu(value: unknown): MealMenuItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new Error("급식 메뉴는 1개 이상 50개 이하의 배열이어야 합니다.");
  }

  return value.map((item, index) => {
    if (!isRecord(item) || !hasExactKeys(item, ["allergens", "name"])) {
      throw new Error(`${index + 1}번째 메뉴의 필드 구성이 올바르지 않습니다.`);
    }
    if (typeof item.name !== "string" || !Array.isArray(item.allergens)) {
      throw new Error(`${index + 1}번째 메뉴의 값 형식이 올바르지 않습니다.`);
    }

    const name = item.name.trim();
    const nameLength = countCodePoints(name);
    if (nameLength < 1 || nameLength > 100 || !isAllowedPlainText(name)) {
      throw new Error(`${index + 1}번째 메뉴 이름이 올바르지 않습니다.`);
    }

    const allergens: AllergenCode[] = [];
    const seen = new Set<string>();
    for (const allergen of item.allergens) {
      if (typeof allergen !== "string" || !ALLERGEN_CODES.has(allergen)) {
        throw new Error(`${index + 1}번째 메뉴의 알레르기 코드가 올바르지 않습니다.`);
      }
      if (seen.has(allergen)) {
        throw new Error(`${index + 1}번째 메뉴에 중복 알레르기 코드가 있습니다.`);
      }
      seen.add(allergen);
      allergens.push(allergen as AllergenCode);
    }

    return { allergens, name };
  });
}
