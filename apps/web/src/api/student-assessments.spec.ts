import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "./auth";
import {
  completeStudentAssessment,
  createStudentAssessment,
  deleteStudentAssessment,
  exportStudentAssessmentsCsv,
  getStudentAssessment,
  updateStudentAssessment,
  type StudentAssessmentItem,
} from "./student-assessments";

const ITEM: StudentAssessmentItem = {
  academic_year: 2026,
  assessment_date: "2026-07-20",
  assessment_type: "performance",
  created_at: "2026-07-20T03:00:00.000Z",
  expires_at: "2027-03-01T00:00:00.000Z",
  id: "31",
  max_score_hundredths: 10_000,
  memo: null,
  recorded_at: null,
  row_version: "4",
  score_hundredths: 9_100,
  semester: 1,
  status: "draft",
  subject: "수학",
  title: "1학기 수행",
  updated_at: "2026-07-20T03:00:00.000Z",
  weight_basis_points: null,
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

function mockCsrfCookie(): void {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue("__Host-classhub_csrf=csrf-value");
}

describe("student assessments API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers the ETag header and falls back to the row version", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(ITEM, 200, { ETag: '"9"' }))
      .mockResolvedValueOnce(jsonResponse(ITEM));

    await expect(getStudentAssessment("31")).resolves.toEqual({ etag: '"9"', item: ITEM });
    await expect(getStudentAssessment("31")).resolves.toEqual({ etag: '"4"', item: ITEM });
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/my-assessments/31",
    );
  });

  it("creates with an idempotency key and CSRF token", async () => {
    mockCsrfCookie();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(ITEM, 201, { ETag: '"1"' }));

    await createStudentAssessment({ title: "1학기 수행" }, "key-1");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url as RequestInfo)).toBe("/api/v1/my-assessments");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Idempotency-Key")).toBe("key-1");
    expect(headers.get("X-CSRF-Token")).toBe("csrf-value");
    expect(JSON.parse(String(init?.body))).toEqual({ title: "1학기 수행" });
  });

  it("guards update, complete, and delete with If-Match preconditions", async () => {
    mockCsrfCookie();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(ITEM, 200, { ETag: '"5"' }))
      .mockResolvedValueOnce(jsonResponse({ ...ITEM, status: "recorded" }, 200))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await updateStudentAssessment("31", { memo: "정리" }, '"4"');
    await completeStudentAssessment("31", '"5"');
    await deleteStudentAssessment("31", '"5"');

    const methods = fetchMock.mock.calls.map(([, init]) => init?.method);
    expect(methods).toEqual(["PATCH", "POST", "DELETE"]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("If-Match")).toBeTruthy();
    }
    expect(requestUrl(fetchMock.mock.calls[1]?.[0] as RequestInfo)).toBe(
      "/api/v1/my-assessments/31/complete",
    );
  });

  it("returns the CSV body as a blob and surfaces API errors", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("id,title\n31,수행", { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다." } }, 401),
      );

    const blob = await exportStudentAssessmentsCsv();
    await expect(blob.text()).resolves.toContain("수행");

    await expect(exportStudentAssessmentsCsv()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("normalizes a network failure into the Korean unknown-outcome error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(exportStudentAssessmentsCsv()).rejects.toBeInstanceOf(ApiRequestError);
    await expect(exportStudentAssessmentsCsv()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});
