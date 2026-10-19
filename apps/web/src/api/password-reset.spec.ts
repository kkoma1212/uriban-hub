import { afterEach, describe, expect, it, vi } from "vitest";

import { confirmPasswordReset, requestPasswordReset } from "./password-reset";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("password reset API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests a reset without sending browser credentials", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ request_accepted: true }, 202));

    await expect(requestPasswordReset({ email: "student@example.com" })).resolves.toEqual({
      request_accepted: true,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/password-reset-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "student@example.com" }),
      signal: expect.any(AbortSignal),
    });
  });

  it("confirms a reset with the fragment token and new password", async () => {
    const token = "A".repeat(43);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        next_action: "LOGIN",
        password_reset: true,
      }),
    );

    await expect(
      confirmPasswordReset({ new_password: "changedPassword456", token }),
    ).resolves.toEqual({ next_action: "LOGIN", password_reset: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/password-resets/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_password: "changedPassword456", token }),
      signal: expect.any(AbortSignal),
    });
  });
});
