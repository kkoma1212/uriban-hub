import { describe, expect, it } from "vitest";

import {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  IdempotencyKeyRequiredError,
  InvalidIdempotencyKeyError,
  normalizeIdempotencyKey,
  serializeCanonicalRequest,
} from "../src/idempotency/index.js";

describe("idempotency canonical contract", () => {
  it("normalizes a UUID and distinguishes missing from invalid headers", () => {
    expect(normalizeIdempotencyKey("550E8400-E29B-41D4-A716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(() => normalizeIdempotencyKey(undefined)).toThrow(IdempotencyKeyRequiredError);
    expect(() => normalizeIdempotencyKey("not-a-uuid")).toThrow(InvalidIdempotencyKeyError);
    expect(() => normalizeIdempotencyKey(["550e8400-e29b-41d4-a716-446655440000"])).toThrow(
      InvalidIdempotencyKeyError,
    );
  });

  it("sorts object keys recursively while preserving array order", () => {
    const first = serializeCanonicalRequest({
      body: { nested: { z: 1, a: 2 }, values: [3, 1, 2] },
      effectiveClassId: "42",
    });
    const second = serializeCanonicalRequest({
      body: { values: [3, 1, 2], nested: { a: 2, z: 1 } },
      effectiveClassId: "42",
    });

    expect(first).toBe(second);
    expect(first).toContain('"values":[3,1,2]');
  });

  it("treats omitted optional fields and explicit null as the same request", () => {
    const omitted = createIdempotencyRequestHash({
      body: { title: "알림" },
      effectiveClassId: "42",
      optionalFields: ["content"],
    });
    const explicitNull = createIdempotencyRequestHash({
      body: { content: null, title: "알림" },
      effectiveClassId: "42",
      optionalFields: ["content"],
    });

    expect(omitted.equals(explicitNull)).toBe(true);
  });

  it("changes the route and request identity when the effective class changes", () => {
    const body = { title: "알림" };
    const first = createIdempotencyRequestHash({ body, effectiveClassId: "41" });
    const second = createIdempotencyRequestHash({ body, effectiveClassId: "42" });

    expect(first.equals(second)).toBe(false);
    expect(createIdempotencyRouteKey("POST /notices", "42")).toBe("POST /notices|class:42");
  });

  it("rejects undefined values and non-integer numbers after validation", () => {
    expect(() =>
      serializeCanonicalRequest({ body: { title: undefined }, effectiveClassId: null }),
    ).toThrow(TypeError);
    expect(() =>
      serializeCanonicalRequest({ body: { amount: 1.5 }, effectiveClassId: null }),
    ).toThrow(TypeError);
  });
});
