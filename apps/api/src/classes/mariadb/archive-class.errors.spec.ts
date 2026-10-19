import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { mapMariaDbArchiveClassError } from "./archive-class.errors.js";

const privateText = "private SQL credentials@example.invalid";
function mapped(input: unknown) {
  const error = mapMariaDbArchiveClassError(input);
  expect(JSON.stringify(error.getResponse())).not.toContain(privateText);
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("sql");
  return { status: error.getStatus(), body: error.getResponse() };
}
describe("MariaDB archive-class error boundary", () => {
  it.each([
    [30002, 404, "NOT_FOUND"],
    [30109, 409, "CLASS_ARCHIVE_CONFLICT"],
    [30110, 409, "CLASS_NAME_CONFIRMATION_MISMATCH"],
    [30111, 401, "UNAUTHENTICATED"],
    [30112, 403, "ROLE_INSUFFICIENT"],
    [30113, 403, "ROLE_INSUFFICIENT"],
    [30114, 409, "CLASS_ARCHIVE_CONFLICT"],
    [30115, 409, "CLASS_ARCHIVE_CONFLICT"],
    [30116, 409, "CLASS_ARCHIVE_CONFLICT"],
    [30126, 423, "CLASS_SUSPENDED"],
  ])("maps exact archive SIGNAL %s to %s/%s", (errno, status, code) => {
    expect(
      mapped({
        errno,
        sqlState: "45000",
        sql: privateText,
        message: privateText,
        cause: privateText,
      }),
    ).toMatchObject({ status, body: { code } });
  });
  it.each([
    undefined,
    null,
    privateText,
    { errno: 1062, sqlState: "23000" },
    { errno: 1213, sqlState: "40001" },
    { errno: 1205, sqlState: "HY000" },
    { errno: 30515, sqlState: "40001" },
    { errno: 30001, sqlState: "45000" },
    { errno: 30003, sqlState: "45000" },
    { errno: 30004, sqlState: "45000" },
    { errno: 30005, sqlState: "45000" },
    { errno: 30006, sqlState: "45000" },
    { errno: 30127, sqlState: "45000" },
    { errno: 30111, sqlState: "23000" },
    { errno: "30111", sqlState: "45000" },
    { errno: 30111 },
    Object.create({ errno: 30111, sqlState: "45000" }) as unknown,
    new Error(privateText),
    new BadRequestException({ code: "PRIVATE", message: privateText }),
  ])("sanitizes unknown/native/other-operation errors: %o", (input) => {
    expect(mapped(input)).toMatchObject({ status: 500, body: { code: "INTERNAL_ERROR" } });
  });
  it("never invokes getters or proxy traps", () => {
    const source = { errno: 30111, sqlState: "45000" },
      trap = vi.fn(() => {
        throw new Error(privateText);
      });
    const revoked = Proxy.revocable(source, {});
    revoked.revoke();
    for (const error of [
      Object.defineProperty({ ...source }, "errno", { get: trap }),
      Object.defineProperty({ ...source }, "sqlState", { get: trap }),
      new Proxy(source, {}),
      new Proxy(source, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap }),
      revoked.proxy,
    ])
      expect(mapped(error).status).toBe(500);
    expect(mapped(Object.defineProperty({ ...source }, "message", { get: trap })).status).toBe(401);
    expect(trap).not.toHaveBeenCalled();
  });
});
