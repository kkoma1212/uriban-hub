import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL } from "../lib/authenticated-client-state";
import { changePassword } from "./auth";
import { confirmPasswordReset } from "./password-reset";

const privateKeys = [
  "classhub:content-reuse:v1:1:notice:17",
  "classhub:idempotent-create:notice:1",
  "classhub:change-review:v1:1:17",
];
const operations = [
  {
    name: "authenticated password change",
    run: () =>
      changePassword({ current_password: "currentPassword123", new_password: "newPassword456" }),
    result: { next_action: "LOGIN", password_changed: true },
  },
  {
    name: "password reset confirmation",
    run: () => confirmPasswordReset({ new_password: "newPassword456", token: "A".repeat(43) }),
    result: { next_action: "LOGIN", password_reset: true },
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    "__Host-classhub_csrf=synthetic-csrf",
  );
  for (const key of privateKeys) window.sessionStorage.setItem(key, "private fixture");
  window.sessionStorage.setItem("unrelated-preference", "keep");
  window.localStorage.setItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL, "previous-identity");
});
afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

function expectUnchanged(): void {
  for (const key of privateKeys) expect(window.sessionStorage.getItem(key)).toBe("private fixture");
  expect(window.localStorage.getItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL)).toBe(
    "previous-identity",
  );
}

describe.each(operations)("$name client session invalidation", ({ run, result }) => {
  it("clears private drafts and signals other tabs only after confirmed success", async () => {
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = run();
    expectUnchanged();
    finish(json(result));
    await expect(pending).resolves.toEqual(result);
    for (const key of privateKeys) expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(window.sessionStorage.getItem("unrelated-preference")).toBe("keep");
    expect(window.localStorage.getItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL)).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    // The initiating React route still needs to display its success/login state.
    expect(document.body).toBeVisible();
  });

  it("preserves drafts when the server rejects the operation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ error: { code: "INVALID_CREDENTIALS", message: "Synthetic rejection" } }, 401),
    );
    await expect(run()).rejects.toMatchObject({ status: 401 });
    expectUnchanged();
  });

  it("does not report local session termination on an uncertain network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Synthetic network failure"));
    await expect(run()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expectUnchanged();
  });
});
