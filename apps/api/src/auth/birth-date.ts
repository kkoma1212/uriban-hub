import { BadRequestException, ConflictException } from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";
import { kstDate } from "../common/date/kst-date.js";

// 생년월일(2026-10-01 사용자 결정): 만 14세 자동 판단 · 담임 확인 · 동의한 학생의 생일 알림.
// DB 검사(1900-01-01 이상)와 같은 하한을 쓰고, 미래 날짜는 받지 않는다.
const BIRTH_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const EARLIEST_BIRTH_DATE = "1900-01-01";
const GUARDIAN_CONSENT_AGE = 14;

/** 실제 달력에 있는 YYYY-MM-DD이고, 1900-01-01부터 한국 날짜 기준 오늘까지인지. */
export function isAcceptableBirthDate(value: string, now: Date): boolean {
  const match = BIRTH_DATE_PATTERN.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const real =
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day;
  return real && value >= EARLIEST_BIRTH_DATE && value <= kstDate(now);
}

/** 한국 날짜 기준 만 나이. 2월 29일생은 평년에 3월 1일부터 한 살 더한다(민법 기준). */
export function koreanFullAge(birthDate: string, now: Date): number {
  const today = kstDate(now);
  const years = Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4));
  return today.slice(5) >= birthDate.slice(5) ? years : years - 1;
}

export function ageRouteForBirthDate(birthDate: string, now: Date): "guardian_consent" | "over_14" {
  return koreanFullAge(birthDate, now) >= GUARDIAN_CONSENT_AGE ? "over_14" : "guardian_consent";
}

/**
 * 가입: 2026-10-02 사용자 결정(P-025③)으로 생년월일은 교사·학생 모두 선택이다.
 * 입력했을 때만 날짜와 '고른 나이 경로와 일치'를 확인한다. 비우면 본인이 고른 나이 경로를 따른다.
 */
export function requireSignupBirthDate(
  input: { age_route: "guardian_consent" | "over_14"; birth_date?: string },
  installed: boolean,
  now: Date,
): string | undefined {
  if (!installed) {
    if (input.birth_date !== undefined)
      throw birthDateRejected("생년월일을 받을 수 없는 환경이에요.");
    return undefined;
  }
  if (input.birth_date === undefined) return undefined;
  if (!isAcceptableBirthDate(input.birth_date, now))
    throw birthDateRejected("생년월일을 확인해 주세요.");
  if (ageRouteForBirthDate(input.birth_date, now) !== input.age_route)
    throw birthDateRejected("생년월일과 나이 확인이 맞지 않아요.");
  return input.birth_date;
}

export function birthDateRejected(message: string): BadRequestException {
  return new BadRequestException({ code: ERROR_CODES.VALIDATION_FAILED, message });
}

export function birthDateConflict(message: string): ConflictException {
  return new ConflictException({ code: ERROR_CODES.CONFLICT, message });
}
