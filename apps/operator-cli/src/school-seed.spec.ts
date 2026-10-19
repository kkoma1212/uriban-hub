import { describe, expect, it } from "vitest";

import { parseSchoolSeedJson } from "./school-seed.js";

const valid = {
  edu_office_code: "B10",
  edu_office_name: " 서울특별시교육청 ",
  region_name: " 서울특별시 ",
  school_code: "7010123",
  school_kind: "high",
  school_name: " 우리학교 ",
};

function seed(items: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema_version: 1, items, ...extra });
}

function version2Seed(items: unknown[]): string {
  return JSON.stringify({ schema_version: 2, items });
}

describe("school seed parser", () => {
  it("normalizes the exact version 1 school shape", () => {
    expect(parseSchoolSeedJson(seed([valid]))).toEqual({
      items: [
        {
          eduOfficeCode: "B10",
          eduOfficeName: "서울특별시교육청",
          regionName: "서울특별시",
          schoolCode: "7010123",
          schoolKind: "high",
          schoolName: "우리학교",
        },
      ],
      schemaVersion: 1,
    });
  });

  it("normalizes nullable version 2 school details and preserves version 1 compatibility", () => {
    expect(
      parseSchoolSeedJson(
        version2Seed([
          {
            ...valid,
            homepage_url: "dongan-h.goeay.kr",
            phone_number: " 031-387-6105 ",
            road_address: " 경기도 안양시 동안구 부림로 71 ",
            road_address_detail: " ",
          },
        ]),
      ),
    ).toEqual({
      items: [
        {
          eduOfficeCode: "B10",
          eduOfficeName: "서울특별시교육청",
          homepageUrl: "https://dongan-h.goeay.kr/",
          phoneNumber: "031-387-6105",
          regionName: "서울특별시",
          roadAddress: "경기도 안양시 동안구 부림로 71",
          roadAddressDetail: null,
          schoolCode: "7010123",
          schoolKind: "high",
          schoolName: "우리학교",
        },
      ],
      schemaVersion: 2,
    });
  });

  it.each([
    [
      version2Seed([
        {
          ...valid,
          homepage_url: "javascript:alert(1)",
          phone_number: null,
          road_address: null,
          road_address_detail: null,
        },
      ]),
      "unsafe homepage",
    ],
    [
      version2Seed([
        {
          ...valid,
          homepage_url: null,
          phone_number: "대표번호",
          road_address: null,
          road_address_detail: null,
        },
      ]),
      "phone without digits",
    ],
    [
      version2Seed([
        {
          ...valid,
          homepage_url: null,
          phone_number: null,
          road_address: "주소\n변조",
          road_address_detail: null,
        },
      ]),
      "address control character",
    ],
  ] as Array<[string, string]>)("rejects version 2 %s (%s)", (input) => {
    expect(() => parseSchoolSeedJson(input)).toThrow();
  });

  it.each([
    ["not json", "malformed JSON"],
    [seed([valid], { unexpected: true }), "unknown top-level key"],
    [seed([{ ...valid, source: "seed" }]), "unknown item key"],
    [seed([{ ...valid, edu_office_code: "b10" }]), "bad office code"],
    [seed([{ ...valid, school_code: "123" }]), "bad school code"],
    [seed([{ ...valid, school_kind: "university" }]), "bad school kind"],
    [seed([{ ...valid, school_name: " " }]), "empty normalized name"],
    [seed([valid, { ...valid }]), "duplicate school key"],
  ] as Array<[string, string]>)("rejects %s (%s)", (input) => {
    expect(() => parseSchoolSeedJson(input)).toThrow();
  });

  it("measures text in Unicode code points", () => {
    expect(() =>
      parseSchoolSeedJson(seed([{ ...valid, school_name: "😀".repeat(100) }])),
    ).not.toThrow();
    expect(() =>
      parseSchoolSeedJson(seed([{ ...valid, school_name: "😀".repeat(101) }])),
    ).toThrow();
  });
});
