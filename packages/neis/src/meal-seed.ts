import { parseFragment } from "parse5";

export type MealOperation = "delete" | "upsert";
export type MealType = "breakfast" | "dinner" | "lunch";

export interface SeedMealMenuItem {
  allergens: string[];
  name: string;
}

interface MealSeedKey {
  eduOfficeCode: string;
  mealDate: string;
  mealType: MealType;
  operation: MealOperation;
  schoolCode: string;
}

export interface MealSeedUpsert extends MealSeedKey {
  menuJson: SeedMealMenuItem[];
  operation: "upsert";
}

export interface MealSeedDelete extends MealSeedKey {
  operation: "delete";
}

export type MealSeedItem = MealSeedDelete | MealSeedUpsert;

export interface ParsedMealSeed {
  items: MealSeedItem[];
  schemaVersion: 1;
}

export class MealSeedValidationError extends Error {
  readonly code = "INVALID_MEAL_SEED";

  constructor(message: string) {
    super(message);
    this.name = "MealSeedValidationError";
  }
}

interface HtmlNode {
  childNodes?: HtmlNode[];
  tagName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  location: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    !actual.every((key, index) => key === sortedExpected[index])
  ) {
    throw new MealSeedValidationError(`${location}의 key 구성이 올바르지 않습니다.`);
  }
}

function hasHtmlElement(value: string): boolean {
  const root = parseFragment(value) as unknown as HtmlNode;
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node?.tagName !== undefined) return true;
    if (node?.childNodes !== undefined) pending.push(...node.childNodes);
  }
  return false;
}

function normalizeMenuName(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new MealSeedValidationError(`${location}.name은 문자열이어야 합니다.`);
  }
  const name = value.trim();
  const forbiddenControl = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/u;
  if (
    Array.from(name).length < 1 ||
    Array.from(name).length > 100 ||
    forbiddenControl.test(name) ||
    hasHtmlElement(name)
  ) {
    throw new MealSeedValidationError(`${location}.name이 허용 범위를 벗어났습니다.`);
  }
  return name;
}

export function parseSeedMealMenu(value: unknown, location = "menu_json"): SeedMealMenuItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new MealSeedValidationError(`${location}은 1~50개 메뉴 배열이어야 합니다.`);
  }
  return value.map((menu, menuIndex) => {
    const itemLocation = `${location}[${menuIndex}]`;
    if (!isRecord(menu)) {
      throw new MealSeedValidationError(`${itemLocation}은 객체여야 합니다.`);
    }
    assertExactKeys(menu, ["allergens", "name"], itemLocation);
    if (!Array.isArray(menu.allergens)) {
      throw new MealSeedValidationError(`${itemLocation}.allergens는 배열이어야 합니다.`);
    }
    const seen = new Set<string>();
    const allergens = menu.allergens.map((allergen) => {
      if (
        typeof allergen !== "string" ||
        !/^(?:[1-9]|1[0-9])$/u.test(allergen) ||
        seen.has(allergen)
      ) {
        throw new MealSeedValidationError(
          `${itemLocation}.allergens에 허용되지 않거나 중복된 코드가 있습니다.`,
        );
      }
      seen.add(allergen);
      return allergen;
    });
    return { allergens, name: normalizeMenuName(menu.name, itemLocation) };
  });
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function requiredString(value: unknown, pattern: RegExp, location: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new MealSeedValidationError(`${location} 형식이 올바르지 않습니다.`);
  }
  return value;
}

export function parseMealSeedJson(text: string): ParsedMealSeed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new MealSeedValidationError("급식 seed가 올바른 JSON이 아닙니다.");
  }
  if (!isRecord(parsed))
    throw new MealSeedValidationError("급식 seed 최상위 값은 객체여야 합니다.");
  assertExactKeys(parsed, ["items", "schema_version"], "최상위 객체");
  if (parsed.schema_version !== 1 || !Number.isInteger(parsed.schema_version)) {
    throw new MealSeedValidationError("schema_version은 정수 1이어야 합니다.");
  }
  if (!Array.isArray(parsed.items) || parsed.items.length > 10_000) {
    throw new MealSeedValidationError("items는 최대 10,000개 배열이어야 합니다.");
  }

  const uniqueKeys = new Set<string>();
  const items = parsed.items.map((rawItem, index): MealSeedItem => {
    const location = `items[${index}]`;
    if (!isRecord(rawItem)) throw new MealSeedValidationError(`${location}은 객체여야 합니다.`);
    const operation = rawItem.operation;
    if (operation !== "upsert" && operation !== "delete") {
      throw new MealSeedValidationError(`${location}.operation이 올바르지 않습니다.`);
    }
    assertExactKeys(
      rawItem,
      operation === "upsert"
        ? ["edu_office_code", "meal_date", "meal_type", "menu_json", "operation", "school_code"]
        : ["edu_office_code", "meal_date", "meal_type", "operation", "school_code"],
      location,
    );
    const eduOfficeCode = requiredString(
      rawItem.edu_office_code,
      /^[A-Z][0-9]{2}$/u,
      `${location}.edu_office_code`,
    );
    const schoolCode = requiredString(
      rawItem.school_code,
      /^[0-9]{7}$/u,
      `${location}.school_code`,
    );
    if (typeof rawItem.meal_date !== "string" || !isValidDate(rawItem.meal_date)) {
      throw new MealSeedValidationError(`${location}.meal_date가 유효한 날짜가 아닙니다.`);
    }
    if (
      rawItem.meal_type !== "breakfast" &&
      rawItem.meal_type !== "lunch" &&
      rawItem.meal_type !== "dinner"
    ) {
      throw new MealSeedValidationError(`${location}.meal_type이 올바르지 않습니다.`);
    }
    const mealType: MealType = rawItem.meal_type;
    const uniqueKey = [eduOfficeCode, schoolCode, rawItem.meal_date, mealType].join(":");
    if (uniqueKeys.has(uniqueKey)) {
      throw new MealSeedValidationError(`${location}에 중복 급식 unique key가 있습니다.`);
    }
    uniqueKeys.add(uniqueKey);

    const common = {
      eduOfficeCode,
      mealDate: rawItem.meal_date,
      mealType,
      schoolCode,
    };
    return operation === "delete"
      ? { ...common, operation }
      : {
          ...common,
          menuJson: parseSeedMealMenu(rawItem.menu_json, `${location}.menu_json`),
          operation,
        };
  });

  return { items, schemaVersion: 1 };
}
