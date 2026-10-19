import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSupply,
  createSupplyReminder,
  deleteSupply,
  getSupply,
  listSupplies,
  listSupplyChecks,
  setSupplyCheck,
  updateSupply,
} from "./supplies";

const item = {
  category: "general" as const,
  content_revision: "2",
  description: "자와 컴퍼스",
  id: "17",
  needed_on: "2026-07-15",
  row_version: "4",
  title: "수학 준비물",
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe("supplies API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["today", "this_week"] as const)(
    "requests %s with category/search and returns server dates",
    async (scope) => {
      const result = {
        items: [],
        next_cursor: null,
        server_today: "2026-09-22",
        date_range: { start_date: "2026-09-22", end_date: "2026-09-22" },
      };
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(result));
      await expect(
        listSupplies(scope, "cursor+/", "homework", "수학 %_&", "modified_unconfirmed"),
      ).resolves.toEqual(result);
      const url = new URL(requestUrl(fetchMock.mock.calls[0]![0]), "https://classhub.test");
      expect([...url.searchParams]).toEqual([
        ["scope", scope],
        ["cursor", "cursor+/"],
        ["category", "homework"],
        ["q", "수학 %_&"],
        ["check_state", "modified_unconfirmed"],
      ]);
    },
  );

  it("requests each cursor scope without inventing pagination state", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ items: [item], next_cursor: null, server_today: "2026-07-14" }),
      );

    await listSupplies("past", "opaque+/cursor");

    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/supplies?scope=past&cursor=opaque%2B%2Fcursor",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
  });

  it("preserves a strong ETag from detail and falls back to the row version", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(item, 200, { ETag: '"4-from-server"' }))
      .mockResolvedValueOnce(jsonResponse(item));

    await expect(getSupply("17")).resolves.toEqual({ etag: '"4-from-server"', item });
    await expect(getSupply("17")).resolves.toEqual({ etag: '"4"', item });
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe("/api/v1/supplies/17");
  });

  it("creates once with a stable idempotency key and CSRF header", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(item, 201, { ETag: '"4"' }));
    const request = {
      audience: { member_ids: ["2"], mode: "selected" as const },
      category: "general" as const,
      description: "자와 컴퍼스",
      needed_on: "2026-07-15",
      title: "수학 준비물",
    };

    await expect(createSupply(request, "11111111-1111-4111-8111-111111111111")).resolves.toEqual({
      etag: '"4"',
      item,
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify(request));
    expect(headers.get("Idempotency-Key")).toBe("11111111-1111-4111-8111-111111111111");
    expect(headers.get("X-CSRF-Token")).toBe("csrf-value");
  });

  it("preserves a caller-provided idempotency key", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const randomUuid = vi.spyOn(crypto, "randomUUID");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(item, 201, { ETag: '"4"' }));

    await createSupply(
      {
        category: "homework",
        description: "자와 컴퍼스",
        needed_on: "2026-07-15",
        title: "수학 준비물",
      },
      "22222222-2222-4222-8222-222222222222",
    );

    expect(randomUuid).not.toHaveBeenCalled();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("uses the exact ETag for PATCH and JSON reason for a 204 DELETE", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(item, 200, { ETag: '"5"' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await updateSupply(
      "17",
      {
        audience: { member_ids: ["2"], mode: "selected" },
        category: "general",
        description: null,
        needed_on: "2026-07-16",
        title: "수정한 준비물",
      },
      '"4"',
    );
    await deleteSupply("17", "잘못 등록함", '"5"');

    const patchInit = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(patchInit?.headers).get("If-Match")).toBe('"4"');
    expect(JSON.parse(String(patchInit?.body))).toEqual({
      category: "general",
      description: null,
      needed_on: "2026-07-16",
      title: "수정한 준비물",
    });
    const deleteInit = fetchMock.mock.calls[1]?.[1];
    expect(deleteInit?.method).toBe("DELETE");
    expect(deleteInit?.body).toBe(JSON.stringify({ reason: "잘못 등록함" }));
    expect(new Headers(deleteInit?.headers).get("If-Match")).toBe('"5"');
  });

  it("sets an explicit desired check state and filters teacher check lists", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ supply_id: "17", check_state: "checked", content_revision: "2" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          counts: { checked: 1, unchecked: 2, modified_unconfirmed: 0 },
          items: [],
          next_cursor: null,
          server_today: "2026-07-14",
        }),
      );

    await setSupplyCheck("17", true, "2");
    await listSupplyChecks("17", "modified_unconfirmed", "next cursor");

    const checkInit = fetchMock.mock.calls[0]?.[1];
    expect(checkInit?.method).toBe("PUT");
    expect(checkInit?.body).toBe(JSON.stringify({ is_checked: true, content_revision: 2 }));
    expect(requestUrl(fetchMock.mock.calls[1]?.[0] as RequestInfo)).toBe(
      "/api/v1/supplies/17/checks?state=modified_unconfirmed&cursor=next+cursor",
    );
  });

  it("registers an in-app reminder with the caller key and numeric revision", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const response = {
      batch_id: "batch-1",
      cooldown_suppressed_count: 1,
      created_at: "2026-07-24T03:00:00.000Z",
      created_count: 2,
      current_unresolved_count: 3,
      next_available_at: "2026-07-25T03:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(response, 201));

    await expect(
      createSupplyReminder("17", "2", "33333333-3333-4333-8333-333333333333"),
    ).resolves.toEqual(response);

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/supplies/17/reminders",
    );
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ content_revision: 2 }));
    expect(headers.get("Idempotency-Key")).toBe("33333333-3333-4333-8333-333333333333");
    expect(headers.get("X-CSRF-Token")).toBe("csrf-value");
  });

  it("rejects an unsafe revision before sending a check request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(setSupplyCheck("17", true, "9007199254740992")).rejects.toThrow(
      "준비물 내용이 방금 바뀌었을 수 있어요.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsafe revision before sending a reminder", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      createSupplyReminder("17", "9007199254740992", "33333333-3333-4333-8333-333333333333"),
    ).rejects.toThrow("준비물 내용이 방금 바뀌었을 수 있어요.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
