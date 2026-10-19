import { afterEach, describe, expect, it, vi } from "vitest";

import { getAuditLogs } from "./audit-logs";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe("audit logs API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends days always, and action/cursor only when present", async () => {
    const body = { items: [], next_cursor: null };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(jsonResponse(body)));

    await expect(getAuditLogs({ action: null, days: 7 })).resolves.toEqual(body);
    await getAuditLogs({ action: "MEMBER_APPROVED", cursor: "c+/1", days: 90 });

    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/audit-logs?days=7",
    );
    expect(requestUrl(fetchMock.mock.calls[1]?.[0] as RequestInfo)).toBe(
      "/api/v1/audit-logs?days=90&action=MEMBER_APPROVED&cursor=c%2B%2F1",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
  });
});
