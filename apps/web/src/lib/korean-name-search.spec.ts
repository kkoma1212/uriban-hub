import { describe, expect, it } from "vitest";

import {
  compareStudentsByName,
  isConsonantQuery,
  leadingConsonants,
  matchesStudentSearch,
  type StudentSearchTarget,
} from "./korean-name-search";

function student(displayName: string, studentNumber: number | null = null): StudentSearchTarget {
  return { displayName, studentNumber };
}

describe("korean student name search", () => {
  it("reads the leading consonant of each hangul syllable and leaves other characters alone", () => {
    expect(leadingConsonants("김도윤")).toBe("ㄱㄷㅇ");
    expect(leadingConsonants("박서아")).toBe("ㅂㅅㅇ");
    // 쌍자음 초성은 홑자음으로 뭉개지 않는다.
    expect(leadingConsonants("빠른")).toBe("ㅃㄹ");
    expect(leadingConsonants("Ann 리")).toBe("Ann ㄹ");
  });

  it("treats a query as a consonant run only when every character is a choseong", () => {
    expect(isConsonantQuery("ㄱ")).toBe(true);
    expect(isConsonantQuery("ㄱㅁ")).toBe(true);
    expect(isConsonantQuery("")).toBe(false);
    expect(isConsonantQuery("김")).toBe(false);
    expect(isConsonantQuery("ㄱ1")).toBe(false);
    // 모음은 초성이 아니다.
    expect(isConsonantQuery("ㅏ")).toBe(false);
  });

  it("matches a leading consonant run against the start of the name only", () => {
    expect(matchesStudentSearch(student("김도윤"), "ㄱ")).toBe(true);
    expect(matchesStudentSearch(student("김도윤"), "ㄱㄷ")).toBe(true);
    expect(matchesStudentSearch(student("김도윤"), "ㄱㅅ")).toBe(false);
    expect(matchesStudentSearch(student("박서아"), "ㄱ")).toBe(false);
    /*
     * 덫: 이름 **가운데**에 있는 초성은 걸리면 안 된다. `ㄱ`으로 성씨를 훑는 쓰임이
     * 무너지기 때문이다. 박기준의 초성열은 "ㅂㄱㅈ"이라 "ㄱ"으로 시작하지 않는다.
     */
    expect(matchesStudentSearch(student("박기준"), "ㄱ")).toBe(false);
  });

  it("matches names by partial text regardless of spaces", () => {
    expect(matchesStudentSearch(student("김도윤"), "도윤")).toBe(true);
    expect(matchesStudentSearch(student("김 도윤"), "김도윤")).toBe(true);
    expect(matchesStudentSearch(student("김도윤"), "  도  ")).toBe(true);
    expect(matchesStudentSearch(student("김도윤"), "서윤")).toBe(false);
  });

  it("matches student numbers by prefix and never matches unnumbered students", () => {
    expect(matchesStudentSearch(student("김도윤", 7), "7")).toBe(true);
    expect(matchesStudentSearch(student("김도윤", 17), "1")).toBe(true);
    expect(matchesStudentSearch(student("김도윤", 7), "8")).toBe(false);
    expect(matchesStudentSearch(student("번호없음", null), "1")).toBe(false);
  });

  it("returns everything for a blank query", () => {
    expect(matchesStudentSearch(student("김도윤", 1), "")).toBe(true);
    expect(matchesStudentSearch(student("김도윤", 1), "   ")).toBe(true);
  });

  it("orders by korean name first and student number second", () => {
    const roster = [
      student("홍예준", 28),
      student("김서윤", 2),
      student("김도윤", 9),
      student("김도윤", 1),
      student("박다은", 4),
    ];
    expect([...roster].sort(compareStudentsByName).map((entry) => entry.displayName)).toEqual([
      "김도윤",
      "김도윤",
      "김서윤",
      "박다은",
      "홍예준",
    ]);
    expect(
      [...roster]
        .sort(compareStudentsByName)
        .filter((entry) => entry.displayName === "김도윤")
        .map((entry) => entry.studentNumber),
    ).toEqual([1, 9]);
  });

  it("keeps unnumbered students behind numbered ones with the same name", () => {
    const roster = [student("김도윤", null), student("김도윤", 12)];
    expect([...roster].sort(compareStudentsByName).map((entry) => entry.studentNumber)).toEqual([
      12,
      null,
    ]);
  });

  it("sorts numbers inside names by value, not by digit order", () => {
    const roster = [student("학생10"), student("학생2")];
    expect([...roster].sort(compareStudentsByName).map((entry) => entry.displayName)).toEqual([
      "학생2",
      "학생10",
    ]);
  });
});
