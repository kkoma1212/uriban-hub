import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { AuthController } from "./auth.controller.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "./session-cookie.js";

const RAW_SESSION_SENTINEL = "session-cookie-sentinel-never-audit";

function request(): FastifyRequest {
  return {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${RAW_SESSION_SENTINEL}; ${CSRF_COOKIE_NAME}=csrf-secret`,
      "user-agent": "controller-test-agent",
    },
    id: "00000000-0000-4000-8000-000000000123",
    ip: "127.0.0.1",
    method: "POST",
    routeOptions: { url: "/api/v1/auth/logout" },
  } as unknown as FastifyRequest;
}

function makeController(recordLogout: (...args: unknown[]) => unknown, order: string[] = []) {
  const identity = { currentClassId: "22", userId: "11" };
  const logout = vi.fn().mockResolvedValue(identity);
  const header = vi.fn(() => {
    order.push("clear-cookie");
  });
  const producerRecordLogout = vi.fn((...args: unknown[]) => {
    order.push("producer");
    return recordLogout(...args);
  });
  return {
    controller: new AuthController(
      {} as never,
      {} as never,
      { logout } as never,
      { recordLogout: producerRecordLogout } as never,
    ),
    header,
    identity,
    logout,
    producerRecordLogout,
    reply: { header } as unknown as FastifyReply,
  };
}

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("logout response was delayed by audit")), 250);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe("AuthController logout audit isolation", () => {
  it("does not await a never-settling producer and clears cookies before invoking it", async () => {
    const neverSettles = new Promise<void>(() => undefined);
    const recordLogout = vi.fn(() => neverSettles);
    const order: string[] = [];
    const fixture = makeController(recordLogout, order);
    const httpRequest = request();

    await expect(
      withDeadline(fixture.controller.logout(httpRequest, fixture.reply)),
    ).resolves.toEqual({ logged_out: true });

    expect(fixture.logout).toHaveBeenCalledExactlyOnceWith(RAW_SESSION_SENTINEL);
    expect(fixture.header).toHaveBeenCalledExactlyOnceWith(
      "Set-Cookie",
      expect.arrayContaining([
        expect.stringContaining(`${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0`),
        expect.stringContaining(`${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0`),
      ]),
    );
    expect(order).toEqual(["clear-cookie", "producer"]);
    expect(fixture.producerRecordLogout).toHaveBeenCalledOnce();
    expect(fixture.producerRecordLogout.mock.calls[0]?.[1]).toEqual(fixture.identity);
    expect(JSON.stringify(fixture.producerRecordLogout.mock.calls)).not.toContain(
      RAW_SESSION_SENTINEL,
    );
    expect(JSON.stringify(fixture.producerRecordLogout.mock.calls)).not.toContain("csrf-secret");
  });

  it("preserves the response and clear-cookie header when the producer rejects", async () => {
    const secret = "postgresql://user:password@db/private";
    const recordLogout = vi.fn().mockRejectedValue(new Error(secret));
    const fixture = makeController(recordLogout);

    await expect(
      withDeadline(fixture.controller.logout(request(), fixture.reply)),
    ).resolves.toEqual({ logged_out: true });
    await Promise.resolve();

    expect(fixture.header).toHaveBeenCalledOnce();
    expect(fixture.producerRecordLogout).toHaveBeenCalledOnce();
    expect(JSON.stringify(fixture.producerRecordLogout.mock.calls)).not.toContain(secret);
  });

  it("does not publish when logout has no active session winner", async () => {
    const fixture = makeController(vi.fn());
    fixture.logout.mockResolvedValue(null);

    await expect(fixture.controller.logout(request(), fixture.reply)).resolves.toEqual({
      logged_out: true,
    });

    expect(fixture.header).toHaveBeenCalledOnce();
    expect(fixture.producerRecordLogout).not.toHaveBeenCalled();
  });
});
