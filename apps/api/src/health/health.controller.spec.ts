import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { HealthController } from "./health.controller.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function replyStub(): {
  reply: FastifyReply;
  status: ReturnType<typeof vi.fn>;
} {
  const status = vi.fn();
  return {
    reply: { status } as unknown as FastifyReply,
    status,
  };
}

function createController(ensureAvailable = vi.fn().mockResolvedValue(undefined)): {
  controller: HealthController;
  ensureAvailable: ReturnType<typeof vi.fn>;
} {
  return {
    controller: new HealthController(
      { transaction: vi.fn() } as never,
      { ensureAvailable } as never,
    ),
    ensureAvailable,
  };
}

describe("HealthController shutdown readiness", () => {
  it("fails readiness closed without probing dependencies once shutdown starts", async () => {
    const { controller, ensureAvailable } = createController();
    const databaseProbe = vi.spyOn(
      controller as unknown as { probeDatabase: () => Promise<void> },
      "probeDatabase",
    );
    const { reply, status } = replyStub();

    controller.beforeApplicationShutdown();

    await expect(controller.getReadiness(reply)).resolves.toEqual({ status: "not_ready" });
    expect(status).toHaveBeenCalledExactlyOnceWith(503);
    expect(databaseProbe).not.toHaveBeenCalled();
    expect(ensureAvailable).not.toHaveBeenCalled();
    expect(controller.getHealth()).toEqual({ status: "ok" });
  });

  it("does not become ready when shutdown begins during an in-flight probe", async () => {
    const stalledDatabase = deferred();
    const { controller } = createController();
    const databaseProbe = vi
      .spyOn(controller as unknown as { probeDatabase: () => Promise<void> }, "probeDatabase")
      .mockImplementation(() => stalledDatabase.promise);
    const { reply, status } = replyStub();

    const readiness = controller.getReadiness(reply);
    await vi.waitFor(() => {
      expect(databaseProbe).toHaveBeenCalledOnce();
    });
    controller.beforeApplicationShutdown();
    stalledDatabase.resolve();

    await expect(readiness).resolves.toEqual({ status: "not_ready" });
    expect(status).toHaveBeenCalledExactlyOnceWith(503);
    expect(controller.getHealth()).toEqual({ status: "ok" });
  });
});
