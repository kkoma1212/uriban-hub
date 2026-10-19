import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppEnvironment } from "../config/environment.js";
import { NeisSchoolSchedulesService } from "./neis-school-schedules.service.js";

const school = { eduOfficeCode: "J10", schoolCode: "7530063" };

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AA_YMD: "20260423",
    ATPT_OFCDC_SC_CODE: "J10",
    AY: "2026",
    EVENT_CNTNT: "",
    EVENT_NM: "1차 정기시험",
    FIV_GRADE_EVENT_YN: "*",
    FR_GRADE_EVENT_YN: "*",
    LOAD_DTM: "20260730153000",
    ONE_GRADE_EVENT_YN: "Y",
    SD_SCHUL_CODE: "7530063",
    SBTR_DD_SC_NM: "해당없음",
    SIX_GRADE_EVENT_YN: "*",
    THREE_GRADE_EVENT_YN: "Y",
    TW_GRADE_EVENT_YN: "Y",
    ...overrides,
  };
}

function neisResponse(rows: Record<string, unknown>[]): Response {
  return new Response(
    JSON.stringify({
      SchoolSchedule: [
        {
          head: [
            { list_total_count: rows.length },
            { RESULT: { CODE: "INFO-000", MESSAGE: "정상 처리되었습니다." } },
          ],
        },
        { row: rows },
      ],
    }),
    { headers: { "Content-Type": "application/json" }, status: 200 },
  );
}

const service = (apiKey: string | undefined) =>
  new NeisSchoolSchedulesService(
    new ConfigService<AppEnvironment, true>(apiKey === undefined ? {} : { NEIS_API_KEY: apiKey }),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NeisSchoolSchedulesService", () => {
  it("fetches one academic year, keeps stable ids and reuses the result instead of asking again", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      neisResponse([
        row(),
        row({
          AA_YMD: "20260604",
          EVENT_NM: "대수능 모의평가",
          ONE_GRADE_EVENT_YN: "N",
          TW_GRADE_EVENT_YN: "N",
        }),
      ]),
    );
    const neis = service("test-key");

    const first = await neis.academicYear(school, 2026);
    expect(first).toEqual([
      expect.objectContaining({
        event_date: "2026-04-23",
        event_name: "1차 정기시험",
        grade_mask: 0b111,
      }),
      expect.objectContaining({
        event_date: "2026-06-04",
        event_name: "대수능 모의평가",
        grade_mask: 0b100,
      }),
    ]);
    expect(first![0]!.id).toMatch(/^[1-9]\d*$/u);
    // 학년도 전체(3월 1일 ~ 다음 해 2월 말)를 묻는다.
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("AA_FROM_YMD")).toBe("20260301");
    expect(url.searchParams.get("AA_TO_YMD")).toBe("20270228");

    const again = await neis.academicYear(school, 2026);
    expect(again).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 같은 행사는 다시 받아도 같은 번호다.
    const other = await service("test-key").academicYear(school, 2026);
    expect(other!.map((item) => item.id)).toEqual(first!.map((item) => item.id));
  });

  it("returns undefined so the calendar falls back to stored events when there is no key or NEIS fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await service(undefined).academicYear(school, 2026)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRejectedValue(new Error("network down"));
    const neis = service("test-key");
    expect(await neis.academicYear(school, 2026)).toBeUndefined();
    // 실패는 기억하지 않으므로 다음에 다시 묻는다.
    fetchMock.mockResolvedValue(neisResponse([row()]));
    expect(await neis.academicYear(school, 2026)).toHaveLength(1);
  });
});
