import { describe, expect, it } from "vitest";

import {
  KasiHolidayError,
  normalizeKasiApiKey,
  parseKasiHolidayResponse,
  validateKasiHolidayQuery,
} from "./kasi-holiday.js";

function response(items: unknown, totalCount = Array.isArray(items) ? items.length : 1): unknown {
  return {
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
      body: { items: items === null ? "" : { item: items }, numOfRows: 100, pageNo: 1, totalCount },
    },
  };
}

function holiday(locdate: number, dateName: string, isHoliday = "Y"): unknown {
  return { dateKind: "01", dateName, isHoliday, locdate, seq: 1 };
}

describe("KASI public holiday client", () => {
  it("normalizes an encoded service key exactly once and leaves a raw key alone", () => {
    /*
     * 포털은 같은 키를 두 형태로 준다. 인코딩된 쪽을 그대로 URL 에 넣으면
     * `searchParams` 가 한 번 더 인코딩해 인증이 깨진다 — 이 API 의 대표 실패다.
     */
    expect(normalizeKasiApiKey("ab%2Bcd%2Fef%3D%3D")).toBe("ab+cd/ef==");
    expect(normalizeKasiApiKey("ab+cd/ef==")).toBe("ab+cd/ef==");
    // 인코딩이 깨진 값이 와도 던지지 않고 원본을 쓴다(무엇이 문제인지는 서버가 말해준다).
    expect(normalizeKasiApiKey("100%")).toBe("100%");
  });

  it("refuses a missing key or an out-of-range year", () => {
    expect(() => validateKasiHolidayQuery({ apiKey: undefined, year: 2026 })).toThrow(
      KasiHolidayError,
    );
    expect(() => validateKasiHolidayQuery({ apiKey: "  ", year: 2026 })).toThrow(KasiHolidayError);
    expect(() => validateKasiHolidayQuery({ apiKey: "key\nkey", year: 2026 })).toThrow(
      KasiHolidayError,
    );
    expect(() => validateKasiHolidayQuery({ apiKey: "key", year: 1999 })).toThrow(KasiHolidayError);
    expect(() => validateKasiHolidayQuery({ apiKey: "key", year: 2026.5 })).toThrow(
      KasiHolidayError,
    );
    expect(validateKasiHolidayQuery({ apiKey: " key ", year: 2026 })).toEqual({
      apiKey: "key",
      year: 2026,
    });
  });

  it("keeps only real days off and turns compact dates into ISO dates", () => {
    const holidays = parseKasiHolidayResponse(
      response([
        holiday(20260815, "광복절"),
        holiday(20260817, "대체공휴일(광복절)"),
        // 기념일은 같은 표에 담겨 오지만 쉬는 날이 아니다.
        holiday(20260601, "의병의 날", "N"),
      ]),
      2026,
    );
    expect(holidays).toEqual([
      { date: "2026-08-15", name: "광복절" },
      { date: "2026-08-17", name: "대체공휴일(광복절)" },
    ]);
  });

  it("drops labour day and its substitute because schools stay open on both", () => {
    /*
     * 이 제품이 권위 데이터를 걸러내는 유일한 자리다(2026-08-25 사용자 결정).
     * 나라 기준으로는 공휴일이지만 교원·학생은 그날 학교에 있다.
     *
     * 덫: `대체공휴일(노동절)` 은 이름이 달라 앞의 목록을 그냥 통과했다 — 실제로 2027년
     * 자료에 5월 3일로 들어 있었다. 한쪽만 거르면 5/1 은 검정, 5/3 은 빨강이 된다.
     */
    const holidays = parseKasiHolidayResponse(
      response([
        holiday(20270501, "노동절"),
        holiday(20270503, "대체공휴일(노동절)"),
        holiday(20270505, "어린이날"),
      ]),
      2027,
    );
    expect(holidays).toEqual([{ date: "2027-05-05", name: "어린이날" }]);
  });

  it("keeps substitutes of holidays schools actually observe", () => {
    /* 거르는 것은 근로자의 날 계열뿐이다. 나머지 대체공휴일은 그대로 빨간 날이다. */
    const holidays = parseKasiHolidayResponse(
      response([
        holiday(20270209, "대체공휴일(설날)"),
        holiday(20271227, "대체공휴일(기독탄신일)"),
      ]),
      2027,
    );
    expect(holidays.map((entry) => entry.name)).toEqual([
      "대체공휴일(설날)",
      "대체공휴일(기독탄신일)",
    ]);
  });

  it("accepts the single-item and empty shapes the portal returns", () => {
    expect(parseKasiHolidayResponse(response(holiday(20260101, "1월1일")), 2026)).toEqual([
      { date: "2026-01-01", name: "1월1일" },
    ]);
    expect(parseKasiHolidayResponse(response(null, 0), 2026)).toEqual([]);
  });

  it("keeps one row per date and sorts by date", () => {
    const holidays = parseKasiHolidayResponse(
      response([
        holiday(20260926, "추석"),
        holiday(20260924, "추석"),
        holiday(20260924, "추석 중복"),
        holiday(20260925, "추석"),
      ]),
      2026,
    );
    expect(holidays.map((entry) => entry.date)).toEqual(["2026-09-24", "2026-09-25", "2026-09-26"]);
    expect(holidays[0]).toEqual({ date: "2026-09-24", name: "추석" });
  });

  it("rejects a service error, a foreign year, and an impossible date", () => {
    expect(() =>
      parseKasiHolidayResponse(
        { response: { header: { resultCode: "30", resultMsg: "SERVICE KEY IS NOT REGISTERED" } } },
        2026,
      ),
    ).toThrow(/Response code: 30/u);
    // 2026년을 물었는데 2027년이 오면 응답이 어긋난 것이다. 조용히 넣으면 달력이 틀어진다.
    expect(() => parseKasiHolidayResponse(response([holiday(20270101, "1월1일")]), 2026)).toThrow(
      /returned 2027-01-01 for the year 2026/u,
    );
    expect(() => parseKasiHolidayResponse(response([holiday(20260230, "없는 날")]), 2026)).toThrow(
      /impossible date/u,
    );
    expect(() => parseKasiHolidayResponse(response([holiday(2026081, "짧은 날")]), 2026)).toThrow(
      /YYYYMMDD/u,
    );
  });

  it("rejects a total count that could not come from one year", () => {
    expect(() =>
      parseKasiHolidayResponse(response([holiday(20260101, "1월1일")], 5000), 2026),
    ).toThrow(/unusable total count/u);
  });
});
