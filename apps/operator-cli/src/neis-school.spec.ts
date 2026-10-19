import { describe, expect, it } from "vitest";

import { fetchNeisSchools, parseNeisSchoolPage, validateNeisSchoolQuery } from "./neis-school.js";

function schoolRow(
  schoolCode: string,
  schoolKind = "고등학교",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ATPT_OFCDC_SC_CODE: "B10",
    ATPT_OFCDC_SC_NM: " 서울특별시교육청 ",
    LCTN_SC_NM: " 서울특별시 ",
    SCHUL_KND_SC_NM: schoolKind,
    SCHUL_NM: ` 학교 ${schoolCode} `,
    SD_SCHUL_CODE: schoolCode,
    ...overrides,
  };
}

function schoolResponse(rows: unknown[], totalCount = rows.length): Record<string, unknown> {
  return {
    schoolInfo: [
      {
        head: [
          { list_total_count: totalCount },
          { RESULT: { CODE: "INFO-000", MESSAGE: "정상 처리되었습니다." } },
        ],
      },
      { row: rows },
    ],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("NEIS school response parser", () => {
  it("maps the three supported school kinds and trims public display fields", () => {
    expect(
      parseNeisSchoolPage(
        schoolResponse([
          schoolRow("7010001", "초등학교"),
          schoolRow("7010002", "중학교"),
          schoolRow("7010003", "고등학교"),
        ]),
        { pageIndex: 1, pageSize: 3 },
      ),
    ).toEqual({
      blankedOptionalFieldCount: 0,
      ignoredInvalidIdentifierCount: 0,
      ignoredUnsupportedCount: 0,
      items: [
        {
          eduOfficeCode: "B10",
          eduOfficeName: "서울특별시교육청",
          homepageUrl: null,
          phoneNumber: null,
          regionName: "서울특별시",
          roadAddress: null,
          roadAddressDetail: null,
          schoolCode: "7010001",
          schoolKind: "elementary",
          schoolName: "학교 7010001",
        },
        {
          eduOfficeCode: "B10",
          eduOfficeName: "서울특별시교육청",
          homepageUrl: null,
          phoneNumber: null,
          regionName: "서울특별시",
          roadAddress: null,
          roadAddressDetail: null,
          schoolCode: "7010002",
          schoolKind: "middle",
          schoolName: "학교 7010002",
        },
        {
          eduOfficeCode: "B10",
          eduOfficeName: "서울특별시교육청",
          homepageUrl: null,
          phoneNumber: null,
          regionName: "서울특별시",
          roadAddress: null,
          roadAddressDetail: null,
          schoolCode: "7010003",
          schoolKind: "high",
          schoolName: "학교 7010003",
        },
      ],
      totalCount: 3,
    });
  });

  it("normalizes 동안고 detail fields and blanks unsafe ones instead of failing", () => {
    expect(
      parseNeisSchoolPage(
        schoolResponse([
          schoolRow("7530063", "고등학교", {
            ATPT_OFCDC_SC_CODE: "J10",
            HMPG_ADRES: "dongan-h.goeay.kr",
            ORG_RDNDA: "(평촌동,동안고등학교)",
            ORG_RDNMA: "경기도 안양시 동안구 부림로 71",
            ORG_TELNO: "031-387-6105",
          }),
        ]),
        { pageIndex: 1, pageSize: 1 },
      ),
    ).toMatchObject({
      blankedOptionalFieldCount: 0,
      items: [
        {
          homepageUrl: "https://dongan-h.goeay.kr/",
          phoneNumber: "031-387-6105",
          roadAddress: "경기도 안양시 동안구 부림로 71",
          roadAddressDetail: "(평촌동,동안고등학교)",
        },
      ],
    });

    /*
     * 나이스가 주는 부가 정보가 깨져 있어도 학교는 받아들이고 그 칸만 비운다.
     * 예전에는 여기서 전체를 중단시켰는데, 실제 응답 900번대 행의 홈페이지 주소
     * 하나 때문에 전국 학교가 통째로 안 들어왔다(2026-08-06 실측).
     * 위험한 값이 저장되지 않는다는 보호는 그대로다 — 아래가 그것을 확인한다.
     * 비운 칸은 세어서 동기화 요약에 내보내므로, 조용히 넘어가지는 않는다.
     */
    const unsafeHomepage = parseNeisSchoolPage(
      schoolResponse([
        schoolRow("7530063", "고등학교", {
          HMPG_ADRES: "javascript:alert(1)",
        }),
      ]),
      { pageIndex: 1, pageSize: 1 },
    );
    expect(unsafeHomepage.items[0]?.homepageUrl).toBeNull();
    expect(unsafeHomepage.items[0]?.schoolCode).toBe("7530063");
    expect(unsafeHomepage.blankedOptionalFieldCount).toBe(1);

    const brokenPhone = parseNeisSchoolPage(
      schoolResponse([
        schoolRow("7530063", "고등학교", {
          ORG_TELNO: "대표번호",
        }),
      ]),
      { pageIndex: 1, pageSize: 1 },
    );
    expect(brokenPhone.items[0]?.phoneNumber).toBeNull();
    expect(brokenPhone.items[0]?.schoolCode).toBe("7530063");
    expect(brokenPhone.blankedOptionalFieldCount).toBe(1);
  });

  it("counts official out-of-scope school kinds without treating them as supported schools", () => {
    expect(
      parseNeisSchoolPage(
        schoolResponse([
          schoolRow("7010001", "특수학교"),
          schoolRow("7010002", "각종학교(고)"),
          schoolRow("7010003", "고등학교", { SCHUL_KND_SC_NM: null }),
          schoolRow("7010004"),
        ]),
        { pageIndex: 1, pageSize: 4 },
      ),
    ).toMatchObject({
      ignoredInvalidIdentifierCount: 0,
      ignoredUnsupportedCount: 3,
      items: [{ schoolCode: "7010004", schoolKind: "high" }],
      totalCount: 4,
    });
  });

  it("counts incompatible identifiers and rejects malformed required fields or response drift", () => {
    expect(
      parseNeisSchoolPage(
        schoolResponse([schoolRow("7010001", "고등학교", { SD_SCHUL_CODE: "bad" })]),
        { pageIndex: 1, pageSize: 1 },
      ),
    ).toMatchObject({
      ignoredInvalidIdentifierCount: 1,
      ignoredUnsupportedCount: 0,
      items: [],
      totalCount: 1,
    });
    expect(() =>
      parseNeisSchoolPage(schoolResponse([schoolRow("7010001", "고등학교", { SCHUL_NM: null })]), {
        pageIndex: 1,
        pageSize: 1,
      }),
    ).toThrow(/문자열/u);
    expect(() =>
      parseNeisSchoolPage(
        schoolResponse([schoolRow("7010001", "고등학교", { SCHUL_KND_SC_NM: {} })]),
        { pageIndex: 1, pageSize: 1 },
      ),
    ).toThrow(/문자열/u);
    expect(() =>
      parseNeisSchoolPage(schoolResponse([schoolRow("7010001"), schoolRow("7010001")]), {
        pageIndex: 1,
        pageSize: 2,
      }),
    ).toThrow(/중복 학교 key/u);
    expect(() =>
      parseNeisSchoolPage(schoolResponse([schoolRow("7010001")], 2), {
        pageIndex: 1,
        pageSize: 2,
      }),
    ).toThrow(/총건수와 페이지 행 수/u);
  });

  it("turns NEIS authentication responses into a redacted stable error", () => {
    expect(() =>
      parseNeisSchoolPage(
        { RESULT: { CODE: "ERROR-290", MESSAGE: "upstream detail" } },
        { pageIndex: 1, pageSize: 1 },
      ),
    ).toThrow("NEIS 인증에 실패했습니다. API 키를 확인해 주세요.");
  });

  it("requires a nonblank key without line breaks", () => {
    expect(() => validateNeisSchoolQuery({ apiKey: "" })).toThrow(/NEIS_API_KEY/u);
    expect(() => validateNeisSchoolQuery({ apiKey: "key\nvalue" })).toThrow(/줄바꿈/u);
    expect(validateNeisSchoolQuery({ apiKey: " test-key " })).toEqual({
      apiKey: "test-key",
    });
  });
});

describe("NEIS school HTTP client", () => {
  it("collects every page sequentially and returns a stable code-sorted list", async () => {
    const requestedPages: string[] = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      requestedPages.push(url.searchParams.get("pIndex") ?? "");
      expect(url.searchParams.get("KEY")).toBe("test-api-key");
      expect(url.searchParams.get("pSize")).toBe("2");
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      return url.searchParams.get("pIndex") === "1"
        ? jsonResponse(
            schoolResponse(
              [schoolRow("7010002"), schoolRow("7010001", "중학교", { ATPT_OFCDC_SC_CODE: "C10" })],
              3,
            ),
          )
        : jsonResponse(schoolResponse([schoolRow("7010001")], 3));
    };

    await expect(
      fetchNeisSchools(
        { apiKey: "test-api-key" },
        { fetchImplementation, pageSize: 2, retryDelayMs: 0 },
      ),
    ).resolves.toMatchObject({
      ignoredInvalidIdentifierCount: 0,
      ignoredUnsupportedCount: 0,
      items: [
        { eduOfficeCode: "B10", schoolCode: "7010001" },
        { eduOfficeCode: "B10", schoolCode: "7010002" },
        { eduOfficeCode: "C10", schoolCode: "7010001" },
      ],
      sourceCount: 3,
    });
    expect(requestedPages).toEqual(["1", "2"]);
  });

  it("retries one transient HTTP failure without exposing the key", async () => {
    let attempts = 0;
    const fetchImplementation: typeof fetch = async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("temporary", { status: 503 })
        : jsonResponse(schoolResponse([schoolRow("7010001")]));
    };

    await expect(
      fetchNeisSchools(
        { apiKey: "secret-test-key" },
        { fetchImplementation, pageSize: 1, retryDelayMs: 0 },
      ),
    ).resolves.toMatchObject({
      ignoredInvalidIdentifierCount: 0,
      ignoredUnsupportedCount: 0,
      items: [{ schoolCode: "7010001" }],
      sourceCount: 1,
    });
    expect(attempts).toBe(2);
  });

  it("fails closed when total count changes or a key repeats across pages", async () => {
    const changedTotalFetch: typeof fetch = async (input) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      return url.searchParams.get("pIndex") === "1"
        ? jsonResponse(schoolResponse([schoolRow("7010001"), schoolRow("7010002")], 3))
        : jsonResponse(schoolResponse([schoolRow("7010003"), schoolRow("7010004")], 4));
    };
    await expect(
      fetchNeisSchools(
        { apiKey: "test-key" },
        { fetchImplementation: changedTotalFetch, pageSize: 2, retryDelayMs: 0 },
      ),
    ).rejects.toThrow(/페이지 사이에서 변경/u);

    const duplicateFetch: typeof fetch = async (input) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      return url.searchParams.get("pIndex") === "1"
        ? jsonResponse(schoolResponse([schoolRow("7010001"), schoolRow("7010002")], 3))
        : jsonResponse(schoolResponse([schoolRow("7010001")], 3));
    };
    await expect(
      fetchNeisSchools(
        { apiKey: "test-key" },
        { fetchImplementation: duplicateFetch, pageSize: 2, retryDelayMs: 0 },
      ),
    ).rejects.toThrow(/여러 페이지에 중복/u);
  });
});
