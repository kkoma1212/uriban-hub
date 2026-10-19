const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function kstFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", ...options });
}

const CALENDAR_DATE_FORMATTER = kstFormatter({
  day: "numeric",
  month: "long",
  weekday: "long",
});

const DATE_TIME_FORMATTER = kstFormatter({
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "long",
});

const DATE_TIME_WITH_WEEKDAY_FORMATTER = kstFormatter({
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "long",
  weekday: "long",
});

const DATE_TIME_WITH_SHORT_WEEKDAY_FORMATTER = kstFormatter({
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "long",
  weekday: "short",
});

const DATE_TIME_WITH_YEAR_AND_SHORT_WEEKDAY_FORMATTER = kstFormatter({
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "long",
  weekday: "short",
  year: "numeric",
});

const DATE_TIME_WITH_YEAR_FORMATTER = kstFormatter({
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "long",
  year: "numeric",
});

const TIME_OF_DAY_FORMATTER = kstFormatter({ hour: "numeric", minute: "2-digit" });

const MONTH_NUMERIC_FORMATTER = kstFormatter({ month: "numeric" });

function formatTimestamp(formatter: Intl.DateTimeFormat, value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatter.format(date);
}

/** `YYYY-MM-DD` → `7월 25일 토요일`. 형식이 다르거나 무효하면 입력을 그대로 돌려준다. */
export function formatKstCalendarDate(value: string): string {
  if (!CALENDAR_DATE_PATTERN.test(value)) return value;
  return formatTimestamp(CALENDAR_DATE_FORMATTER, `${value}T00:00:00+09:00`);
}

/** ISO 타임스탬프 → `7월 25일 오후 2:05`. 무효하면 입력을 그대로 돌려준다. */
export function formatKstDateTime(value: string): string {
  return formatTimestamp(DATE_TIME_FORMATTER, value);
}

/** ISO 타임스탬프 → `7월 25일 오후 2:05`, 무효하면 null. (급식 출처 갱신 시각용) */
export function formatKstDateTimeOrNull(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : DATE_TIME_FORMATTER.format(date);
}

/** ISO 타임스탬프 → `7월 25일 토요일 오후 2:05`. 무효하면 입력을 그대로 돌려준다. */
export function formatKstDateTimeWithWeekday(value: string): string {
  return formatTimestamp(DATE_TIME_WITH_WEEKDAY_FORMATTER, value);
}

/** ISO 타임스탬프 → `7월 25일 (토) 오후 2:05`. 무효하면 입력을 그대로 돌려준다. */
export function formatKstDateTimeWithShortWeekday(value: string): string {
  return formatTimestamp(DATE_TIME_WITH_SHORT_WEEKDAY_FORMATTER, value);
}

/** ISO 타임스탬프 → `2026년 7월 25일 토 오후 2:05`. 무효하면 입력을 그대로 돌려준다. */
export function formatKstDateTimeWithYearAndShortWeekday(value: string): string {
  return formatTimestamp(DATE_TIME_WITH_YEAR_AND_SHORT_WEEKDAY_FORMATTER, value);
}

/** ISO 타임스탬프 → `2026년 7월 25일 오후 2:05`. 무효하면 입력을 그대로 돌려준다. */
export function formatKstDateTimeWithYear(value: string): string {
  return formatTimestamp(DATE_TIME_WITH_YEAR_FORMATTER, value);
}

/** ISO 타임스탬프 → `오후 2:05`. null은 null로, 무효하면 입력을 그대로 돌려준다. */
export function formatKstTimeOfDay(value: string | null): string | null {
  if (value === null) return null;
  return formatTimestamp(TIME_OF_DAY_FORMATTER, value);
}

/** 현재(또는 지정) 시점의 KST 월 라벨 — `7월`. 자리·모둠 기본 제목에 쓴다. */
export function formatKstCurrentMonth(now: Date = new Date()): string {
  return MONTH_NUMERIC_FORMATTER.format(now);
}
