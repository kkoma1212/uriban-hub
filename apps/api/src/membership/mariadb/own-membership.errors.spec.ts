import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {
  invalidOwnMembershipInput,
  mapMariaDbOwnMembershipError,
  ownMembershipInternalError,
  ownMembershipRetryClassifier,
} from "./own-membership.errors.js";

const privateText = "private SQL credentials@example.invalid";
type Operation = "cancel" | "leave";
function mapped(input: unknown, operation: Operation) {
  const error = mapMariaDbOwnMembershipError(input, operation);
  expect(JSON.stringify(error.getResponse())).not.toContain(privateText);
  expect(String(error)).not.toContain(privateText);
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("sql");
  return { status: error.getStatus(), body: error.getResponse() };
}

describe("MariaDB own-membership operation error boundaries", () => {
  it.each([
    ["cancel", 30002, 409, "MEMBERSHIP_STATUS_CHANGED"],
    ["cancel", 30208, 409, "MEMBERSHIP_STATUS_CHANGED"],
    ["cancel", 30209, 401, "UNAUTHENTICATED"],
    ["cancel", 30210, 409, "MEMBERSHIP_STATUS_CHANGED"],
    ["cancel", 30211, 409, "MEMBERSHIP_STATUS_CHANGED"],
    ["leave", 30002, 409, "MEMBERSHIP_STATUS_CHANGED"],
    ["leave", 30212, 409, "MEMBERSHIP_STATUS_CHANGED"],
    ["leave", 30213, 401, "UNAUTHENTICATED"],
    ["leave", 30214, 409, "MEMBERSHIP_STATUS_CHANGED"],
    ["leave", 30215, 409, "MEMBERSHIP_STATUS_CHANGED"],
  ] as const)("maps only %s SIGNAL %s to %s/%s", (operation, errno, status, code) => {
    expect(
      mapped(
        { errno, sqlState: "45000", message: privateText, sql: privateText, cause: privateText },
        operation,
      ),
    ).toMatchObject({ status, body: { code, message: expect.any(String) } });
  });

  it.each([
    ["cancel", 30212],
    ["cancel", 30213],
    ["cancel", 30214],
    ["cancel", 30215],
    ["leave", 30208],
    ["leave", 30209],
    ["leave", 30210],
    ["leave", 30211],
  ] as const)("rejects another operation's %s/%s SIGNAL", (operation, errno) => {
    expect(mapped({ errno, sqlState: "45000" }, operation)).toMatchObject({
      status: 500,
      body: { code: "INTERNAL_ERROR" },
    });
  });

  describe.each(["cancel", "leave"] as const)("%s unknown failures", (operation) => {
    it.each([
      undefined,
      null,
      privateText,
      30002,
      { errno: 1062, sqlState: "23000", constraint: "class_members_one_current_per_user" },
      { errno: 1213, sqlState: "40001" },
      { errno: 1205, sqlState: "HY000" },
      { errno: 30515, sqlState: "40001" },
      { errno: 30001, sqlState: "45000" },
      { errno: 30003, sqlState: "45000" },
      { errno: 30004, sqlState: "45000" },
      { errno: 30005, sqlState: "45000" },
      { errno: 30006, sqlState: "45000" },
      { errno: 30202, sqlState: "45000" },
      { errno: 30217, sqlState: "45000" },
      { errno: 30002, sqlState: "23000" },
      { errno: "30002", sqlState: "45000" },
      { errno: 30002 },
      { code: "30002", sqlState: "45000" },
      Object.create({ errno: 30002, sqlState: "45000" }) as unknown,
      new Error(privateText),
      new BadRequestException({ code: "PRIVATE", message: privateText }),
    ])("sanitizes other native, custom and forged errors: %o", (input) => {
      expect(mapped(input, operation)).toMatchObject({
        status: 500,
        body: { code: "INTERNAL_ERROR" },
      });
    });

    it("never invokes diagnostic or message getters", () => {
      const get = vi.fn(() => {
        throw new Error(privateText);
      });
      for (const property of ["errno", "sqlState"]) {
        const input = Object.defineProperty({ errno: 30002, sqlState: "45000" }, property, { get });
        expect(mapped(input, operation).status).toBe(500);
      }
      const input = Object.defineProperty({ errno: 30002, sqlState: "45000" }, "message", { get });
      expect(mapped(input, operation).status).toBe(409);
      expect(get).not.toHaveBeenCalled();
    });

    it("rejects transparent, hostile and revoked proxies without invoking traps", () => {
      const input = { errno: 30002, sqlState: "45000" };
      const trap = vi.fn(() => {
        throw new Error(privateText);
      });
      const revoked = Proxy.revocable(input, {});
      revoked.revoke();
      for (const value of [
        new Proxy(input, {}),
        new Proxy(input, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap }),
        revoked.proxy,
      ])
        expect(mapped(value, operation).status).toBe(500);
      expect(trap).not.toHaveBeenCalled();
    });
  });

  it("constructs fixed input and internal errors without diagnostic fields", () => {
    const input = invalidOwnMembershipInput();
    expect(input.getStatus()).toBe(400);
    expect(input.getResponse()).toMatchObject({ code: "VALIDATION_FAILED" });
    const internal = ownMembershipInternalError();
    expect(internal.getStatus()).toBe(500);
    expect(internal.getResponse()).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(input).not.toHaveProperty("cause");
    expect(internal).not.toHaveProperty("cause");
  });

  it("classifies only own data diagnostics as retryable and never invokes accessors or proxy traps", () => {
    const native = { errno: 1213, sqlState: "40001" };
    expect(ownMembershipRetryClassifier.classify(native)).toEqual({
      kind: "deadlock",
      vendorCode: "1213",
    });
    const trap = vi.fn(() => {
      throw new Error(privateText);
    });
    const revoked = Proxy.revocable(native, {});
    revoked.revoke();
    for (const input of [
      Object.create(native) as unknown,
      Object.defineProperty({ ...native }, "errno", { get: trap }),
      Object.defineProperty({ ...native }, "sqlState", { get: trap }),
      new Proxy(native, {}),
      new Proxy(native, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap }),
      revoked.proxy,
    ])
      expect(ownMembershipRetryClassifier.classify(input)).toEqual({ kind: "unknown" });
    expect(trap).not.toHaveBeenCalled();
  });
});
