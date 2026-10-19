// 나이스 학사일정(SchoolSchedule) 조회·검증. 2026-09-30 운영자 명령에서 옮겨 와 웹 서버(학사일정 바로 가져오기)와 함께 쓴다.
const NEIS_SCHOOL_SCHEDULE_ENDPOINT = "https://open.neis.go.kr/hub/SchoolSchedule";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_COUNT = 5_000;
const PAGE_SIZE = 1_000;
const GRADE_FIELDS = [
  "ONE_GRADE_EVENT_YN",
  "TW_GRADE_EVENT_YN",
  "THREE_GRADE_EVENT_YN",
  "FR_GRADE_EVENT_YN",
  "FIV_GRADE_EVENT_YN",
  "SIX_GRADE_EVENT_YN",
] as const;

export interface NeisSchoolSchedule {
  academicYear: number;
  eduOfficeCode: string;
  eventContent: string | null;
  eventDate: string;
  eventName: string;
  gradeMask: number;
  schoolCode: string;
  schoolDayType: string;
  sourceLoadedOn: string;
}

export interface NeisSchoolScheduleQuery {
  apiKey: string | undefined;
  eduOfficeCode: string;
  from: string;
  schoolCode: string;
  to: string;
}

export interface FetchNeisSchoolSchedulesOptions {
  fetchImplementation?: typeof fetch;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export type ValidatedNeisSchoolScheduleQuery = Omit<NeisSchoolScheduleQuery, "apiKey"> & {
  apiKey: string;
};

export class NeisSchoolScheduleError extends Error {
  constructor(
    readonly code:
      | "INVALID_NEIS_CONFIG"
      | "INVALID_NEIS_QUERY"
      | "INVALID_NEIS_RESPONSE"
      | "NEIS_REQUEST_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "NeisSchoolScheduleError";
  }
}

interface ParsedPage {
  events: NeisSchoolSchedule[];
  totalCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function compactDate(value: unknown, location: string, allowTimestamp = false): string {
  if (
    typeof value !== "string" ||
    (allowTimestamp ? !/^(?:\d{8}|\d{14})$/u.test(value) : !/^\d{8}$/u.test(value))
  ) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      `${location} must be an 8-digit NEIS date${allowTimestamp ? " or 14-digit timestamp" : ""}.`,
    );
  }
  const compact = value.slice(0, 8);
  const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  if (!isValidDate(date)) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      `${location} is not a valid calendar date.`,
    );
  }
  return date;
}

export function validateNeisSchoolScheduleQuery(
  query: NeisSchoolScheduleQuery,
): ValidatedNeisSchoolScheduleQuery {
  const apiKey = query.apiKey?.trim();
  if (apiKey === undefined || apiKey === "" || /[\r\n]/u.test(apiKey)) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_CONFIG",
      "NEIS_API_KEY is required and must not contain line breaks.",
    );
  }
  if (!/^[A-Z][0-9]{2}$/u.test(query.eduOfficeCode)) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_QUERY",
      "The education office code must be one uppercase letter followed by two digits.",
    );
  }
  if (!/^[0-9]{7}$/u.test(query.schoolCode)) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_QUERY",
      "The school code must contain seven digits.",
    );
  }
  if (!isValidDate(query.from) || !isValidDate(query.to)) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_QUERY",
      "The start and end dates must be valid calendar dates.",
    );
  }
  const from = new Date(`${query.from}T00:00:00.000Z`);
  const to = new Date(`${query.to}T00:00:00.000Z`);
  const daySpan = Math.floor((to.getTime() - from.getTime()) / 86_400_000);
  if (daySpan < 0 || daySpan > 369) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_QUERY",
      "A school schedule request must cover between 1 and 370 inclusive days.",
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

function responseError(code: string): NeisSchoolScheduleError {
  if (code === "ERROR-290") {
    return new NeisSchoolScheduleError(
      "NEIS_REQUEST_FAILED",
      "NEIS authentication failed. Check the configured API key.",
    );
  }
  return new NeisSchoolScheduleError(
    "NEIS_REQUEST_FAILED",
    `NEIS could not process the school schedule request. Response code: ${code}`,
  );
}

function requiredString(row: Record<string, unknown>, key: string, location: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      `${location}.${key} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function optionalString(
  row: Record<string, unknown>,
  key: string,
  location: string,
  maxLength: number,
): string | null {
  const value = row[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      `${location}.${key} must be a string when present.`,
    );
  }
  const normalized = value.trim();
  if (normalized === "") return null;
  if (normalized.length > maxLength) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      `${location}.${key} exceeds ${maxLength} characters.`,
    );
  }
  return normalized;
}

function parseAcademicYear(value: unknown, location: string): number {
  if (typeof value !== "string" || !/^\d{4}$/u.test(value)) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      `${location} must be a four-digit year.`,
    );
  }
  const year = Number(value);
  if (year < 2020 || year > 2100) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      `${location} is outside the supported academic year range.`,
    );
  }
  return year;
}

function parseGradeMask(row: Record<string, unknown>, location: string): number {
  let gradeMask = 0;
  GRADE_FIELDS.forEach((field, index) => {
    const value = row[field];
    if (value !== "Y" && value !== "N" && value !== "*") {
      throw new NeisSchoolScheduleError(
        "INVALID_NEIS_RESPONSE",
        `${location}.${field} must be Y, N, or *.`,
      );
    }
    if (value === "Y") gradeMask |= 1 << index;
  });
  if (gradeMask === 0) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      `${location} does not target any grade.`,
    );
  }
  return gradeMask;
}

function naturalKey(event: NeisSchoolSchedule): string {
  return [
    event.eduOfficeCode,
    event.schoolCode,
    event.academicYear,
    event.eventDate,
    event.eventName,
    event.gradeMask,
  ].join("\u001f");
}

function parseRows(
  rows: unknown[],
  query: ValidatedNeisSchoolScheduleQuery,
  pageIndex: number,
): NeisSchoolSchedule[] {
  if (rows.length > PAGE_SIZE) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      "The NEIS school schedule page exceeds the configured limit.",
    );
  }
  return rows.map((rawRow, index) => {
    const location = `SchoolSchedule.page[${pageIndex}].row[${index}]`;
    if (!isRecord(rawRow)) {
      throw new NeisSchoolScheduleError("INVALID_NEIS_RESPONSE", `${location} must be an object.`);
    }
    const eduOfficeCode = requiredString(rawRow, "ATPT_OFCDC_SC_CODE", location);
    const schoolCode = requiredString(rawRow, "SD_SCHUL_CODE", location);
    if (eduOfficeCode !== query.eduOfficeCode || schoolCode !== query.schoolCode) {
      throw new NeisSchoolScheduleError(
        "INVALID_NEIS_RESPONSE",
        `${location} does not belong to the requested school.`,
      );
    }
    const eventDate = compactDate(rawRow.AA_YMD, `${location}.AA_YMD`);
    if (eventDate < query.from || eventDate > query.to) {
      throw new NeisSchoolScheduleError(
        "INVALID_NEIS_RESPONSE",
        `${location}.AA_YMD is outside the requested date range.`,
      );
    }
    const eventName = requiredString(rawRow, "EVENT_NM", location);
    if (eventName.length > 200) {
      throw new NeisSchoolScheduleError(
        "INVALID_NEIS_RESPONSE",
        `${location}.EVENT_NM exceeds 200 characters.`,
      );
    }
    const schoolDayType = requiredString(rawRow, "SBTR_DD_SC_NM", location);
    if (schoolDayType.length > 30) {
      throw new NeisSchoolScheduleError(
        "INVALID_NEIS_RESPONSE",
        `${location}.SBTR_DD_SC_NM exceeds 30 characters.`,
      );
    }
    return {
      academicYear: parseAcademicYear(rawRow.AY, `${location}.AY`),
      eduOfficeCode,
      eventContent: optionalString(rawRow, "EVENT_CNTNT", location, 2_000),
      eventDate,
      eventName,
      gradeMask: parseGradeMask(rawRow, location),
      schoolCode,
      schoolDayType,
      sourceLoadedOn: compactDate(rawRow.LOAD_DTM, `${location}.LOAD_DTM`, true),
    };
  });
}

function parseNeisSchoolSchedulePage(
  value: unknown,
  query: ValidatedNeisSchoolScheduleQuery,
  pageIndex: number,
): ParsedPage {
  if (!isRecord(value)) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      "The NEIS response root must be an object.",
    );
  }

  const rootResult = safeResult(value);
  if (rootResult !== null) {
    if (rootResult.code === "INFO-200") return { events: [], totalCount: 0 };
    throw responseError(rootResult.code);
  }

  const sections = value.SchoolSchedule;
  if (!Array.isArray(sections)) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      "The NEIS response does not contain SchoolSchedule.",
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

  if (resultCode === "INFO-200") return { events: [], totalCount: 0 };
  if (resultCode !== "INFO-000") {
    if (resultCode !== null) throw responseError(resultCode);
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      "The NEIS success result code is missing.",
    );
  }
  if (totalCount === null || totalCount > MAX_TOTAL_COUNT || rows === null) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      "The NEIS school schedule count or page structure is invalid.",
    );
  }
  const expectedRows = Math.max(0, Math.min(PAGE_SIZE, totalCount - (pageIndex - 1) * PAGE_SIZE));
  if (rows.length !== expectedRows) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      "The NEIS school schedule page is incomplete.",
    );
  }
  return { events: parseRows(rows, query, pageIndex), totalCount };
}

export function parseNeisSchoolScheduleResponse(
  value: unknown,
  rawQuery: NeisSchoolScheduleQuery,
): NeisSchoolSchedule[] {
  const query = validateNeisSchoolScheduleQuery(rawQuery);
  const page = parseNeisSchoolSchedulePage(value, query, 1);
  if (page.totalCount > PAGE_SIZE) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      "The response requires pagination; use fetchNeisSchoolSchedules.",
    );
  }
  const seen = new Set<string>();
  for (const event of page.events) {
    const key = naturalKey(event);
    if (seen.has(key)) {
      throw new NeisSchoolScheduleError(
        "INVALID_NEIS_RESPONSE",
        "The NEIS response contains a duplicate school event.",
      );
    }
    seen.add(key);
  }
  return page.events.sort(compareEvents);
}

function compactQueryDate(value: string): string {
  return value.replaceAll("-", "");
}

function compareEvents(left: NeisSchoolSchedule, right: NeisSchoolSchedule): number {
  return (
    left.eventDate.localeCompare(right.eventDate) ||
    left.eventName.localeCompare(right.eventName, "ko") ||
    left.gradeMask - right.gradeMask
  );
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

async function requestPage(
  query: ValidatedNeisSchoolScheduleQuery,
  pageIndex: number,
  fetchImplementation: typeof fetch,
  retryDelayMs: number,
  timeoutMs: number,
): Promise<ParsedPage> {
  const url = new URL(NEIS_SCHOOL_SCHEDULE_ENDPOINT);
  url.searchParams.set("Type", "json");
  url.searchParams.set("KEY", query.apiKey);
  url.searchParams.set("pIndex", String(pageIndex));
  url.searchParams.set("pSize", String(PAGE_SIZE));
  url.searchParams.set("ATPT_OFCDC_SC_CODE", query.eduOfficeCode);
  url.searchParams.set("SD_SCHUL_CODE", query.schoolCode);
  url.searchParams.set("AA_FROM_YMD", compactQueryDate(query.from));
  url.searchParams.set("AA_TO_YMD", compactQueryDate(query.to));

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
          throw new NeisSchoolScheduleError(
            "NEIS_REQUEST_FAILED",
            `The NEIS school schedule request failed with HTTP ${response.status}.`,
          );
        }
      } else {
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
          throw new NeisSchoolScheduleError(
            "INVALID_NEIS_RESPONSE",
            "The NEIS school schedule response exceeds the configured size limit.",
          );
        }
        let payload: unknown;
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          throw new NeisSchoolScheduleError(
            "INVALID_NEIS_RESPONSE",
            "The NEIS school schedule response is not valid JSON.",
          );
        }
        return parseNeisSchoolSchedulePage(payload, query, pageIndex);
      }
    } catch (error) {
      if (error instanceof NeisSchoolScheduleError) throw error;
      if (attempt === 0) {
        shouldRetry = true;
      } else {
        throw new NeisSchoolScheduleError(
          "NEIS_REQUEST_FAILED",
          "The NEIS school schedule request failed twice.",
        );
      }
    } finally {
      clearTimeout(timeout);
    }
    if (shouldRetry) await wait(retryDelayMs);
  }
  throw new NeisSchoolScheduleError(
    "NEIS_REQUEST_FAILED",
    "The NEIS school schedule request failed.",
  );
}

export async function fetchNeisSchoolSchedules(
  rawQuery: NeisSchoolScheduleQuery,
  options: FetchNeisSchoolSchedulesOptions = {},
): Promise<NeisSchoolSchedule[]> {
  const query = validateNeisSchoolScheduleQuery(rawQuery);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryDelayMs = options.retryDelayMs ?? 250;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_CONFIG",
      "The NEIS timeout must be between 1 and 60000 milliseconds.",
    );
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_CONFIG",
      "The NEIS retry delay must be between 0 and 10000 milliseconds.",
    );
  }

  const firstPage = await requestPage(query, 1, fetchImplementation, retryDelayMs, timeoutMs);
  const events = [...firstPage.events];
  const pageCount = Math.ceil(firstPage.totalCount / PAGE_SIZE);
  for (let pageIndex = 2; pageIndex <= pageCount; pageIndex += 1) {
    const page = await requestPage(query, pageIndex, fetchImplementation, retryDelayMs, timeoutMs);
    if (page.totalCount !== firstPage.totalCount) {
      throw new NeisSchoolScheduleError(
        "INVALID_NEIS_RESPONSE",
        "The NEIS total count changed while paging school schedules.",
      );
    }
    events.push(...page.events);
  }
  if (events.length !== firstPage.totalCount) {
    throw new NeisSchoolScheduleError(
      "INVALID_NEIS_RESPONSE",
      "The fetched NEIS school schedule count is incomplete.",
    );
  }

  const seen = new Set<string>();
  for (const event of events) {
    const key = naturalKey(event);
    if (seen.has(key)) {
      throw new NeisSchoolScheduleError(
        "INVALID_NEIS_RESPONSE",
        "The NEIS response contains a duplicate school event.",
      );
    }
    seen.add(key);
  }
  return events.sort(compareEvents);
}
