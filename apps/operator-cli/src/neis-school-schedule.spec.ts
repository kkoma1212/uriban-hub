import { describe, expect, it, vi } from "vitest";

import {
  fetchNeisSchoolSchedules,
  NeisSchoolScheduleError,
  parseNeisSchoolScheduleResponse,
  type NeisSchoolScheduleQuery,
} from "./neis-school-schedule.js";

const query: NeisSchoolScheduleQuery = {
  apiKey: "test-api-key",
  eduOfficeCode: "J10",
  from: "2026-03-01",
  schoolCode: "7530063",
  to: "2027-02-28",
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AA_YMD: "20260303",
    ATPT_OFCDC_SC_CODE: "J10",
    AY: "2026",
    EVENT_CNTNT: "",
    EVENT_NM: "입학식",
    FIV_GRADE_EVENT_YN: "*",
    FR_GRADE_EVENT_YN: "*",
    LOAD_DTM: "20260730153000",
    ONE_GRADE_EVENT_YN: "Y",
    SD_SCHUL_CODE: "7530063",
    SBTR_DD_SC_NM: "해당없음",
    SIX_GRADE_EVENT_YN: "*",
    THREE_GRADE_EVENT_YN: "N",
    TW_GRADE_EVENT_YN: "N",
    ...overrides,
  };
}

function response(rows: Record<string, unknown>[] = [row()]): Record<string, unknown> {
  return {
    SchoolSchedule: [
      {
        head: [
          { list_total_count: rows.length },
          { RESULT: { CODE: "INFO-000", MESSAGE: "정상 처리되었습니다." } },
        ],
      },
      { row: rows },
    ],
  };
}

describe("NEIS school schedule parser", () => {
  it("normalizes event metadata and grade flags", () => {
    expect(parseNeisSchoolScheduleResponse(response(), query)).toEqual([
      {
        academicYear: 2026,
        eduOfficeCode: "J10",
        eventContent: null,
        eventDate: "2026-03-03",
        eventName: "입학식",
        gradeMask: 1,
        schoolCode: "7530063",
        schoolDayType: "해당없음",
        sourceLoadedOn: "2026-07-30",
      },
    ]);

    expect(
      parseNeisSchoolScheduleResponse(
        response([
          row({
            EVENT_CNTNT: "전 학년 정상 등교",
            EVENT_NM: "2차 정기시험",
            ONE_GRADE_EVENT_YN: "Y",
            THREE_GRADE_EVENT_YN: "Y",
            TW_GRADE_EVENT_YN: "Y",
          }),
        ]),
        query,
      )[0],
    ).toMatchObject({ eventContent: "전 학년 정상 등교", gradeMask: 7 });
  });

  it("accepts official no-data and both observed LOAD_DTM formats", () => {
    expect(
      parseNeisSchoolScheduleResponse(
        { RESULT: { CODE: "INFO-200", MESSAGE: "해당하는 데이터가 없습니다." } },
        query,
      ),
    ).toEqual([]);
    expect(
      parseNeisSchoolScheduleResponse(response([row({ LOAD_DTM: "20260730" })]), query)[0]
        ?.sourceLoadedOn,
    ).toBe("2026-07-30");
  });

  it("fails closed on mismatched identity, invalid grades, and duplicate natural keys", () => {
    expect(() =>
      parseNeisSchoolScheduleResponse(response([row({ SD_SCHUL_CODE: "0000000" })]), query),
    ).toThrow(/requested school/);
    expect(() =>
      parseNeisSchoolScheduleResponse(
        response([
          row({
            ONE_GRADE_EVENT_YN: "N",
            THREE_GRADE_EVENT_YN: "N",
            TW_GRADE_EVENT_YN: "N",
          }),
        ]),
        query,
      ),
    ).toThrow(/does not target any grade/);
    expect(() => parseNeisSchoolScheduleResponse(response([row(), row()]), query)).toThrow(
      /duplicate school event/,
    );
  });

  it("requires a key and limits a request to 370 inclusive days", () => {
    expect(() => parseNeisSchoolScheduleResponse(response(), { ...query, apiKey: "" })).toThrow(
      /NEIS_API_KEY/,
    );
    expect(() =>
      parseNeisSchoolScheduleResponse(response(), {
        ...query,
        from: "2026-01-01",
        to: "2027-01-06",
      }),
    ).toThrow(/370 inclusive days/);
  });

  it("does not expose a rejected API key", () => {
    const secretQuery = { ...query, apiKey: "never-print-this-secret" };
    let captured: unknown;
    try {
      parseNeisSchoolScheduleResponse(
        { RESULT: { CODE: "ERROR-290", MESSAGE: "인증키가 유효하지 않습니다." } },
        secretQuery,
      );
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject<Partial<NeisSchoolScheduleError>>({
      code: "NEIS_REQUEST_FAILED",
    });
    expect(String(captured)).not.toContain(secretQuery.apiKey);
  });
});

describe("NEIS school schedule HTTP client", () => {
  it("uses the fixed HTTPS endpoint and bounded query parameters", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(response()), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );

    await expect(
      fetchNeisSchoolSchedules(query, {
        fetchImplementation,
        retryDelayMs: 0,
        timeoutMs: 1_000,
      }),
    ).resolves.toHaveLength(1);

    const calledUrl = fetchImplementation.mock.calls[0]?.[0];
    expect(calledUrl).toBeInstanceOf(URL);
    const url = calledUrl as URL;
    expect(url.origin).toBe("https://open.neis.go.kr");
    expect(url.pathname).toBe("/hub/SchoolSchedule");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      AA_FROM_YMD: "20260301",
      AA_TO_YMD: "20270228",
      ATPT_OFCDC_SC_CODE: "J10",
      KEY: "test-api-key",
      SD_SCHUL_CODE: "7530063",
      Type: "json",
      pIndex: "1",
      pSize: "1000",
    });
  });

  it("retries one transient HTTP failure", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response()), { status: 200 }));

    await expect(
      fetchNeisSchoolSchedules(query, {
        fetchImplementation,
        retryDelayMs: 0,
        timeoutMs: 1_000,
      }),
    ).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
