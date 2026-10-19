import { Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { createPrivacySafeSubject } from "../../auth/auth-crypto.js";
import { AUTH_CONFIG, AUTH_RATE_LIMITER } from "../../auth/auth.tokens.js";
import { RateLimitedException } from "../../common/rate-limit/rate-limit.errors.js";
import type { AppEnvironment } from "../../config/environment.js";
import { DATABASE } from "../../database/database.module.js";
import { NOTIFICATION_MAILER } from "../../mail/notification-mailer.js";
import { MariaDbMembersService } from "../../members/mariadb/members.service.js";
import { MembersModule } from "../../members/members.module.js";
import { MembersService } from "../../members/members.service.js";
import { MembershipModule } from "../membership.module.js";
import { MembershipService } from "../membership.service.js";
import { MariaDbMembershipService } from "./membership.service.js";

async function context(engine?: string) {
  const database = { selectFrom: vi.fn(), transaction: vi.fn(), executeQuery: vi.fn() };
  const rateLimiter = {
    consume: vi.fn().mockResolvedValue({ allowed: false, retryAfterSeconds: 29 }),
  };
  const authConfig = {
    emailHmacKey: "synthetic-provider-test-privacy-key",
    emailHmacKeyVersion: "provider-qa",
  };
  @Module({
    // Use the real module provider declarations, including their injection order.
    providers: [
      ...(Reflect.getMetadata("providers", MembershipModule) as Provider[]),
      ...(Reflect.getMetadata("providers", MembersModule) as Provider[]),
      { provide: DATABASE, useValue: database },
      { provide: NOTIFICATION_MAILER, useValue: {} },
      { provide: AUTH_RATE_LIMITER, useValue: rateLimiter },
      { provide: AUTH_CONFIG, useValue: authConfig },
      {
        provide: ConfigService,
        useValue: new ConfigService<AppEnvironment, true>(
          engine === undefined ? {} : { DATABASE_ENGINE: engine },
        ),
      },
    ],
  })
  class ProviderTestModule {}
  const app = await NestFactory.createApplicationContext(ProviderTestModule, {
    abortOnError: false,
    logger: false,
  });
  return { app, database, rateLimiter, authConfig };
}

describe("Membership and Members module database selection", () => {
  it.each([undefined, "postgres"])("preserves PG service tokens with engine %s", async (engine) => {
    const { app } = await context(engine);
    try {
      expect(Object.getPrototypeOf(app.get(MembershipService))).toBe(MembershipService.prototype);
      expect(Object.getPrototypeOf(app.get(MembersService))).toBe(MembersService.prototype);
    } finally {
      await app.close();
    }
  });

  it("injects Maria wrappers and the existing privacy-safe rate limiter before any DB access", async () => {
    const { app, database, rateLimiter, authConfig } = await context("mariadb");
    try {
      const membership = app.get(MembershipService);
      expect(membership).toBeInstanceOf(MariaDbMembershipService);
      expect(app.get(MembersService)).toBeInstanceOf(MariaDbMembersService);
      const clientIp = "203.0.113.7";
      await expect(
        membership.createRequest({
          clientIp,
          inviteCode: "ABCDEFGH",
          requestId: "10000000-0000-4000-8000-000000000001",
          userId: "9007199254740993",
        }),
      ).rejects.toBeInstanceOf(RateLimitedException);
      expect(rateLimiter.consume).toHaveBeenCalledExactlyOnceWith({
        key: `invite-code:ip:${createPrivacySafeSubject(authConfig.emailHmacKey, authConfig.emailHmacKeyVersion, "invite_code_ip", `9007199254740993:${clientIp}`)}`,
      });
      expect(JSON.stringify(rateLimiter.consume.mock.calls)).not.toContain(clientIp);
      expect(database.selectFrom).not.toHaveBeenCalled();
      expect(database.transaction).not.toHaveBeenCalled();
      expect(database.executeQuery).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects invalid engines without selecting either PG service", async () => {
    await expect(context("mariadb-typo")).rejects.toThrow("Unsupported database engine");
  });
});
