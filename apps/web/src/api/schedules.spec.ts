import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listScheduleCalendar,
  listSchedules,
  updateSchedule,
} from "./schedules";

const item = {
  d_day_label: "D-2",
  days_until: 2,
  description: "3단원까지",
  due_date: "2026-07-16",
  id: "17",
  row_version: "4",
  schedule_type: "exam" as const,
  subject: "수학",
  title: "수학 단원평가",
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

describe("schedules API client", () => {
  it.each(["today", "this_week"] as const)(
    "requests %s and preserves the server's date range",
    async (scope) => {
      const response = {
        items: [],
        next_cursor: null,
        server_today: "2026-09-22",
        date_range: { start_date: "2026-09-21", end_date: "2026-09-27" },
      };
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(response));
      await expect(listSchedules(scope, undefined, "assignment", "수학")).resolves.toEqual(
        response,
      );
      const url = new URL(requestUrl(fetchMock.mock.calls[0]![0]), "https://classhub.test");
      expect([...url.searchParams]).toEqual([
        ["scope", scope],
        ["schedule_type", "assignment"],
        ["q", "수학"],
      ]);
    },
  );

  it("sends the selected type and literal Unicode search with each cursor request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ items: [], next_cursor: null, server_today: "2026-09-22" }),
      );
    await listSchedules("past", "cursor+/", "performance", "수학 %_&");
    const url = new URL(requestUrl(fetchMock.mock.calls[0]![0]), "https://classhub.test");
    expect([...url.searchParams]).toEqual([
      ["scope", "past"],
      ["cursor", "cursor+/"],
      ["schedule_type", "performance"],
      ["q", "수학 %_&"],
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests the exact cursor scope", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ items: [item], next_cursor: null, server_today: "2026-07-14" }),
      );

    await listSchedules("past", "opaque+/cursor");

    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/schedules?scope=past&cursor=opaque%2B%2Fcursor",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
  });

  it("requests one exact inclusive calendar range", async () => {
    const response = {
      end_date: "2028-03-11",
      items: [item],
      oldest_visible_date: "2026-04-25",
      server_today: "2026-07-24",
      start_date: "2028-01-30",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(response));

    await expect(listScheduleCalendar("2028-01-30", "2028-03-11")).resolves.toEqual(response);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/schedules/calendar?end_date=2028-03-11&start_date=2028-01-30",
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

    await expect(getSchedule("17")).resolves.toEqual({ etag: '"4-from-server"', item });
    await expect(getSchedule("17")).resolves.toEqual({ etag: '"4"', item });
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe("/api/v1/schedules/17");
  });

  it("creates with one stable idempotency key and CSRF token", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(item, 201, { ETag: '"4"' }));
    const request = {
      description: "3단원까지",
      due_date: "2026-07-16",
      schedule_type: "exam" as const,
      subject: "수학",
      title: "수학 단원평가",
    };

    await expect(createSchedule(request, "11111111-1111-4111-8111-111111111111")).resolves.toEqual({
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

    await createSchedule(
      {
        description: "3단원까지",
        due_date: "2026-07-16",
        schedule_type: "exam",
        subject: "수학",
        title: "수학 단원평가",
      },
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
    const request = {
      description: null,
      due_date: "2026-07-17",
      schedule_type: "assignment" as const,
      subject: null,
      title: "수정한 일정",
    };

    await updateSchedule("17", request, '"4"');
    await deleteSchedule("17", "잘못 등록함", '"5"');

    const patchInit = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(patchInit?.headers).get("If-Match")).toBe('"4"');
    expect(patchInit?.body).toBe(JSON.stringify(request));
    const deleteInit = fetchMock.mock.calls[1]?.[1];
    expect(deleteInit?.method).toBe("DELETE");
    expect(deleteInit?.body).toBe(JSON.stringify({ reason: "잘못 등록함" }));
    expect(new Headers(deleteInit?.headers).get("If-Match")).toBe('"5"');
  });
});
