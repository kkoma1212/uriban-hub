import { describe, expect, it } from "vitest";

import {
  clearSessionCookies,
  createSessionCookies,
  CSRF_COOKIE_NAME,
  readCookie,
  SESSION_COOKIE_NAME,
} from "./session-cookie.js";

describe("session cookies", () => {
  it("creates host-only secure cookies with the required visibility", () => {
    const cookies = createSessionCookies(
      "session-token",
      "csrf-token",
      new Date(Date.now() + 60_000),
    );

    expect(cookies[0]).toContain(`${SESSION_COOKIE_NAME}=session-token`);
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[1]).toContain(`${CSRF_COOKIE_NAME}=csrf-token`);
    expect(cookies[1]).not.toContain("HttpOnly");
    for (const cookie of cookies) {
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).not.toContain("Domain=");
    }
  });

  it("reads an exact cookie and clears both session cookies", () => {
    expect(readCookie("other=1; wanted=two; final=3", "wanted")).toBe("two");
    expect(readCookie("other=1", "wanted")).toBeUndefined();
    expect(clearSessionCookies()).toEqual([
      expect.stringContaining(`${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0`),
      expect.stringContaining(`${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0`),
    ]);
  });
});
