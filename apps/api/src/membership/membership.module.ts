import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AuthModule } from "../auth/auth.module.js";
import { AUTH_CONFIG, AUTH_RATE_LIMITER } from "../auth/auth.tokens.js";
import type { AuthConfig } from "../auth/auth.types.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { NOTIFICATION_MAILER, type NotificationMailer } from "../mail/notification-mailer.js";
import { MariaDbMembershipService } from "./mariadb/membership.service.js";
import { CurrentMembershipController, MembershipController } from "./membership.controller.js";
import { MembershipService } from "./membership.service.js";

export function createMembershipService(
  database: ClassHubDatabase,
  rateLimiter: RedisRateLimiter,
  authConfig: AuthConfig,
  config: ConfigService<AppEnvironment, true>,
  notifications?: NotificationMailer,
): MembershipService {
  const engine = config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
  if (engine === "mariadb")
    return new MariaDbMembershipService(database, rateLimiter, authConfig, notifications);
  if (engine === "postgres")
    return new MembershipService(database, rateLimiter, authConfig, notifications);
  throw new Error("Unsupported database engine");
}

@Module({
  imports: [AuthModule],
  controllers: [CurrentMembershipController, MembershipController],
  providers: [
    {
      provide: MembershipService,
      inject: [DATABASE, AUTH_RATE_LIMITER, AUTH_CONFIG, ConfigService, NOTIFICATION_MAILER],
      useFactory: createMembershipService,
    },
  ],
  exports: [MembershipService],
})
export class MembershipModule {}
