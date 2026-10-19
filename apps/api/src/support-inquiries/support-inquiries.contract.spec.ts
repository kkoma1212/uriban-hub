import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { SupportInquiriesController } from "./support-inquiries.controller.js";
import { CreateSupportInquiryDto } from "./support-inquiries.dto.js";

describe("support inquiry contract", () => {
  it("requires a session for reads and CSRF for creation", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, SupportInquiriesController.prototype.list),
    ).toContain(AuthenticatedSessionGuard);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, SupportInquiriesController.prototype.create),
    ).toContain(AuthenticatedCsrfGuard);
  });

  it("bounds the subject and body", () => {
    expect(
      validateSync(
        plainToInstance(CreateSupportInquiryDto, { body: "도움이 필요합니다.", subject: "문의" }),
      ),
    ).toHaveLength(0);
    expect(
      validateSync(plainToInstance(CreateSupportInquiryDto, { body: "", subject: "" })).length,
    ).toBeGreaterThan(0);
    expect(
      validateSync(plainToInstance(CreateSupportInquiryDto, { body: "   ", subject: "   " }))
        .length,
    ).toBeGreaterThan(0);
    expect(
      validateSync(
        plainToInstance(CreateSupportInquiryDto, {
          body: "<script>alert(1)</script>",
          subject: "문의",
        }),
      ).length,
    ).toBeGreaterThan(0);
  });
});
