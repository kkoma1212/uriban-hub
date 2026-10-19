import { afterEach, describe, expect, it, vi } from "vitest";

import { listUpdates } from "./updates";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe("updates API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("binds the opaque cursor request to the selected filter", async () => {
    const body = {
      items: [],
      next_cursor: null,
      selected_audience_enabled: false,
      server_today: "2026-07-26",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body));

    await expect(listUpdates("performance", "opaque+/cursor")).resolves.toEqual(body);

    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/updates?filter=performance&cursor=opaque%2B%2Fcursor",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
  });
});
