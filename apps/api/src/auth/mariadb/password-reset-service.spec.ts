import { createMariaDbDatabase, type DB } from "@classhub/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordResetTokenInvalidOrExpiredException } from "../auth.errors.js";
import { PasswordResetService } from "../password-reset.service.js";

const hasher = vi.hoisted(() => vi.fn().mockResolvedValue("synthetic-password-hash"));
vi.mock("../password-hasher.js", () => ({ hashPassword: hasher }));
const actor = "9007199254740993";
const token = "9007199254740995";
const time = "2026-09-07 09:00:00.123456";
const context = {
  clientIp: "2001:0db8:0:0:0:0:0:1",
  requestId: "a65550f1-c6cc-45d8-92ce-de2766ef5ed7",
  userAgent: "qa",
};
type Step = { rows?: Record<string, unknown>[]; affectedRows?: number; error?: unknown };
const databases: ReturnType<typeof createMariaDbDatabase<DB>>[] = [];
function boundary(steps: Step[], options: { socialInstalled?: boolean } = {}) {
  const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const state: { commitError?: Error } = {};
  const database = createMariaDbDatabase<DB>(
    () => ({
      getConnection: (callback) =>
        callback(null, {
          query: (statement, parameters, reply) => {
            calls.push({ sql: statement, parameters });
            if (!/^(select|insert|update|delete)\b/iu.test(statement.trimStart()))
              return reply(statement === "COMMIT" ? state.commitError : null, {
                affectedRows: 0,
                insertId: 0,
              });
            const step = steps.shift();
            if (!step) return reply(new Error("Unexpected synthetic query"), undefined);
            reply(step.error, step.rows ?? { affectedRows: step.affectedRows ?? 1, insertId: 0 });
          },
          release: vi.fn(),
          destroy: vi.fn(),
        }),
      end: (callback) => callback(null),
    }),
    {
      host: "reset.test.invalid",
      database: "synthetic",
      user: "synthetic_app",
      password: "synthetic",
      sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic",
    },
  );
  databases.push(database);
  const mailer = { sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined) };
  const securityMailer = {
    sendSecurityChange: vi.fn(async () => {
      calls.push({ sql: "NOTICE", parameters: [] });
      return "accepted" as const;
    }),
  };
  const publisher = { publish: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
  const rateLimiter = {
    consume: vi.fn().mockResolvedValue({ allowed: true }),
    clear: vi.fn().mockResolvedValue(undefined),
    consumeAll: vi.fn().mockResolvedValue({ allowed: true }),
  };
  const service = new PasswordResetService(
    database,
    rateLimiter as never,
    mailer,
    { emailHmacKey: "synthetic-password-reset-key-only", emailHmacKeyVersion: "qa" } as never,
    publisher,
    {
      get: (key: string) =>
        key === "AUTH_DATABASE_EXTENSIONS" && options.socialInstalled === true
          ? "social"
          : "mariadb",
    } as never,
    securityMailer,
  );
  return { service, calls, mailer, securityMailer, publisher, state, steps, rateLimiter };
}
const clock = () => ({ rows: [{ transaction_time: time }] });
const user = (overrides: Record<string, unknown> = {}) => ({
  rows: [
    {
      id: actor,
      is_active: 1,
      deleted_at: null,
      display_name: "QA user",
      email_normalized: "reset@example.invalid",
      email_verified_at: time,
      ...overrides,
    },
  ],
});
const identity = () => ({ rows: [{ id: token, user_id: actor }] });
const activeToken = () => ({ rows: [{ used_at: null, invalidated_at: null }] });
const writes = (target: ReturnType<typeof boundary>) =>
  target.calls.filter((call) => /^(insert|update)\b/iu.test(call.sql));
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
  vi.clearAllMocks();
});

describe("MariaDB password-reset service boundaries", () => {
  it.each(["denied", "unavailable"])(
    "leaves existing reset tokens untouched when mail admission is %s",
    async (outcome) => {
      const target = boundary([]);
      if (outcome === "denied")
        target.rateLimiter.consumeAll.mockResolvedValueOnce({ allowed: false });
      else
        target.rateLimiter.consumeAll.mockRejectedValueOnce(
          new Error("synthetic unavailable budget"),
        );
      await expect(target.service.requestReset("reset@example.invalid", context)).rejects.toThrow();
      expect(target.calls).toHaveLength(0);
      expect(target.mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, 0])(
    "keeps request acceptance private for absent/inactive accounts (%s)",
    async (active) => {
      const target = boundary([
        clock(),
        active === undefined ? { rows: [] } : user({ is_active: active }),
      ]);
      await expect(target.service.requestReset("reset@example.invalid", context)).resolves.toEqual({
        request_accepted: true,
      });
      expect(writes(target)).toHaveLength(0);
      expect(target.mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
      expect(target.publisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({ actor_user_id: null }),
      );
    },
  );

  it("commits before SMTP and pins issuance/invalidations to one six-digit DB timestamp", async () => {
    const target = boundary([clock(), user(), { rows: [] }, {}, {}]);
    target.mailer.sendPasswordResetEmail.mockImplementation(async () => {
      expect(target.calls.at(-1)?.sql).toBe("COMMIT");
    });
    await target.service.requestReset(" RESET@example.invalid ", context);
    expect(target.steps).toHaveLength(0);
    const mutations = writes(target);
    expect(mutations).toHaveLength(2);
    expect(mutations.every((call) => call.parameters.includes(time))).toBe(true);
    expect(mutations[1]?.sql).toContain("INET6_NTOA(INET6_ATON(?))");
    expect(mutations[1]?.sql).toContain("INTERVAL 30 MINUTE");
    expect(target.mailer.sendPasswordResetEmail).toHaveBeenCalledWith(
      "reset@example.invalid",
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    );
  });

  it.each(["insert", "commit"])(
    "does not send mail or report success after a %s failure",
    async (stage) => {
      const failure = new Error("synthetic failed write");
      const target = boundary([
        clock(),
        user(),
        { rows: [] },
        {},
        stage === "insert" ? { error: failure } : {},
      ]);
      if (stage === "commit") target.state.commitError = failure;
      await expect(target.service.requestReset("reset@example.invalid", context)).rejects.toThrow();
      expect(target.mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
      expect(target.publisher.publish).not.toHaveBeenCalled();
      expect(target.securityMailer.sendSecurityChange).not.toHaveBeenCalled();
    },
  );

  it("answers without waiting for the reset mail so timing does not reveal accounts (I1-14)", async () => {
    const target = boundary([clock(), user(), { rows: [] }, {}, {}]);
    target.mailer.sendPasswordResetEmail.mockReturnValue(new Promise(() => undefined));
    await expect(target.service.requestReset("reset@example.invalid", context)).resolves.toEqual({
      request_accepted: true,
    });
    expect(target.mailer.sendPasswordResetEmail).toHaveBeenCalledOnce();
  });

  it("keeps acceptance and emits a safe failure event when SMTP fails after commit", async () => {
    const target = boundary([clock(), user(), { rows: [] }, {}, {}]);
    target.mailer.sendPasswordResetEmail.mockRejectedValue(new Error("private SMTP diagnostic"));
    await expect(target.service.requestReset("reset@example.invalid", context)).resolves.toEqual({
      request_accepted: true,
    });
    // 메일은 응답과 분리돼 뒤에서 보낸다(총검수 I1-14) — 실패 기록도 조금 뒤에 남는다.
    await vi.waitFor(() =>
      expect(target.publisher.publish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: "email.delivery_failed",
          failure_code: "smtp_delivery_failed",
        }),
      ),
    );
    expect(JSON.stringify(target.publisher.publish.mock.calls)).not.toContain(
      "private SMTP diagnostic",
    );
  });

  it.each([0, 2])(
    "rejects an unexpected token update count %d and rolls back before changing the password",
    async (affectedRows) => {
      const target = boundary([identity(), clock(), user(), activeToken(), { affectedRows }]);
      await expect(
        target.service.confirmReset("x".repeat(43), "Reset123", context),
      ).rejects.toBeInstanceOf(PasswordResetTokenInvalidOrExpiredException);
      expect(writes(target)).toHaveLength(1);
      expect(target.calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
      expect(target.publisher.publish).not.toHaveBeenCalled();
    },
  );

  it("uses the locked transaction time for token consumption, password change and session revocation", async () => {
    const target = boundary([identity(), clock(), user(), activeToken(), {}, {}, {}, {}]);
    await expect(target.service.confirmReset("x".repeat(43), "Reset123", context)).resolves.toEqual(
      { next_action: "LOGIN", password_reset: true },
    );
    const mutations = writes(target);
    expect(mutations).toHaveLength(4);
    expect(mutations.filter((call) => call.parameters.includes(time))).toHaveLength(3);
    expect(mutations.some((call) => /returning|::|now\(\)/iu.test(call.sql))).toBe(false);
    expect(target.publisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.password_reset_completed", actor_user_id: actor }),
    );
    expect(target.steps).toHaveLength(0);
    expect(target.securityMailer.sendSecurityChange).toHaveBeenCalledWith({
      email: "reset@example.invalid",
      kind: "password_reset",
      occurredAt: expect.any(Date),
    });
    expect(target.calls.at(-1)?.sql).toBe("NOTICE");
  });

  it("removes every social login link in the reset transaction and tells the owner (total audit I1-03/I1-04)", async () => {
    const target = boundary(
      [identity(), clock(), user(), activeToken(), {}, {}, {}, {}, { affectedRows: 2 }],
      { socialInstalled: true },
    );
    await target.service.confirmReset("x".repeat(43), "Reset123", context);
    const removal = target.calls.find((call) => /^delete from `social_identities`/u.test(call.sql));
    expect(removal?.parameters).toEqual([actor]);
    const commit = target.calls.findIndex((call) => call.sql === "COMMIT");
    expect(target.calls.indexOf(removal!)).toBeLessThan(commit);
    expect(
      (target.securityMailer.sendSecurityChange.mock.calls as unknown as [{ kind: string }][]).map(
        ([notice]) => notice.kind,
      ),
    ).toEqual(["password_reset", "social_links_removed"]);
  });

  it("does not mention social logins when none were linked", async () => {
    const target = boundary(
      [identity(), clock(), user(), activeToken(), {}, {}, {}, {}, { affectedRows: 0 }],
      { socialInstalled: true },
    );
    await target.service.confirmReset("x".repeat(43), "Reset123", context);
    expect(
      (target.securityMailer.sendSecurityChange.mock.calls as unknown as [{ kind: string }][]).map(
        ([notice]) => notice.kind,
      ),
    ).toEqual(["password_reset"]);
  });

  it.each(["unverified", "commit-failure"] as const)(
    "does not send a reset completion notice for %s",
    async (failure) => {
      const target = boundary([
        identity(),
        clock(),
        user({ email_verified_at: failure === "unverified" ? null : time }),
        activeToken(),
        {},
        {},
        {},
        {},
      ]);
      if (failure === "commit-failure") {
        target.state.commitError = new Error("synthetic commit failure");
        await expect(
          target.service.confirmReset("x".repeat(43), "Reset123", context),
        ).rejects.toThrow();
      } else await target.service.confirmReset("x".repeat(43), "Reset123", context);
      expect(target.securityMailer.sendSecurityChange).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed booleans instead of treating them as active accounts", async () => {
    const target = boundary([clock(), user({ is_active: 2 })]);
    await expect(target.service.requestReset("reset@example.invalid", context)).rejects.toThrow(
      "Invalid MariaDB",
    );
    expect(writes(target)).toHaveLength(0);
    expect(target.mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});
