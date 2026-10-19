import { describe, expect, it, vi } from "vitest";

import {
  fetchNeisMeals,
  NeisMealError,
  parseNeisMealResponse,
  type NeisMealQuery,
} from "./neis-meal.js";

const query: NeisMealQuery = {
  apiKey: "test-api-key",
  eduOfficeCode: "M10",
  from: "2026-07-01",
  schoolCode: "8021028",
  to: "2026-07-31",
};

function normalResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mealServiceDietInfo: [
      {
        head: [
          { list_total_count: 1 },
          { RESULT: { CODE: "INFO-000", MESSAGE: "정상 처리되었습니다." } },
        ],
      },
      {
        row: [
          {
            ATPT_OFCDC_SC_CODE: "M10",
            CAL_INFO: "1452.2 Kcal",
            DDISH_NM: "토마토&amp;치즈샐러드(국내산) (1.2.5)<br/>쌀밥<br>김치찌개 (5.9)",
            LOAD_DTM: "20260729",
            MLSV_YMD: "20260702",
            MMEAL_SC_CODE: "2",
            SD_SCHUL_CODE: "8021028",
            ...overrides,
          },
        ],
      },
    ],
  };
}

describe("NEIS meal response parser", () => {
  it("decodes dish text, preserves non-allergen parentheses, and extracts final allergen codes", () => {
    expect(parseNeisMealResponse(normalResponse(), query)).toEqual([
      {
        calorieKcalTenths: 14522,
        eduOfficeCode: "M10",
        mealDate: "2026-07-02",
        menuJson: [
          {
            allergens: ["1", "2", "5"],
            name: "토마토&치즈샐러드(국내산)",
          },
          { allergens: [], name: "쌀밥" },
          { allergens: ["5", "9"], name: "김치찌개" },
        ],
        schoolCode: "8021028",
        sourceLoadedOn: "2026-07-29",
      },
    ]);
  });

  it("keeps a missing calorie nullable and rejects malformed present values", () => {
    expect(parseNeisMealResponse(normalResponse({ CAL_INFO: "" }), query)[0]).toMatchObject({
      calorieKcalTenths: null,
    });
    expect(parseNeisMealResponse(normalResponse({ CAL_INFO: undefined }), query)[0]).toMatchObject({
      calorieKcalTenths: null,
    });
    expect(() =>
      parseNeisMealResponse(normalResponse({ CAL_INFO: "1,452.2 Kcal" }), query),
    ).toThrow(/CAL_INFO/);
    expect(() =>
      parseNeisMealResponse(normalResponse({ CAL_INFO: "10000.0 Kcal" }), query),
    ).toThrow(/CAL_INFO/);
  });

  it("treats the official no-data result as an empty success", () => {
    expect(
      parseNeisMealResponse(
        { RESULT: { CODE: "INFO-200", MESSAGE: "해당하는 데이터가 없습니다." } },
        query,
      ),
    ).toEqual([]);
  });

  it("returns a safe authentication error without exposing the API key", () => {
    const secretQuery = { ...query, apiKey: "never-print-this-secret" };
    let captured: unknown;
    try {
      parseNeisMealResponse(
        { RESULT: { CODE: "ERROR-290", MESSAGE: "인증키가 유효하지 않습니다." } },
        secretQuery,
      );
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject<Partial<NeisMealError>>({
      code: "NEIS_REQUEST_FAILED",
      message: "NEIS 인증에 실패했습니다. API 키를 확인해 주세요.",
    });
    expect(String(captured)).not.toContain(secretQuery.apiKey);
  });

  it("rejects mismatched schools, unsafe elements, and malformed metadata", () => {
    expect(() =>
      parseNeisMealResponse(normalResponse({ SD_SCHUL_CODE: "0000000" }), query),
    ).toThrow(/학교 또는 중식 코드/);
    expect(() =>
      parseNeisMealResponse(normalResponse({ DDISH_NM: "<strong>급식</strong> (1)" }), query),
    ).toThrow(/허용되지 않는 HTML 요소/);
    expect(() => parseNeisMealResponse(normalResponse({ LOAD_DTM: "20260230" }), query)).toThrow(
      /유효한 날짜/,
    );
  });

  it("requires a key and limits each request to 31 inclusive days", () => {
    expect(() => parseNeisMealResponse(normalResponse(), { ...query, apiKey: "" })).toThrow(
      /NEIS_API_KEY/,
    );
    expect(() =>
      parseNeisMealResponse(normalResponse(), {
        ...query,
        from: "2026-07-01",
        to: "2026-08-01",
      }),
    ).toThrow(/최대 31일/);
  });
});

describe("NEIS meal HTTP client", () => {
  it("uses the fixed HTTPS endpoint with a bounded lunch query", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(normalResponse()), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );

    await expect(
      fetchNeisMeals(query, { fetchImplementation, retryDelayMs: 0, timeoutMs: 1_000 }),
    ).resolves.toHaveLength(1);

    const calledUrl = fetchImplementation.mock.calls[0]?.[0];
    expect(calledUrl).toBeInstanceOf(URL);
    const url = calledUrl as URL;
    expect(url.origin).toBe("https://open.neis.go.kr");
    expect(url.pathname).toBe("/hub/mealServiceDietInfo");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      ATPT_OFCDC_SC_CODE: "M10",
      KEY: "test-api-key",
      MLSV_FROM_YMD: "20260701",
      MLSV_TO_YMD: "20260731",
      MMEAL_SC_CODE: "2",
      SD_SCHUL_CODE: "8021028",
      Type: "json",
      pIndex: "1",
      pSize: "100",
    });
    const requestInit = fetchImplementation.mock.calls[0]?.[1];
    expect(requestInit).toMatchObject({
      method: "GET",
      redirect: "error",
    });
    expect(requestInit).not.toHaveProperty("headers");
  });

  it("retries one transient HTTP failure and then succeeds", async () => {
    const firstResponse = new Response("temporary", { status: 503 });
    const firstCancel = vi.spyOn(firstResponse.body!, "cancel");
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify(normalResponse()), { status: 200 }));

    await expect(
      fetchNeisMeals(query, { fetchImplementation, retryDelayMs: 0, timeoutMs: 1_000 }),
    ).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(firstCancel).toHaveBeenCalledOnce();
  });

  it("stops after two transient HTTP failures", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("temporary", { status: 500 }));

    await expect(
      fetchNeisMeals(query, { fetchImplementation, retryDelayMs: 0, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({
      code: "NEIS_REQUEST_FAILED",
      message: "NEIS HTTP 요청에 실패했습니다. 상태 코드: 500",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("does not retry a terminal client status or include the key in errors", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("bad request", { status: 400 }));

    await expect(
      fetchNeisMeals(query, { fetchImplementation, retryDelayMs: 0, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({
      code: "NEIS_REQUEST_FAILED",
      message: "NEIS HTTP 요청에 실패했습니다. 상태 코드: 400",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    await fetchNeisMeals(query, {
      fetchImplementation,
      retryDelayMs: 0,
      timeoutMs: 1_000,
    }).catch((error: unknown) => {
      expect(String(error)).not.toContain(query.apiKey);
    });
  });
});
