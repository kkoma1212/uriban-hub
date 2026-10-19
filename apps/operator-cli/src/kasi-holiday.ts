/*
 * 한국천문연구원 특일 정보(공공데이터포털)에서 그 해의 법정공휴일을 받아온다.
 *
 * 이 저장소의 NEIS 클라이언트(`neis-school-schedule.ts`)와 같은 뼈대를 쓴다 — 오류 코드
 * 분류, 429·5xx 한 번 재시도, 응답 크기 상한, JSON 파싱 방어. 새 방식을 발명하지 않는다.
 */

const KASI_HOLIDAY_ENDPOINT =
  "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_COUNT = 100;
const PAGE_SIZE = 100;
const MINIMUM_YEAR = 2020;
const MAXIMUM_YEAR = 2100;

/*
 * 근로자의 날은 이 목록에서 뺀다(2026-08-25 사용자 결정).
 *
 * 특일 정보는 나라 기준이라 5월 1일을 `isHoliday=Y` 로 준다. 맞는 말이지만 **학교는
 * 그날 정상 수업한다** — 교원은 근로기준법상 근로자가 아니라 쉬지 않고, 학생도 등교한다.
 * 이 제품은 학급 달력이므로 그날을 빨갛게 칠하면 "쉬는 날"이라고 잘못 알리게 된다.
 *
 * 권위 데이터를 우리가 걸러내는 유일한 자리다. 늘리지 않는다 — 늘어나는 순간 이 목록
 * 자체가 "우리가 판단하는 공휴일"이 되어 출처의 권위를 잃는다. 다른 날을 빼야 한다는
 * 요구가 오면 그건 정책 결정이므로 사용자에게 먼저 묻는다.
 *
 * 값은 공백을 지운 형태로 적는다 — 비교 전에 입력도 같은 형태로 만든다.
 */
const SCHOOL_WORKING_HOLIDAY_NAMES = new Set(["노동절", "근로자의날"]);

/**
 * 뺀 날의 **대체휴일도 함께 뺀다**(2026-08-25 사용자 결정).
 *
 * 2027년 목록에 `대체공휴일(노동절)` 이 5월 3일로 들어 있었다. 근로자의 날에 학교가
 * 안 쉬면 그 대체휴일에도 안 쉬는데, 이름이 달라 앞의 목록을 그냥 통과했다. 한쪽만
 * 거르면 "5월 1일은 검정인데 5월 3일은 빨강" 이라는 앞뒤 안 맞는 달력이 된다.
 */
function isSchoolWorkingDay(name: string): boolean {
  const compact = name.replace(/\s+/gu, "");
  if (SCHOOL_WORKING_HOLIDAY_NAMES.has(compact)) return true;
  const base = /^대체공휴일\((?<base>[^)]+)\)$/u.exec(compact)?.groups?.base;
  return base !== undefined && SCHOOL_WORKING_HOLIDAY_NAMES.has(base);
}

export interface KasiHoliday {
  /** `YYYY-MM-DD`. */
  date: string;
  name: string;
}

export interface KasiHolidayQuery {
  apiKey: string | undefined;
  year: number;
}

export type ValidatedKasiHolidayQuery = Omit<KasiHolidayQuery, "apiKey"> & { apiKey: string };

export interface FetchKasiHolidaysOptions {
  fetchImplementation?: typeof fetch;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export class KasiHolidayError extends Error {
  constructor(
    readonly code:
      | "INVALID_KASI_CONFIG"
      | "INVALID_KASI_QUERY"
      | "INVALID_KASI_RESPONSE"
      | "KASI_REQUEST_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "KasiHolidayError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 포털은 같은 키를 Encoding·Decoding 두 형태로 주고, 어느 쪽이 도는지 스스로도 단정하지
 * 않는다("구동되는 키를 사용하시기 바랍니다"). 그래서 받는 쪽에서 한 형태로 모은다.
 *
 * base64 인증키에는 `%` 가 나올 수 없으므로, `%` 가 있으면 이미 인코딩된 형태로 보고
 * 한 번 푼다. 이 한 줄이 없으면 `URL.searchParams` 가 다시 인코딩해 `%2B` 가 `%252B` 가
 * 되고 인증이 거부된다 — 이 API 에서 가장 흔한 실패다.
 */
export function normalizeKasiApiKey(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    /* 인코딩된 형태가 아니라 값 안에 `%` 가 그냥 들어 있는 경우. 원본을 그대로 쓴다. */
    return value;
  }
}

export function validateKasiHolidayQuery(query: KasiHolidayQuery): ValidatedKasiHolidayQuery {
  const apiKey = query.apiKey?.trim();
  if (apiKey === undefined || apiKey === "" || /[\r\n]/u.test(apiKey)) {
    throw new KasiHolidayError(
      "INVALID_KASI_CONFIG",
      "KASI_HOLIDAY_API_KEY is required and must not contain line breaks.",
    );
  }
  if (!Number.isInteger(query.year) || query.year < MINIMUM_YEAR || query.year > MAXIMUM_YEAR) {
    throw new KasiHolidayError(
      "INVALID_KASI_QUERY",
      `The holiday year must be an integer between ${MINIMUM_YEAR} and ${MAXIMUM_YEAR}.`,
    );
  }
  return { apiKey: normalizeKasiApiKey(apiKey), year: query.year };
}

/** `20260815` → `2026-08-15`. 그 해가 아닌 날짜는 응답이 어긋난 것이므로 거부한다. */
function parseLocalDate(value: unknown, year: number): string {
  const compact =
    typeof value === "number" && Number.isInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!/^\d{8}$/u.test(compact)) {
    throw new KasiHolidayError(
      "INVALID_KASI_RESPONSE",
      "The holiday response contained a date that is not in YYYYMMDD form.",
    );
  }
  const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new KasiHolidayError(
      "INVALID_KASI_RESPONSE",
      `The holiday response contained an impossible date: ${compact}`,
    );
  }
  if (!date.startsWith(`${year}-`)) {
    throw new KasiHolidayError(
      "INVALID_KASI_RESPONSE",
      `The holiday response returned ${date} for the year ${year}.`,
    );
  }
  return date;
}

function parseName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "" || name.length > 60 || /[\p{Cc}]/u.test(name)) {
    throw new KasiHolidayError(
      "INVALID_KASI_RESPONSE",
      "The holiday response contained a name that is empty or too long.",
    );
  }
  return name;
}

/** 응답의 `items` 는 0건이면 빈 문자열, 1건이면 객체, 여러 건이면 배열로 온다. */
function itemRows(body: Record<string, unknown>): unknown[] {
  const items = body.items;
  if (items === "" || items === undefined || items === null) return [];
  if (!isRecord(items)) {
    throw new KasiHolidayError(
      "INVALID_KASI_RESPONSE",
      "The holiday response items are malformed.",
    );
  }
  const item = items.item;
  if (item === undefined || item === null) return [];
  return Array.isArray(item) ? item : [item];
}

export function parseKasiHolidayResponse(payload: unknown, year: number): KasiHoliday[] {
  if (!isRecord(payload) || !isRecord(payload.response)) {
    throw new KasiHolidayError(
      "INVALID_KASI_RESPONSE",
      "The holiday response shape is unexpected.",
    );
  }
  const header = payload.response.header;
  if (!isRecord(header) || typeof header.resultCode !== "string") {
    throw new KasiHolidayError("INVALID_KASI_RESPONSE", "The holiday response header is missing.");
  }
  if (header.resultCode !== "00") {
    const message = typeof header.resultMsg === "string" ? header.resultMsg : "unknown";
    throw new KasiHolidayError(
      "KASI_REQUEST_FAILED",
      `The holiday service rejected the request. Response code: ${header.resultCode} (${message})`,
    );
  }
  const body = payload.response.body;
  if (!isRecord(body)) {
    throw new KasiHolidayError("INVALID_KASI_RESPONSE", "The holiday response body is missing.");
  }
  const totalCount = Number(body.totalCount ?? 0);
  if (!Number.isInteger(totalCount) || totalCount < 0 || totalCount > MAX_TOTAL_COUNT) {
    throw new KasiHolidayError(
      "INVALID_KASI_RESPONSE",
      `The holiday response reported an unusable total count: ${String(body.totalCount)}`,
    );
  }

  const byDate = new Map<string, KasiHoliday>();
  for (const row of itemRows(body)) {
    if (!isRecord(row)) {
      throw new KasiHolidayError("INVALID_KASI_RESPONSE", "A holiday row is malformed.");
    }
    /* 특일 정보는 공휴일이 아닌 기념일도 같은 표에 담아 준다. 쉬는 날만 가져온다. */
    if (row.isHoliday !== "Y") continue;
    const name = parseName(row.dateName);
    if (isSchoolWorkingDay(name)) continue;
    const date = parseLocalDate(row.locdate, year);
    /*
     * 설날·추석은 사흘이 같은 이름으로 오고, 드물게 한 날짜에 두 줄이 올 수 있다.
     * 표의 기본키가 날짜라 먼저 온 이름을 남긴다 — 순서는 응답이 날짜순이라 안정적이다.
     */
    if (!byDate.has(date)) byDate.set(date, { date, name });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
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

export async function fetchKasiHolidays(
  query: KasiHolidayQuery,
  options: FetchKasiHolidaysOptions = {},
): Promise<KasiHoliday[]> {
  const validated = validateKasiHolidayQuery(query);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const url = new URL(KASI_HOLIDAY_ENDPOINT);
  url.searchParams.set("serviceKey", validated.apiKey);
  url.searchParams.set("solYear", String(validated.year));
  url.searchParams.set("numOfRows", String(PAGE_SIZE));
  url.searchParams.set("pageNo", "1");
  /* 포털 기본 응답은 XML 이다. JSON 을 달라고 해야 파서를 새로 들이지 않는다. */
  url.searchParams.set("_type", "json");

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
          throw new KasiHolidayError(
            "KASI_REQUEST_FAILED",
            `The holiday request failed with HTTP ${response.status}.`,
          );
        }
      } else {
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
          throw new KasiHolidayError(
            "INVALID_KASI_RESPONSE",
            "The holiday response exceeds the configured size limit.",
          );
        }
        let payload: unknown;
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          /*
           * 인증 실패 때 포털은 JSON 을 요청해도 XML 오류 문서를 돌려준다. 파싱 실패를
           * "응답이 이상하다"로 뭉뚱그리면 원인을 못 찾으므로 여기서 갈라 말해준다.
           */
          throw new KasiHolidayError(
            "KASI_REQUEST_FAILED",
            "The holiday service returned a non-JSON document. This usually means the API key was rejected.",
          );
        }
        return parseKasiHolidayResponse(payload, validated.year);
      }
    } finally {
      clearTimeout(timeout);
    }
    if (shouldRetry) await wait(retryDelayMs);
  }

  throw new KasiHolidayError("KASI_REQUEST_FAILED", "The holiday request could not be completed.");
}
