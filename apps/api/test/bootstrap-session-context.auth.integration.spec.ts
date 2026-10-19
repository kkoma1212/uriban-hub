import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { issueSessionSecrets } from "../src/auth/session-crypto.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME, readCookie } from "../src/auth/session-cookie.js";
import {
  app,
  database,
  createClassFixture,
  setupPollsHarness,
  teardownSuppliesHarness,
  type ClassFixture,
} from "./supplies-test-harness.js";

let fixture: ClassFixture;
beforeAll(setupPollsHarness, 120_000);
beforeEach(async () => {
  fixture = await createClassFixture();
});
afterAll(teardownSuppliesHarness, 120_000);

async function bootstrap(headers: Record<string, string>) {
  const response = await app.inject({ method: "GET", url: "/api/v1/bootstrap", headers });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json().session_context).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
  return response.json() as { session_context: string };
}

describe("authenticated bootstrap session context", () => {
  it("remains stable across genuine CSRF refresh without changing session lifetime", async () => {
    const actor = fixture.students[0];
    const before = await bootstrap(actor.headers);
    const storedBefore = await database
      .selectFrom("sessions")
      .select(["id", "expires_at", "csrf_token_hash"])
      .where("user_id", "=", actor.userId)
      .executeTakeFirstOrThrow();
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/csrf-token",
      headers: actor.headers,
    });
    expect(refreshed.statusCode).toBe(200);
    const cookies = refreshed.headers["set-cookie"];
    const csrf = readCookie(
      Array.isArray(cookies) ? cookies.join("; ") : cookies,
      CSRF_COOKIE_NAME,
    );
    expect(csrf).toBeDefined();
    const token = readCookie(actor.headers.cookie, SESSION_COOKIE_NAME)!;
    const after = await bootstrap({
      ...actor.headers,
      cookie: `${SESSION_COOKIE_NAME}=${token}; ${CSRF_COOKIE_NAME}=${csrf}`,
    });
    expect(after.session_context).toBe(before.session_context);
    const storedAfter = await database
      .selectFrom("sessions")
      .select(["id", "expires_at", "csrf_token_hash"])
      .where("user_id", "=", actor.userId)
      .executeTakeFirstOrThrow();
    expect(storedAfter.id).toBe(storedBefore.id);
    expect(storedAfter.expires_at).toEqual(storedBefore.expires_at);
    expect(storedAfter.csrf_token_hash).not.toEqual(storedBefore.csrf_token_hash);
    expect(after.session_context).not.toContain(token);
    expect(after.session_context).not.toContain(csrf);
  });

  it("distinguishes another login of the same account and another account", async () => {
    const actor = fixture.students[0];
    const first = await bootstrap(actor.headers);
    const secrets = issueSessionSecrets();
    await database
      .insertInto("sessions")
      .values({
        created_ip: "127.0.0.1",
        user_id: actor.userId,
        session_hash: secrets.sessionTokenHash,
        csrf_token_hash: secrets.csrfTokenHash,
        expires_at: sql<Date>`now() + interval '1 day'`,
      })
      .execute();
    const second = await bootstrap({
      ...actor.headers,
      cookie: `${SESSION_COOKIE_NAME}=${secrets.sessionToken}; ${CSRF_COOKIE_NAME}=${secrets.csrfToken}`,
    });
    expect(second.session_context).not.toBe(first.session_context);
    expect((await bootstrap(fixture.students[1].headers)).session_context).not.toBe(
      first.session_context,
    );
  });

  it("cannot authenticate with a public context and does not disclose it to unauthenticated callers", async () => {
    const original = await bootstrap(fixture.students[0].headers);
    for (const cookie of [undefined, `${SESSION_COOKIE_NAME}=${original.session_context}`]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/bootstrap",
        headers: cookie === undefined ? {} : { cookie },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("UNAUTHENTICATED");
      expect(response.json()).not.toHaveProperty("session_context");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("does not return a former context after revocation or expiry", async () => {
    const actor = fixture.students[0];
    await bootstrap(actor.headers);
    await database
      .updateTable("sessions")
      .set({ revoked_at: new Date() })
      .where("user_id", "=", actor.userId)
      .execute();
    const revoked = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: actor.headers,
    });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json()).not.toHaveProperty("session_context");
    const other = fixture.students[1];
    await database
      .updateTable("sessions")
      .set({ issued_at: new Date(0), expires_at: new Date(86_400_000) })
      .where("user_id", "=", other.userId)
      .execute();
    const expired = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: other.headers,
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).not.toHaveProperty("session_context");
  });
});
