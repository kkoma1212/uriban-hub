import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeAttendanceNotification,
  cancelAttendanceNotification,
  createAttendanceNotification,
  getAttendanceHistory,
  getTodayAttendance,
  updateAttendanceNotification,
} from "./attendance-notifications";

const item = {
  acknowledged_at: null,
  expected_time: "08:30",
  id: "17",
  notification_type: "late" as const,
  row_version: "4",
  status: "pending" as const,
  submitted_at: "2026-07-18T00:01:00.000Z",
  updated_at: "2026-07-18T00:01:00.000Z",
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe("attendance notifications API client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("binds teacher filters and an opaque cursor to the today request", async () => {
    const teacher = {
      counts: { absent: 1, acknowledged: 1, early: 0, late: 1, pending: 1, total: 2 },
      items: [],
      next_cursor: null,
      role: "teacher" as const,
      server_today: "2026-07-18",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(teacher));

    await expect(getTodayAttendance("late", "pending", "opaque+/cursor")).resolves.toEqual({
      data: teacher,
      etag: null,
    });
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/attendance-notifications/today?status=pending&type=late&cursor=opaque%2B%2Fcursor",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
  });

  it("preserves the student's strong ETag and falls back to row_version", async () => {
    const student = {
      notification: item,
      role: "student" as const,
      server_today: "2026-07-18",
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(student, 200, { ETag: '"server-4"' }))
      .mockResolvedValueOnce(jsonResponse(student));

    await expect(getTodayAttendance()).resolves.toEqual({ data: student, etag: '"server-4"' });
    await expect(getTodayAttendance()).resolves.toEqual({ data: student, etag: '"4"' });
  });

  it("requests the signed-in student's history with an encoded date range", async () => {
    const history = {
      counts: { absent: 1, early: 0, late: 2, total: 3 },
      items: [],
      range: { from: "2025-07-18", to: "2026-07-18" },
      role: "student" as const,
      server_today: "2026-07-18",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(history));

    await expect(getAttendanceHistory("2025-07-18", "2026-07-18")).resolves.toEqual(history);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/attendance-notifications/history?from=2025-07-18&to=2026-07-18",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
  });

  it("creates with exact body, server date, CSRF, and one UUID", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(item, 201, { ETag: '"4"' }));
    const request = { expected_time: "08:30", notification_type: "late" as const };

    await expect(
      createAttendanceNotification(request, "2026-07-18", "11111111-1111-4111-8111-111111111111"),
    ).resolves.toEqual({ etag: '"4"', item });
    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify(request));
    expect(headers.get("Idempotency-Key")).toBe("11111111-1111-4111-8111-111111111111");
    expect(headers.get("X-Server-Today")).toBe("2026-07-18");
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

    await createAttendanceNotification(
      { expected_time: "08:30", notification_type: "late" },
      "2026-07-18",
      "22222222-2222-4222-8222-222222222222",
    );

    expect(randomUuid).not.toHaveBeenCalled();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("updates with the quoted ETag and exact conditional time body", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ ...item, expected_time: null, notification_type: "absent" }),
      );

    await updateAttendanceNotification(
      "17",
      { expected_time: null, notification_type: "absent" },
      "2026-07-18",
      '"4"',
    );
    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/attendance-notifications/17",
    );
    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBe(JSON.stringify({ expected_time: null, notification_type: "absent" }));
    expect(headers.get("If-Match")).toBe('"4"');
    expect(headers.get("X-Server-Today")).toBe("2026-07-18");
  });

  it("sends cancel and acknowledge as bodyless conditional actions", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ...item, status: "canceled", row_version: "5" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...item,
          acknowledged_at: "2026-07-18T00:10:00.000Z",
          status: "acknowledged",
          row_version: "6",
        }),
      );

    await cancelAttendanceNotification("17", "2026-07-18", '"4"');
    await acknowledgeAttendanceNotification("17", "2026-07-18", '"5"');

    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/attendance-notifications/17/cancel",
    );
    expect(requestUrl(fetchMock.mock.calls[1]?.[0] as RequestInfo)).toBe(
      "/api/v1/attendance-notifications/17/acknowledge",
    );
    for (const [index, etag] of ['"4"', '"5"'].entries()) {
      const init = fetchMock.mock.calls[index]?.[1];
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("If-Match")).toBe(etag);
      expect(new Headers(init?.headers).get("X-Server-Today")).toBe("2026-07-18");
    }
  });
});
