import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { AccountRequestAdmissionGuard } from "./account-request-admission.guard.js";
import { AccountRecoveryController } from "./account-recovery.controller.js";
import { AuthController } from "./auth.controller.js";
import { PreAuthOriginGuard } from "./pre-auth-origin.guard.js";
import type { RateLimitRequest } from "../common/rate-limit/redis-rate-limiter.js";

const accountHandlers = [
  AuthController.prototype.signUp,
  AuthController.prototype.requestPasswordReset,
  AccountRecoveryController.prototype.request,
];
const resetHandler = AuthController.prototype.confirmPasswordReset;
function harness() {
  const counts = new Map<string, number>();
  const consume = vi.fn(async (request: RateLimitRequest) => {
    const previous = counts.get(request.key) ?? 0;
    const allowed = previous < request.limit!;
    const count = allowed ? previous + 1 : previous;
    counts.set(request.key, count);
    return {
      allowed,
      count,
      limit: request.limit!,
      remaining: Math.max(0, request.limit! - count),
      retryAfterSeconds: 60,
    };
  });
  const limiter = {
    consume,
    getPolicy: vi.fn(async () => {
      throw new Error("Unexpected database policy lookup");
    }),
  };
  const guard = new AccountRequestAdmissionGuard(
    limiter as never,
    { emailHmacKey: "synthetic-4c-only", emailHmacKeyVersion: "test" } as never,
    new Reflector(),
  );
  const enter = (
    handler: ReturnType<ExecutionContext["getHandler"]> = accountHandlers[0]!,
    body: unknown = { email: "student@example.invalid" },
    ip = "203.0.113.7",
  ) =>
    guard.canActivate({
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => ({ body, ip }) }),
    } as unknown as ExecutionContext);
  return { counts, limiter, enter };
}

describe("account request admission", () => {
  it.each([...accountHandlers, resetHandler])(
    "runs after Origin validation on protected handler %s",
    (handler) => {
      const guards = Reflect.getMetadata("__guards__", handler) as unknown[];
      expect(guards.indexOf(PreAuthOriginGuard)).toBeLessThan(
        guards.indexOf(AccountRequestAdmissionGuard),
      );
      expect(guards).toContain(AccountRequestAdmissionGuard);
    },
  );

  it("keeps the login budget separate and fails closed if a protected handler lacks its scope", async () => {
    const h = harness();
    expect(Reflect.getMetadata("__guards__", AuthController.prototype.login)).not.toContain(
      AccountRequestAdmissionGuard,
    );
    await expect(h.enter(AuthController.prototype.logout)).rejects.toThrow("scope is missing");
    expect(h.limiter.consume).not.toHaveBeenCalled();
  });

  it("shares the pair budget across signup, account finding and reset with normalized email", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++)
      await h.enter(accountHandlers[i % 3], {
        email: i % 2 ? " STUDENT@EXAMPLE.INVALID " : "student@example.invalid",
      });
    await expect(h.enter(accountHandlers[2])).rejects.toMatchObject({
      response: { code: "RATE_LIMITED", retry_after_seconds: 60 },
    });
    await expect(h.enter(accountHandlers[1], { email: "other@example.invalid" })).resolves.toBe(
      true,
    );
    expect(h.limiter.getPolicy).not.toHaveBeenCalled();
  });

  it("preserves email plus addressing and never stores email, token or network text in keys", async () => {
    const h = harness();
    await h.enter(accountHandlers[0], { email: "student+one@example.invalid" });
    await h.enter(accountHandlers[0], { email: "student+two@example.invalid" });
    await h.enter(resetHandler, { token: "T".repeat(43) });
    const pairs = h.limiter.consume.mock.calls
      .map(([request]) => request.key)
      .filter((key) => key.includes(":pair:"));
    expect(new Set(pairs).size).toBe(3);
    expect(JSON.stringify(h.limiter.consume.mock.calls)).not.toMatch(
      /student|example|203\.0\.113|TTTT/u,
    );
  });

  it.each([
    ["203.0.113.7", "::ffff:203.0.113.7"],
    ["2001:db8:0:1::1", "2001:db8:0:1::ffff"],
  ])("groups network aliases %s and %s", async (first, second) => {
    const h = harness();
    for (let i = 0; i < 10; i++)
      await h.enter(accountHandlers[0], { email: "student@example.invalid" }, first);
    await expect(
      h.enter(accountHandlers[1], { email: "student@example.invalid" }, second),
    ).rejects.toThrow();
    await expect(
      h.enter(accountHandlers[1], { email: "student@example.invalid" }, "198.51.100.3"),
    ).resolves.toBe(true);
  });

  it("does not let repeated blocked pair traffic exhaust another network's shared capacity", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) await h.enter();
    for (let i = 0; i < 600; i++) await expect(h.enter()).rejects.toThrow();
    expect(h.counts.get("auth-admission:account-request:service:v1")).toBe(10);
    await expect(
      h.enter(accountHandlers[1], { email: "other@example.invalid" }, "198.51.100.3"),
    ).resolves.toBe(true);
  });

  it("rejects a full service budget without consulting the configurable database policy", async () => {
    const h = harness();
    h.counts.set("auth-admission:account-request:service:v1", 600);
    await expect(h.enter()).rejects.toThrow();
    expect(h.limiter.getPolicy).not.toHaveBeenCalled();
    expect(
      h.limiter.consume.mock.calls.every(
        ([request]) => request.limit !== undefined && request.windowSeconds === 60,
      ),
    ).toBe(true);
  });

  it("isolates reset confirmation capacity from account requests", async () => {
    const h = harness();
    h.counts.set("auth-admission:reset-confirm:service:v1", 120);
    await expect(h.enter(resetHandler, { token: "T".repeat(43) })).rejects.toThrow();
    await expect(h.enter()).resolves.toBe(true);
  });

  it("bounds malformed bodies before validation without echoing their values", async () => {
    const h = harness();
    for (const body of [null, [], "text", {}, { email: "x".repeat(100_000) }])
      await h.enter(accountHandlers[0], body);
    const pairs = h.limiter.consume.mock.calls
      .map(([request]) => request.key)
      .filter((key) => key.includes(":pair:"));
    expect(new Set(pairs).size).toBe(1);
    expect(pairs.every((key) => key.length < 200)).toBe(true);
  });

  it("propagates Redis failure without falling back to unbounded request processing", async () => {
    const h = harness();
    h.limiter.consume.mockRejectedValueOnce(new Error("synthetic Redis failure"));
    await expect(h.enter()).rejects.toThrow("synthetic Redis failure");
    expect(h.limiter.consume).toHaveBeenCalledOnce();
    expect(h.limiter.getPolicy).not.toHaveBeenCalled();
  });
});
