import type { SchoolKind, SchoolSeedItem } from "./school-seed.js";

const NEIS_SCHOOL_ENDPOINT = "https://open.neis.go.kr/hub/schoolInfo";
const DEFAULT_PAGE_SIZE = 1_000;
const MAX_PAGE_SIZE = 1_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SCHOOLS = 30_000;

export interface NeisSchoolQuery {
  apiKey: string | undefined;
}

export interface NeisSchoolPageContext {
  pageIndex: number;
  pageSize: number;
}

export interface NeisSchoolPage {
  blankedOptionalFieldCount: number;
  ignoredInvalidIdentifierCount: number;
  ignoredUnsupportedCount: number;
  items: SchoolSeedItem[];
  totalCount: number;
}

export interface NeisSchoolCatalog {
  blankedOptionalFieldCount: number;
  ignoredInvalidIdentifierCount: number;
  ignoredUnsupportedCount: number;
  items: SchoolSeedItem[];
  sourceCount: number;
}

export interface FetchNeisSchoolsOptions {
  fetchImplementation?: typeof fetch;
  pageSize?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export interface ValidatedNeisSchoolQuery {
  apiKey: string;
}

export class NeisSchoolError extends Error {
  constructor(
    readonly code: "INVALID_NEIS_CONFIG" | "INVALID_NEIS_RESPONSE" | "NEIS_REQUEST_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "NeisSchoolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateNeisSchoolQuery(query: NeisSchoolQuery): ValidatedNeisSchoolQuery {
  const apiKey = query.apiKey?.trim();
  if (apiKey === undefined || apiKey === "" || /[\r\n]/u.test(apiKey)) {
    throw new NeisSchoolError(
      "INVALID_NEIS_CONFIG",
      "NEIS_API_KEY가 필요하며 줄바꿈을 포함할 수 없습니다.",
    );
  }
  return { apiKey };
}

function validatePageContext(context: NeisSchoolPageContext): void {
  if (!Number.isInteger(context.pageIndex) || context.pageIndex < 1) {
    throw new NeisSchoolError("INVALID_NEIS_CONFIG", "NEIS 학교 페이지 위치가 올바르지 않습니다.");
  }
  if (
    !Number.isInteger(context.pageSize) ||
    context.pageSize < 1 ||
    context.pageSize > MAX_PAGE_SIZE
  ) {
    throw new NeisSchoolError(
      "INVALID_NEIS_CONFIG",
      `NEIS 학교 페이지 크기는 1~${MAX_PAGE_SIZE}여야 합니다.`,
    );
  }
}

function safeResult(value: unknown): { code: string; message: string } | null {
  if (!isRecord(value) || !isRecord(value.RESULT)) return null;
  const code = value.RESULT.CODE;
  const message = value.RESULT.MESSAGE;
  return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

function responseError(code: string): NeisSchoolError {
  if (code === "ERROR-290") {
    return new NeisSchoolError(
      "NEIS_REQUEST_FAILED",
      "NEIS 인증에 실패했습니다. API 키를 확인해 주세요.",
    );
  }
  return new NeisSchoolError(
    "NEIS_REQUEST_FAILED",
    `NEIS가 요청을 처리하지 못했습니다. 응답 코드: ${code}`,
  );
}

function normalizedText(row: Record<string, unknown>, key: string, location: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new NeisSchoolError("INVALID_NEIS_RESPONSE", `${location}.${key}은 문자열이어야 합니다.`);
  }
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > 100) {
    throw new NeisSchoolError(
      "INVALID_NEIS_RESPONSE",
      `${location}.${key}은 trim 후 1~100자여야 합니다.`,
    );
  }
  return normalized;
}

function nullableText(
  row: Record<string, unknown>,
  key: string,
  maximum: number,
  location: string,
): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new NeisSchoolError(
      "INVALID_NEIS_RESPONSE",
      `${location}.${key}은 문자열 또는 null이어야 합니다.`,
    );
  }
  const normalized = value.trim();
  if (normalized === "") return null;
  if (Array.from(normalized).length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new NeisSchoolError(
      "INVALID_NEIS_RESPONSE",
      `${location}.${key}은 제어문자 없이 trim 후 1~${maximum}자여야 합니다.`,
    );
  }
  return normalized;
}

/*
 * 아래 두 항목은 나이스가 주는 값이고 우리가 품질을 통제할 수 없다. 실제 응답에는
 * 형식이 깨진 홈페이지 주소가 섞여 있고(2026-08-06 실측: 900번대 행에서 발견),
 * 예전에는 그런 값 하나가 동기화 전체를 중단시켰다. 학교 이름·코드는 멀쩡한데
 * 부가 정보 한 칸 때문에 전국 학교를 못 받는 것은 거부 범위가 잘못 잡힌 것이다.
 *
 * 그래서 이 둘만 "그 칸을 비우고 계속"으로 바꾼다. 안전성은 그대로다 — 이상한
 * 값은 여전히 저장되지 않는다. 학교 코드·이름 같은 필수 항목은 종전대로 중단시킨다.
 * 사람이 직접 쓴 시드 파일(school-seed.ts)은 오타를 알려주는 편이 맞으므로 건드리지 않는다.
 *
 * 대신 비운 칸은 세어서 동기화 요약에 내보낸다. 안 그러면 나이스 데이터 품질이
 * 나빠져도 아무 데도 안 남는다. `blanked`는 "값이 있었는데 못 받아들였다"는 뜻이고,
 * 원래 비어 있던 칸은 세지 않는다.
 */
interface OptionalField {
  blanked: boolean;
  value: string | null;
}

const ABSENT: OptionalField = { blanked: false, value: null };

function nullablePhoneNumber(row: Record<string, unknown>, location: string): OptionalField {
  const normalized = nullableText(row, "ORG_TELNO", 50, location);
  if (normalized === null) return ABSENT;
  const digitCount = normalized.replace(/\D/gu, "").length;
  if (digitCount < 3 || digitCount > 20) return { blanked: true, value: null };
  return { blanked: false, value: normalized };
}

function nullableHomepageUrl(row: Record<string, unknown>, location: string): OptionalField {
  const normalized = nullableText(row, "HMPG_ADRES", 500, location);
  if (normalized === null) return ABSENT;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/iu.test(normalized) ? normalized : `https://${normalized}`);
  } catch {
    return { blanked: true, value: null };
  }
  // 통과 조건은 종전과 똑같다 — 위험한 주소는 여전히 저장되지 않는다.
  // 달라진 것은 걸렸을 때의 처리뿐이다: 중단이 아니라 그 칸만 비운다.
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    Array.from(url.href).length > 500
  ) {
    return { blanked: true, value: null };
  }
  return { blanked: false, value: url.href };
}

function supportedSchoolKind(row: Record<string, unknown>, location: string): SchoolKind | null {
  const value = row.SCHUL_KND_SC_NM;
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new NeisSchoolError(
      "INVALID_NEIS_RESPONSE",
      `${location}.SCHUL_KND_SC_NM은 문자열이어야 합니다.`,
    );
  }
  const normalized = value.trim();
  if (normalized === "초등학교") return "elementary";
  if (normalized === "중학교") return "middle";
  if (normalized === "고등학교") return "high";
  return null;
}

function parseRows(
  rows: unknown[],
  context: NeisSchoolPageContext,
): Pick<
  NeisSchoolPage,
  | "blankedOptionalFieldCount"
  | "ignoredInvalidIdentifierCount"
  | "ignoredUnsupportedCount"
  | "items"
> {
  if (rows.length > context.pageSize) {
    throw new NeisSchoolError(
      "INVALID_NEIS_RESPONSE",
      "NEIS 학교 응답이 요청한 페이지 크기를 초과했습니다.",
    );
  }
  const uniqueKeys = new Set<string>();
  const items: SchoolSeedItem[] = [];
  let blankedOptionalFieldCount = 0;
  let ignoredInvalidIdentifierCount = 0;
  let ignoredUnsupportedCount = 0;
  rows.forEach((rawRow, index) => {
    const location = `schoolInfo.row[${index}]`;
    if (!isRecord(rawRow)) {
      throw new NeisSchoolError("INVALID_NEIS_RESPONSE", `${location}은 객체여야 합니다.`);
    }
    const schoolKind = supportedSchoolKind(rawRow, location);
    if (schoolKind === null) {
      ignoredUnsupportedCount += 1;
      return;
    }
    const eduOfficeCode = rawRow.ATPT_OFCDC_SC_CODE;
    const schoolCode = rawRow.SD_SCHUL_CODE;
    if (
      typeof eduOfficeCode !== "string" ||
      !/^[A-Z][0-9]{2}$/u.test(eduOfficeCode) ||
      typeof schoolCode !== "string" ||
      !/^[0-9]{7}$/u.test(schoolCode)
    ) {
      ignoredInvalidIdentifierCount += 1;
      return;
    }
    const uniqueKey = `${eduOfficeCode}:${schoolCode}`;
    if (uniqueKeys.has(uniqueKey)) {
      throw new NeisSchoolError("INVALID_NEIS_RESPONSE", `${location}에 중복 학교 key가 있습니다.`);
    }
    uniqueKeys.add(uniqueKey);
    const homepage = nullableHomepageUrl(rawRow, location);
    const phone = nullablePhoneNumber(rawRow, location);
    if (homepage.blanked) blankedOptionalFieldCount += 1;
    if (phone.blanked) blankedOptionalFieldCount += 1;
    items.push({
      eduOfficeCode,
      eduOfficeName: normalizedText(rawRow, "ATPT_OFCDC_SC_NM", location),
      homepageUrl: homepage.value,
      phoneNumber: phone.value,
      regionName: normalizedText(rawRow, "LCTN_SC_NM", location),
      roadAddress: nullableText(rawRow, "ORG_RDNMA", 200, location),
      roadAddressDetail: nullableText(rawRow, "ORG_RDNDA", 200, location),
      schoolCode,
      schoolKind,
      schoolName: normalizedText(rawRow, "SCHUL_NM", location),
    });
  });
  return {
    blankedOptionalFieldCount,
    ignoredInvalidIdentifierCount,
    ignoredUnsupportedCount,
    items,
  };
}

function integerTotalCount(value: unknown): number | null {
  const candidate = typeof value === "string" ? Number(value) : value;
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate < 0 ||
    candidate > MAX_SCHOOLS
  ) {
    return null;
  }
  return candidate;
}

export function parseNeisSchoolPage(
  value: unknown,
  context: NeisSchoolPageContext,
): NeisSchoolPage {
  validatePageContext(context);
  if (!isRecord(value)) {
    throw new NeisSchoolError("INVALID_NEIS_RESPONSE", "NEIS 응답 최상위 값이 객체가 아닙니다.");
  }

  const rootResult = safeResult(value);
  if (rootResult !== null) {
    if (rootResult.code === "INFO-200") {
      return {
        blankedOptionalFieldCount: 0,
        ignoredInvalidIdentifierCount: 0,
        ignoredUnsupportedCount: 0,
        items: [],
        totalCount: 0,
      };
    }
    throw responseError(rootResult.code);
  }

  const sections = value.schoolInfo;
  if (!Array.isArray(sections)) {
    throw new NeisSchoolError("INVALID_NEIS_RESPONSE", "NEIS 학교 응답에 schoolInfo가 없습니다.");
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
          totalCount = integerTotalCount(item.list_total_count);
        }
        const result = safeResult(item);
        if (result !== null) resultCode = result.code;
      }
    }
    if (Array.isArray(section.row)) rows = section.row;
  }

  if (resultCode === "INFO-200") {
    return {
      blankedOptionalFieldCount: 0,
      ignoredInvalidIdentifierCount: 0,
      ignoredUnsupportedCount: 0,
      items: [],
      totalCount: 0,
    };
  }
  if (resultCode !== "INFO-000") {
    if (resultCode !== null) throw responseError(resultCode);
    throw new NeisSchoolError("INVALID_NEIS_RESPONSE", "NEIS 정상 처리 코드가 없습니다.");
  }
  if (totalCount === null || rows === null) {
    throw new NeisSchoolError(
      "INVALID_NEIS_RESPONSE",
      "NEIS 학교 응답의 총건수 또는 행 구성이 올바르지 않습니다.",
    );
  }

  const offset = (context.pageIndex - 1) * context.pageSize;
  const expectedCount = offset >= totalCount ? 0 : Math.min(context.pageSize, totalCount - offset);
  if (rows.length !== expectedCount) {
    throw new NeisSchoolError(
      "INVALID_NEIS_RESPONSE",
      "NEIS 학교 응답의 총건수와 페이지 행 수가 일치하지 않습니다.",
    );
  }

  return { ...parseRows(rows, context), totalCount };
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

async function fetchSchoolPage(
  query: ValidatedNeisSchoolQuery,
  context: NeisSchoolPageContext,
  options: Required<Pick<FetchNeisSchoolsOptions, "retryDelayMs" | "timeoutMs">> & {
    fetchImplementation: typeof fetch;
  },
): Promise<NeisSchoolPage> {
  const url = new URL(NEIS_SCHOOL_ENDPOINT);
  url.searchParams.set("Type", "json");
  url.searchParams.set("KEY", query.apiKey);
  url.searchParams.set("pIndex", String(context.pageIndex));
  url.searchParams.set("pSize", String(context.pageSize));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    let shouldRetry = false;
    try {
      const response = await options.fetchImplementation(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (attempt === 0 && retryableStatus(response.status)) {
          shouldRetry = true;
        } else {
          throw new NeisSchoolError(
            "NEIS_REQUEST_FAILED",
            `NEIS HTTP 요청에 실패했습니다. 상태 코드: ${response.status}`,
          );
        }
      } else {
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
          throw new NeisSchoolError(
            "INVALID_NEIS_RESPONSE",
            "NEIS 학교 응답 크기가 제한을 초과했습니다.",
          );
        }
        let payload: unknown;
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          throw new NeisSchoolError(
            "INVALID_NEIS_RESPONSE",
            "NEIS 학교 응답이 올바른 JSON이 아닙니다.",
          );
        }
        return parseNeisSchoolPage(payload, context);
      }
    } catch (error) {
      if (error instanceof NeisSchoolError) throw error;
      if (attempt === 0) {
        shouldRetry = true;
      } else {
        throw new NeisSchoolError(
          "NEIS_REQUEST_FAILED",
          "NEIS 학교 요청에 두 번 연속 실패했습니다. 잠시 후 다시 시도해 주세요.",
        );
      }
    } finally {
      clearTimeout(timeout);
    }
    if (shouldRetry) await wait(options.retryDelayMs);
  }
  throw new NeisSchoolError("NEIS_REQUEST_FAILED", "NEIS 학교 요청에 실패했습니다.");
}

export async function fetchNeisSchools(
  rawQuery: NeisSchoolQuery,
  options: FetchNeisSchoolsOptions = {},
): Promise<NeisSchoolCatalog> {
  const query = validateNeisSchoolQuery(rawQuery);
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryDelayMs = options.retryDelayMs ?? 250;
  validatePageContext({ pageIndex: 1, pageSize });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new NeisSchoolError(
      "INVALID_NEIS_CONFIG",
      "NEIS 학교 요청 제한 시간이 올바르지 않습니다.",
    );
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000) {
    throw new NeisSchoolError(
      "INVALID_NEIS_CONFIG",
      "NEIS 학교 재시도 대기 시간이 올바르지 않습니다.",
    );
  }

  const fetchOptions = {
    fetchImplementation: options.fetchImplementation ?? fetch,
    retryDelayMs,
    timeoutMs,
  };
  const firstPage = await fetchSchoolPage(query, { pageIndex: 1, pageSize }, fetchOptions);
  if (firstPage.totalCount === 0) {
    throw new NeisSchoolError("INVALID_NEIS_RESPONSE", "NEIS 전국 학교 목록이 비어 있습니다.");
  }

  const schools = [...firstPage.items];
  let blankedOptionalFieldCount = firstPage.blankedOptionalFieldCount;
  let ignoredInvalidIdentifierCount = firstPage.ignoredInvalidIdentifierCount;
  let ignoredUnsupportedCount = firstPage.ignoredUnsupportedCount;
  const totalPages = Math.ceil(firstPage.totalCount / pageSize);
  for (let pageIndex = 2; pageIndex <= totalPages; pageIndex += 1) {
    const page = await fetchSchoolPage(query, { pageIndex, pageSize }, fetchOptions);
    if (page.totalCount !== firstPage.totalCount) {
      throw new NeisSchoolError(
        "INVALID_NEIS_RESPONSE",
        "NEIS 학교 총건수가 페이지 사이에서 변경되었습니다.",
      );
    }
    schools.push(...page.items);
    blankedOptionalFieldCount += page.blankedOptionalFieldCount;
    ignoredInvalidIdentifierCount += page.ignoredInvalidIdentifierCount;
    ignoredUnsupportedCount += page.ignoredUnsupportedCount;
  }
  if (schools.length === 0) {
    throw new NeisSchoolError(
      "INVALID_NEIS_RESPONSE",
      "NEIS 전국 학교 목록에 지원하는 초·중·고가 없습니다.",
    );
  }

  const uniqueKeys = new Set<string>();
  for (const school of schools) {
    const key = `${school.eduOfficeCode}:${school.schoolCode}`;
    if (uniqueKeys.has(key)) {
      throw new NeisSchoolError(
        "INVALID_NEIS_RESPONSE",
        "NEIS 학교 목록의 여러 페이지에 중복 학교 key가 있습니다.",
      );
    }
    uniqueKeys.add(key);
  }
  if (
    schools.length + ignoredInvalidIdentifierCount + ignoredUnsupportedCount !==
    firstPage.totalCount
  ) {
    throw new NeisSchoolError(
      "INVALID_NEIS_RESPONSE",
      "NEIS 학교 총건수와 포함·제외한 학교 수가 일치하지 않습니다.",
    );
  }

  return {
    blankedOptionalFieldCount,
    ignoredInvalidIdentifierCount,
    ignoredUnsupportedCount,
    items: schools.sort(
      (left, right) =>
        left.eduOfficeCode.localeCompare(right.eduOfficeCode, "en") ||
        left.schoolCode.localeCompare(right.schoolCode, "en"),
    ),
    sourceCount: firstPage.totalCount,
  };
}
