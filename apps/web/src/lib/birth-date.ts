// 생년월일 규칙 — 서버(apps/api/src/auth/birth-date.ts)와 같다. 화면은 미리 안내만 하고 판정은 서버가 한다.
const BIRTH_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
export const EARLIEST_BIRTH_DATE = "1900-01-01";

/** 한국 날짜 기준 오늘(YYYY-MM-DD). */
export function kstToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul",
    year: "numeric",
  }).formatToParts(now);
  const value = (type: "day" | "month" | "year"): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function isAcceptableBirthDate(value: string, now: Date = new Date()): boolean {
  const match = BIRTH_DATE_PATTERN.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const real =
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day;
  return real && value >= EARLIEST_BIRTH_DATE && value <= kstToday(now);
}

/** 한국 날짜 기준 만 나이. 2월 29일생은 평년에 3월 1일부터 한 살 더한다. */
export function koreanFullAge(birthDate: string, now: Date = new Date()): number {
  const today = kstToday(now);
  const years = Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4));
  return today.slice(5) >= birthDate.slice(5) ? years : years - 1;
}

export function ageRouteForBirthDate(
  birthDate: string,
  now: Date = new Date(),
): "guardian_consent" | "over_14" {
  return koreanFullAge(birthDate, now) >= 14 ? "over_14" : "guardian_consent";
}

/** 생일 표시용 "3월 5일" — 태어난 해는 보이지 않는다. */
export function formatBirthMonthDay(birthDate: string): string {
  return `${Number(birthDate.slice(5, 7))}월 ${Number(birthDate.slice(8, 10))}일`;
}
