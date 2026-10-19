import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";

import {
  CreateSupplyDto,
  DeleteSupplyDto,
  ListSuppliesQueryDto,
  ListSupplyChecksQueryDto,
  SetSupplyCheckDto,
  UpdateSupplyDto,
} from "./supplies.dto.js";

function instanceAndErrors<T extends object>(
  type: new () => T,
  values: Record<string, unknown>,
): { errors: ReturnType<typeof validateSync>; instance: T } {
  const instance = plainToInstance(type, values);
  return { errors: validateSync(instance), instance };
}

const validCreate = {
  description: "수학 문제집과 필기도구\n계산기는 선택이에요.",
  needed_on: "2026-07-15",
  title: "수학 준비물",
};

describe("supply DTO validation", () => {
  it("trims supply text and counts Unicode code points", () => {
    const valid = instanceAndErrors(CreateSupplyDto, {
      ...validCreate,
      description: "  준비물 설명  ",
      title: `  ${"😀".repeat(100)}  `,
    });
    expect(valid.errors).toHaveLength(0);
    expect(valid.instance.title).toBe("😀".repeat(100));
    expect(valid.instance.description).toBe("준비물 설명");

    expect(
      instanceAndErrors(CreateSupplyDto, {
        ...validCreate,
        title: "😀".repeat(101),
      }).errors,
    ).not.toHaveLength(0);
  });

  it("rejects HTML and control characters while allowing LF only in descriptions", () => {
    expect(instanceAndErrors(CreateSupplyDto, validCreate).errors).toHaveLength(0);
    expect(
      instanceAndErrors(CreateSupplyDto, { ...validCreate, title: "<b>준비물</b>" }).errors,
    ).not.toHaveLength(0);
    expect(
      instanceAndErrors(CreateSupplyDto, { ...validCreate, title: "준비\n물" }).errors,
    ).not.toHaveLength(0);
    expect(
      instanceAndErrors(CreateSupplyDto, { ...validCreate, description: "준비\t물" }).errors,
    ).not.toHaveLength(0);
    expect(
      instanceAndErrors(CreateSupplyDto, { ...validCreate, description: "준비\u2028물" }).errors,
    ).not.toHaveLength(0);
    expect(
      instanceAndErrors(CreateSupplyDto, { ...validCreate, description: "<i>설명</i>" }).errors,
    ).not.toHaveLength(0);
  });

  it("accepts only real YYYY-MM-DD calendar dates", () => {
    expect(instanceAndErrors(CreateSupplyDto, validCreate).errors).toHaveLength(0);
    for (const neededOn of ["2026-02-30", "2026-7-15", "2026-07-15T00:00:00Z", "15-07-2026"]) {
      expect(
        instanceAndErrors(CreateSupplyDto, { ...validCreate, needed_on: neededOn }).errors,
      ).not.toHaveLength(0);
    }
  });

  it("normalizes nullable descriptions and validates partial updates", () => {
    const emptyDescription = instanceAndErrors(UpdateSupplyDto, { description: "   " });
    expect(emptyDescription.errors).toHaveLength(0);
    expect(emptyDescription.instance.description).toBeNull();
    expect(instanceAndErrors(UpdateSupplyDto, {}).errors).toHaveLength(0);
    expect(instanceAndErrors(UpdateSupplyDto, { description: null }).errors).toHaveLength(0);
    expect(instanceAndErrors(UpdateSupplyDto, { needed_on: "2026-02-30" }).errors).not.toHaveLength(
      0,
    );
  });

  it("requires a nullable delete reason field and applies plain-text rules", () => {
    expect(instanceAndErrors(DeleteSupplyDto, {}).errors).not.toHaveLength(0);
    expect(instanceAndErrors(DeleteSupplyDto, { reason: null }).errors).toHaveLength(0);

    const emptyReason = instanceAndErrors(DeleteSupplyDto, { reason: "   " });
    expect(emptyReason.errors).toHaveLength(0);
    expect(emptyReason.instance.reason).toBeNull();
    expect(instanceAndErrors(DeleteSupplyDto, { reason: "<b>삭제</b>" }).errors).not.toHaveLength(
      0,
    );
    expect(instanceAndErrors(DeleteSupplyDto, { reason: "삭제\n사유" }).errors).not.toHaveLength(0);
  });

  it("requires an exact desired check state and safe positive revision", () => {
    expect(
      instanceAndErrors(SetSupplyCheckDto, { content_revision: 1, is_checked: true }).errors,
    ).toHaveLength(0);
    for (const contentRevision of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        instanceAndErrors(SetSupplyCheckDto, {
          content_revision: contentRevision,
          is_checked: false,
        }).errors,
      ).not.toHaveLength(0);
    }
    expect(
      instanceAndErrors(SetSupplyCheckDto, { content_revision: 1, is_checked: 1 }).errors,
    ).not.toHaveLength(0);
  });

  it("accepts only the documented list scopes and check filters", () => {
    for (const checkState of [undefined, "unchecked", "modified_unconfirmed", "checked"]) {
      expect(
        instanceAndErrors(ListSuppliesQueryDto, { scope: "upcoming", check_state: checkState })
          .errors,
      ).toHaveLength(0);
    }
    for (const checkState of ["all", "pending", "", null, ["checked", "unchecked"]]) {
      expect(
        instanceAndErrors(ListSuppliesQueryDto, { scope: "upcoming", check_state: checkState })
          .errors,
      ).not.toHaveLength(0);
    }
    for (const scope of ["upcoming", "today", "this_week", "past"]) {
      expect(
        instanceAndErrors(ListSuppliesQueryDto, { scope, category: "homework", q: "수학" }).errors,
      ).toHaveLength(0);
    }
    for (const scope of ["week", "TODAY", null, ["today", "past"]]) {
      expect(instanceAndErrors(ListSuppliesQueryDto, { scope }).errors).not.toHaveLength(0);
    }
    expect(instanceAndErrors(ListSuppliesQueryDto, { scope: "future" }).errors).not.toHaveLength(0);
    expect(
      instanceAndErrors(ListSupplyChecksQueryDto, { state: "modified_unconfirmed" }).errors,
    ).toHaveLength(0);
    expect(instanceAndErrors(ListSupplyChecksQueryDto, { state: "all" }).errors).not.toHaveLength(
      0,
    );
  });
});
