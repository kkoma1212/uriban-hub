import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { mapMariaDbMembershipRequestError } from "./request-membership.errors.js";

const privateText = "private SQL credential=value@example.invalid";
function mapped(input: unknown) {
  const error = mapMariaDbMembershipRequestError(input);
  expect(JSON.stringify(error.getResponse())).not.toContain(privateText);
  expect(String(error)).not.toContain(privateText);
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("sql");
  return { status: error.getStatus(), body: error.getResponse() };
}

describe("MariaDB membership-request public error boundary", () => {
  it.each([
    [30002, 400, "INVITE_CODE_INVALID_OR_EXPIRED"],
    [30201, 400, "INVITE_CODE_INVALID_OR_EXPIRED"],
    [30202, 401, "UNAUTHENTICATED"],
    [30203, 409, "CURRENT_MEMBERSHIP_EXISTS"],
    [30204, 409, "MEMBERSHIP_REQUEST_NOT_ALLOWED"],
    [30205, 400, "INVITE_CODE_INVALID_OR_EXPIRED"],
    [30206, 409, "MEMBERSHIP_REQUEST_NOT_ALLOWED"],
    [30216, 409, "REJOIN_NOT_ALLOWED"],
    [30217, 403, "EMAIL_NOT_VERIFIED"],
  ])("maps exact request SIGNAL %s to %s/%s", (errno, status, code) => {
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
    30203,
    { errno: 1062, sqlState: "23000", constraint: "class_members_one_current_per_user" },
    { errno: 1213, sqlState: "40001" },
    { errno: 1205, sqlState: "HY000" },
    { errno: 30515, sqlState: "40001" },
    { errno: 30001, sqlState: "45000" },
    { errno: 30003, sqlState: "45000" },
    { errno: 30004, sqlState: "45000" },
    { errno: 30005, sqlState: "45000" },
    { errno: 30006, sqlState: "45000" },
    { errno: 30124, sqlState: "45000" },
    { errno: 30207, sqlState: "45000" },
    { errno: 30208, sqlState: "45000" },
    { errno: 30203, sqlState: "23000" },
    { errno: "30203", sqlState: "45000" },
    { errno: 30203 },
    { code: "30203", sqlState: "45000" },
    Object.create({ errno: 30203, sqlState: "45000" }) as unknown,
    new Error(privateText),
    new BadRequestException({ code: "PRIVATE", message: privateText }),
  ])("does not infer public semantics from other diagnostics: %o", (error) => {
    expect(mapped(error)).toMatchObject({ status: 500, body: { code: "INTERNAL_ERROR" } });
  });

  it("never invokes diagnostic or message accessors", () => {
    const get = vi.fn(() => {
      throw new Error(privateText);
    });
    for (const property of ["errno", "sqlState"]) {
      const error = Object.defineProperty({ errno: 30203, sqlState: "45000" }, property, { get });
      expect(mapped(error).status).toBe(500);
    }
    const error = Object.defineProperty({ errno: 30203, sqlState: "45000" }, "message", { get });
    expect(mapped(error).status).toBe(409);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects transparent, throwing and revoked proxies without invoking traps", () => {
    const input = { errno: 30203, sqlState: "45000" };
    const trap = vi.fn(() => {
      throw new Error(privateText);
    });
    const revoked = Proxy.revocable(input, {});
    revoked.revoke();
    for (const error of [
      new Proxy(input, {}),
      new Proxy(input, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap }),
      revoked.proxy,
    ])
      expect(mapped(error)).toMatchObject({ status: 500, body: { code: "INTERNAL_ERROR" } });
    expect(trap).not.toHaveBeenCalled();
  });
});
