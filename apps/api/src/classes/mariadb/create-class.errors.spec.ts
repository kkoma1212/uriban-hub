import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  InvalidIdempotencyKeyError,
  MariaDbIdempotencyError,
} from "@classhub/db";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { mapMariaDbCreateClassError } from "./create-class.errors.js";

const privateText = "private SQL INSERT token=password@example.invalid";
const mapped = (input: unknown) => {
  const error = mapMariaDbCreateClassError(input);
  expect(JSON.stringify(error.getResponse())).not.toContain(privateText);
  expect(String(error)).not.toContain(privateText);
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("sql");
  return { status: error.getStatus(), body: error.getResponse() };
};

describe("MariaDB create-class public error boundary", () => {
  it.each([
    [30102, 401, "UNAUTHENTICATED"],
    [30103, 409, "CLASS_CREATION_NOT_ALLOWED"],
    [30104, 403, "ROLE_INSUFFICIENT"],
    [30105, 404, "SCHOOL_NOT_FOUND"],
    [30106, 400, "SCHOOL_KIND_NOT_SUPPORTED"],
    [30107, 409, "CLASS_ALREADY_EXISTS"],
    [30108, 409, "INVITE_CODE_GENERATION_FAILED"],
    [30124, 403, "EMAIL_NOT_VERIFIED"],
    [30125, 400, "GRADE_NOT_ALLOWED"],
  ])("maps only exact create SIGNAL %s to %s/%s", (errno, status, code) => {
    expect(
      mapped({
        errno,
        sqlState: "45000",
        message: privateText,
        sql: privateText,
        cause: privateText,
      }),
    ).toMatchObject({ status, body: { code, message: expect.any(String) } });
  });

  it.each([
    undefined,
    null,
    privateText,
    30107,
    { errno: 1062, sqlState: "23000", constraint: "classes_active_identity_unique" },
    { errno: 1213, sqlState: "40001" },
    { errno: 1205, sqlState: "HY000" },
    { errno: 30515, sqlState: "40001" },
    { errno: 30217, sqlState: "45000" },
    { errno: 30006, sqlState: "45000" },
    { errno: 30101, sqlState: "45000" },
    { errno: 30107, sqlState: "23000" },
    { errno: "30107", sqlState: "45000" },
    { errno: 30107 },
    { code: "30107", sqlState: "45000" },
    Object.create({ errno: 30107, sqlState: "45000" }) as unknown,
    new Error(privateText),
    new BadRequestException({ code: "PRIVATE", message: privateText }),
  ])("does not guess a domain error from unknown diagnostics: %o", (error) => {
    expect(mapped(error)).toMatchObject({ status: 500, body: { code: "INTERNAL_ERROR" } });
  });

  it("does not invoke native diagnostic or message getters", () => {
    const get = vi.fn(() => {
      throw new Error(privateText);
    });
    for (const property of ["errno", "sqlState"]) {
      const error = Object.defineProperty({ errno: 30107, sqlState: "45000" }, property, { get });
      expect(mapped(error).status).toBe(500);
    }
    const error = Object.defineProperty({ errno: 30107, sqlState: "45000" }, "message", { get });
    expect(mapped(error).status).toBe(409);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects transparent, throwing and revoked proxies", () => {
    const input = { errno: 30107, sqlState: "45000" };
    const revoked = Proxy.revocable(input, {});
    revoked.revoke();
    for (const error of [
      new Proxy(input, {}),
      new Proxy(input, {
        getPrototypeOf() {
          throw new Error(privateText);
        },
      }),
      revoked.proxy,
    ])
      expect(mapped(error)).toMatchObject({ status: 500, body: { code: "INTERNAL_ERROR" } });
  });

  it.each([
    [new IdempotencyKeyRequiredError(), 400, "IDEMPOTENCY_KEY_REQUIRED"],
    [new InvalidIdempotencyKeyError(), 400, "INVALID_IDEMPOTENCY_KEY"],
    [new IdempotencyKeyReusedError(), 409, "IDEMPOTENCY_KEY_REUSED"],
  ])("preserves existing idempotency error semantics: %o", (input, status, code) => {
    expect(mapped(input)).toMatchObject({ status, body: { code } });
  });

  it("maps invalid idempotency input to validation and internal states to generic 500", () => {
    expect(mapped(new MariaDbIdempotencyError("invalid_request"))).toMatchObject({
      status: 400,
      body: { code: "VALIDATION_FAILED" },
    });
    for (const code of [
      "invalid_response",
      "invalid_stored_response",
      "reservation_conflict",
      "reservation_lost",
    ] as const)
      expect(mapped(new MariaDbIdempotencyError(code))).toMatchObject({
        status: 500,
        body: { code: "INTERNAL_ERROR" },
      });
  });
});
