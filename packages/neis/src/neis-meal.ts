import { parseFragment } from "parse5";

import { parseSeedMealMenu, type SeedMealMenuItem } from "./meal-seed.js";

const NEIS_MEAL_ENDPOINT = "https://open.neis.go.kr/hub/mealServiceDietInfo";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 100;
const LUNCH_CODE = "2";

export interface NeisMeal {
  calorieKcalTenths: number | null;
  eduOfficeCode: string;
  mealDate: string;
  menuJson: SeedMealMenuItem[];
  schoolCode: string;
  sourceLoadedOn: string;
}

export interface NeisMealQuery {
  apiKey: string | undefined;
  eduOfficeCode: string;
  from: string;
  schoolCode: string;
  to: string;
}

export interface FetchNeisMealsOptions {
  fetchImplementation?: typeof fetch;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export type ValidatedNeisMealQuery = Omit<NeisMealQuery, "apiKey"> & { apiKey: string };

export class NeisMealError extends Error {
  constructor(
    readonly code:
      | "INVALID_NEIS_CONFIG"
      | "INVALID_NEIS_QUERY"
      | "INVALID_NEIS_RESPONSE"
      | "NEIS_REQUEST_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "NeisMealError";
  }
}

interface HtmlNode {
  childNodes?: HtmlNode[];
  tagName?: string;
  value?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function compactDate(value: unknown, location: string): string {
  if (typeof value !== "string" || !/^\d{8}$/u.test(value)) {
    throw new NeisMealError("INVALID_NEIS_RESPONSE", `${location} 형식이 올바르지 않습니다.`);
  }
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (!isValidDate(date)) {
    throw new NeisMealError("INVALID_NEIS_RESPONSE", `${location}가 유효한 날짜가 아닙니다.`);
  }
  return date;
}

export function validateNeisMealQuery(query: NeisMealQuery): ValidatedNeisMealQuery {
  const apiKey = query.apiKey?.trim();
  if (apiKey === undefined || apiKey === "" || /[\r\n]/u.test(apiKey)) {
    throw new NeisMealError(
      "INVALID_NEIS_CONFIG",
      "NEIS_API_KEY가 필요하며 줄바꿈을 포함할 수 없습니다.",
    );
  }
  if (!/^[A-Z][0-9]{2}$/u.test(query.eduOfficeCode)) {
    throw new NeisMealError(
      "INVALID_NEIS_QUERY",
      "교육청 코드는 영문 대문자 1자와 숫자 2자리여야 합니다.",
    );
  }
  if (!/^[0-9]{7}$/u.test(query.schoolCode)) {
    throw new NeisMealError("INVALID_NEIS_QUERY", "학교 코드는 숫자 7자리여야 합니다.");
  }
  if (!isValidDate(query.from) || !isValidDate(query.to)) {
    throw new NeisMealError("INVALID_NEIS_QUERY", "조회 시작일과 종료일이 유효하지 않습니다.");
  }
  const from = new Date(`${query.from}T00:00:00.000Z`);
  const to = new Date(`${query.to}T00:00:00.000Z`);
  const daySpan = Math.floor((to.getTime() - from.getTime()) / 86_400_000);
  if (daySpan < 0 || daySpan > 30) {
    throw new NeisMealError(
      "INVALID_NEIS_QUERY",
      "NEIS 급식 조회 기간은 시작일을 포함해 최대 31일이어야 합니다.",
    );
  }
  return { ...query, apiKey };
}

function safeResult(value: unknown): { code: string; message: string } | null {
  if (!isRecord(value) || !isRecord(value.RESULT)) return null;
  const code = value.RESULT.CODE;
  const message = value.RESULT.MESSAGE;
  return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

function responseError(code: string): NeisMealError {
  if (code === "ERROR-290") {
    return new NeisMealError(
      "NEIS_REQUEST_FAILED",
      "NEIS 인증에 실패했습니다. API 키를 확인해 주세요.",
    );
  }
  return new NeisMealError(
    "NEIS_REQUEST_FAILED",
    `NEIS가 요청을 처리하지 못했습니다. 응답 코드: ${code}`,
  );
}

function dishText(value: string, location: string): string {
  const root = parseFragment(value) as unknown as HtmlNode;
  const parts: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.tagName !== undefined) {
      if (node.tagName !== "br") {
        throw new NeisMealError(
          "INVALID_NEIS_RESPONSE",
          `${location}에 허용되지 않는 HTML 요소가 있습니다.`,
        );
      }
      parts.push("\n");
      return;
    }
    if (node.value !== undefined) parts.push(node.value);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return parts.join("");
}

function parseDishMenu(value: unknown, location: string): SeedMealMenuItem[] {
  if (typeof value !== "string") {
    throw new NeisMealError("INVALID_NEIS_RESPONSE", `${location}은 문자열이어야 합니다.`);
  }
  const lines = dishText(value, location)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const menu = lines.map((line, index) => {
    const allergenMatch = line.match(/\s*\((\d+(?:\.\d+)*)\)\s*$/u);
    const name = allergenMatch === null ? line : line.slice(0, allergenMatch.index).trim();
    const allergens = allergenMatch?.[1]?.split(".") ?? [];
    const seen = new Set<string>();
    for (const allergen of allergens) {
      if (!/^(?:[1-9]|1[0-9])$/u.test(allergen) || seen.has(allergen)) {
        throw new NeisMealError(
          "INVALID_NEIS_RESPONSE",
          `${location}[${index}]의 알레르기 코드가 올바르지 않습니다.`,
        );
      }
      seen.add(allergen);
    }
    return { allergens, name };
  });
  try {
    return parseSeedMealMenu(menu, location);
  } catch {
    throw new NeisMealError(
      "INVALID_NEIS_RESPONSE",
      `${location}의 급식 메뉴 구성이 올바르지 않습니다.`,
    );
  }
}

function requiredString(row: Record<string, unknown>, key: string, location: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new NeisMealError(
      "INVALID_NEIS_RESPONSE",
      `${location}.${key}가 비어 있거나 문자열이 아닙니다.`,
    );
  }
  return value;
}

function parseCalorieKcalTenths(value: unknown, location: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new NeisMealError("INVALID_NEIS_RESPONSE", `${location} must be a string when present.`);
  }
  const normalized = value.trim();
  if (normalized === "") return null;
  const match = normalized.match(/^([0-9]{1,4})(?:\.([0-9]))?\s*Kcal$/iu);
  if (match === null) {
    throw new NeisMealError(
      "INVALID_NEIS_RESPONSE",
      `${location} must use the NEIS calorie format, for example 1452.2 Kcal.`,
    );
  }
  const wholeKcal = Number(match[1]);
  const decimalKcal = Number(match[2] ?? "0");
  const calorieKcalTenths = wholeKcal * 10 + decimalKcal;
  if (calorieKcalTenths > 99_999) {
    throw new NeisMealError(
      "INVALID_NEIS_RESPONSE",
      `${location} must be between 0.0 and 9999.9 Kcal.`,
    );
  }
  return calorieKcalTenths;
}

function parseRows(rows: unknown[], query: ValidatedNeisMealQuery): NeisMeal[] {
  if (rows.length > PAGE_SIZE) {
    throw new NeisMealError(
      "INVALID_NEIS_RESPONSE",
      "NEIS 급식 응답이 페이지 제한을 초과했습니다.",
    );
  }
  const meals: NeisMeal[] = [];
  const seenDates = new Set<string>();
  rows.forEach((rawRow, index) => {
    const location = `mealServiceDietInfo.row[${index}]`;
    if (!isRecord(rawRow)) {
      throw new NeisMealError("INVALID_NEIS_RESPONSE", `${location}은 객체여야 합니다.`);
    }
    const eduOfficeCode = requiredString(rawRow, "ATPT_OFCDC_SC_CODE", location);
    const schoolCode = requiredString(rawRow, "SD_SCHUL_CODE", location);
    const mealCode = requiredString(rawRow, "MMEAL_SC_CODE", location);
    if (
      eduOfficeCode !== query.eduOfficeCode ||
      schoolCode !== query.schoolCode ||
      mealCode !== LUNCH_CODE
    ) {
      throw new NeisMealError(
        "INVALID_NEIS_RESPONSE",
        `${location}의 학교 또는 중식 코드가 요청과 일치하지 않습니다.`,
      );
    }
    const mealDate = compactDate(rawRow.MLSV_YMD, `${location}.MLSV_YMD`);
    if (mealDate < query.from || mealDate > query.to || seenDates.has(mealDate)) {
      throw new NeisMealError(
        "INVALID_NEIS_RESPONSE",
        `${location}의 급식일이 조회 범위를 벗어났거나 중복되었습니다.`,
      );
    }
    seenDates.add(mealDate);
    meals.push({
      calorieKcalTenths: parseCalorieKcalTenths(rawRow.CAL_INFO, `${location}.CAL_INFO`),
      eduOfficeCode,
      mealDate,
      menuJson: parseDishMenu(rawRow.DDISH_NM, `${location}.DDISH_NM`),
      schoolCode,
      sourceLoadedOn: compactDate(rawRow.LOAD_DTM, `${location}.LOAD_DTM`),
    });
  });
  return meals.sort((left, right) => left.mealDate.localeCompare(right.mealDate));
}

export function parseNeisMealResponse(value: unknown, rawQuery: NeisMealQuery): NeisMeal[] {
  const query = validateNeisMealQuery(rawQuery);
  if (!isRecord(value)) {
    throw new NeisMealError("INVALID_NEIS_RESPONSE", "NEIS 응답 최상위 값이 객체가 아닙니다.");
  }

  const rootResult = safeResult(value);
  if (rootResult !== null) {
    if (rootResult.code === "INFO-200") return [];
    throw responseError(rootResult.code);
  }

  const sections = value.mealServiceDietInfo;
  if (!Array.isArray(sections)) {
    throw new NeisMealError(
      "INVALID_NEIS_RESPONSE",
      "NEIS 급식 응답에 mealServiceDietInfo가 없습니다.",
    );
  }
  let totalCount: number | null = null;
  let resultCode: string | null = null;
  let rows: unknown[] | null = null;
  for (const section of sections) {
    if (!isRecord(section)) continue;
    if (Array.isArray(section.head)) {
      for (const item of section.head) {
        if (!isRecord(item)) continue;
        if (item.list_total_count !== undefined) {
          const candidate =
            typeof item.list_total_count === "string"
              ? Number(item.list_total_count)
              : item.list_total_count;
          if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
            totalCount = candidate;
          }
        }
        const result = safeResult(item);
        if (result !== null) resultCode = result.code;
      }
    }
    if (Array.isArray(section.row)) rows = section.row;
  }

  if (resultCode === "INFO-200") return [];
  if (resultCode !== "INFO-000") {
    if (resultCode !== null) throw responseError(resultCode);
    throw new NeisMealError("INVALID_NEIS_RESPONSE", "NEIS 정상 처리 코드가 없습니다.");
  }
  if (
    totalCount === null ||
    totalCount > PAGE_SIZE ||
    rows === null ||
    totalCount !== rows.length
  ) {
    throw new NeisMealError(
      "INVALID_NEIS_RESPONSE",
      "NEIS 급식 응답 개수 또는 페이지 구성이 올바르지 않습니다.",
    );
  }
  return parseRows(rows, query);
}

function compactQueryDate(value: string): string {
  return value.replaceAll("-", "");
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function fetchNeisMeals(
  rawQuery: NeisMealQuery,
  options: FetchNeisMealsOptions = {},
): Promise<NeisMeal[]> {
  const query = validateNeisMealQuery(rawQuery);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryDelayMs = options.retryDelayMs ?? 250;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new NeisMealError("INVALID_NEIS_CONFIG", "NEIS 요청 제한 시간이 올바르지 않습니다.");
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000) {
    throw new NeisMealError("INVALID_NEIS_CONFIG", "NEIS 재시도 대기 시간이 올바르지 않습니다.");
  }

  const url = new URL(NEIS_MEAL_ENDPOINT);
  url.searchParams.set("Type", "json");
  url.searchParams.set("KEY", query.apiKey);
  url.searchParams.set("pIndex", "1");
  url.searchParams.set("pSize", String(PAGE_SIZE));
  url.searchParams.set("ATPT_OFCDC_SC_CODE", query.eduOfficeCode);
  url.searchParams.set("SD_SCHUL_CODE", query.schoolCode);
  url.searchParams.set("MMEAL_SC_CODE", LUNCH_CODE);
  url.searchParams.set("MLSV_FROM_YMD", compactQueryDate(query.from));
  url.searchParams.set("MLSV_TO_YMD", compactQueryDate(query.to));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let shouldRetry = false;
    try {
      const response = await fetchImplementation(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (attempt === 0 && retryableStatus(response.status)) {
          shouldRetry = true;
        } else {
          throw new NeisMealError(
            "NEIS_REQUEST_FAILED",
            `NEIS HTTP 요청에 실패했습니다. 상태 코드: ${response.status}`,
          );
        }
      } else {
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
          throw new NeisMealError("INVALID_NEIS_RESPONSE", "NEIS 응답 크기가 제한을 초과했습니다.");
        }
        let payload: unknown;
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          throw new NeisMealError("INVALID_NEIS_RESPONSE", "NEIS 응답이 올바른 JSON이 아닙니다.");
        }
        return parseNeisMealResponse(payload, query);
      }
    } catch (error) {
      if (error instanceof NeisMealError) throw error;
      if (attempt === 0) {
        shouldRetry = true;
      } else {
        throw new NeisMealError(
          "NEIS_REQUEST_FAILED",
          "NEIS 요청에 두 번 연속 실패했습니다. 잠시 후 다시 시도해 주세요.",
        );
      }
    } finally {
      clearTimeout(timeout);
    }
    if (shouldRetry) {
      await wait(retryDelayMs);
    }
  }
  throw new NeisMealError("NEIS_REQUEST_FAILED", "NEIS 요청에 실패했습니다.");
}
