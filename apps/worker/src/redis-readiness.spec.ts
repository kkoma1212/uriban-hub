import { describe, expect, it, vi } from "vitest";

import { probeWorkerRedisReadiness } from "./redis-readiness.js";

function fixture() {
  return {
    worker: { isReady: true, ping: vi.fn(async () => "PONG") },
    readiness: { isReady: true, ping: vi.fn(async () => "PONG") },
  };
}

describe("worker Redis readiness", () => {
  it("pings only the separate connection", async () => {
    const { worker, readiness } = fixture();
    await probeWorkerRedisReadiness(worker, readiness);
    expect(readiness.ping).toHaveBeenCalledOnce();
    expect(worker.ping).not.toHaveBeenCalled();
  });

  it("rejects a shared blocking connection", async () => {
    const { worker } = fixture();
    await expect(probeWorkerRedisReadiness(worker, worker)).rejects.toThrow();
    expect(worker.ping).not.toHaveBeenCalled();
  });

  it.each(["worker", "readiness"] as const)(
    "fails closed while the %s connection is disconnected and recovers",
    async (connection) => {
      const clients = fixture();
      clients[connection].isReady = false;
      await expect(probeWorkerRedisReadiness(clients.worker, clients.readiness)).rejects.toThrow();
      expect(clients.readiness.ping).not.toHaveBeenCalled();
      clients[connection].isReady = true;
      await expect(
        probeWorkerRedisReadiness(clients.worker, clients.readiness),
      ).resolves.toBeUndefined();
    },
  );

  it.each(["worker", "readiness"] as const)(
    "rejects a PONG when the %s connection disconnected during the probe",
    async (connection) => {
      const clients = fixture();
      clients.readiness.ping.mockImplementation(async () => {
        clients[connection].isReady = false;
        return "PONG";
      });
      await expect(probeWorkerRedisReadiness(clients.worker, clients.readiness)).rejects.toThrow();
    },
  );

  it("does not treat a failed PING or an unexpected reply as ready", async () => {
    const { worker, readiness } = fixture();
    readiness.ping.mockRejectedValueOnce(new Error("Redis unavailable"));
    await expect(probeWorkerRedisReadiness(worker, readiness)).rejects.toThrow();
    readiness.ping.mockResolvedValueOnce("unexpected");
    await expect(probeWorkerRedisReadiness(worker, readiness)).rejects.toThrow();
  });
});
