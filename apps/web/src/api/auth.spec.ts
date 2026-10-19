import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL,
  handleAuthenticatedClientStateStorage,
} from "../lib/authenticated-client-state";
import {
  apiFetch,
  ApiRequestError,
  cancelMembershipRequest,
  changePassword,
  confirmGuardianConsent,
  createClass,
  createGuardianConsentRequest,
  getGuardianConsentRequestStatus,
  leaveCurrentClass,
  login,
  logout,
  NETWORK_ERROR_CODE,
  parseResponse,
  REQUEST_ABORTED_CODE,
  REQUEST_TIMEOUT_CODE,
  resendVerificationEmail,
  rotateCurrentInviteCode,
  signUp,
  updateCurrentClass,
  withCsrfRecovery,
} from "./auth";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function csrfInvalidResponse(): Response {
  return jsonResponse({ error: { code: "CSRF_INVALID", message: "CSRF token is invalid." } }, 403);
}

async function capturedRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("apiFetch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("passes a successful response through untouched", async () => {
    const response = jsonResponse({ ok: true });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(apiFetch("/api/v1/home")).resolves.toBe(response);
  });

  it("normalizes a network failure into a Korean unknown-outcome error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await capturedRejection(apiFetch("/api/v1/home"));

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      code: NETWORK_ERROR_CODE,
      message: "서버에 연결하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.",
      status: 0,
    });
    // The browser's English message must never surface to the UI.
    expect((error as ApiRequestError).message).not.toContain("Failed to fetch");
  });

  it("times out a permanently pending response without exposing request details", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise(() => undefined));

    const errorPromise = capturedRejection(
      apiFetch("/api/v1/private/student@example.com?token=private-token"),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      code: REQUEST_TIMEOUT_CODE,
      message:
        "요청 시간이 초과되어 결과를 확인하지 못했습니다. 현재 상태를 확인한 뒤 다시 시도해 주세요.",
      status: 0,
    });
    expect((error as ApiRequestError).message).not.toContain("student@example.com");
    expect((error as ApiRequestError).message).not.toContain("private-token");
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives an earlier caller abort priority over the deadline and hides its reason", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => undefined));
    const errorPromise = capturedRejection(apiFetch("/api/v1/home", { signal: controller.signal }));

    await vi.advanceTimersByTimeAsync(19_999);
    controller.abort("private caller reason");
    await vi.advanceTimersByTimeAsync(1);
    const error = await errorPromise;

    expect(error).toMatchObject({
      code: REQUEST_ABORTED_CODE,
      message: "요청이 취소되었습니다. 다시 시도해 주세요.",
      status: 0,
    });
    expect((error as ApiRequestError).message).not.toContain("private caller reason");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start fetch or install timers for an already aborted signal", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(apiFetch("/api/v1/home", { signal: controller.signal })).rejects.toMatchObject({
      code: REQUEST_ABORTED_CODE,
      status: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans the deadline timer and caller abort listener after success", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const response = jsonResponse({ ok: true });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(apiFetch("/api/v1/home", { signal: controller.signal })).resolves.toBe(response);

    const abortListener = addListener.mock.calls.find(([type]) => type === "abort")?.[1];
    expect(abortListener).toBeTypeOf("function");
    expect(removeListener).toHaveBeenCalledWith("abort", abortListener);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves HTTP 401 and 415 parsing semantics", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다." } }, 401),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "INTERNAL_ERROR", message: "private upstream detail" } },
          415,
        ),
      );

    const unauthorized = await capturedRejection(
      apiFetch("/api/v1/home").then((response) => parseResponse(response)),
    );
    const unsupported = await capturedRejection(
      apiFetch("/api/v1/home").then((response) => parseResponse(response)),
    );

    expect(unauthorized).toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(unsupported).toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "요청 형식을 처리할 수 없어요. 화면을 새로고침한 뒤 다시 시도해 주세요.",
      status: 415,
    });
  });
});

describe("parseResponse", () => {
  it("returns a successful JSON body unchanged", async () => {
    const body = { destination: "HOME", server_today: "2026-07-13" };

    await expect(parseResponse(jsonResponse(body))).resolves.toEqual(body);
  });

  it("preserves a valid JSON API error envelope", async () => {
    const error = await capturedRejection(
      parseResponse(
        jsonResponse(
          {
            error: {
              code: "UNAUTHENTICATED",
              details: { next_available_at: "2026-07-25T03:00:00.000Z" },
              message: "로그인이 필요합니다.",
              request_id: "request-1",
            },
          },
          401,
        ),
      ),
    );

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      code: "UNAUTHENTICATED",
      details: { next_available_at: "2026-07-25T03:00:00.000Z" },
      message: "로그인이 필요합니다.",
      status: 401,
    });
  });

  it.each([
    {
      name: "an HTML gateway error",
      response: () =>
        new Response("<html><body>Bad Gateway</body></html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
      status: 502,
    },
    {
      name: "an empty unauthorized response",
      response: () => new Response(null, { status: 401 }),
      status: 401,
    },
    {
      name: "an empty gateway error",
      response: () => new Response(null, { status: 502 }),
      status: 502,
    },
    {
      name: "malformed JSON from an error response",
      response: () =>
        new Response('{"error":', {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
      status: 502,
    },
    {
      name: "malformed JSON from a successful response",
      response: () =>
        new Response('{"destination":', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      status: 200,
    },
    {
      name: "an empty 204 response for a body-required parser",
      response: () => new Response(null, { status: 204 }),
      status: 204,
    },
  ])("wraps $name without exposing parser or proxy details", async ({ response, status }) => {
    const error = await capturedRejection(parseResponse(response()));

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error).toMatchObject({
      code: "UNEXPECTED_RESPONSE",
      message: "요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
      status,
    });
  });

  it.each([null, {}, { error: null }, { error: { code: 123, message: {} } }])(
    "uses the existing safe fallback for malformed JSON error envelopes",
    async (body) => {
      const error = await capturedRejection(parseResponse(jsonResponse(body, 502)));

      expect(error).toBeInstanceOf(ApiRequestError);
      expect(error).toMatchObject({
        code: "UNKNOWN_ERROR",
        message: "요청을 처리하지 못했습니다.",
        status: 502,
      });
    },
  );

  it("normalizes an unsupported-media response without exposing the server message", async () => {
    const serverMessage = "Unsupported Media Type: application/x-www-form-urlencoded";
    const error = await capturedRejection(
      parseResponse(
        jsonResponse(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: serverMessage,
            },
          },
          415,
        ),
      ),
    );

    expect(error).toBeInstanceOf(ApiRequestError);
    if (!(error instanceof ApiRequestError)) throw new Error("expected ApiRequestError");
    expect(error).toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "요청 형식을 처리할 수 없어요. 화면을 새로고침한 뒤 다시 시도해 주세요.",
      status: 415,
    });
    expect(error.message).not.toContain(serverMessage);
  });
});

describe("guardian consent signup API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends only the guardian email when creating a consent request", async () => {
    const responseBody = {
      completion_token: "completion-token",
      consent_delivery_status: "sent",
      expires_at: "2026-08-29T10:00:00.000Z",
      request_id: "request-1",
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(responseBody, 201));

    await expect(createGuardianConsentRequest("guardian@example.com")).resolves.toEqual(
      responseBody,
    );

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/guardian-consent-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guardian_email: "guardian@example.com" }),
      signal: expect.any(AbortSignal),
    });
  });

  it("posts both opaque request fields when checking consent status", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ status: "approved" }));
    const request = { completion_token: "completion-token", request_id: "request-1" };

    await expect(getGuardianConsentRequestStatus(request)).resolves.toEqual({
      status: "approved",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/guardian-consent-requests/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: expect.any(AbortSignal),
    });
  });

  it("confirms guardian consent with the fragment token only", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ guardian_consent: true }));

    await expect(confirmGuardianConsent("mail-fragment-token")).resolves.toEqual({
      guardian_consent: true,
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/guardian-consents/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "mail-fragment-token" }),
      signal: expect.any(AbortSignal),
    });
  });

  it("sends the new over-14 signup contract without an age consent key", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ next_action: "LOGIN" }, 201));
    const request = {
      age_route: "over_14" as const,
      approval_code: "123456",
      consents: { privacy: true as const, terms: true as const },
      display_name: "학생",
      email: "student@example.com",
      password: "classhub123",
      role: "student" as const,
    };

    await signUp(request);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/sign-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).consents).toEqual({
      privacy: true,
      terms: true,
    });
  });
});

describe("authenticated cross-tab client state", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("clears private state before hard replacing a tab that receives the clear signal", () => {
    const idempotencyKey = "classhub:idempotent-create:notices:membership-1";
    const existingSignal = crypto.randomUUID();
    window.sessionStorage.setItem(idempotencyKey, "other-tab-pending-draft");
    window.localStorage.setItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL, existingSignal);
    const storageSetItem = vi.spyOn(Storage.prototype, "setItem");
    const hardReplace = vi.fn((path: string) => {
      expect(path).toBe("/bootstrap");
      expect(window.sessionStorage.getItem(idempotencyKey)).toBeNull();
    });

    handleAuthenticatedClientStateStorage(
      {
        key: AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL,
        newValue: crypto.randomUUID(),
      },
      hardReplace,
    );

    expect(hardReplace).toHaveBeenCalledOnce();
    expect(hardReplace).toHaveBeenCalledWith("/bootstrap");
    expect(storageSetItem).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL)).toBe(
      existingSignal,
    );
  });

  it.each([
    {
      label: "an unrelated storage key",
      event: { key: "unrelated-key", newValue: crypto.randomUUID() },
    },
    {
      label: "removal of the clear signal",
      event: { key: AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL, newValue: null },
    },
  ])("ignores $label", ({ event }) => {
    const idempotencyKey = "classhub:idempotent-create:notices:membership-1";
    window.sessionStorage.setItem(idempotencyKey, "retained-draft");
    const hardReplace = vi.fn();

    handleAuthenticatedClientStateStorage(event, hardReplace);

    expect(window.sessionStorage.getItem(idempotencyKey)).toBe("retained-draft");
    expect(hardReplace).not.toHaveBeenCalled();
  });
});

describe("authenticated mutation CSRF recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("shares one monotonic deadline across the initial request, refresh, and retry", async () => {
    vi.useFakeTimers();
    let csrfToken = "stale-token";
    let mutationAttempts = 0;
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(
      () => `__Host-classhub_csrf=${csrfToken}`,
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/memberships/current/leave") {
        mutationAttempts += 1;
        if (mutationAttempts === 1) {
          return new Promise<Response>((resolve) => {
            globalThis.setTimeout(() => resolve(csrfInvalidResponse()), 8_000);
          });
        }
        return new Promise<Response>(() => undefined);
      }
      if (url === "/api/v1/auth/csrf-token") {
        return new Promise<Response>((resolve) => {
          globalThis.setTimeout(() => {
            csrfToken = "fresh-token";
            resolve(jsonResponse({ csrf_refreshed: true }));
          }, 8_000);
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const operation = leaveCurrentClass();
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const errorPromise = capturedRejection(operation);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(errorPromise).resolves.toMatchObject({
      code: REQUEST_TIMEOUT_CODE,
      status: 0,
    });
    expect(settled).toBe(true);
    expect(mutationAttempts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out an older staggered waiter without canceling a later shared refresh", async () => {
    vi.useFakeTimers();
    let csrfToken = "stale-token";
    let olderAttempts = 0;
    let laterAttempts = 0;
    let refreshAttempts = 0;
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(
      () => `__Host-classhub_csrf=${csrfToken}`,
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/test/older-mutation") {
        olderAttempts += 1;
        if (olderAttempts > 1) return Promise.resolve(jsonResponse({ recovered: true }));
        return new Promise<Response>((resolve) => {
          globalThis.setTimeout(() => resolve(csrfInvalidResponse()), 15_000);
        });
      }
      if (url === "/api/v1/test/later-mutation") {
        laterAttempts += 1;
        return Promise.resolve(
          laterAttempts === 1 ? csrfInvalidResponse() : jsonResponse({ recovered: true }),
        );
      }
      if (url === "/api/v1/auth/csrf-token") {
        refreshAttempts += 1;
        return new Promise<Response>((resolve) => {
          globalThis.setTimeout(() => {
            csrfToken = "fresh-token";
            resolve(jsonResponse({ csrf_refreshed: true }));
          }, 12_000);
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const olderOperation = withCsrfRecovery(({ apiFetch }) =>
      apiFetch("/api/v1/test/older-mutation"),
    );
    const olderError = capturedRejection(olderOperation);
    await vi.advanceTimersByTimeAsync(14_000);

    const laterOperation = withCsrfRecovery(({ apiFetch }) =>
      apiFetch("/api/v1/test/later-mutation"),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshAttempts).toBe(1);
    expect(olderAttempts).toBe(1);
    expect(laterAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(await Promise.race([olderError, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    await expect(olderError).resolves.toMatchObject({
      code: REQUEST_TIMEOUT_CODE,
      status: 0,
    });
    const refreshCall = fetchMock.mock.calls.find(([input]) => input === "/api/v1/auth/csrf-token");
    expect(refreshCall?.[1]?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(6_000);
    await expect(laterOperation).resolves.toEqual({ recovered: true });
    expect(olderAttempts).toBe(1);
    expect(laterAttempts).toBe(2);
    expect(refreshAttempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets later waiters acquire one successor after the old owner's refresh times out", async () => {
    vi.useFakeTimers();
    let csrfToken = "stale-token";
    let ownerAttempts = 0;
    const laterAttempts = [0, 0];
    let refreshAttempts = 0;
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(
      () => `__Host-classhub_csrf=${csrfToken}`,
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/test/old-refresh-owner") {
        ownerAttempts += 1;
        return Promise.resolve(
          csrfToken === "stale-token" ? csrfInvalidResponse() : jsonResponse({ recovered: true }),
        );
      }
      const laterIndex = ["/api/v1/test/later-refresh-1", "/api/v1/test/later-refresh-2"].indexOf(
        url,
      );
      if (laterIndex >= 0) {
        laterAttempts[laterIndex] = (laterAttempts[laterIndex] ?? 0) + 1;
        return Promise.resolve(
          csrfToken === "stale-token" ? csrfInvalidResponse() : jsonResponse({ recovered: true }),
        );
      }
      if (url === "/api/v1/auth/csrf-token") {
        refreshAttempts += 1;
        if (refreshAttempts === 1) return new Promise<Response>(() => undefined);
        return new Promise<Response>((resolve) => {
          globalThis.setTimeout(() => {
            csrfToken = "fresh-token";
            resolve(jsonResponse({ csrf_refreshed: true }));
          }, 2_000);
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const ownerOperation = withCsrfRecovery(({ apiFetch }) =>
      apiFetch("/api/v1/test/old-refresh-owner"),
    );
    const ownerError = capturedRejection(ownerOperation);
    await vi.advanceTimersByTimeAsync(14_000);

    const laterOperations = [1, 2].map((index) =>
      withCsrfRecovery(({ apiFetch }) => apiFetch(`/api/v1/test/later-refresh-${index}`)),
    );
    await vi.advanceTimersByTimeAsync(5_999);
    expect(refreshAttempts).toBe(1);
    expect(ownerAttempts).toBe(1);
    expect(laterAttempts).toEqual([1, 1]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(ownerError).resolves.toMatchObject({
      code: REQUEST_TIMEOUT_CODE,
      status: 0,
    });
    expect(refreshAttempts).toBe(2);
    const firstRefreshCall = fetchMock.mock.calls.filter(
      ([input]) => input === "/api/v1/auth/csrf-token",
    )[0];
    expect(firstRefreshCall?.[1]?.signal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(Promise.all(laterOperations)).resolves.toEqual([
      { recovered: true },
      { recovered: true },
    ]);
    expect(ownerAttempts).toBe(1);
    expect(laterAttempts).toEqual([2, 2]);
    expect(refreshAttempts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not create a third refresh or retry a mutation after the successor exhausts the waiter budget", async () => {
    vi.useFakeTimers();
    let ownerAttempts = 0;
    let laterAttempts = 0;
    let refreshAttempts = 0;
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=stale-token",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/test/exhausted-owner") {
        ownerAttempts += 1;
        return Promise.resolve(csrfInvalidResponse());
      }
      if (url === "/api/v1/test/exhausted-later") {
        laterAttempts += 1;
        return Promise.resolve(csrfInvalidResponse());
      }
      if (url === "/api/v1/auth/csrf-token") {
        refreshAttempts += 1;
        return new Promise<Response>(() => undefined);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const ownerError = capturedRejection(
      withCsrfRecovery(({ apiFetch }) => apiFetch("/api/v1/test/exhausted-owner")),
    );
    await vi.advanceTimersByTimeAsync(14_000);
    const laterError = capturedRejection(
      withCsrfRecovery(({ apiFetch }) => apiFetch("/api/v1/test/exhausted-later")),
    );

    await vi.advanceTimersByTimeAsync(6_000);
    await expect(ownerError).resolves.toMatchObject({ code: REQUEST_TIMEOUT_CODE });
    expect(refreshAttempts).toBe(2);
    expect(ownerAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(14_000);
    await expect(laterError).resolves.toMatchObject({ code: REQUEST_TIMEOUT_CODE });
    expect(refreshAttempts).toBe(2);
    expect(laterAttempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a shared refresh when every waiter leaves and lets a later operation start cleanly", async () => {
    vi.useFakeTimers();
    let csrfToken = "stale-token";
    const firstController = new AbortController();
    const secondController = new AbortController();
    const controllers = [firstController, secondController];
    let refreshAttempts = 0;
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(
      () => `__Host-classhub_csrf=${csrfToken}`,
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/v1/test/abandon-refresh-")) {
        return Promise.resolve(
          csrfToken === "stale-token" ? csrfInvalidResponse() : jsonResponse({ recovered: true }),
        );
      }
      if (url === "/api/v1/auth/csrf-token") {
        refreshAttempts += 1;
        if (refreshAttempts === 1) return new Promise<Response>(() => undefined);
        csrfToken = "fresh-token";
        return Promise.resolve(jsonResponse({ csrf_refreshed: true }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const abandoned = controllers.map((controller, index) =>
      withCsrfRecovery(({ apiFetch }) =>
        apiFetch(`/api/v1/test/abandon-refresh-${index}`, { signal: controller.signal }),
      ),
    );
    const abandonedErrors = abandoned.map((operation) => capturedRejection(operation));
    await vi.advanceTimersByTimeAsync(0);
    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/v1/auth/csrf-token"),
    ).toHaveLength(1);
    const firstRefreshCall = fetchMock.mock.calls.find(
      ([input]) => input === "/api/v1/auth/csrf-token",
    );
    expect(firstRefreshCall?.[1]?.signal?.aborted).toBe(false);

    firstController.abort();
    await expect(abandonedErrors[0]).resolves.toMatchObject({ code: REQUEST_ABORTED_CODE });
    expect(firstRefreshCall?.[1]?.signal?.aborted).toBe(false);
    secondController.abort();
    await expect(abandonedErrors[1]).resolves.toMatchObject({ code: REQUEST_ABORTED_CODE });
    expect(firstRefreshCall?.[1]?.signal?.aborted).toBe(true);

    await expect(
      withCsrfRecovery(({ apiFetch }) => apiFetch("/api/v1/test/abandon-refresh-later")),
    ).resolves.toEqual({ recovered: true });
    expect(refreshAttempts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts only a joined waiter and removes its listeners while shared refresh completes", async () => {
    vi.useFakeTimers();
    let csrfToken = "stale-token";
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const callerController = new AbortController();
    const addListener = vi.spyOn(callerController.signal, "addEventListener");
    const removeListener = vi.spyOn(callerController.signal, "removeEventListener");
    let joinedAttempts = 0;
    let ownerAttempts = 0;
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(
      () => `__Host-classhub_csrf=${csrfToken}`,
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/test/refresh-owner") {
        ownerAttempts += 1;
        return Promise.resolve(
          ownerAttempts === 1 ? csrfInvalidResponse() : jsonResponse({ recovered: true }),
        );
      }
      if (url === "/api/v1/test/abort-joiner") {
        joinedAttempts += 1;
        return Promise.resolve(
          joinedAttempts === 1 ? csrfInvalidResponse() : jsonResponse({ recovered: true }),
        );
      }
      if (url === "/api/v1/auth/csrf-token") return refreshResponse;
      throw new Error(`Unexpected URL: ${url}`);
    });

    const ownerOperation = withCsrfRecovery(({ apiFetch }) =>
      apiFetch("/api/v1/test/refresh-owner"),
    );
    await vi.advanceTimersByTimeAsync(0);
    const joinedOperation = withCsrfRecovery(({ apiFetch }) =>
      apiFetch("/api/v1/test/abort-joiner", { signal: callerController.signal }),
    );
    const joinedError = capturedRejection(joinedOperation);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/v1/auth/csrf-token"),
    ).toHaveLength(1);

    callerController.abort("private caller reason");
    await expect(joinedError).resolves.toMatchObject({
      code: REQUEST_ABORTED_CODE,
      status: 0,
    });
    const refreshCall = fetchMock.mock.calls.find(([input]) => input === "/api/v1/auth/csrf-token");
    expect(refreshCall?.[1]?.signal?.aborted).toBe(false);

    csrfToken = "fresh-token";
    resolveRefresh(jsonResponse({ csrf_refreshed: true }));
    await vi.advanceTimersByTimeAsync(0);
    await expect(ownerOperation).resolves.toEqual({ recovered: true });
    expect(joinedAttempts).toBe(1);
    expect(ownerAttempts).toBe(2);

    const abortListeners = addListener.mock.calls
      .filter(([type]) => type === "abort")
      .map(([, listener]) => listener);
    expect(abortListeners.length).toBeGreaterThanOrEqual(2);
    for (const listener of abortListeners) {
      expect(removeListener).toHaveBeenCalledWith("abort", listener);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the previous account's private client state after a successful login", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ authenticated: true, next_action: "BOOTSTRAP" }),
    );
    window.sessionStorage.setItem(
      "classhub:idempotent-create:classes:pending-teacher",
      "previous-account-draft",
    );

    await login({ email: "teacher@example.com", password: "correct-password" });

    expect(
      window.sessionStorage.getItem("classhub:idempotent-create:classes:pending-teacher"),
    ).toBeNull();
    expect(window.localStorage.getItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL)).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
  });

  it.each([
    {
      label: "leaving the current class",
      mutate: leaveCurrentClass,
      path: "/api/v1/memberships/current/leave",
      status: "left",
    },
    {
      label: "canceling the current membership request",
      mutate: cancelMembershipRequest,
      path: "/api/v1/membership-requests/current/cancel",
      status: "canceled",
    },
  ])(
    "clears current- and other-tab private state after $label",
    async ({ mutate, path, status }) => {
      vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
        "__Host-classhub_csrf=membership-transition-csrf",
      );
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          class_id: "class-1",
          membership_id: "membership-1",
          next_action: "BOOTSTRAP",
          row_version: "2",
          status,
          status_changed_at: "2026-08-02T03:00:00.000Z",
        }),
      );
      window.sessionStorage.setItem(
        "classhub:idempotent-create:notices:membership-1",
        "membership-private-draft",
      );

      await mutate();

      expect(
        window.sessionStorage.getItem("classhub:idempotent-create:notices:membership-1"),
      ).toBeNull();
      const clearSignal = window.localStorage.getItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL);
      expect(clearSignal).toMatch(/^[0-9a-f-]{36}$/u);
      expect(fetchMock).toHaveBeenCalledWith(path, {
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": "membership-transition-csrf",
        },
        method: "POST",
        body: "{}",
        signal: expect.any(AbortSignal),
      });

      window.sessionStorage.setItem(
        "classhub:idempotent-create:polls:membership-1",
        "other-tab-membership-draft",
      );
      const hardReplace = vi.fn(() => {
        expect(
          window.sessionStorage.getItem("classhub:idempotent-create:polls:membership-1"),
        ).toBeNull();
      });
      handleAuthenticatedClientStateStorage(
        { key: AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL, newValue: clearSignal },
        hardReplace,
      );
      expect(hardReplace).toHaveBeenCalledWith("/bootstrap");
    },
  );

  it("sends verification resend with an explicit JSON object for proxy-compatible framing", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=resend-csrf-token",
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("/api/v1/auth/email-verifications/resend");
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("include");
      expect(init?.body).toBe("{}");
      const headers = new Headers(init?.headers);
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("X-CSRF-Token")).toBe("resend-csrf-token");
      return Promise.resolve(jsonResponse({ verification_delivery_status: "sent" }));
    });

    await expect(resendVerificationEmail()).resolves.toEqual({
      verification_delivery_status: "sent",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a password change with authenticated CSRF and an unchanged JSON body", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=password-change-csrf",
    );
    const request = {
      current_password: "currentPassword123",
      new_password: "changedPassword456",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("/api/v1/account/password");
      expect(init?.method).toBe("PATCH");
      expect(init?.credentials).toBe("include");
      expect(init?.body).toBe(JSON.stringify(request));
      const headers = new Headers(init?.headers);
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("X-CSRF-Token")).toBe("password-change-csrf");
      return Promise.resolve(jsonResponse({ next_action: "LOGIN", password_changed: true }));
    });

    await expect(changePassword(request)).resolves.toEqual({
      next_action: "LOGIN",
      password_changed: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes a missing CSRF cookie before sending the mutation", async () => {
    let csrfToken: string | undefined;
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(() =>
      csrfToken === undefined ? "" : `__Host-classhub_csrf=${csrfToken}`,
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/csrf-token") {
        expect(init).toEqual({
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: expect.any(AbortSignal),
        });
        csrfToken = "refreshed-token";
        return Promise.resolve(jsonResponse({ csrf_refreshed: true }));
      }
      if (url === "/api/v1/memberships/current/leave") {
        expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("refreshed-token");
        return Promise.resolve(jsonResponse({ status: "left" }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await leaveCurrentClass();

    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      "/api/v1/auth/csrf-token",
      "/api/v1/memberships/current/leave",
    ]);
  });

  it("shares one refresh across concurrent mutations with a missing cookie", async () => {
    const csrf = { token: undefined as string | undefined };
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(() =>
      csrf.token === undefined ? "" : `__Host-classhub_csrf=${csrf.token}`,
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/csrf-token") return refreshResponse;
      if (
        url === "/api/v1/memberships/current/leave" ||
        url === "/api/v1/membership-requests/current/cancel"
      ) {
        expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("shared-token");
        return Promise.resolve(jsonResponse({ status: "left" }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const mutations = [leaveCurrentClass(), cancelMembershipRequest()];
    let waitError: unknown;
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    } catch (error) {
      waitError = error;
    } finally {
      csrf.token = "shared-token";
      resolveRefresh(jsonResponse({ csrf_refreshed: true }));
    }
    const results = await Promise.allSettled(mutations);
    if (waitError !== undefined) throw waitError;

    expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/v1/auth/csrf-token"),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/v1/memberships/current/leave"),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => input === "/api/v1/membership-requests/current/cancel",
      ),
    ).toHaveLength(1);
  });

  it("shares one refresh across concurrent CSRF_INVALID recovery paths", async () => {
    let csrfToken = "stale-token";
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(
      () => `__Host-classhub_csrf=${csrfToken}`,
    );
    const tokens = new Map<string, Array<string | null>>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/csrf-token") return refreshResponse;
      if (
        url === "/api/v1/memberships/current/leave" ||
        url === "/api/v1/membership-requests/current/cancel"
      ) {
        const token = new Headers(init?.headers).get("X-CSRF-Token");
        tokens.set(url, [...(tokens.get(url) ?? []), token]);
        return Promise.resolve(token === "stale-token" ? csrfInvalidResponse() : jsonResponse({}));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const mutations = [leaveCurrentClass(), cancelMembershipRequest()];
    let waitError: unknown;
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    } catch (error) {
      waitError = error;
    } finally {
      csrfToken = "fresh-token";
      resolveRefresh(jsonResponse({ csrf_refreshed: true }));
    }
    const results = await Promise.allSettled(mutations);
    if (waitError !== undefined) throw waitError;

    expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/v1/auth/csrf-token"),
    ).toHaveLength(1);
    expect(tokens.get("/api/v1/memberships/current/leave")).toEqual(["stale-token", "fresh-token"]);
    expect(tokens.get("/api/v1/membership-requests/current/cancel")).toEqual([
      "stale-token",
      "fresh-token",
    ]);
  });

  it("retries CSRF_INVALID once with the same idempotency key and request body", async () => {
    let csrfToken = "stale-token";
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(
      () => `__Host-classhub_csrf=${csrfToken}`,
    );
    const idempotencyKey = "11111111-1111-4111-8111-111111111111";
    const mutationRequests: RequestInit[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/csrf-token") {
        csrfToken = "fresh-token";
        return Promise.resolve(jsonResponse({ csrf_refreshed: true }));
      }
      if (url === "/api/v1/classes") {
        mutationRequests.push(init ?? {});
        return Promise.resolve(
          mutationRequests.length === 1
            ? csrfInvalidResponse()
            : jsonResponse({ next_action: "HOME" }, 201),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const request = {
      academic_year: 2026,
      edu_office_code: "B10",
      expected_student_count: 30,
      grade: 2,
      name: "테스트 1반",
      school_code: "1234567",
    };

    await createClass(request, idempotencyKey);

    expect(mutationRequests).toHaveLength(2);
    expect(mutationRequests.map(({ body }) => body)).toEqual([
      JSON.stringify(request),
      JSON.stringify(request),
    ]);
    expect(
      mutationRequests.map(({ headers }) => new Headers(headers).get("Idempotency-Key")),
    ).toEqual([idempotencyKey, idempotencyKey]);
    expect(mutationRequests.map(({ headers }) => new Headers(headers).get("X-CSRF-Token"))).toEqual(
      ["stale-token", "fresh-token"],
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps the invite rotation idempotency key across its retry", async () => {
    let csrfToken = "stale-token";
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(
      () => `__Host-classhub_csrf=${csrfToken}`,
    );
    const idempotencyKey = "22222222-2222-4222-8222-222222222222";
    const mutationRequests: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/csrf-token") {
        csrfToken = "fresh-token";
        return Promise.resolve(jsonResponse({ csrf_refreshed: true }));
      }
      if (url === "/api/v1/classes/current/invite-code/rotate") {
        mutationRequests.push(init ?? {});
        return Promise.resolve(
          mutationRequests.length === 1 ? csrfInvalidResponse() : jsonResponse({ class_id: "1" }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await rotateCurrentInviteCode(idempotencyKey);

    expect(
      mutationRequests.map(({ headers }) => new Headers(headers).get("Idempotency-Key")),
    ).toEqual([idempotencyKey, idempotencyKey]);
    expect(mutationRequests.map(({ headers }) => new Headers(headers).get("X-CSRF-Token"))).toEqual(
      ["stale-token", "fresh-token"],
    );
  });

  it("keeps If-Match and the body unchanged across a class update retry", async () => {
    let csrfToken = "stale-token";
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(
      () => `__Host-classhub_csrf=${csrfToken}`,
    );
    const mutationRequests: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/csrf-token") {
        csrfToken = "fresh-token";
        return Promise.resolve(jsonResponse({ csrf_refreshed: true }));
      }
      if (url === "/api/v1/classes/current") {
        mutationRequests.push(init ?? {});
        return Promise.resolve(
          mutationRequests.length === 1
            ? csrfInvalidResponse()
            : jsonResponse({ row_version: "8" }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const request = { expected_student_count: 28, name: "수정된 테스트 1반" };

    await updateCurrentClass(request, "7");

    expect(mutationRequests).toHaveLength(2);
    expect(mutationRequests.map(({ body }) => body)).toEqual([
      JSON.stringify(request),
      JSON.stringify(request),
    ]);
    expect(mutationRequests.map(({ headers }) => new Headers(headers).get("If-Match"))).toEqual([
      '"7"',
      '"7"',
    ]);
    expect(mutationRequests.map(({ headers }) => new Headers(headers).get("X-CSRF-Token"))).toEqual(
      ["stale-token", "fresh-token"],
    );
  });

  it("does not retry a second CSRF_INVALID response", async () => {
    let csrfToken = "stale-token";
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(
      () => `__Host-classhub_csrf=${csrfToken}`,
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/csrf-token") {
        csrfToken = "fresh-token";
        return Promise.resolve(jsonResponse({ csrf_refreshed: true }));
      }
      if (url === "/api/v1/memberships/current/leave") {
        return Promise.resolve(csrfInvalidResponse());
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(leaveCurrentClass()).rejects.toMatchObject({
      code: "CSRF_INVALID",
      status: 403,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/v1/auth/csrf-token"),
    ).toHaveLength(1);
  });

  it("does not rotate again for a late stale CSRF_INVALID response", async () => {
    let csrfToken = "stale-token";
    let resolveLateFailure!: (response: Response) => void;
    const lateFailure = new Promise<Response>((resolve) => {
      resolveLateFailure = resolve;
    });
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(
      () => `__Host-classhub_csrf=${csrfToken}`,
    );
    const attempts = new Map<string, number>();
    const tokens = new Map<string, Array<string | null>>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/csrf-token") {
        csrfToken = "fresh-token";
        return Promise.resolve(jsonResponse({ csrf_refreshed: true }));
      }
      const token = new Headers(init?.headers).get("X-CSRF-Token");
      tokens.set(url, [...(tokens.get(url) ?? []), token]);
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      if (url === "/api/v1/memberships/current/leave") {
        return Promise.resolve(token === "stale-token" ? csrfInvalidResponse() : jsonResponse({}));
      }
      if (url === "/api/v1/membership-requests/current/cancel") {
        if (attempt === 1) return lateFailure;
        return Promise.resolve(token === "fresh-token" ? jsonResponse({}) : csrfInvalidResponse());
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const lateMutation = cancelMembershipRequest();
    let firstMutationError: unknown;
    try {
      await leaveCurrentClass();
    } catch (error) {
      firstMutationError = error;
    } finally {
      resolveLateFailure(csrfInvalidResponse());
    }
    const [lateResult] = await Promise.allSettled([lateMutation]);
    if (firstMutationError !== undefined) throw firstMutationError;

    expect(lateResult.status).toBe("fulfilled");
    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/v1/auth/csrf-token"),
    ).toHaveLength(1);
    expect(attempts.get("/api/v1/membership-requests/current/cancel")).toBe(2);
    expect(tokens.get("/api/v1/membership-requests/current/cancel")).toEqual([
      "stale-token",
      "fresh-token",
    ]);
  });

  it("propagates a refresh failure, skips the mutation, and clears the failed single-flight", async () => {
    let csrfToken: string | undefined;
    let refreshAttempts = 0;
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(() =>
      csrfToken === undefined ? "" : `__Host-classhub_csrf=${csrfToken}`,
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/csrf-token") {
        refreshAttempts += 1;
        if (refreshAttempts === 1) {
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: "RATE_LIMIT_SERVICE_UNAVAILABLE",
                  message: "Rate limit unavailable.",
                },
              },
              503,
            ),
          );
        }
        csrfToken = "recovered-token";
        return Promise.resolve(jsonResponse({ csrf_refreshed: true }));
      }
      if (url === "/api/v1/memberships/current/leave") {
        return Promise.resolve(jsonResponse({ status: "left" }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(leaveCurrentClass()).rejects.toMatchObject({
      code: "RATE_LIMIT_SERVICE_UNAVAILABLE",
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await leaveCurrentClass();

    expect(refreshAttempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails safely when a successful refresh does not install a cookie", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue("");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ csrf_refreshed: true }));

    await expect(leaveCurrentClass()).rejects.toThrow(
      "요청 보안 정보를 찾을 수 없습니다. 다시 로그인해 주세요.",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/csrf-token", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: expect.any(AbortSignal),
    });
  });

  it("does not refresh for a non-CSRF error", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=current-token",
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/memberships/current/leave") {
        return Promise.resolve(
          jsonResponse({ error: { code: "ROLE_INSUFFICIENT", message: "Forbidden" } }, 403),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(leaveCurrentClass()).rejects.toBeInstanceOf(ApiRequestError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/v1/auth/csrf-token", expect.anything());
  });

  it("logs out without reading or recovering the CSRF cookie", async () => {
    const cookieGetter = vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(() => {
      throw new Error("logout must not read the CSRF cookie");
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ logged_out: true }));
    window.sessionStorage.setItem(
      "classhub:idempotent-create:notices:membership-1",
      "pending-private-draft",
    );

    await logout();

    expect(
      window.sessionStorage.getItem("classhub:idempotent-create:notices:membership-1"),
    ).toBeNull();
    expect(window.localStorage.getItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL)).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    expect(cookieGetter).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: expect.any(AbortSignal),
    });

    window.sessionStorage.setItem(
      "classhub:idempotent-create:supplies:membership-1",
      "other-tab-pending-draft",
    );
    const hardReplace = vi.fn(() => {
      expect(
        window.sessionStorage.getItem("classhub:idempotent-create:supplies:membership-1"),
      ).toBeNull();
    });
    handleAuthenticatedClientStateStorage(
      {
        key: AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL,
        newValue: crypto.randomUUID(),
      },
      hardReplace,
    );
    expect(hardReplace).toHaveBeenCalledWith("/bootstrap");
  });

  it("retains private client state when logout fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        { error: { code: "RATE_LIMIT_SERVICE_UNAVAILABLE", message: "잠시 실패했어요." } },
        503,
      ),
    );
    window.sessionStorage.setItem(
      "classhub:idempotent-create:notices:membership-1",
      "pending-private-draft",
    );

    await expect(logout()).rejects.toMatchObject({ status: 503 });

    expect(window.sessionStorage.getItem("classhub:idempotent-create:notices:membership-1")).toBe(
      "pending-private-draft",
    );
    expect(window.localStorage.getItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL)).toBeNull();
  });
});
