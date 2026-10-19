import { describe, expect, it } from "vitest";

import {
  ageRouteForBirthDate,
  formatBirthMonthDay,
  isAcceptableBirthDate,
  koreanFullAge,
} from "./birth-date";

// 서버(apps/api/src/auth/birth-date.spec.ts)와 같은 경계 — 화면 안내와 서버 판정이 어긋나지 않게.
const now = new Date("2026-10-01T01:00:00.000Z");

describe("birth date rules on the sign-up screen", () => {
  it("matches the server's date range and calendar checks", () => {
    expect(isAcceptableBirthDate("2012-02-29", now)).toBe(true);
    expect(isAcceptableBirthDate("2013-02-29", now)).toBe(false);
    expect(isAcceptableBirthDate("1899-12-31", now)).toBe(false);
    expect(isAcceptableBirthDate("2026-10-01", now)).toBe(true);
    expect(isAcceptableBirthDate("2026-10-02", now)).toBe(false);
  });

  it("matches the server's full age and age route", () => {
    expect(koreanFullAge("2012-10-01", now)).toBe(14);
    expect(ageRouteForBirthDate("2012-10-02", now)).toBe("guardian_consent");
    expect(koreanFullAge("2012-02-29", new Date("2026-02-28T03:00:00.000Z"))).toBe(13);
    expect(koreanFullAge("2012-02-29", new Date("2026-03-01T03:00:00.000Z"))).toBe(14);
  });

  it("formats a birthday without the year", () => {
    expect(formatBirthMonthDay("2011-03-05")).toBe("3월 5일");
  });
});
