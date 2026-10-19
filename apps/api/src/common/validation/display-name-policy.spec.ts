import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";

import {
  BLOCKED_DISPLAY_NAME_WHOLE_WORDS as WEB_BLOCKED_WHOLE_WORDS,
  BLOCKED_DISPLAY_NAME_WORDS as WEB_BLOCKED_WORDS,
} from "../../../../web/src/lib/display-name-policy.js";
import { UpdateAccountProfileRequestDto } from "../../account/account.dto.js";
import { SignUpRequestDto } from "../../auth/auth.dto.js";
import { ApproveMemberDto } from "../../members/members.dto.js";
import {
  BLOCKED_DISPLAY_NAME_WHOLE_WORDS,
  BLOCKED_DISPLAY_NAME_WORDS,
  containsBlockedDisplayNameWord,
} from "./display-name-policy.js";

const signUp = {
  age_route: "over_14" as const,
  approval_code: "123456",
  consents: { privacy: true as const, terms: true as const },
  display_name: "김민준",
  email: "student@example.com",
  password: "unit-test-safe-123",
  role: "student" as const,
};

describe("display name word policy", () => {
  it("blocks listed words, including spaced, digit and symbol variants", () => {
    for (const name of [
      "씨발",
      "나는병신",
      "시 발",
      "시1발",
      "시.발",
      "ㅅㅂ맨",
      "F U C K",
      "개새끼야",
      "fuck you",
      "Shit",
    ]) {
      expect(containsBlockedDisplayNameWord(name), name).toBe(true);
    }
  });

  it("keeps ordinary Korean and foreign names", () => {
    for (const name of [
      "김민준",
      "이서연",
      "박보영",
      "시바견",
      "애비게일",
      "에이미",
      "신발장",
      "보람",
      "지유",
      "Chris",
      "Essex",
      "학생 <3",
      // 2026-09-29 Codex 검증 R3: 금칙어를 품은 실제 이름
      "Harshit",
      "Nishita",
      "Dikshit",
      "Pornchai",
      "에밀 졸라",
      "Scunthorpe",
    ]) {
      expect(containsBlockedDisplayNameWord(name), name).toBe(false);
    }
  });

  it("applies to signup and own-name change but not to teacher-set class names", () => {
    const errors = <T extends object>(type: new () => T, values: object) =>
      validateSync(plainToInstance(type, values)).length;
    expect(errors(SignUpRequestDto, signUp)).toBe(0);
    expect(errors(SignUpRequestDto, { ...signUp, display_name: "병신 학생" })).toBeGreaterThan(0);
    expect(errors(UpdateAccountProfileRequestDto, { display_name: "민준" })).toBe(0);
    expect(errors(UpdateAccountProfileRequestDto, { display_name: "지랄 민준" })).toBeGreaterThan(
      0,
    );
    expect(errors(ApproveMemberDto, { display_name_in_class: "민준", student_number: 1 })).toBe(0);
  });

  it("matches the word list the web form checks before submitting", () => {
    expect([...WEB_BLOCKED_WORDS]).toEqual([...BLOCKED_DISPLAY_NAME_WORDS]);
    expect([...WEB_BLOCKED_WHOLE_WORDS]).toEqual([...BLOCKED_DISPLAY_NAME_WHOLE_WORDS]);
  });
});
