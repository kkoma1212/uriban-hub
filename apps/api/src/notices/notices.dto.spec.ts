import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";

import {
  ConfirmNoticeDto,
  CreateNoticeDto,
  DeleteNoticeDto,
  ListNoticeConfirmationsQueryDto,
  ListNoticesQueryDto,
  UpdateNoticeDto,
} from "./notices.dto.js";

function instanceAndErrors<T extends object>(
  type: new () => T,
  values: Record<string, unknown>,
): { errors: ReturnType<typeof validateSync>; instance: T } {
  const instance = plainToInstance(type, values);
  return { errors: validateSync(instance), instance };
}

const validCreate = {
  content: "수행평가 제출일은 금요일입니다.\n준비물을 확인해 주세요.",
  is_important: true,
  title: "수행평가 안내",
};

describe("notice DTO validation", () => {
  it("trims notice text and counts Unicode code points", () => {
    const valid = instanceAndErrors(CreateNoticeDto, {
      ...validCreate,
      content: "  공지 내용  ",
      title: `  ${"😀".repeat(100)}  `,
    });
    expect(valid.errors).toHaveLength(0);
    expect(valid.instance.title).toBe("😀".repeat(100));
    expect(valid.instance.content).toBe("공지 내용");
    expect(
      instanceAndErrors(CreateNoticeDto, { ...validCreate, content: "😀".repeat(2001) }).errors,
    ).not.toHaveLength(0);
  });

  it("rejects HTML and control characters while allowing LF only in content", () => {
    expect(instanceAndErrors(CreateNoticeDto, validCreate).errors).toHaveLength(0);
    expect(
      instanceAndErrors(CreateNoticeDto, { ...validCreate, title: "공지\n제목" }).errors,
    ).not.toHaveLength(0);
    expect(
      instanceAndErrors(CreateNoticeDto, { ...validCreate, content: "공지\t내용" }).errors,
    ).not.toHaveLength(0);
    expect(
      instanceAndErrors(CreateNoticeDto, { ...validCreate, content: "<b>공지</b>" }).errors,
    ).not.toHaveLength(0);
  });

  it("accepts optional importance and partial updates", () => {
    expect(
      instanceAndErrors(CreateNoticeDto, { ...validCreate, is_important: undefined }).errors,
    ).toHaveLength(0);
    expect(instanceAndErrors(UpdateNoticeDto, {}).errors).toHaveLength(0);
    expect(instanceAndErrors(UpdateNoticeDto, { is_important: false }).errors).toHaveLength(0);
    expect(instanceAndErrors(UpdateNoticeDto, { is_important: "true" }).errors).not.toHaveLength(0);
    expect(instanceAndErrors(UpdateNoticeDto, { content: "   " }).errors).not.toHaveLength(0);
  });

  it("requires a nullable delete reason field and applies plain-text rules", () => {
    expect(instanceAndErrors(DeleteNoticeDto, {}).errors).not.toHaveLength(0);
    expect(instanceAndErrors(DeleteNoticeDto, { reason: null }).errors).toHaveLength(0);
    const emptyReason = instanceAndErrors(DeleteNoticeDto, { reason: "   " });
    expect(emptyReason.errors).toHaveLength(0);
    expect(emptyReason.instance.reason).toBeNull();
    expect(instanceAndErrors(DeleteNoticeDto, { reason: "삭제\n사유" }).errors).not.toHaveLength(0);
  });

  it("requires a safe positive confirmation revision", () => {
    expect(instanceAndErrors(ConfirmNoticeDto, { content_revision: 1 }).errors).toHaveLength(0);
    for (const value of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        instanceAndErrors(ConfirmNoticeDto, { content_revision: value }).errors,
      ).not.toHaveLength(0);
    }
  });

  it("accepts only documented importance and confirmation filters", () => {
    expect(instanceAndErrors(ListNoticesQueryDto, {}).errors).toHaveLength(0);
    expect(instanceAndErrors(ListNoticesQueryDto, { importance: "important" }).errors).toHaveLength(
      0,
    );
    expect(
      instanceAndErrors(ListNoticesQueryDto, { importance: "urgent" }).errors,
    ).not.toHaveLength(0);
    expect(
      instanceAndErrors(ListNoticeConfirmationsQueryDto, { state: "modified_unconfirmed" }).errors,
    ).toHaveLength(0);
    expect(
      instanceAndErrors(ListNoticeConfirmationsQueryDto, { state: "all" }).errors,
    ).not.toHaveLength(0);
  });
});
