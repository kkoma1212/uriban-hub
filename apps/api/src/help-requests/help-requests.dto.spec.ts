import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";

import {
  CreateHelpRequestDto,
  ListHelpRequestsQueryDto,
  ResolveHelpRequestDto,
  SendHelpMessageDto,
} from "./help-requests.dto.js";

function check<T extends object>(type: new () => T, values: Record<string, unknown>) {
  const instance = plainToInstance(type, values);
  return { errors: validateSync(instance), instance };
}

const valid = { kind: "question", message: null, target_id: "10", target_kind: "notice" };

describe("help request DTOs", () => {
  it("설명은 선택이며 공백만 쓰면 없음(null)으로 받는다", () => {
    expect(check(CreateHelpRequestDto, valid).errors).toEqual([]);
    const blank = check(CreateHelpRequestDto, { ...valid, message: "   " });
    expect(blank.errors).toEqual([]);
    expect(blank.instance.message).toBeNull();
    const trimmed = check(CreateHelpRequestDto, { ...valid, message: "  물감이 없어요 " });
    expect(trimmed.instance.message).toBe("물감이 없어요");
  });

  it("200자를 넘는 설명·HTML·빠진 설명 필드·모르는 종류와 대상을 거부한다", () => {
    for (const values of [
      { ...valid, message: "가".repeat(201) },
      { ...valid, message: "<b>질문</b>" },
      { kind: "question", target_id: "10", target_kind: "notice" },
      { ...valid, kind: "chat" },
      { ...valid, target_kind: "schedule" },
      { ...valid, target_id: "0" },
    ])
      expect(check(CreateHelpRequestDto, values).errors).not.toEqual([]);
    expect(check(CreateHelpRequestDto, { ...valid, message: "가".repeat(200) }).errors).toEqual([]);
  });

  it("답변도 선택 200자이고, 목록 대상은 종류와 ID를 함께 받아야 한다", () => {
    expect(check(ResolveHelpRequestDto, { reply: null }).errors).toEqual([]);
    expect(check(ResolveHelpRequestDto, { reply: "가".repeat(201) }).errors).not.toEqual([]);
    expect(check(ResolveHelpRequestDto, {}).errors).not.toEqual([]);
    expect(check(ListHelpRequestsQueryDto, {}).errors).toEqual([]);
    expect(check(ListHelpRequestsQueryDto, { status: "done" }).errors).not.toEqual([]);
    expect(check(ListHelpRequestsQueryDto, { target_kind: "notice" }).errors).not.toEqual([]);
    expect(check(ListHelpRequestsQueryDto, { target_id: "3" }).errors).not.toEqual([]);
    expect(
      check(ListHelpRequestsQueryDto, { target_id: "3", target_kind: "supply" }).errors,
    ).toEqual([]);
  });

  it("대화 메시지는 앞뒤 공백을 뺀 1~500자, 줄바꿈은 되고 HTML·빈 메시지·general 요청 종류는 안 된다", () => {
    const sent = check(SendHelpMessageDto, { body: "  내일 알려 주세요\n고맙습니다  " });
    expect(sent.errors).toEqual([]);
    expect(sent.instance.body).toBe("내일 알려 주세요\n고맙습니다");
    expect(check(SendHelpMessageDto, { body: "가".repeat(500) }).errors).toEqual([]);
    for (const values of [
      { body: "가".repeat(501) },
      { body: "   " },
      { body: "<script>x</script>" },
      { body: null },
      {},
    ])
      expect(check(SendHelpMessageDto, values).errors).not.toEqual([]);
    // 글과 무관한 대화는 /help-requests/general로만 시작한다(카드 요청 종류로는 못 만든다).
    expect(check(CreateHelpRequestDto, { ...valid, kind: "general" }).errors).not.toEqual([]);
  });
});
