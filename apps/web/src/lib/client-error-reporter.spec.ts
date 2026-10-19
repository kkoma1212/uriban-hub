import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Reporter = typeof import("./client-error-reporter");

// 보낸 기록(중복·한도)은 모듈 안에 있으므로 검사마다 새로 불러온다.
async function freshReporter(): Promise<Reporter> {
  vi.resetModules();
  return import("./client-error-reporter");
}

function signedIn(signed: boolean): void {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    signed ? "__Host-classhub_csrf=synthetic-token" : "",
  );
}

function mockFetch(status = 204) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
}

function sentBodies(fetchMock: ReturnType<typeof mockFetch>): Record<string, string>[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
}

beforeEach(() => {
  window.history.replaceState(null, "", "/notices/123");
  document.body.innerHTML = '<div data-app-role="student"></div>';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("client error reporter", () => {
  it("sends only the screen shape and error name, never the message", async () => {
    signedIn(true);
    const fetchMock = mockFetch();
    const { reportClientError } = await freshReporter();

    reportClientError(new TypeError("김학생 kim@example.com 의 글을 읽지 못함"), "script");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/client-errors");
    expect(init?.headers).toMatchObject({ "X-CSRF-Token": "synthetic-token" });
    expect(sentBodies(fetchMock)[0]).toEqual({
      device: expect.stringMatching(/^(phone|desktop)$/u),
      name: "TypeError",
      role: "student",
      route: "/notices/:id",
      source: "script",
    });
    expect(String(init?.body)).not.toMatch(/김학생|example\.com|123/u);
  });

  it("does not send before sign-in", async () => {
    signedIn(false);
    const fetchMock = mockFetch();
    const { reportClientError } = await freshReporter();
    reportClientError(new Error("x"), "script");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the same error once per page and stops after the session is gone", async () => {
    signedIn(true);
    const fetchMock = mockFetch(401);
    const { reportClientError } = await freshReporter();

    reportClientError(new TypeError("a"), "script");
    reportClientError(new TypeError("b"), "script");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fetchMock.mock.results[0]?.value).resolves.toBeDefined());
    await Promise.resolve();
    reportClientError(new RangeError("c"), "script");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies failed screen-file loads as chunk errors", async () => {
    signedIn(true);
    const fetchMock = mockFetch();
    const { reportClientError } = await freshReporter();
    reportClientError(
      new TypeError("Failed to fetch dynamically imported module: /assets/x.js"),
      "render",
    );
    expect(sentBodies(fetchMock)[0]).toMatchObject({ name: "TypeError", source: "chunk" });
  });

  it("never throws when sending fails", async () => {
    signedIn(true);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const { reportClientError } = await freshReporter();
    expect(() => reportClientError(new Error("x"), "promise")).not.toThrow();
  });

  it("turns ids, tokens and unexpected characters into :id", async () => {
    const { clientErrorRoute } = await freshReporter();
    expect(clientErrorRoute("/help-requests/45")).toBe("/help-requests/:id");
    expect(clientErrorRoute("/signup-approval/AbCdEf_123")).toBe("/signup-approval/:id");
    expect(clientErrorRoute("/help-requests/ask")).toBe("/help-requests/ask");
    expect(clientErrorRoute("/" + "a/".repeat(60))).toBe("/");
  });
});
