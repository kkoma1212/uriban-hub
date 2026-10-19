import { describe, expect, it } from "vitest";
import { createApplicationHttpAdapter } from "./app.factory.js";
import { loadEnvironment } from "./config/environment.js";

async function probe(
  remoteAddress: string,
  hops: number,
  proxies = "127.0.0.1,::1",
  forwardedFor = "203.0.113.99, 198.51.100.11",
) {
  const server = createApplicationHttpAdapter(
    loadEnvironment({
      NODE_ENV: "development",
      TRUSTED_PROXY_HOPS: String(hops),
      TRUSTED_PROXY_ADDRESSES: proxies,
    }),
  ).getInstance();
  server.get("/proxy-evidence", (request) => ({
    ip: request.ip,
    hostname: request.hostname,
    protocol: request.protocol,
  }));
  try {
    const response = await server.inject({
      method: "GET",
      url: "/proxy-evidence",
      remoteAddress,
      headers: {
        host: "origin.example.invalid",
        "x-forwarded-for": forwardedFor,
        "x-forwarded-host": "public.example.invalid",
        "x-forwarded-proto": "https",
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  } finally {
    await server.close();
  }
}

describe("HTTP proxy trust boundary", () => {
  it("ignores all forwarded fields when proxy trust is disabled", async () => {
    expect(await probe("127.0.0.1", 0)).toEqual({
      ip: "127.0.0.1",
      hostname: "origin.example.invalid",
      protocol: "http",
    });
  });
  it("rejects a direct peer even when it forges an allowed loopback hop", async () => {
    expect(await probe("203.0.113.10", 2, "127.0.0.1,::1", "198.51.100.11, 127.0.0.1")).toEqual({
      ip: "203.0.113.10",
      hostname: "origin.example.invalid",
      protocol: "http",
    });
  });
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "accepts the allowed local peer %s and bounds the client chain",
    async (address) => {
      expect(await probe(address, 1)).toEqual({
        ip: "198.51.100.11",
        hostname: "public.example.invalid",
        protocol: "https",
      });
    },
  );
  it("requires both the explicit proxy address and the configured hop budget", async () => {
    const chain = "198.51.100.11, 10.0.0.3";
    const proxies = "10.0.0.2,10.0.0.3";
    expect((await probe("10.0.0.2", 1, proxies, chain)).ip).toBe("10.0.0.3");
    expect((await probe("10.0.0.2", 2, proxies, chain)).ip).toBe("198.51.100.11");
    expect((await probe("10.0.0.2", 2, "10.0.0.2", chain)).ip).toBe("10.0.0.3");
  });
  it.each(["", "localhost", "*", "127.0.0.1,", "10.0.0.0/8"])(
    "rejects ambiguous proxy address configuration %j",
    (addresses) => {
      expect(() =>
        loadEnvironment({
          NODE_ENV: "development",
          TRUSTED_PROXY_HOPS: "1",
          TRUSTED_PROXY_ADDRESSES: addresses,
        }),
      ).toThrow("TRUSTED_PROXY_ADDRESSES");
    },
  );
});
