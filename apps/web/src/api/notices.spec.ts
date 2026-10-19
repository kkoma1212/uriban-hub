import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmNotice,
  createNotice,
  createNoticeReminder,
  deleteNotice,
  getNotice,
  listNoticeConfirmations,
  listNotices,
  updateNotice,
} from "./notices";

const item = {
  content: "금요일까지 제출해 주세요.",
  content_revision: "2",
  id: "17",
  is_important: true,
  published_at: "2026-07-14T03:00:00.000Z",
  row_version: "4",
  title: "수행평가 안내",
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

describe("notices API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests an importance-bound cursor page", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ items: [item], next_cursor: null, server_today: "2026-07-14" }),
      );
    await listNotices("important", "opaque+/cursor");
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/notices?importance=important&cursor=opaque%2B%2Fcursor",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
  });

  it("preserves a strong ETag and falls back to row_version", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(item, 200, { ETag: '"4-from-server"' }))
      .mockResolvedValueOnce(jsonResponse(item));
    await expect(getNotice("17")).resolves.toEqual({ etag: '"4-from-server"', item });
    await expect(getNotice("17")).resolves.toEqual({ etag: '"4"', item });
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe("/api/v1/notices/17");
  });

  /*
   * 사이에 낀 프록시가 응답을 다시 압축하면 강한 ETag 가 약한 값(W/"4")으로 바뀐다.
   * 그대로 If-Match 로 되보내면 서버가 거절해 수정·등록이 통째로 막힌다 —
   * 2026-08-12 터널 접속에서 실제로 났고, 터널 없이 도는 검수는 이걸 못 잡았다.
   */
  it("drops a weak ETag and falls back to row_version", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(item, 200, { ETag: 'W/"4-from-proxy"' }),
    );
    await expect(getNotice("17")).resolves.toEqual({ etag: '"4"', item });
  });

  it("creates with one idempotency key and the exact notice body", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(item, 201, { ETag: '"4"' }));
    const request = {
      audience: { member_ids: ["2"], mode: "selected" as const },
      category: "performance" as const,
      content: item.content,
      is_important: true,
      title: item.title,
    };
    await expect(createNotice(request, "11111111-1111-4111-8111-111111111111")).resolves.toEqual({
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

    await createNotice(
      { content: item.content, is_important: true, title: item.title },
      "22222222-2222-4222-8222-222222222222",
    );

    expect(randomUuid).not.toHaveBeenCalled();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("uses the exact ETag for PATCH and JSON reason for DELETE", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(item, 200, { ETag: '"5"' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await updateNotice(
      "17",
      {
        audience: { member_ids: ["2"], mode: "selected" },
        category: "performance",
        content: "수정",
        is_important: false,
        title: "수정 공지",
      },
      '"4"',
    );
    await deleteNotice("17", "잘못 등록함", '"5"');
    const patchInit = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(patchInit?.headers).get("If-Match")).toBe('"4"');
    expect(JSON.parse(String(patchInit?.body))).toEqual({
      category: "performance",
      content: "수정",
      is_important: false,
      title: "수정 공지",
    });
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ reason: "잘못 등록함" }));
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("If-Match")).toBe('"5"');
  });

  it("confirms an explicit numeric revision and filters teacher lists", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ notice_id: "17", confirmation_state: "confirmed", content_revision: "2" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          counts: { confirmed: 1, unread: 2, modified_unconfirmed: 0 },
          items: [],
          next_cursor: null,
          server_today: "2026-07-14",
        }),
      );
    await confirmNotice("17", "2");
    await listNoticeConfirmations("17", "modified_unconfirmed", "next cursor");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ content_revision: 2 }));
    expect(requestUrl(fetchMock.mock.calls[1]?.[0] as RequestInfo)).toBe(
      "/api/v1/notices/17/confirmations?state=modified_unconfirmed&cursor=next+cursor",
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
      createNoticeReminder("17", "2", "33333333-3333-4333-8333-333333333333"),
    ).resolves.toEqual(response);

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/notices/17/reminders",
    );
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ content_revision: 2 }));
    expect(headers.get("Idempotency-Key")).toBe("33333333-3333-4333-8333-333333333333");
    expect(headers.get("X-CSRF-Token")).toBe("csrf-value");
  });

  it("rejects an unsafe revision before sending a confirmation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(confirmNotice("17", "9007199254740992")).rejects.toThrow(
      "공지 내용이 방금 바뀌었을 수 있어요.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsafe revision before sending a reminder", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      createNoticeReminder("17", "9007199254740992", "33333333-3333-4333-8333-333333333333"),
    ).rejects.toThrow("공지 내용이 방금 바뀌었을 수 있어요.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
