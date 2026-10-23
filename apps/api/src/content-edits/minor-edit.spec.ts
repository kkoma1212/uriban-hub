import { describe, expect, it } from "vitest";

import { isMinorTextEdit, MINOR_EDIT_MAX_CHANGED_CHARACTERS } from "./minor-edit.js";

const LIMIT = MINOR_EDIT_MAX_CHANGED_CHARACTERS;

describe("isMinorTextEdit", () => {
  it("오타·띄어쓰기 한두 글자는 작은 변경이다", () => {
    expect(isMinorTextEdit([["내일 체육복 챙겨 오세오", "내일 체육복 챙겨 오세요"]])).toBe(true);
    expect(isMinorTextEdit([["내일체육복 챙겨 오세요", "내일 체육복 챙겨 오세요"]])).toBe(true);
    expect(isMinorTextEdit([["같은 글", "같은 글"]])).toBe(true);
  });

  it("한글 한 글자는 바이트가 아니라 한 글자로 센다", () => {
    expect(isMinorTextEdit([["가".repeat(LIMIT), "나".repeat(LIMIT)]])).toBe(true);
    expect(isMinorTextEdit([["가".repeat(LIMIT + 1), "나".repeat(LIMIT + 1)]])).toBe(false);
  });

  it(`제목과 본문의 바뀐 글자를 합쳐 ${LIMIT}자까지만 받는다`, () => {
    const body = "준비물은 실내화와 물통입니다. 잊지 마세요.";
    expect(
      isMinorTextEdit([
        ["가나다라마", "가나다라바"],
        [body, `${body}${"!".repeat(LIMIT - 1)}`],
      ]),
    ).toBe(true);
    expect(
      isMinorTextEdit([
        ["가나다라마", "가나다라바"],
        [body, `${body}${"!".repeat(LIMIT)}`],
      ]),
    ).toBe(false);
  });

  it("긴 본문에서 멀리 떨어진 오타 두 개도 작은 변경이다", () => {
    const middle = "학급 안내 문장입니다. ".repeat(150);
    expect(isMinorTextEdit([[`안넝${middle}끝입니댜`, `안녕${middle}끝입니다`]])).toBe(true);
  });

  it("숫자(날짜·시간·개수)가 바뀌면 한 글자라도 작은 변경이 아니다", () => {
    expect(isMinorTextEdit([["3월 5일 체육복", "3월 6일 체육복"]])).toBe(false);
    expect(isMinorTextEdit([["2교시", "3교시"]])).toBe(false);
    expect(isMinorTextEdit([["물통 1개", "물통 1개 꼭"]])).toBe(true);
    expect(isMinorTextEdit([["12시", "1 2시"]])).toBe(false);
  });

  it("문장을 크게 바꾸면 작은 변경이 아니다", () => {
    // 10자에서 5자로 낮춘 계기가 된 예(정확히 10자가 바뀐다).
    expect(
      isMinorTextEdit([["내일은 체육복을 챙겨 오세요.", "모레는 실내화와 물통을 챙겨 오세요."]]),
    ).toBe(false);
    expect(isMinorTextEdit([["", "새로 쓴 긴 설명 문장을 붙였어요."]])).toBe(false);
  });

  it("굵게·형광펜 기호만 더하거나 뺀 수정은 바뀐 글자 0자다(T-RICHTEXT)", () => {
    // 기호 8자를 그대로 세면 상한 5자를 넘는다 — 기호를 빼고 비교해야 통과한다.
    expect(isMinorTextEdit([["내일은 체육복을 챙겨요", "내일은 **체육복**을 ==챙겨요=="]])).toBe(
      true,
    );
    expect(isMinorTextEdit([["**강당**에서 해요", "강당에서 해요"]])).toBe(true);
    // 서식과 함께 글자를 많이 바꾸면 그대로 거절한다.
    expect(isMinorTextEdit([["내일은 체육복", "**모레는 실내화와 물통**"]])).toBe(false);
  });

  it("한계: 상한 안에서 낱말을 바꾸면 뜻이 달라져도 통과한다(교사 판단에 맡김)", () => {
    // '내일 체육복' → '모레 실내화'는 정확히 5자가 바뀐다.
    expect(isMinorTextEdit([["내일 체육복 챙겨 오세요", "모레 실내화 챙겨 오세요"]])).toBe(true);
  });
});
