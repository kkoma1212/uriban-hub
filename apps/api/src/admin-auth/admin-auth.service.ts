import { randomUUID } from "node:crypto";

import { passwordForVerification, type DB } from "@classhub/db";
import { Inject, Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type Kysely, type Transaction } from "kysely";

import { createPrivacySafeDigest, issueVerificationToken } from "../auth/auth-crypto.js";
import { hashPassword, verifyPassword } from "../auth/password-hasher.js";
import { hashSessionSecret, isSessionSecret, issueSessionSecrets } from "../auth/session-crypto.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type {
  RateLimitRequest,
  RateLimitResult,
  RedisRateLimiter,
} from "../common/rate-limit/redis-rate-limiter.js";
import {
  accountWaitBudgets,
  clearAccountWait,
  enterAccountWait,
  loginNetworkSubject,
  recordAccountFailure,
  type AccountWaitBudgets,
} from "../auth/login-admission.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { sanitizeSecurityAuditUserAgent } from "../security-audit/security-audit-metadata.js";
import { AUTH_RATE_LIMITER } from "../auth/auth.tokens.js";
import {
  adminAuthDatabase,
  adminAuthDate,
  insertAdminSession,
  readAdminRoles,
  type AdminAuthDatabaseEngine,
} from "./admin-auth.database.js";
import { changeAdminPassword } from "./admin-auth.password.js";
import {
  SECURITY_CHANGE_MAILER,
  notifySecurityChange,
  type SecurityChangeMailer,
} from "../mail/security-change-mailer.js";
import { renewAdminSession } from "./admin-auth.renew.js";
import { AdminPasskeysService, type AdminSecondFactor } from "./admin-passkeys.service.js";
import {
  adminMfaFailureBudget,
  enterAdminMfa,
  recordAdminMfaFailure,
} from "./admin-mfa-failures.js";
import { ADMIN_SESSION_LIFETIME_MS, ADMIN_STEP_UP_LIFETIME_MS } from "./admin-auth.types.js";
import {
  createOtpAuthUri,
  decryptTotpSecret,
  encodeBase32,
  encryptTotpSecret,
  generateTotpSecret,
  verifyTotp,
} from "./admin-auth.crypto.js";
import {
  AdminAccountLockedException,
  AdminChallengeInvalidException,
  AdminInvalidCredentialsException,
  AdminMfaInvalidException,
  AdminSessionRequiredException,
  AdminUnavailableException,
} from "./admin-auth.errors.js";
import type {
  AdminChallengeResult,
  AdminRequestMetadata,
  AdminSessionIssueResult,
  AuthenticatedAdminSession,
} from "./admin-auth.types.js";

const DUMMY_PASSWORD = "classhub-admin-server-dummy-password-1";
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type AdminAuditAction =
  | "admin.auth.login_failed"
  | "admin.auth.login_succeeded"
  | "admin.auth.logout"
  | "admin.auth.mfa_enrolled"
  | "admin.auth.password_verified"
  | "admin.auth.session_expired"
  | "admin.auth.step_up_failed"
  | "admin.auth.step_up_succeeded";

interface AuditCommand {
  accountId: string | null;
  action: AdminAuditAction;
  denyReason?: string;
  email?: string;
  metadata: AdminRequestMetadata;
}

function blockedRetryAfterSeconds(...limits: RateLimitResult[]): number {
  return Math.max(
    ...limits.filter(({ allowed }) => !allowed).map(({ retryAfterSeconds }) => retryAfterSeconds),
  );
}

function retryAfterSeconds(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1_000));
}

@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly logger = new Logger(AdminAuthService.name);
  private dummyPasswordHash: Promise<string> | undefined;
  private readonly engine: AdminAuthDatabaseEngine;

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter,
    private readonly config: ConfigService<AppEnvironment, true>,
    @Optional()
    @Inject(SECURITY_CHANGE_MAILER)
    private readonly securityMailer?: SecurityChangeMailer,
    @Optional() private readonly passkeys?: AdminPasskeysService,
  ) {
    ({ database: this.database, engine: this.engine } = adminAuthDatabase(database, config));
  }

  async onModuleInit(): Promise<void> {
    await this.getDummyPasswordHash();
  }

  async beginLogin(
    email: string,
    password: string,
    metadata: AdminRequestMetadata,
  ): Promise<AdminChallengeResult> {
    const pairFailures = await this.consumeLoginLimits(email, metadata.clientIp);
    const accountWait = this.adminAccountWait(email);
    const account = await this.database
      .selectFrom("admin_accounts")
      .select(["id", "locked_until", "password_hash", "password_input_version", "status"])
      .where("email_normalized", "=", email)
      .executeTakeFirst();
    const candidate =
      account === undefined
        ? password
        : (passwordForVerification(password, account.password_input_version) ?? password);
    const passwordMatches = await verifyPassword(
      candidate,
      account?.password_hash ?? (await this.getDummyPasswordHash()),
    );

    if (account === undefined) {
      await this.recordAuditBestEffort({
        accountId: null,
        action: "admin.auth.login_failed",
        denyReason: "invalid_credentials",
        email,
        metadata,
      });
      await this.recordLoginFailure(pairFailures, accountWait);
      throw new AdminInvalidCredentialsException();
    }

    const now = new Date();
    const result = await this.database.transaction().execute(async (transaction) => {
      const locked = await transaction
        .selectFrom("admin_accounts")
        .select([
          "failed_login_attempts",
          "id",
          "locked_until",
          "password_hash",
          "password_input_version",
          "status",
        ])
        .where("id", "=", account.id)
        .forUpdate()
        .executeTakeFirstOrThrow();

      if (locked.locked_until !== null && locked.locked_until.getTime() > now.getTime()) {
        await this.insertAudit(transaction, {
          accountId: locked.id,
          action: "admin.auth.login_failed",
          denyReason: "account_locked",
          metadata,
        });
        return { kind: "locked" as const, until: locked.locked_until };
      }

      if (locked.status !== "active" && locked.status !== "pending_mfa") {
        await this.insertAudit(transaction, {
          accountId: locked.id,
          action: "admin.auth.login_failed",
          denyReason: "account_unavailable",
          metadata,
        });
        return { kind: "invalid" as const };
      }

      const versionRecognized =
        passwordForVerification(password, locked.password_input_version) !== null;
      const stillMatches =
        passwordMatches &&
        versionRecognized &&
        locked.password_hash === account.password_hash &&
        locked.password_input_version === account.password_input_version;
      if (!stillMatches) {
        // 총검수 C1-03·보안보완 4B: 누구나 관리자 계정을 잠글 수 없도록 DB 잠금을 새로 걸지 않는다.
        // 횟수는 기록만 하고, 대기는 계정·출처 기준 Redis 한도(consumeLoginLimits·adminAccountWait)가 맡는다.
        const failedAttempts = locked.locked_until === null ? locked.failed_login_attempts : 0;
        const nextAttempts = failedAttempts + 1;
        await transaction
          .updateTable("admin_accounts")
          .set({
            failed_login_attempts: nextAttempts,
            // 이미 끝난 옛 잠금만 비운다. 새 잠금은 걸지 않는다(위 설명).
            locked_until: null,
            updated_at: adminAuthDate(now, this.engine),
          })
          .where("id", "=", locked.id)
          .execute();
        await this.insertAudit(transaction, {
          accountId: locked.id,
          action: "admin.auth.login_failed",
          denyReason: "invalid_credentials",
          metadata,
        });
        return { kind: "invalid" as const };
      }

      await transaction
        .updateTable("admin_accounts")
        .set({
          failed_login_attempts: 0,
          locked_until: null,
          updated_at: adminAuthDate(now, this.engine),
        })
        .where("id", "=", locked.id)
        .execute();
      await transaction
        .updateTable("admin_login_challenges")
        .set({ consumed_at: this.challengeConsumedAt(now) })
        .where("admin_account_id", "=", locked.id)
        .where("consumed_at", "is", null)
        .execute();

      const factor = await transaction
        .selectFrom("admin_mfa_factors")
        .selectAll()
        .where("admin_account_id", "=", locked.id)
        .where("revoked_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      let purpose: "enroll_totp" | "verify_totp";
      let setup: AdminChallengeResult["setup"];

      if (locked.status === "pending_mfa") {
        if (factor !== undefined && factor.status !== "pending") {
          throw new AdminUnavailableException();
        }
        const secret = factor === undefined ? generateTotpSecret() : this.decryptFactor(factor);
        if (factor === undefined) {
          const encrypted = encryptTotpSecret(
            secret,
            this.mfaEncryptionKey(),
            this.mfaKeyVersion(),
            locked.id,
          );
          await transaction
            .insertInto("admin_mfa_factors")
            .values({
              admin_account_id: locked.id,
              key_version: this.mfaKeyVersion(),
              secret_auth_tag: encrypted.authTag,
              secret_ciphertext: encrypted.ciphertext,
              secret_iv: encrypted.iv,
              status: "pending",
            })
            .execute();
        }
        const manualKey = encodeBase32(secret);
        purpose = "enroll_totp";
        setup = { manualKey, otpAuthUri: createOtpAuthUri(email, manualKey) };
      } else {
        if (
          (factor === undefined || factor.status !== "active") &&
          !(await this.passkeys?.hasPasskey(transaction, locked.id))
        ) {
          throw new AdminUnavailableException();
        }
        purpose = "verify_totp";
      }

      const challenge = issueVerificationToken();
      const challengeExpiresAt = new Date(now.getTime() + CHALLENGE_LIFETIME_MS);
      await transaction
        .insertInto("admin_login_challenges")
        .values({
          admin_account_id: locked.id,
          challenge_hash: challenge.hash,
          expires_at: adminAuthDate(challengeExpiresAt, this.engine),
          purpose,
        })
        .execute();
      await this.insertAudit(transaction, {
        accountId: locked.id,
        action: "admin.auth.password_verified",
        metadata,
      });

      return {
        challengeExpiresAt,
        challengeToken: challenge.raw,
        kind: "challenge" as const,
        nextStep: purpose,
        methods:
          purpose === "verify_totp" && this.passkeys?.enabled()
            ? await this.passkeys.loginMethods(transaction, locked.id, factor?.status === "active")
            : undefined,
        setup,
      };
    });

    if (result.kind === "locked") {
      throw new AdminAccountLockedException(retryAfterSeconds(result.until, now));
    }
    if (result.kind === "invalid") {
      await this.recordLoginFailure(pairFailures, accountWait);
      throw new AdminInvalidCredentialsException();
    }
    const { accountSlow, accountSpacing, accountLockAfter } = accountWait;
    await clearAccountWait(this.rateLimiter, { accountSlow, accountSpacing, accountLockAfter });
    return {
      challengeExpiresAt: result.challengeExpiresAt,
      challengeToken: result.challengeToken,
      nextStep: result.nextStep,
      ...(result.methods === undefined ? {} : { methods: result.methods }),
      ...(result.setup === undefined ? {} : { setup: result.setup }),
    };
  }

  async completeTotp(
    rawChallengeToken: string | undefined,
    code: string,
    metadata: AdminRequestMetadata,
  ): Promise<AdminSessionIssueResult> {
    return this.completeLoginFactor(rawChallengeToken, { kind: "totp", code }, metadata);
  }

  async completeAlternativeLogin(
    rawChallengeToken: string | undefined,
    verification: Exclude<AdminSecondFactor, { kind: "totp" }>,
    metadata: AdminRequestMetadata,
  ): Promise<AdminSessionIssueResult> {
    if (!this.passkeys?.enabled()) throw new AdminUnavailableException();
    return this.completeLoginFactor(rawChallengeToken, verification, metadata);
  }

  async beginPasskeyLogin(rawChallengeToken: string | undefined, metadata: AdminRequestMetadata) {
    if (!isSessionSecret(rawChallengeToken) || !this.passkeys?.enabled())
      throw new AdminChallengeInvalidException();
    await this.consumeTotpLimits(rawChallengeToken, metadata.clientIp);
    return this.database.transaction().execute(async (transaction) => {
      const challenge = await transaction
        .selectFrom("admin_login_challenges")
        .selectAll()
        .where("challenge_hash", "=", hashSessionSecret(rawChallengeToken))
        .forUpdate()
        .executeTakeFirst();
      if (
        !challenge ||
        challenge.purpose !== "verify_totp" ||
        challenge.consumed_at !== null ||
        challenge.failed_attempts >= 5 ||
        challenge.expires_at.getTime() <= Date.now()
      )
        throw new AdminChallengeInvalidException();
      return this.passkeys!.authenticationOptions(
        transaction,
        challenge.admin_account_id,
        `login:${rawChallengeToken}`,
        "login",
        metadata,
      );
    });
  }

  async beginPasskeyStepUp(session: AuthenticatedAdminSession, metadata: AdminRequestMetadata) {
    if (!this.passkeys?.enabled()) throw new AdminUnavailableException();
    return this.database
      .transaction()
      .execute((transaction) =>
        this.passkeys!.authenticationOptions(
          transaction,
          session.adminAccountId,
          `session:${session.sessionId}`,
          "step_up",
          metadata,
        ),
      );
  }

  private async completeLoginFactor(
    rawChallengeToken: string | undefined,
    verification: AdminSecondFactor,
    metadata: AdminRequestMetadata,
  ): Promise<AdminSessionIssueResult> {
    if (!isSessionSecret(rawChallengeToken)) throw new AdminChallengeInvalidException();
    await this.consumeTotpLimits(rawChallengeToken, metadata.clientIp);
    const challengeHash = hashSessionSecret(rawChallengeToken);
    const pending = await this.database
      .selectFrom("admin_login_challenges")
      .select("admin_account_id")
      .where("challenge_hash", "=", challengeHash)
      .executeTakeFirst();
    const mfaBudget =
      pending === undefined ? undefined : this.adminMfaBudget(pending.admin_account_id);
    if (mfaBudget !== undefined) await enterAdminMfa(this.rateLimiter, mfaBudget);
    const secrets = issueSessionSecrets();
    const now = new Date();
    const absoluteExpiresAt = new Date(now.getTime() + ADMIN_SESSION_LIFETIME_MS);

    const result = await this.database.transaction().execute(async (transaction) => {
      const challenge = await transaction
        .selectFrom("admin_login_challenges")
        .selectAll()
        .where("challenge_hash", "=", challengeHash)
        .forUpdate()
        .executeTakeFirst();
      if (
        challenge === undefined ||
        challenge.consumed_at !== null ||
        challenge.expires_at.getTime() <= now.getTime() ||
        challenge.failed_attempts >= 5
      ) {
        return { kind: "challenge_invalid" as const };
      }

      const account = await transaction
        .selectFrom("admin_accounts")
        .select(["display_name", "email_normalized", "id", "status"])
        .where("id", "=", challenge.admin_account_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const requiredAccountStatus = challenge.purpose === "enroll_totp" ? "pending_mfa" : "active";
      if (account.status !== requiredAccountStatus) {
        await transaction
          .updateTable("admin_login_challenges")
          .set({ consumed_at: this.challengeConsumedAt(now) })
          .where("id", "=", challenge.id)
          .execute();
        return { kind: "challenge_invalid" as const };
      }

      const factor = await transaction
        .selectFrom("admin_mfa_factors")
        .selectAll()
        .where("admin_account_id", "=", account.id)
        .where("revoked_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      const requiredFactorStatus = challenge.purpose === "enroll_totp" ? "pending" : "active";
      if (
        (verification.kind === "totp" &&
          (factor === undefined || factor.status !== requiredFactorStatus)) ||
        (verification.kind !== "totp" && challenge.purpose !== "verify_totp")
      ) {
        return { kind: "challenge_invalid" as const };
      }

      const acceptedTimestep =
        verification.kind === "totp" && factor
          ? verifyTotp(
              this.decryptFactor(factor),
              verification.code,
              now.getTime(),
              factor.last_accepted_timestep === null ? null : BigInt(factor.last_accepted_timestep),
            )
          : null;
      const validFactor =
        verification.kind === "totp"
          ? acceptedTimestep !== null
          : await this.passkeys?.verify(
              transaction,
              account.id,
              `login:${rawChallengeToken}`,
              "login",
              verification,
              metadata,
            );
      if (!validFactor) {
        const failedAttempts = Math.min(5, challenge.failed_attempts + 1);
        await transaction
          .updateTable("admin_login_challenges")
          .set({
            failed_attempts: failedAttempts,
            ...(failedAttempts >= 5 ? { consumed_at: this.challengeConsumedAt(now) } : {}),
          })
          .where("id", "=", challenge.id)
          .execute();
        await this.insertAudit(transaction, {
          accountId: account.id,
          action: "admin.auth.login_failed",
          denyReason: `${verification.kind}_invalid_or_reused`,
          metadata,
        });
        return { kind: "mfa_invalid" as const, email: account.email_normalized };
      }

      const enrolled = challenge.purpose === "enroll_totp";
      if (verification.kind === "totp" && factor && acceptedTimestep !== null) {
        await transaction
          .updateTable("admin_mfa_factors")
          .set({
            ...(enrolled
              ? { activated_at: adminAuthDate(now, this.engine), status: "active" }
              : {}),
            last_accepted_timestep: acceptedTimestep.toString(),
          })
          .where("id", "=", factor.id)
          .execute();
      }
      await transaction
        .updateTable("admin_login_challenges")
        .set({ consumed_at: this.challengeConsumedAt(now) })
        .where("id", "=", challenge.id)
        .execute();
      await transaction
        .updateTable("admin_accounts")
        .set({
          last_login_at: adminAuthDate(now, this.engine),
          ...(enrolled ? { status: "active" } : {}),
          updated_at: adminAuthDate(now, this.engine),
        })
        .where("id", "=", account.id)
        .execute();

      const sessionRow = await insertAdminSession(
        transaction,
        {
          absolute_expires_at: adminAuthDate(absoluteExpiresAt, this.engine),
          admin_account_id: account.id,
          created_ip_hmac: this.privateDigest("admin_session_ip", metadata.clientIp),
          csrf_token_hash: secrets.csrfTokenHash,
          hmac_key_version: this.emailHmacKeyVersion(),
          issued_at: adminAuthDate(now, this.engine),
          last_seen_at: adminAuthDate(now, this.engine),
          mfa_verified_at: adminAuthDate(now, this.engine),
          reauthenticated_at: null,
          session_hash: secrets.sessionTokenHash,
          user_agent: sanitizeSecurityAuditUserAgent(metadata.userAgent),
        },
        this.engine,
      );
      const roles = await readAdminRoles(transaction, account.id);

      if (enrolled) {
        await this.insertAudit(transaction, {
          accountId: account.id,
          action: "admin.auth.mfa_enrolled",
          metadata,
        });
      }
      await this.insertAudit(transaction, {
        accountId: account.id,
        action: "admin.auth.login_succeeded",
        metadata,
      });

      return {
        kind: "issued" as const,
        enrolled,
        session: {
          absoluteExpiresAt,
          adminAccountId: account.id,
          csrfTokenHash: secrets.csrfTokenHash,
          displayName: account.display_name,
          email: account.email_normalized,
          issuedAt: now,
          lastSeenAt: now,
          mfaVerifiedAt: now,
          reauthenticatedAt: null,
          roles,
          sessionId: sessionRow.id,
        },
      };
    });

    if (result.kind === "challenge_invalid") throw new AdminChallengeInvalidException();
    if (result.kind === "mfa_invalid") {
      await this.recordMfaFailure(mfaBudget, result.email);
      throw new AdminMfaInvalidException();
    }
    if (verification.kind === "recovery")
      await notifySecurityChange(this.securityMailer, {
        email: result.session.email,
        kind: "admin_recovery_code_used",
        occurredAt: now,
      });
    if (result.enrolled)
      await notifySecurityChange(this.securityMailer, {
        email: result.session.email,
        kind: "admin_mfa_enrolled",
        occurredAt: now,
      });
    return {
      csrfToken: secrets.csrfToken,
      session: result.session,
      sessionToken: secrets.sessionToken,
    };
  }

  async authenticate(
    rawSessionToken: string | undefined,
    metadata: AdminRequestMetadata,
  ): Promise<AuthenticatedAdminSession> {
    if (!isSessionSecret(rawSessionToken)) throw new AdminSessionRequiredException();
    const sessionHash = hashSessionSecret(rawSessionToken);
    const result = await this.database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("admin_sessions")
        .selectAll()
        .where("session_hash", "=", sessionHash)
        .forUpdate()
        .executeTakeFirst();
      if (session === undefined || session.revoked_at !== null) return null;
      const now = new Date();
      const absoluteExpired = session.absolute_expires_at.getTime() <= now.getTime();
      const idleExpired =
        session.last_seen_at.getTime() + ADMIN_SESSION_LIFETIME_MS <= now.getTime();
      const account = await transaction
        .selectFrom("admin_accounts")
        .select(["display_name", "email_normalized", "status"])
        .where("id", "=", session.admin_account_id)
        .executeTakeFirst();
      if (absoluteExpired || idleExpired || account?.status !== "active") {
        await transaction
          .updateTable("admin_sessions")
          .set({ revoked_at: adminAuthDate(now, this.engine) })
          .where("id", "=", session.id)
          .where("revoked_at", "is", null)
          .execute();
        await this.insertAudit(transaction, {
          accountId: session.admin_account_id,
          action: "admin.auth.session_expired",
          denyReason:
            account?.status !== "active"
              ? "account_unavailable"
              : absoluteExpired
                ? "absolute_timeout"
                : "idle_timeout",
          metadata,
        });
        return null;
      }

      // One-time cap for pre-policy 8-hour sessions. Ordinary reads never extend
      // expiry; a renewed session already has expiry <= last_seen_at + 30 minutes.
      const absoluteExpiresAt = new Date(
        Math.min(
          session.absolute_expires_at.getTime(),
          session.last_seen_at.getTime() + ADMIN_SESSION_LIFETIME_MS,
        ),
      );
      await transaction
        .updateTable("admin_sessions")
        .set({
          last_seen_at: adminAuthDate(now, this.engine),
          ...(absoluteExpiresAt.getTime() < session.absolute_expires_at.getTime()
            ? { absolute_expires_at: adminAuthDate(absoluteExpiresAt, this.engine) }
            : {}),
        })
        .where("id", "=", session.id)
        .execute();
      const roles = await readAdminRoles(transaction, session.admin_account_id);
      return {
        absoluteExpiresAt,
        adminAccountId: session.admin_account_id,
        csrfTokenHash: session.csrf_token_hash,
        displayName: account.display_name,
        email: account.email_normalized,
        issuedAt: session.issued_at,
        lastSeenAt: now,
        mfaVerifiedAt: session.mfa_verified_at,
        reauthenticatedAt: session.reauthenticated_at,
        roles,
        sessionId: session.id,
      } satisfies AuthenticatedAdminSession;
    });

    if (result === null) throw new AdminSessionRequiredException();
    return result;
  }

  async renew(
    session: AuthenticatedAdminSession,
    metadata: AdminRequestMetadata,
  ): Promise<AuthenticatedAdminSession> {
    const result = await renewAdminSession(this.database, this.engine, session, (transaction) =>
      this.insertAudit(transaction, {
        accountId: session.adminAccountId,
        action: "admin.auth.session_expired",
        denyReason: "renewal_unavailable",
        metadata,
      }),
    );
    if (result === null) throw new AdminSessionRequiredException();
    return result;
  }

  async logout(session: AuthenticatedAdminSession, metadata: AdminRequestMetadata): Promise<void> {
    const now = new Date();
    await this.database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("admin_sessions")
        .set({ revoked_at: adminAuthDate(now, this.engine) })
        .where("id", "=", session.sessionId)
        .where("revoked_at", "is", null)
        .execute();
      await this.insertAudit(transaction, {
        accountId: session.adminAccountId,
        action: "admin.auth.logout",
        metadata,
      });
    });
  }

  async stepUp(
    session: AuthenticatedAdminSession,
    password: string,
    code: string,
    metadata: AdminRequestMetadata,
  ): Promise<{ reauthenticatedAt: Date; validUntil: Date }> {
    return this.stepUpFactor(session, password, { kind: "totp", code }, metadata);
  }

  async stepUpAlternative(
    session: AuthenticatedAdminSession,
    password: string,
    verification: Exclude<AdminSecondFactor, { kind: "totp" }>,
    metadata: AdminRequestMetadata,
  ) {
    if (!this.passkeys?.enabled()) throw new AdminUnavailableException();
    return this.stepUpFactor(session, password, verification, metadata);
  }

  private async stepUpFactor(
    session: AuthenticatedAdminSession,
    password: string,
    verification: AdminSecondFactor,
    metadata: AdminRequestMetadata,
  ): Promise<{ reauthenticatedAt: Date; validUntil: Date }> {
    const limit = await this.rateLimiter.consume({
      key: `admin-step-up:session:${this.privateDigest("admin_step_up_session", session.sessionId)}`,
    });
    if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds, limit);
    const mfaBudget = this.adminMfaBudget(session.adminAccountId);
    await enterAdminMfa(this.rateLimiter, mfaBudget);
    const proof = await this.database.transaction().execute(async (transaction) => {
      const account = await transaction
        .selectFrom("admin_accounts")
        .select(["password_hash", "password_input_version", "status"])
        .where("id", "=", session.adminAccountId)
        .forUpdate()
        .executeTakeFirst();
      const factor = await transaction
        .selectFrom("admin_mfa_factors")
        .selectAll()
        .where("admin_account_id", "=", session.adminAccountId)
        .where("status", "=", "active")
        .where("revoked_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      const storedSession = await transaction
        .selectFrom("admin_sessions")
        .select(["id", "admin_account_id", "absolute_expires_at", "mfa_verified_at", "revoked_at"])
        .where("id", "=", session.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (
        account === undefined ||
        account.status !== "active" ||
        (verification.kind === "totp" && factor === undefined) ||
        storedSession?.revoked_at !== null ||
        storedSession.admin_account_id !== session.adminAccountId ||
        storedSession.absolute_expires_at.getTime() <= Date.now()
      ) {
        throw new AdminSessionRequiredException();
      }

      const normalizedPassword = passwordForVerification(password, account.password_input_version);
      const passwordMatches = await verifyPassword(
        normalizedPassword ?? password,
        account.password_hash,
      );
      const now = new Date();
      if (storedSession.absolute_expires_at.getTime() <= now.getTime()) {
        throw new AdminSessionRequiredException();
      }
      const acceptedTimestep =
        verification.kind === "totp" && factor
          ? verifyTotp(
              this.decryptFactor(factor),
              verification.code,
              now.getTime(),
              factor.last_accepted_timestep === null ? null : BigInt(factor.last_accepted_timestep),
            )
          : null;
      const validFactor =
        verification.kind === "totp"
          ? acceptedTimestep !== null
          : normalizedPassword !== null &&
            passwordMatches &&
            now.getTime() > storedSession.mfa_verified_at.getTime() &&
            (await this.passkeys?.verify(
              transaction,
              session.adminAccountId,
              `session:${session.sessionId}`,
              "step_up",
              verification,
              metadata,
            ));
      if (
        normalizedPassword === null ||
        !passwordMatches ||
        !validFactor ||
        now.getTime() <= storedSession.mfa_verified_at.getTime()
      ) {
        await this.insertAudit(transaction, {
          accountId: session.adminAccountId,
          action: "admin.auth.step_up_failed",
          denyReason: `invalid_password_or_${verification.kind}`,
          metadata,
        });
        return null;
      }

      if (verification.kind === "totp" && factor && acceptedTimestep !== null)
        await transaction
          .updateTable("admin_mfa_factors")
          .set({ last_accepted_timestep: acceptedTimestep.toString() })
          .where("id", "=", factor.id)
          .execute();
      await transaction
        .updateTable("admin_sessions")
        .set({ reauthenticated_at: adminAuthDate(now, this.engine) })
        .where("id", "=", session.sessionId)
        .execute();
      await this.passkeys?.recordStepUp(transaction, session.sessionId, verification.kind, now);
      await this.insertAudit(transaction, {
        accountId: session.adminAccountId,
        action: "admin.auth.step_up_succeeded",
        metadata,
      });
      return {
        reauthenticatedAt: now,
        validUntil: new Date(
          Math.min(
            now.getTime() + ADMIN_STEP_UP_LIFETIME_MS,
            storedSession.absolute_expires_at.getTime(),
          ),
        ),
      };
    });

    if (proof === null) {
      await this.recordMfaFailure(mfaBudget, session.email);
      throw new AdminMfaInvalidException();
    }
    if (verification.kind === "recovery")
      await notifySecurityChange(this.securityMailer, {
        email: session.email,
        kind: "admin_recovery_code_used",
        occurredAt: proof.reauthenticatedAt,
      });
    return proof;
  }

  async changePassword(
    session: AuthenticatedAdminSession,
    newPassword: string,
    metadata: AdminRequestMetadata,
  ): Promise<{ password_changed: true }> {
    return changeAdminPassword(
      this.database,
      this.engine,
      session,
      newPassword,
      metadata,
      this.securityMailer,
    );
  }
  /*
   * 총검수 C1-03(보안보완 4B와 같은 원칙): 업무 설정값으로 약해지지 않는 고정 상한을 출처 기준으로 둔다.
   * 예전 '이메일 단위' 한도는 아무 곳에서나 관리자 이메일로 요청해 진짜 관리자를 막을 수 있어 없앴다.
   * 계정 기준 대기는 일반 로그인과 같다(2026-10-02 사용자 결정: 점점 기다리게).
   */
  private async consumeLoginLimits(email: string, clientIp: string) {
    const network = loginNetworkSubject(clientIp);
    const pair = this.privateDigest("admin_login_pair", JSON.stringify([network, email]));
    for (const request of [
      {
        key: `admin-login:network:${this.privateDigest("admin_login_network", network)}`,
        limit: 30,
        windowSeconds: 60,
      },
      { key: `admin-login:pair:${pair}`, limit: 10, windowSeconds: 60 },
    ]) {
      const limit = await this.rateLimiter.consume(request);
      if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds, limit);
    }
    const policy = await this.rateLimiter.getPolicy();
    const pairFailures = {
      key: `admin-login-failure:pair:${pair}`,
      limit: Math.min(policy.max_attempts, 5),
      windowSeconds: Math.max(policy.cooldown_seconds, 60),
    };
    const failures = await this.rateLimiter.peek(pairFailures);
    if (!failures.allowed) throw new RateLimitedException(failures.retryAfterSeconds, failures);
    await enterAccountWait(this.rateLimiter, this.adminAccountWait(email));
    return pairFailures;
  }

  private adminMfaBudget(accountId: string) {
    return adminMfaFailureBudget(this.privateDigest("admin_mfa_account", accountId));
  }

  private async recordMfaFailure(
    budget: Required<RateLimitRequest> | undefined,
    email: string,
  ): Promise<void> {
    if (budget === undefined || !(await recordAdminMfaFailure(this.rateLimiter, budget))) return;
    await notifySecurityChange(this.securityMailer, {
      email,
      kind: "admin_mfa_failures",
      occurredAt: new Date(),
    });
  }

  private adminAccountWait(email: string) {
    return accountWaitBudgets("admin-login", this.privateDigest("admin_login_account", email));
  }

  private async recordLoginFailure(
    pairFailures: Required<RateLimitRequest>,
    accountWait: AccountWaitBudgets,
  ): Promise<void> {
    await this.rateLimiter.consume(pairFailures);
    const lock = await recordAccountFailure(this.rateLimiter, accountWait);
    if (lock !== undefined) throw new RateLimitedException(lock.retryAfterSeconds, lock);
  }
  private async consumeTotpLimits(rawChallengeToken: string, clientIp: string): Promise<void> {
    const [ipLimit, challengeLimit] = await Promise.all([
      this.rateLimiter.consume({
        key: `admin-totp:ip:${this.privateDigest("admin_totp_ip", clientIp)}`,
      }),
      this.rateLimiter.consume({
        key: `admin-totp:challenge:${hashSessionSecret(rawChallengeToken).toString("base64url")}`,
      }),
    ]);
    if (!ipLimit.allowed || !challengeLimit.allowed) {
      throw new RateLimitedException(
        blockedRetryAfterSeconds(ipLimit, challengeLimit),
        !challengeLimit.allowed ? challengeLimit : ipLimit,
      );
    }
  }

  private decryptFactor(factor: {
    admin_account_id: string;
    key_version: string;
    secret_auth_tag: Buffer;
    secret_ciphertext: Buffer;
    secret_iv: Buffer;
  }): Buffer {
    if (factor.key_version !== this.mfaKeyVersion()) throw new AdminUnavailableException();
    try {
      return decryptTotpSecret(
        {
          authTag: factor.secret_auth_tag,
          ciphertext: factor.secret_ciphertext,
          iv: factor.secret_iv,
        },
        this.mfaEncryptionKey(),
        factor.key_version,
        factor.admin_account_id,
      );
    } catch (error) {
      if (error instanceof AdminUnavailableException) throw error;
      throw new AdminUnavailableException();
    }
  }

  private async getDummyPasswordHash(): Promise<string> {
    this.dummyPasswordHash ??= hashPassword(DUMMY_PASSWORD);
    return this.dummyPasswordHash;
  }

  private mfaEncryptionKey(): string {
    const value = this.config.get("ADMIN_MFA_ENCRYPTION_KEY", { infer: true });
    if (value === undefined) throw new AdminUnavailableException();
    return value;
  }

  private mfaKeyVersion(): string {
    const value = this.config.get("ADMIN_MFA_KEY_VERSION", { infer: true });
    if (value === undefined) throw new AdminUnavailableException();
    return value;
  }

  private challengeConsumedAt(now: Date) {
    // The database's creation default (Maria UTC_TIMESTAMP(6), PG clock_timestamp()) can be a
    // fraction of a millisecond ahead of the app clock — PG integration tests hit it intermittently.
    // Keep expiration decisions on the existing app clock and make only the stored consume time monotonic.
    return sql<Date>`GREATEST(created_at, ${adminAuthDate(now, this.engine)})`;
  }

  private emailHmacKeyVersion(): string {
    return this.config.get("EMAIL_HMAC_KEY_VERSION", { infer: true });
  }

  private privateDigest(namespace: string, value: string): string {
    return createPrivacySafeDigest(
      this.config.get("EMAIL_HMAC_KEY", { infer: true }),
      namespace,
      value,
    );
  }

  private auditValues(command: AuditCommand) {
    return {
      action: command.action,
      actor_email_hmac:
        command.email === undefined ? null : this.privateDigest("admin_audit_email", command.email),
      actor_ip_hmac: this.privateDigest("admin_audit_ip", command.metadata.clientIp),
      admin_account_id: command.accountId,
      deny_reason: command.denyReason ?? null,
      event_id: randomUUID(),
      hmac_key_version: this.emailHmacKeyVersion(),
      request_id: UUID_PATTERN.test(command.metadata.requestId)
        ? command.metadata.requestId
        : randomUUID(),
      user_agent: sanitizeSecurityAuditUserAgent(command.metadata.userAgent),
    };
  }

  private async insertAudit(
    database: Kysely<DB> | Transaction<DB>,
    command: AuditCommand,
  ): Promise<void> {
    await database.insertInto("admin_auth_audit_logs").values(this.auditValues(command)).execute();
  }

  private async recordAuditBestEffort(command: AuditCommand): Promise<void> {
    try {
      await this.insertAudit(this.database, command);
    } catch {
      this.logger.error({
        action: "admin_auth.audit_failed",
        failure_code: "admin_auth_audit_insert_failed",
        request_id: command.metadata.requestId,
      });
    }
  }
}
