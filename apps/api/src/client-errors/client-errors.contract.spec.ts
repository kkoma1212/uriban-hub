import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import { ClientErrorsController } from "./client-errors.controller.js";
import { ReportClientErrorDto } from "./client-errors.dto.js";

const valid = {
  device: "phone",
  name: "TypeError",
  role: "student",
  route: "/notices/:id",
  source: "script",
};
const errorsFor = (values: Record<string, unknown>) =>
  validateSync(plainToInstance(ReportClientErrorDto, { ...valid, ...values }));

describe("client error contract", () => {
  it("requires a signed-in session with CSRF", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ClientErrorsController.prototype.report)).toContain(
      AuthenticatedCsrfGuard,
    );
  });

  it("accepts only the error shape, never free text", () => {
    expect(errorsFor({})).toHaveLength(0);
    // 오류 문장·이메일·검색어·주소 밖 값은 받지 않는다.
    for (const values of [
      { name: "Cannot read properties of undefined" },
      { name: "kim@example.com" },
      { route: "/notices?q=김학생" },
      { route: "https://example.com/notices" },
      { route: "/Notices" },
      { route: "/" + "a".repeat(80) },
      { source: "network" },
      { role: "admin" },
      { device: "tablet" },
    ])
      expect(errorsFor(values).length, JSON.stringify(values)).toBeGreaterThan(0);
  });
});
