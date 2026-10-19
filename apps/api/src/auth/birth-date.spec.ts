import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import {
  ageRouteForBirthDate,
  isAcceptableBirthDate,
  koreanFullAge,
  requireSignupBirthDate,
} from "./birth-date.js";

// 2026-10-01 10:00 KST = 01:00 UTC. 한국 날짜는 UTC보다 하루 앞설 수 있다.
const now = new Date("2026-10-01T01:00:00.000Z");

describe("birth date rules", () => {
  it("accepts only real calendar dates from 1900-01-01 to today in Korea", () => {
    expect(isAcceptableBirthDate("2012-02-29", now)).toBe(true);
    expect(isAcceptableBirthDate("2013-02-29", now)).toBe(false);
    expect(isAcceptableBirthDate("2012-13-01", now)).toBe(false);
    expect(isAcceptableBirthDate("1899-12-31", now)).toBe(false);
    expect(isAcceptableBirthDate("1900-01-01", now)).toBe(true);
    expect(isAcceptableBirthDate("2026-10-01", now)).toBe(true);
    expect(isAcceptableBirthDate("2026-10-02", now)).toBe(false);
    expect(isAcceptableBirthDate("2012-2-9", now)).toBe(false);
  });

  it("uses the Korean date, not UTC, for today", () => {
    // 2026-09-30 23:30 UTC = 2026-10-01 08:30 KST
    const lateUtc = new Date("2026-09-30T23:30:00.000Z");
    expect(isAcceptableBirthDate("2026-10-01", lateUtc)).toBe(true);
    expect(koreanFullAge("2012-10-01", lateUtc)).toBe(14);
  });

  it("counts full age the day of the birthday, not before", () => {
    expect(koreanFullAge("2012-10-01", now)).toBe(14);
    expect(koreanFullAge("2012-10-02", now)).toBe(13);
    expect(ageRouteForBirthDate("2012-10-01", now)).toBe("over_14");
    expect(ageRouteForBirthDate("2012-10-02", now)).toBe("guardian_consent");
  });

  it("treats a 29 February birthday as reached on 1 March in common years", () => {
    expect(koreanFullAge("2012-02-29", new Date("2027-02-28T03:00:00.000Z"))).toBe(14);
    expect(koreanFullAge("2012-02-29", new Date("2026-02-28T03:00:00.000Z"))).toBe(13);
    expect(koreanFullAge("2012-02-29", new Date("2026-03-01T03:00:00.000Z"))).toBe(14);
  });

  it("accepts an optional birth date that must match the chosen age route when given", () => {
    expect(requireSignupBirthDate({ age_route: "over_14" }, false, now)).toBeUndefined();
    expect(() =>
      requireSignupBirthDate({ age_route: "over_14", birth_date: "2000-01-01" }, false, now),
    ).toThrow(BadRequestException);
    // 2026-10-02 사용자 결정(P-025③): 받을 수 있는 환경에서도 비워 둘 수 있다.
    expect(requireSignupBirthDate({ age_route: "over_14" }, true, now)).toBeUndefined();
    expect(() =>
      requireSignupBirthDate({ age_route: "over_14", birth_date: "2099-01-01" }, true, now),
    ).toThrow(BadRequestException);
    expect(
      requireSignupBirthDate({ age_route: "over_14", birth_date: "2000-01-01" }, true, now),
    ).toBe("2000-01-01");
    expect(() =>
      requireSignupBirthDate({ age_route: "over_14", birth_date: "2015-05-05" }, true, now),
    ).toThrow(BadRequestException);
    expect(
      requireSignupBirthDate(
        { age_route: "guardian_consent", birth_date: "2015-05-05" },
        true,
        now,
      ),
    ).toBe("2015-05-05");
  });
});
