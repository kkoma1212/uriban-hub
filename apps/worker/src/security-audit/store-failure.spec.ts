import { describe, expect, it, vi } from "vitest";

import { classifySecurityAuditStoreFailure as classify } from "./store-failure.js";

describe("safe audit store failure categories", () => {
  it.each([
    [{ code: "23503" }, "reference_missing"],
    [{ errno: 1452, sqlState: "23000" }, "reference_missing"],
    [{ code: "23514" }, "constraint_rejected"],
    [{ errno: 4025, sqlState: "23000" }, "constraint_rejected"],
    [{ code: "42501" }, "permission_denied"],
    [{ errno: 1142, sqlState: "42000" }, "permission_denied"],
    [{ code: "40001" }, "contention"],
    [{ code: "40P01" }, "contention"],
    [{ errno: 1213, sqlState: "40001" }, "contention"],
    [{ errno: 1205, sqlState: "HY000" }, "contention"],
    [{ code: "ECONNREFUSED" }, "connection_unavailable"],
    [{ code: "08006" }, "connection_unavailable"],
    [{ code: "WORKER_MARIADB_DATABASE_FAILED", reason: "query_timeout" }, "connection_unavailable"],
    [
      { code: "MARIADB_RUNTIME_ROLE_ATTESTATION_FAILED", reason: "privileges_rejected" },
      "permission_denied",
    ],
    [{ code: "MARIADB_RUNTIME_ROLE_ATTESTATION_FAILED", reason: "query_failed" }, "unknown"],
    [
      { code: "MARIADB_SECURITY_AUDIT_STORE_FAILED", failureReason: "reference_missing" },
      "reference_missing",
    ],
    [{ code: "MARIADB_SECURITY_AUDIT_STORE_FAILED", failureReason: "private-value" }, "unknown"],
    [{ errno: "1452", sqlState: "23000" }, "unknown"],
    [{ errno: 1452, sqlState: "unexpected" }, "unknown"],
    [{ errno: 1062, sqlState: "23000" }, "unknown"],
    [new Error("private SQL, token and connection details"), "unknown"],
    [null, "unknown"],
    ["23503", "unknown"],
  ] as const)("classifies only recognized primitive metadata (%#)", (error, reason) => {
    expect(classify(error)).toBe(reason);
  });

  it("does not execute getters, inherited properties, proxies or coercion hooks", () => {
    const trap = vi.fn(() => {
      throw new Error("must not execute");
    });
    const coercion = { toString: trap, valueOf: trap, [Symbol.toPrimitive]: trap };
    const getter = Object.defineProperty({}, "code", { get: trap });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor: trap, get: trap });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const error of [
      getter,
      proxy,
      revoked.proxy,
      { code: coercion, errno: coercion },
      Object.create({ code: "23503" }),
    ]) {
      expect(classify(error)).toBe("unknown");
    }
    expect(trap).not.toHaveBeenCalled();
  });
});
