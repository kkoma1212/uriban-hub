import { afterEach, describe, expect, it, vi } from "vitest";
import { adminFetch, registerAdminStepUpHandler } from "./admin-request";

const denied = (code = "ADMIN_STEP_UP_REQUIRED") =>
  new Response(JSON.stringify({ error: { code, message: "verify" } }), { status: 401 });
const ok = () => new Response(JSON.stringify({ changed: true }));
afterEach(() => vi.restoreAllMocks());

describe("administrator reauthentication request recovery", () => {
  it("queues one strong confirmation after recovery-capable confirmation", async () => {
    const completions: Array<(accepted: boolean) => void> = [];
    const verify = vi.fn(() => new Promise<boolean>((resolve) => completions.push(resolve)));
    const unregister = registerAdminStepUpHandler(verify);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(denied("ADMIN_STRONG_STEP_UP_REQUIRED"))
      .mockResolvedValueOnce(denied("ADMIN_STRONG_STEP_UP_REQUIRED"))
      .mockResolvedValue(ok());
    try {
      const weak = adminFetch("/api/v1/admin/accounts");
      await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
      const strong = [
        adminFetch("/api/v1/admin/auth/factors"),
        adminFetch("/api/v1/admin/auth/factors"),
      ];
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(verify).toHaveBeenCalledOnce();
      completions[0]!(true);
      expect((await weak).ok).toBe(true);
      await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
      expect(verify.mock.calls).toEqual([[{ allowRecovery: true }], [{ allowRecovery: false }]]);
      expect(fetch).toHaveBeenCalledTimes(4);
      completions[1]!(true);
      expect((await Promise.all(strong)).every((response) => response.ok)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(6);
    } finally {
      unregister();
    }
  });
  it("lets a weak request join a strong confirmation", async () => {
    let complete!: (accepted: boolean) => void;
    const verify = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const unregister = registerAdminStepUpHandler(verify);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(denied("ADMIN_STRONG_STEP_UP_REQUIRED"))
      .mockResolvedValueOnce(denied())
      .mockResolvedValue(ok());
    try {
      const strong = adminFetch("/api/v1/admin/auth/factors");
      await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
      const weak = adminFetch("/api/v1/admin/accounts");
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 30));
      complete(true);
      expect((await Promise.all([strong, weak])).every((response) => response.ok)).toBe(true);
      expect(verify).toHaveBeenCalledExactlyOnceWith({ allowRecovery: false });
    } finally {
      unregister();
    }
  });
  it.each(["cancel", "detach", "abort", "reject"])(
    "does not prompt or replay a queued strong request after %s",
    async (outcome) => {
      let complete!: (accepted: boolean) => void;
      let reject!: (reason: Error) => void;
      const verify = vi.fn(
        () =>
          new Promise<boolean>((resolve, fail) => {
            complete = resolve;
            reject = fail;
          }),
      );
      const unregister = registerAdminStepUpHandler(verify);
      const controller = new AbortController();
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(denied())
        .mockResolvedValueOnce(denied("ADMIN_STRONG_STEP_UP_REQUIRED"))
        .mockResolvedValue(ok());
      try {
        const weak = adminFetch("/api/v1/admin/accounts");
        await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
        const strong = adminFetch("/api/v1/admin/auth/factors", { signal: controller.signal });
        const results = Promise.allSettled([weak, strong]);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (outcome === "detach") unregister();
        if (outcome === "abort") controller.abort();
        if (outcome === "reject") reject(new Error("verification failed"));
        else complete(outcome !== "cancel");
        const settled = await results;
        expect(settled[1]?.status).toBe("rejected");
        expect(verify).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledTimes(outcome === "abort" ? 3 : 2);
        // A rejected flight must not poison the next independent attempt.
        fetch.mockResolvedValueOnce(denied()).mockResolvedValueOnce(ok());
        verify.mockResolvedValueOnce(true);
        if (outcome === "reject")
          expect((await adminFetch("/api/v1/admin/accounts")).ok).toBe(true);
      } finally {
        unregister();
      }
    },
  );
  it("shares a published flight with a request started inside the handler", async () => {
    let reentrant!: Promise<Response>;
    let complete!: (accepted: boolean) => void;
    const verify = vi.fn(() => {
      reentrant = adminFetch("/api/v1/admin/users/1/status");
      return new Promise<boolean>((resolve) => {
        complete = resolve;
      });
    });
    const unregister = registerAdminStepUpHandler(verify);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(denied())
      .mockResolvedValue(ok());
    try {
      const request = adminFetch("/api/v1/admin/accounts");
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 30));
      complete(true);
      expect((await Promise.all([request, reentrant])).every((response) => response.ok)).toBe(true);
      expect(verify).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });
  it("recognizes the server's 403 and forbids recovery for factor changes", async () => {
    const verify = vi.fn(async () => true);
    const unregister = registerAdminStepUpHandler(verify);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "ADMIN_STRONG_STEP_UP_REQUIRED", message: "verify" } }),
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(ok());
    try {
      expect(
        (await adminFetch("/api/v1/admin/auth/recovery-codes", { method: "POST", body: "{}" })).ok,
      ).toBe(true);
      expect(verify).toHaveBeenCalledWith({ allowRecovery: false });
    } finally {
      unregister();
    }
  });
  it("waits for confirmation and retries the exact request once", async () => {
    let complete!: (accepted: boolean) => void;
    const verify = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const unregister = registerAdminStepUpHandler(verify);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(ok());
    const init = {
      method: "PATCH",
      body: '{"roles":["support"]}',
      headers: { "X-Admin-CSRF": "synthetic" },
    };
    try {
      const request = adminFetch("/api/v1/admin/accounts/7/roles", init);
      await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
      init.body = '{"roles":["super_admin"]}';
      init.headers["X-Admin-CSRF"] = "changed";
      expect(fetch).toHaveBeenCalledOnce();
      complete(true);
      expect((await request).status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1]?.[1]?.body).toBe('{"roles":["support"]}');
      expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("X-Admin-CSRF")).toBe("synthetic");
    } finally {
      unregister();
    }
  });
  it.each([false, true])(
    "does not replay when cancelled or detached: detached=%s",
    async (detached) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(denied());
      let unregister: () => void = () => undefined;
      const verify = vi.fn(async () => {
        if (detached) unregister();
        return detached;
      });
      unregister = registerAdminStepUpHandler(verify);
      try {
        await expect(
          adminFetch("/api/v1/admin/accounts", { method: "POST", body: "{}" }),
        ).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
        expect(fetch).toHaveBeenCalledOnce();
      } finally {
        unregister();
      }
    },
  );
  it("never prompts for expiry, business failure or network failure", async () => {
    const verify = vi.fn(async () => true);
    const unregister = registerAdminStepUpHandler(verify);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(denied("ADMIN_SESSION_REQUIRED"))
      .mockResolvedValueOnce(new Response("{}", { status: 409 }))
      .mockRejectedValueOnce(new Error("offline"));
    try {
      expect((await adminFetch("/api/v1/admin/accounts")).status).toBe(401);
      expect((await adminFetch("/api/v1/admin/accounts")).status).toBe(409);
      await expect(adminFetch("/api/v1/admin/accounts")).rejects.toMatchObject({
        code: "NETWORK_ERROR",
      });
      expect(verify).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
  it("returns a second step-up denial without a retry loop", async () => {
    const verify = vi.fn(async () => true),
      unregister = registerAdminStepUpHandler(verify);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => denied());
    try {
      expect(
        (await adminFetch("/api/v1/admin/accounts", { method: "POST", body: "{}" })).status,
      ).toBe(401);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(verify).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });
  it("never retries a network failure on the authorized replay", async () => {
    const verify = vi.fn(async () => true);
    const unregister = registerAdminStepUpHandler(verify);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(denied())
      .mockRejectedValueOnce(new Error("offline"));
    try {
      await expect(adminFetch("/api/v1/admin/accounts")).rejects.toMatchObject({
        code: "NETWORK_ERROR",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(verify).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });
  it("clears a synchronously throwing handler before the next request", async () => {
    const verify = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => {
        throw new Error("verification failed");
      })
      .mockResolvedValueOnce(true);
    const unregister = registerAdminStepUpHandler(verify);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(ok());
    try {
      await expect(adminFetch("/api/v1/admin/accounts")).rejects.toThrow("verification failed");
      expect((await adminFetch("/api/v1/admin/accounts")).ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      unregister();
    }
  });
  it("shares one prompt for concurrently rejected requests", async () => {
    let complete!: (accepted: boolean) => void;
    const verify = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const unregister = registerAdminStepUpHandler(verify);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    try {
      const requests = Promise.all([
        adminFetch("/api/v1/admin/accounts"),
        adminFetch("/api/v1/admin/users/1/status"),
      ]);
      await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      complete(true);
      expect((await requests).every((result) => result.ok)).toBe(true);
      expect(verify).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });
});
