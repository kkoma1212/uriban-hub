import { ShutdownSignal } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mainMocks = vi.hoisted(() => ({
  createApplication: vi.fn(),
}));

vi.mock("./app.factory.js", () => ({
  createApplication: mainMocks.createApplication,
}));

describe("API process bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    mainMocks.createApplication.mockReset();
  });

  it("registers SIGINT and SIGTERM shutdown hooks before listening", async () => {
    const enableShutdownHooks = vi.fn();
    const listen = vi.fn().mockResolvedValue(undefined);
    mainMocks.createApplication.mockResolvedValue({
      app: { enableShutdownHooks, listen },
      environment: { API_HOST: "127.0.0.1", API_PORT: 3000 },
    });

    await import("./main.js");
    await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce());

    expect(enableShutdownHooks).toHaveBeenCalledExactlyOnceWith([
      ShutdownSignal.SIGINT,
      ShutdownSignal.SIGTERM,
    ]);
    expect(enableShutdownHooks.mock.invocationCallOrder[0]).toBeLessThan(
      listen.mock.invocationCallOrder[0]!,
    );
    expect(listen).toHaveBeenCalledWith(3000, "127.0.0.1");
  });

  it("surfaces application startup failures through module evaluation", async () => {
    const failure = new Error("simulated application startup failure");
    mainMocks.createApplication.mockRejectedValue(failure);

    await expect(import("./main.js")).rejects.toBe(failure);
  });
});
