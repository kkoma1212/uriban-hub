import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createApplicationHttpAdapter } from "./app.factory.js";

it("keeps a completed mutation response reachable while its ancillary mail finishes", async () => {
  const server = createApplicationHttpAdapter({
    TRUSTED_PROXY_HOPS: 0,
    TRUSTED_PROXY_ADDRESSES: "127.0.0.1,::1",
  }).getInstance();
  server.post("/delayed-mutation-result", async () => {
    // Real SMTP socket timeout is ten seconds. The committed DB result must
    // still be deliverable when the mail attempt reports that timeout.
    await delay(10_250);
    return { status: "pending", email_delivery_status: "failed" };
  });
  const origin = await server.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`${origin}/delayed-mutation-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "pending", email_delivery_status: "failed" });
  } finally {
    await server.close();
  }
}, 20_000);
