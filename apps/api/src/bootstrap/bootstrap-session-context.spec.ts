import { describe, expect, it } from "vitest";

import type { AuthenticatedSession } from "../auth/auth.types.js";
import { hashSessionSecret, isSessionSecret, issueSessionSecrets } from "../auth/session-crypto.js";
import { bootstrapSessionContext } from "./bootstrap-session-context.js";

const session: AuthenticatedSession = {
  userId: "101",
  sessionId: "202",
  currentClassId: null,
  expiresAt: new Date("2026-09-25T00:00:00Z"),
};
describe("bootstrap session comparison context", () => {
  it("is stable without returning an authentication token or its database hash", () => {
    const secrets = issueSessionSecrets();
    const context = bootstrapSessionContext(session, secrets.sessionToken);
    expect(context).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(
      bootstrapSessionContext(
        { ...session, currentClassId: "3", expiresAt: new Date() },
        secrets.sessionToken,
      ),
    ).toBe(context);
    expect(context).not.toContain(secrets.sessionToken);
    expect(context).not.toContain(secrets.csrfToken);
    expect(context).not.toContain(hashSessionSecret(secrets.sessionToken).toString("base64url"));
    expect(isSessionSecret(context)).toBe(false);
  });
  it("distinguishes accounts, sessions, and login credentials", () => {
    const token = issueSessionSecrets().sessionToken;
    const context = bootstrapSessionContext(session, token);
    expect(bootstrapSessionContext({ ...session, userId: "102" }, token)).not.toBe(context);
    expect(bootstrapSessionContext({ ...session, sessionId: "203" }, token)).not.toBe(context);
    expect(bootstrapSessionContext(session, issueSessionSecrets().sessionToken)).not.toBe(context);
  });
  it.each([undefined, "", "invalid", "v1." + "A".repeat(43)])(
    "does not derive a context without a valid raw credential",
    (token) => {
      expect(() => bootstrapSessionContext(session, token)).toThrow();
    },
  );
});
