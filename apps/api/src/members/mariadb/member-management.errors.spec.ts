import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {
  invalidMemberManagementInput,
  mapMariaDbMemberManagementError,
  memberManagementInternalError,
} from "./member-management.errors.js";

type Operation = "approve" | "reject" | "remove" | "rejoin";
const privateText = "private SQL credential@example.invalid";
const contracts: Record<Operation, { status: number; code: string; errnos: number[] }[]> = {
  approve: [
    { status: 404, code: "MEMBER_NOT_FOUND", errnos: [30002, 30301, 30302, 30326] },
    { status: 403, code: "ROLE_INSUFFICIENT", errnos: [30303, 30304, 30305] },
    { status: 409, code: "MEMBER_STATUS_CHANGED", errnos: [30306, 30327] },
    { status: 409, code: "MEMBER_ACCOUNT_INACTIVE", errnos: [30325] },
    { status: 423, code: "CLASS_SUSPENDED", errnos: [30328] },
  ],
  reject: [
    { status: 404, code: "MEMBER_NOT_FOUND", errnos: [30002, 30307, 30308, 30329, 30330] },
    { status: 403, code: "ROLE_INSUFFICIENT", errnos: [30309, 30310, 30311] },
    { status: 409, code: "MEMBER_STATUS_CHANGED", errnos: [30312, 30331] },
    { status: 423, code: "CLASS_SUSPENDED", errnos: [30332] },
  ],
  remove: [
    { status: 404, code: "MEMBER_NOT_FOUND", errnos: [30002, 30313, 30314, 30333, 30334] },
    { status: 403, code: "ROLE_INSUFFICIENT", errnos: [30315, 30316, 30317] },
    { status: 409, code: "MEMBER_STATUS_CHANGED", errnos: [30318, 30335] },
    { status: 423, code: "CLASS_SUSPENDED", errnos: [30336] },
  ],
  rejoin: [
    { status: 404, code: "MEMBER_NOT_FOUND", errnos: [30002, 30319, 30320, 30337, 30338] },
    { status: 403, code: "ROLE_INSUFFICIENT", errnos: [30321, 30322, 30323] },
    { status: 409, code: "MEMBER_STATUS_CHANGED", errnos: [30324, 30339] },
    { status: 423, code: "CLASS_SUSPENDED", errnos: [30340] },
  ],
};
function mapped(input: unknown, operation: Operation) {
  const error = mapMariaDbMemberManagementError(input, operation);
  expect(JSON.stringify(error.getResponse())).not.toContain(privateText);
  expect(String(error)).not.toContain(privateText);
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("sql");
  return { status: error.getStatus(), body: error.getResponse() };
}

describe.each(Object.keys(contracts) as Operation[])("MariaDB %s error boundary", (operation) => {
  it.each(
    contracts[operation].flatMap(({ status, code, errnos }) =>
      errnos.map((errno) => ({ errno, status, code })),
    ),
  )("maps exact operation SIGNAL $errno to $status/$code", ({ errno, status, code }) => {
    expect(
      mapped(
        { errno, sqlState: "45000", message: privateText, sql: privateText, cause: privateText },
        operation,
      ),
    ).toMatchObject({ status, body: { code, message: expect.any(String) } });
  });

  it("rejects every SIGNAL belonging only to another management operation", () => {
    const own = new Set(contracts[operation].flatMap(({ errnos }) => errnos));
    const others = Object.values(contracts).flatMap((groups) =>
      groups.flatMap(({ errnos }) => errnos),
    );
    for (const errno of new Set(others)) {
      if (own.has(errno)) continue;
      expect(mapped({ errno, sqlState: "45000" }, operation)).toMatchObject({
        status: 500,
        body: { code: "INTERNAL_ERROR" },
      });
    }
  });

  it.each([
    undefined,
    null,
    privateText,
    { errno: 1062, sqlState: "23000", constraint: "class_members_student_number_unique" },
    { errno: 1213, sqlState: "40001" },
    { errno: 1205, sqlState: "HY000" },
    { errno: 30515, sqlState: "40001" },
    { errno: 30001, sqlState: "45000" },
    { errno: 30003, sqlState: "45000" },
    { errno: 30004, sqlState: "45000" },
    { errno: 30005, sqlState: "45000" },
    { errno: 30006, sqlState: "45000" },
    { errno: 30209, sqlState: "45000" },
    { errno: 30002, sqlState: "23000" },
    { errno: "30002", sqlState: "45000" },
    { errno: 30002 },
    Object.create({ errno: 30002, sqlState: "45000" }) as unknown,
    new Error(privateText),
    new BadRequestException({ code: "PRIVATE", message: privateText }),
  ])("sanitizes native and forged errors without inferring public semantics: %o", (input) => {
    expect(mapped(input, operation)).toMatchObject({
      status: 500,
      body: { code: "INTERNAL_ERROR" },
    });
  });

  it("never invokes accessors and rejects transparent, hostile and revoked proxies", () => {
    const source = { errno: 30002, sqlState: "45000" };
    const trap = vi.fn(() => {
      throw new Error(privateText);
    });
    const revoked = Proxy.revocable(source, {});
    revoked.revoke();
    for (const input of [
      Object.defineProperty({ ...source }, "errno", { get: trap }),
      Object.defineProperty({ ...source }, "sqlState", { get: trap }),
      new Proxy(source, {}),
      new Proxy(source, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap }),
      revoked.proxy,
    ])
      expect(mapped(input, operation).status).toBe(500);
    expect(
      mapped(Object.defineProperty({ ...source }, "message", { get: trap }), operation).status,
    ).toBe(404);
    expect(trap).not.toHaveBeenCalled();
  });
});

it("constructs fresh fixed validation and internal failures", () => {
  const invalid = invalidMemberManagementInput();
  expect(invalid.getStatus()).toBe(400);
  expect(invalid.getResponse()).toMatchObject({ code: "VALIDATION_FAILED" });
  const internal = memberManagementInternalError();
  expect(internal.getStatus()).toBe(500);
  expect(internal.getResponse()).toMatchObject({ code: "INTERNAL_ERROR" });
  expect(invalid).not.toHaveProperty("cause");
  expect(internal).not.toHaveProperty("cause");
});
