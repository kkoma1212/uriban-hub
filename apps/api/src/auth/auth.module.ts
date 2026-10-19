import { Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AccountBirthDateController } from "../account/account-birth-date.controller.js";
import { AccountBirthDateService } from "../account/account-birth-date.service.js";
import { AccountController } from "../account/account.controller.js";
import { AccountService } from "../account/account.service.js";
import {
  createRedisRateLimiter,
  type RedisRateLimiter,
} from "../common/rate-limit/redis-rate-limiter.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, DatabaseModule, type ClassHubDatabase } from "../database/database.module.js";
import { databaseRequestLimitPolicy } from "../common/rate-limit/request-limit-policy.js";
import {
  SmtpPasswordResetMailer,
  type PasswordResetMailer,
} from "../mail/password-reset-mailer.js";
import { SmtpVerificationMailer, type VerificationMailer } from "../mail/verification-mailer.js";
import {
  NOTIFICATION_MAILER,
  SmtpNotificationMailer,
  type NotificationMailer,
} from "../mail/notification-mailer.js";
import { smtpMailerOptions } from "../mail/smtp-transport.js";
import { SecurityAuditModule } from "../security-audit/security-audit.module.js";
import { AuthController } from "./auth.controller.js";
import { AccountRecoveryController } from "./account-recovery.controller.js";
import { AccountRecoveryService } from "./account-recovery.service.js";
import { AuthenticatedCsrfGuard } from "./authenticated-csrf.guard.js";
import { AuthenticatedSessionGuard } from "./authenticated-session.guard.js";
import { AuthService } from "./auth.service.js";
import {
  AUTH_CONFIG,
  AUTH_RATE_LIMITER,
  PASSWORD_RESET_MAILER,
  VERIFICATION_MAILER,
} from "./auth.tokens.js";
import type { AuthConfig } from "./auth.types.js";
import { PasswordResetEnabledGuard } from "./password-reset-enabled.guard.js";
import { PasswordResetService } from "./password-reset.service.js";
import { PreAuthOriginGuard } from "./pre-auth-origin.guard.js";
import { SessionService } from "./session.service.js";
import { SocialAuthController } from "./social/social-auth.controller.js";
import { SocialAuthProvider } from "./social/social-auth.provider.js";
import { SocialAuthFlows } from "./social/social-auth.flows.js";
import { SocialAuthService } from "./social/social-auth.service.js";
import { ProfilePhotoImageService } from "../profile-photos/profile-photo-image.service.js";
import { MARIA_DB_SESSION_OPTIONS } from "./mariadb/session-options.js";
import { SignupApprovalRedemptionController } from "./signup-approval-redemption.controller.js";
import { SignupApprovalRedemptionService } from "./signup-approval-redemption.service.js";
import { AdminSignupApprovalService } from "../admin-signup-approval/admin-signup-approval.service.js";
import { MailManagementService } from "../mail/mail-management.service.js";
import { AccountRequestAdmissionGuard } from "./account-request-admission.guard.js";
import {
  SECURITY_CHANGE_MAILER,
  SmtpSecurityChangeMailer,
} from "../mail/security-change-mailer.js";

@Injectable()
class AuthResourcesLifecycle implements OnApplicationShutdown {
  constructor(@Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter) {}

  async onApplicationShutdown(): Promise<void> {
    await this.rateLimiter.close();
  }
}

@Module({
  imports: [DatabaseModule, SecurityAuditModule],
  controllers: [
    AuthController,
    AccountController,
    AccountBirthDateController,
    SignupApprovalRedemptionController,
    AccountRecoveryController,
    SocialAuthController,
  ],
  providers: [
    AdminSignupApprovalService,
    MailManagementService,
    AccountService,
    AccountBirthDateService,
    AccountRecoveryService,
    AuthService,
    SocialAuthProvider,
    SocialAuthFlows,
    SocialAuthService,
    ProfilePhotoImageService,
    SignupApprovalRedemptionService,
    PasswordResetEnabledGuard,
    PasswordResetService,
    AuthenticatedCsrfGuard,
    AuthenticatedSessionGuard,
    PreAuthOriginGuard,
    AccountRequestAdmissionGuard,
    SessionService,
    {
      provide: MARIA_DB_SESSION_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>) =>
        config.get("DATABASE_ENGINE", { infer: true }) === "mariadb"
          ? { dialect: "mariadb" as const }
          : undefined,
    },
    {
      provide: AUTH_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>): AuthConfig => ({
        agePolicyVersion: config.get("AGE_POLICY_VERSION", { infer: true }),
        emailHmacKey: config.get("EMAIL_HMAC_KEY", { infer: true }),
        emailHmacKeyVersion: config.get("EMAIL_HMAC_KEY_VERSION", { infer: true }),
        privacyPolicyVersion: config.get("PRIVACY_POLICY_VERSION", { infer: true }),
        termsPolicyVersion: config.get("TERMS_POLICY_VERSION", { infer: true }),
      }),
    },
    {
      provide: AUTH_RATE_LIMITER,
      inject: [ConfigService, DATABASE],
      useFactory: (
        config: ConfigService<AppEnvironment, true>,
        database: ClassHubDatabase,
      ): RedisRateLimiter =>
        createRedisRateLimiter(
          config.get("REDIS_URL", { infer: true }),
          databaseRequestLimitPolicy(database),
        ),
    },
    {
      provide: VERIFICATION_MAILER,
      inject: [ConfigService, MailManagementService],
      useFactory: (
        config: ConfigService<AppEnvironment, true>,
        management: MailManagementService,
      ): VerificationMailer => new SmtpVerificationMailer(smtpMailerOptions(config, management)),
    },
    {
      provide: PASSWORD_RESET_MAILER,
      inject: [ConfigService, MailManagementService],
      useFactory: (
        config: ConfigService<AppEnvironment, true>,
        management: MailManagementService,
      ): PasswordResetMailer => new SmtpPasswordResetMailer(smtpMailerOptions(config, management)),
    },
    {
      provide: SECURITY_CHANGE_MAILER,
      inject: [ConfigService, MailManagementService],
      useFactory: (
        config: ConfigService<AppEnvironment, true>,
        management: MailManagementService,
      ) => new SmtpSecurityChangeMailer(smtpMailerOptions(config, management)),
    },
    {
      provide: NOTIFICATION_MAILER,
      inject: [ConfigService, MailManagementService],
      useFactory: (
        config: ConfigService<AppEnvironment, true>,
        management: MailManagementService,
      ): NotificationMailer => new SmtpNotificationMailer(smtpMailerOptions(config, management)),
    },
    AuthResourcesLifecycle,
  ],
  exports: [
    AdminSignupApprovalService,
    MailManagementService,
    NOTIFICATION_MAILER,
    PASSWORD_RESET_MAILER,
    SECURITY_CHANGE_MAILER,
    AUTH_CONFIG,
    AUTH_RATE_LIMITER,
    AuthenticatedCsrfGuard,
    AuthenticatedSessionGuard,
    SessionService,
  ],
})
export class AuthModule {}
