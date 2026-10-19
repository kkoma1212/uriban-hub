import { IdempotencyKeyReusedError } from "@classhub/db";
import { describe, expect, it } from "vitest";
import { mapInviteCodeBoundaryError, mapInviteRotationSignal } from "./invite-code.errors.js";

describe("MariaDB rotate_class_invite diagnostic boundary", () => {
  it.each([
    [30117, 404, "NOT_FOUND"],
    [30118, 401, "UNAUTHENTICATED"],
    [30119, 403, "ROLE_INSUFFICIENT"],
    [30120, 403, "ROLE_INSUFFICIENT"],
    [30121, 404, "INVITE_CODE_NOT_FOUND"],
    [30123, 409, "INVITE_CODE_GENERATION_FAILED"],
    [30127, 423, "CLASS_SUSPENDED"],
  ] as const)("maps only routine signal %s", (errno, status, code) => {
    const error = {
      errno,
      sqlState: "45000",
      message: "private invite AAAAAAA2",
      sql: "private SQL",
    };
    expect(mapInviteRotationSignal(error)).toMatchObject({ status, response: { code } });
    expect(mapInviteCodeBoundaryError(error)).toMatchObject({
      status: 500,
      response: { code: "INTERNAL_ERROR" },
    });
    expect(JSON.stringify(mapInviteRotationSignal(error))).not.toMatch(/private|AAAAAAA2/u);
  });
  it.each([
    { errno: 30123, sqlState: "40001" },
    { errno: "30123", sqlState: "45000" },
    { errno: 30122, sqlState: "45000" },
    { errno: 1213, sqlState: "40001" },
    { errno: 1062, sqlState: "23000" },
    { cause: { errno: 30123, sqlState: "45000" } },
  ])("does not guess domain failure from %o", (error) => {
    expect(mapInviteRotationSignal(error)).toBeUndefined();
    expect(mapInviteCodeBoundaryError(error)).toMatchObject({
      status: 500,
      response: { code: "INTERNAL_ERROR" },
    });
  });
  it("does not invoke diagnostic accessors or proxy traps", () => {
    const error = Object.defineProperty({}, "errno", {
      get() {
        throw new Error("private getter");
      },
    });
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("private proxy");
        },
        getOwnPropertyDescriptor() {
          throw new Error("private proxy");
        },
      },
    );
    for (const value of [error, proxy]) {
      expect(mapInviteRotationSignal(value)).toBeUndefined();
      expect(mapInviteCodeBoundaryError(value)).toMatchObject({
        status: 500,
        response: { code: "INTERNAL_ERROR" },
      });
    }
  });
  it("preserves idempotency hash conflict without private fields", () => {
    expect(mapInviteCodeBoundaryError(new IdempotencyKeyReusedError())).toMatchObject({
      status: 409,
      response: { code: "IDEMPOTENCY_KEY_REUSED" },
    });
  });
});
