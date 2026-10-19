import { afterEach, describe, expect, it, vi } from "vitest";

import { rejectMember } from "./auth";

describe("member transition API requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the JSON body and content type for a rejection reason", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          member: {
            id: "member-2",
            reason: "반 정보를 확인해 주세요.",
            row_version: "2",
            status: "rejected",
            status_changed_at: "2026-07-13T01:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await rejectMember("member-2", "반 정보를 확인해 주세요.");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/members/member-2/reject");
    expect(init?.body).toBe(JSON.stringify({ reason: "반 정보를 확인해 주세요." }));
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-CSRF-Token")).toBe("test-csrf-token");
  });
});
