import { randomUUID } from "node:crypto";

import { ForbiddenException, Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type Transaction } from "kysely";

import { matchesDatabaseConstraint, type SecurityAuditEvent, type DB } from "@classhub/db";
import { SOCIAL_ONLY_PASSWORD } from "./social/social-auth.database.js";

import { normalizeApprovalEmail } from "../admin-signup-approval/admin-signup-approval.policy.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RateLimitResult, RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AppEnvironment } from "../config/environment.js";
import {
  authDateValue,
  authNumericId,
  authPersistenceFailure,
  authTransactionNow,
  authUpdateSucceeded,
  createAuthMariaRowCodec,
  isMariaSignupDuplicate,
  SignupInsertCollision,
} from "./mariadb/auth-persistence.js";
import {
  closeApprovedGuardianConsentAttempt,
  lockApprovedGuardianConsent,
} from "./mariadb/auth-signup-approval.js";
import type { VerificationMailer } from "../mail/verification-mailer.js";
import { admitAuthMail } from "../mail/auth-mail-admission.js";
import { AdminSignupApprovalService } from "../admin-signup-approval/admin-signup-approval.service.js";
import { NOTIFICATION_MAILER, type NotificationMailer } from "../mail/notification-mailer.js";
import { publishSecurityAuditBestEffort } from "../security-audit/security-audit-best-effort.js";
import { sanitizeSecurityAuditUserAgent } from "../security-audit/security-audit-metadata.js";
import { SECURITY_AUDIT_PUBLISHER } from "../security-audit/security-audit.tokens.js";
import type { SecurityAuditPublisher } from "../security-audit/security-audit.types.js";
import {
  createPrivacySafeDigest,
  createPrivacySafeSubject,
  hashVerificationToken,
  issueVerificationToken,
} from "./auth-crypto.js";
import {
  AccountUnavailableException,
  EmailAlreadyVerifiedException,
  EmailAlreadyRegisteredException,
  InvalidConsentsException,
  SignupApprovalInvalidException,
  TokenInvalidOrExpiredException,
} from "./auth.errors.js";
import { hashPassword } from "./password-hasher.js";
import { requireSignupBirthDate } from "./birth-date.js";
import {
  currentLegalConsentSnapshot,
  requireLegalConsentSnapshot,
  sameLegalConsentSnapshot,
  type LegalConsentSnapshot,
} from "../legal/legal-consent-snapshot.js";
import { NFC_PASSWORD_INPUT_VERSION } from "./password-input-policy.js";
import { requireAcceptedNewPassword } from "./password-input-policy-http.js";
import { AUTH_CONFIG, AUTH_RATE_LIMITER, VERIFICATION_MAILER } from "./auth.tokens.js";
import type {
  AuthRequestContext,
  AuthConfig,
  ConfirmEmailResult,
  GuardianConsentConfirmResult,
  GuardianConsentReference,
  GuardianConsentRequestResult,
  GuardianConsentStatusResult,
  ResendEmailResult,
  SignUpCommand,
  SignUpResult,
} from "./auth.types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return matchesDatabaseConstraint(error, {
    kind: "unique_violation",
    objectName: constraint,
  });
}

function hasAcceptedRequiredConsents(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const consents = value as Record<string, unknown>;
  const requiredKeys = ["privacy", "terms"] as const;
  return (
    Object.keys(consents).length === requiredKeys.length &&
    requiredKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(consents, key) && consents[key] === true,
    )
  );
}

function isGuardianConsentReference(value: unknown): value is GuardianConsentReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const reference = value as Record<string, unknown>;
  const requiredKeys = ["completion_token", "request_id"] as const;
  return (
    Object.keys(reference).length === requiredKeys.length &&
    typeof reference.completion_token === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(reference.completion_token) &&
    typeof reference.request_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      reference.request_id,
    )
  );
}

function hasValidAgeRoute(command: SignUpCommand): boolean {
  if (command.age_route === "over_14") {
    return command.guardian_consent === undefined;
  }

  return (
    command.age_route === "guardian_consent" && isGuardianConsentReference(command.guardian_consent)
  );
}

function hasValidSignupApprovalInput(command: SignUpCommand): boolean {
  return (
    (command.role === "student" || command.role === "teacher") &&
    command.approval_code === undefined
  );
}

function blockedRetryAfterSeconds(...limits: RateLimitResult[]): number {
  const blocked = limits.filter((limit) => !limit.allowed);
  if (blocked.length === 0) {
    throw new Error("Retry-After requires at least one blocked rate limit.");
  }
  return Math.max(...blocked.map((limit) => limit.retryAfterSeconds));
}

@Injectable()
export class AuthService {
  private readonly database: ClassHubDatabase;
  private readonly mariaDb: boolean;
  private readonly bindingRequired: boolean;
  private readonly birthDatesInstalled: boolean;
  private readonly under14SignupOpen: boolean;
  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter,
    @Inject(VERIFICATION_MAILER) private readonly mailer: VerificationMailer,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(SECURITY_AUDIT_PUBLISHER)
    private readonly securityAuditPublisher: SecurityAuditPublisher,
    @Optional() @Inject(ConfigService) environment?: ConfigService<AppEnvironment, true>,
    @Optional() @Inject(NOTIFICATION_MAILER) private readonly notifications?: NotificationMailer,
    @Optional()
    @Inject(AdminSignupApprovalService)
    private readonly signupMail?: AdminSignupApprovalService,
  ) {
    this.mariaDb = environment?.get("DATABASE_ENGINE", { infer: true }) === "mariadb";
    this.birthDatesInstalled =
      environment?.get("USER_BIRTH_DATES_DATABASE_INSTALLED", { infer: true }) === true;
    // 환경 설정을 읽은 경우에만 닫는다(설정 없이 만든 시험용 서비스는 기존 동작 그대로).
    this.under14SignupOpen = environment?.get("UNDER_14_SIGNUP_ENABLED", { infer: true }) !== false;
    this.bindingRequired =
      environment?.get("NODE_ENV", { infer: true }) === "production" ||
      environment?.get("LEGAL_CONSENT_BINDING_ENABLED", { infer: true }) === true;
    this.database = this.mariaDb ? database.withPlugin(createAuthMariaRowCodec()) : database;
  }

  signUpOptions(): {
    birth_date_collected: boolean;
    birth_date_required: boolean;
    under_14_signup: boolean;
  } {
    return {
      birth_date_collected: this.birthDatesInstalled,
      // P-025③: 받을 수 있는 환경이어도 필수가 아니다(예전 화면과의 호환을 위해 키는 남긴다).
      birth_date_required: false,
      under_14_signup: this.under14SignupOpen,
    };
  }

  private assertUnder14SignupOpen(): void {
    if (this.under14SignupOpen) return;
    throw new ForbiddenException({
      code: "UNDER_14_SIGNUP_CLOSED",
      message: "지금은 만 14세 이상만 가입할 수 있어요.",
    });
  }

  async signUp(
    command: SignUpCommand,
    clientIp: string,
    requestContext: AuthRequestContext = {
      requestId: randomUUID(),
      userAgent: undefined,
    },
  ): Promise<SignUpResult> {
    if (command.age_route === "guardian_consent") this.assertUnder14SignupOpen();
    return this.createAccount(command, clientIp, requestContext);
  }

  /** Only the verified social flow service calls this; the public password DTO cannot select it. */
  async signUpWithSocialIdentity(
    command: Omit<SignUpCommand, "password">,
    clientIp: string,
    requestContext: AuthRequestContext,
    social: {
      emailVerified: boolean;
      attach: (transaction: Transaction<DB>, userId: string) => Promise<void>;
    },
  ): Promise<SignUpResult> {
    return this.createAccount({ ...command, password: "" }, clientIp, requestContext, social);
  }

  private async createAccount(
    command: SignUpCommand,
    clientIp: string,
    requestContext: AuthRequestContext,
    social?: {
      emailVerified: boolean;
      attach: (transaction: Transaction<DB>, userId: string) => Promise<void>;
    },
  ): Promise<SignUpResult> {
    if (!hasAcceptedRequiredConsents(command.consents) || !hasValidAgeRoute(command)) {
      throw new InvalidConsentsException();
    }

    if (!hasValidSignupApprovalInput(command)) {
      throw new SignupApprovalInvalidException();
    }
    const birthDate = requireSignupBirthDate(command, this.birthDatesInstalled, new Date());

    const email = normalizeApprovalEmail(command.email);
    await this.consumeSignUpLimits(email, clientIp);

    const passwordHash =
      social === undefined
        ? await hashPassword(
            requireAcceptedNewPassword(command.password, {
              displayName: command.display_name,
              email,
            }),
          )
        : SOCIAL_ONLY_PASSWORD;
    const now = new Date();
    let closedDuplicateGuardianAttempt = false;
    // The anonymous request spends the same shared mail budget before looking
    // up the account. A later reset/recovery request must not reveal whether
    // this signup created an account through different cooldown consumption.
    let signupMailAdmitted = false;
    try {
      await admitAuthMail(this.rateLimiter, this.config, email, "signup-email", { clientIp });
      signupMailAdmitted = true;
    } catch {
      // Preserve the existing initial-signup contract: an unavailable mail
      // budget must not discard a valid account; authenticated resend remains.
    }
    try {
      await this.database.transaction().execute(async (transaction) => {
        const transactionNow = await authTransactionNow(transaction, this.mariaDb);
        const documentSnapshot = this.bindingRequired
          ? requireLegalConsentSnapshot(
              command.legal_documents,
              await currentLegalConsentSnapshot(transaction, this.mariaDb, now, true),
            )
          : undefined;
        const guardianRequest =
          command.age_route === "guardian_consent"
            ? await lockApprovedGuardianConsent(
                transaction,
                command.guardian_consent!,
                email,
                now,
                this.config,
                documentSnapshot,
              )
            : undefined;

        const existingUser = await transaction
          .selectFrom("users")
          .select("id")
          .where("email_normalized", "=", email)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
        if (existingUser !== undefined) {
          if (guardianRequest !== undefined) {
            await closeApprovedGuardianConsentAttempt(
              transaction,
              command.guardian_consent!,
              transactionNow,
            );
            closedDuplicateGuardianAttempt = true;
            return;
          }
          throw new EmailAlreadyRegisteredException();
        }

        const userInsert = transaction.insertInto("users").values({
          display_name: command.display_name.trim(),
          email_normalized: email,
          password_hash: passwordHash,
          password_input_version: NFC_PASSWORD_INPUT_VERSION,
          signup_approved_at: null,
          signup_role: command.role,
          ...(birthDate === undefined ? {} : { birth_date: birthDate }),
        });
        let user: { id: string };
        if (this.mariaDb) {
          let inserted;
          try {
            inserted = await userInsert.executeTakeFirstOrThrow();
          } catch (error) {
            if (isMariaSignupDuplicate(error)) throw new SignupInsertCollision();
            throw error;
          }
          if (inserted.numInsertedOrUpdatedRows !== 1n || typeof inserted.insertId !== "bigint")
            throw authPersistenceFailure();
          const id = authNumericId(inserted.insertId.toString());
          user = await transaction
            .selectFrom("users")
            .select("id")
            .where("id", "=", id)
            .where("email_normalized", "=", email)
            .where("deleted_at", "is", null)
            .executeTakeFirstOrThrow();
          if (user.id !== id) throw authPersistenceFailure();
        } else user = await userInsert.returning("id").executeTakeFirstOrThrow();

        if (social?.emailVerified === true) {
          // Reuse the existing verified-email UPDATE privilege; signup INSERT remains minimal.
          await transaction
            .updateTable("users")
            .set({ email_verified_at: authDateValue(now, this.mariaDb) })
            .where("id", "=", user.id)
            .execute();
        }
        const consents = [
          {
            accepted_at: authDateValue(now, this.mariaDb),
            consent_type: "terms",
            ip_address: this.mariaDb ? sql<string>`INET6_NTOA(INET6_ATON(${clientIp}))` : clientIp,
            policy_version:
              documentSnapshot?.terms.policy_version ?? this.config.termsPolicyVersion,
            user_id: user.id,
          },
          {
            accepted_at: authDateValue(now, this.mariaDb),
            consent_type: "privacy",
            ip_address: this.mariaDb ? sql<string>`INET6_NTOA(INET6_ATON(${clientIp}))` : clientIp,
            policy_version:
              documentSnapshot?.privacy_consent.policy_version ?? this.config.privacyPolicyVersion,
            user_id: user.id,
          },
          ...(command.age_route === "over_14"
            ? [
                {
                  accepted_at: authDateValue(now, this.mariaDb),
                  consent_type: "age_over_14",
                  ip_address: this.mariaDb
                    ? sql<string>`INET6_NTOA(INET6_ATON(${clientIp}))`
                    : clientIp,
                  policy_version: this.config.agePolicyVersion,
                  user_id: user.id,
                },
              ]
            : []),
        ];

        await transaction
          .insertInto("user_consents")
          .values(
            consents.map((consent) =>
              documentSnapshot === undefined
                ? consent
                : {
                    ...consent,
                    document_snapshot: JSON.stringify(documentSnapshot),
                  },
            ),
          )
          .execute();

        if (guardianRequest !== undefined) {
          const consumeQuery = transaction
            .updateTable("guardian_consent_requests")
            .set({
              completion_token_hash: null,
              consumed_at: transactionNow,
              user_id: user.id,
            })
            .where("id", "=", guardianRequest.id)
            .where("approved_at", "is not", null)
            .where("consumed_at", "is", null)
            .where("invalidated_at", "is", null)
            .where("completion_token_hash", "=", guardianRequest.completionTokenHash)
            .where("expires_at", ">", transactionNow);
          const consumed = this.mariaDb
            ? authUpdateSucceeded(await consumeQuery.executeTakeFirstOrThrow())
            : (await consumeQuery.returning("id").executeTakeFirst()) !== undefined;

          if (!consumed) {
            throw new TokenInvalidOrExpiredException();
          }
        }
        if (social) await social.attach(transaction, user.id);
      });
    } catch (error) {
      let duplicateEmail = error instanceof EmailAlreadyRegisteredException;
      if (this.mariaDb && error instanceof SignupInsertCollision) {
        // The users INSERT alone marked this 1062. The whole transaction has
        // rolled back before checking its exact active-email conflict.
        const duplicate = await this.database
          .selectFrom("users")
          .select("id")
          .where("email_normalized", "=", email)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
        if (duplicate === undefined) throw authPersistenceFailure();
        duplicateEmail = true;
      }
      if (isUniqueViolation(error, "users_active_email_unique")) {
        duplicateEmail = true;
      }
      if (duplicateEmail) {
        // Close the presented, approved proof on either accepted outcome.
        // Keeping it reusable only for existing accounts creates a second
        // enumeration channel through guardian status or a subsequent signup.
        // Do not attach this proof to, or change, the existing account.
        if (command.guardian_consent !== undefined) {
          await this.database.transaction().execute(async (transaction) => {
            const transactionNow = await authTransactionNow(transaction, this.mariaDb);
            await closeApprovedGuardianConsentAttempt(
              transaction,
              command.guardian_consent!,
              transactionNow,
            );
          });
        }
        throw new EmailAlreadyRegisteredException();
      }
      throw error;
    }

    if (closedDuplicateGuardianAttempt) throw new EmailAlreadyRegisteredException();

    {
      let status: "failed" | "sent" = "failed";
      try {
        if (this.signupMail !== undefined && signupMailAdmitted) {
          const result = await this.signupMail.issue(
            email,
            command.role,
            null,
            requestContext.requestId,
            true,
            clientIp,
            true,
          );
          status = result.email_delivery_status;
        }
      } catch {
        /* The account remains available for login and a resend. */
      }
      return { next_action: "LOGIN", signup_delivery_status: status };
    }
  }

  async resendSignupApproval(userId: string, requestId: string, clientIp?: string) {
    const limit = await this.rateLimiter.consume({ key: `signup-code-resend:account:${userId}` });
    if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds, limit);
    if (this.signupMail === undefined) throw new Error("Signup mail service is unavailable.");
    return this.signupMail.sendForAccount(userId, requestId, clientIp);
  }

  async requestGuardianConsent(
    guardianEmail: string,
    clientIp: string,
    submittedDocuments?: LegalConsentSnapshot,
  ): Promise<GuardianConsentRequestResult> {
    this.assertUnder14SignupOpen();
    const email = guardianEmail.trim().toLowerCase();
    await this.consumeGuardianConsentRequestLimits(email, clientIp);
    await admitAuthMail(this.rateLimiter, this.config, email, "guardian-consent", { clientIp });

    const requestId = randomUUID();
    const approvalToken = issueVerificationToken();
    const completionToken = issueVerificationToken();

    const insertRequest = (database: ClassHubDatabase, documentSnapshot?: LegalConsentSnapshot) =>
      database.insertInto("guardian_consent_requests").values({
        approval_token_hash: approvalToken.hash,
        approved_at: null,
        completion_token_hash: completionToken.hash,
        consumed_at: null,
        expires_at: this.mariaDb
          ? sql<Date>`DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 24 HOUR)`
          : sql<Date>`now() + interval '24 hours'`,
        guardian_email_normalized: email,
        id: requestId,
        invalidated_at: null,
        privacy_policy_version:
          documentSnapshot?.privacy_consent.policy_version ?? this.config.privacyPolicyVersion,
        terms_policy_version:
          documentSnapshot?.terms.policy_version ?? this.config.termsPolicyVersion,
        ...(documentSnapshot === undefined
          ? {}
          : { document_snapshot: JSON.stringify(documentSnapshot) }),
        user_id: null,
      });
    const request = this.bindingRequired
      ? await this.database.transaction().execute(async (transaction) => {
          const documentSnapshot = requireLegalConsentSnapshot(
            submittedDocuments,
            await currentLegalConsentSnapshot(transaction, this.mariaDb, new Date(), true),
          );
          const query = insertRequest(transaction, documentSnapshot);
          if (!this.mariaDb) return query.returning("expires_at").executeTakeFirstOrThrow();
          const inserted = await query.executeTakeFirstOrThrow();
          if (inserted.numInsertedOrUpdatedRows !== 1n) throw authPersistenceFailure();
          return transaction
            .selectFrom("guardian_consent_requests")
            .select("expires_at")
            .where("id", "=", requestId)
            .executeTakeFirstOrThrow();
        })
      : this.mariaDb
        ? await this.database.transaction().execute(async (transaction) => {
            const inserted = await insertRequest(transaction).executeTakeFirstOrThrow();
            if (inserted.numInsertedOrUpdatedRows !== 1n) throw authPersistenceFailure();
            return transaction
              .selectFrom("guardian_consent_requests")
              .select("expires_at")
              .where("id", "=", requestId)
              .where("approval_token_hash", "=", approvalToken.hash)
              .where("completion_token_hash", "=", completionToken.hash)
              .executeTakeFirstOrThrow();
          })
        : await insertRequest(this.database).returning("expires_at").executeTakeFirstOrThrow();

    let consentDeliveryStatus: "failed" | "sent" = "sent";
    try {
      await this.mailer.sendGuardianConsentEmail(email, approvalToken.raw);
    } catch {
      consentDeliveryStatus = "failed";
    }

    return {
      completion_token: completionToken.raw,
      consent_delivery_status: consentDeliveryStatus,
      expires_at: request.expires_at.toISOString(),
      request_id: requestId,
    };
  }

  async confirmGuardianConsent(
    rawToken: string,
    submittedDocuments?: LegalConsentSnapshot,
  ): Promise<GuardianConsentConfirmResult> {
    const tokenHash = hashVerificationToken(rawToken);
    const now = new Date();

    await this.database.transaction().execute(async (transaction) => {
      const transactionNow = await authTransactionNow(transaction, this.mariaDb);
      const documentSnapshot = this.bindingRequired
        ? requireLegalConsentSnapshot(
            submittedDocuments,
            await currentLegalConsentSnapshot(transaction, this.mariaDb, now, true),
          )
        : undefined;
      const request = await transaction
        .selectFrom("guardian_consent_requests")
        .select([
          "approved_at",
          "consumed_at",
          "expires_at",
          "id",
          "invalidated_at",
          "privacy_policy_version",
          "terms_policy_version",
        ])
        .select(this.bindingRequired ? ["document_snapshot"] : [])
        .where("approval_token_hash", "=", tokenHash)
        .forUpdate()
        .executeTakeFirst();

      if (
        request === undefined ||
        request.approved_at !== null ||
        request.consumed_at !== null ||
        request.invalidated_at !== null ||
        request.expires_at.getTime() <= now.getTime() ||
        (documentSnapshot === undefined
          ? request.terms_policy_version !== this.config.termsPolicyVersion ||
            request.privacy_policy_version !== this.config.privacyPolicyVersion
          : !sameLegalConsentSnapshot(request.document_snapshot, documentSnapshot))
      ) {
        throw new TokenInvalidOrExpiredException();
      }

      const approvalQuery = transaction
        .updateTable("guardian_consent_requests")
        .set({ approval_token_hash: null, approved_at: transactionNow })
        .where("id", "=", request.id)
        .where("approval_token_hash", "=", tokenHash)
        .where("approved_at", "is", null)
        .where("consumed_at", "is", null)
        .where("invalidated_at", "is", null)
        .where("expires_at", ">", transactionNow);
      const approved = this.mariaDb
        ? authUpdateSucceeded(await approvalQuery.executeTakeFirstOrThrow())
        : (await approvalQuery.returning("id").executeTakeFirst()) !== undefined;

      if (!approved) {
        throw new TokenInvalidOrExpiredException();
      }
    });

    return { guardian_consent: true };
  }

  async getGuardianConsentStatus(
    reference: GuardianConsentReference,
  ): Promise<GuardianConsentStatusResult> {
    const completionTokenHash = hashVerificationToken(reference.completion_token);
    const documentSnapshot = this.bindingRequired
      ? await currentLegalConsentSnapshot(this.database, this.mariaDb, new Date())
      : undefined;
    const request = await this.database
      .selectFrom("guardian_consent_requests")
      .select([
        "approved_at",
        "consumed_at",
        "expires_at",
        "invalidated_at",
        "privacy_policy_version",
        "terms_policy_version",
      ])
      .select(this.bindingRequired ? ["document_snapshot"] : [])
      .where("id", "=", reference.request_id)
      .where("completion_token_hash", "=", completionTokenHash)
      .executeTakeFirst();

    if (request === undefined) {
      throw new TokenInvalidOrExpiredException();
    }

    if (
      request.consumed_at !== null ||
      request.invalidated_at !== null ||
      request.expires_at.getTime() <= Date.now() ||
      (documentSnapshot === undefined
        ? request.terms_policy_version !== this.config.termsPolicyVersion ||
          request.privacy_policy_version !== this.config.privacyPolicyVersion
        : !sameLegalConsentSnapshot(request.document_snapshot, documentSnapshot))
    ) {
      return { status: "expired" };
    }

    return { status: request.approved_at === null ? "pending" : "approved" };
  }

  async confirmEmail(rawToken: string): Promise<ConfirmEmailResult> {
    const tokenHash = hashVerificationToken(rawToken);
    const tokenIdentity = await this.database
      .selectFrom("email_verification_tokens")
      .select(["id", "user_id"])
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();

    if (tokenIdentity === undefined) {
      throw new TokenInvalidOrExpiredException();
    }

    await this.database.transaction().execute(async (transaction) => {
      const transactionNow = await authTransactionNow(transaction, this.mariaDb);
      const user = await transaction
        .selectFrom("users")
        .select(["deleted_at", "email_verified_at", "is_active"])
        .where("id", "=", tokenIdentity.user_id)
        .forUpdate()
        .executeTakeFirst();

      if (
        user === undefined ||
        !user.is_active ||
        user.deleted_at !== null ||
        user.email_verified_at !== null
      ) {
        throw new TokenInvalidOrExpiredException();
      }

      const token = await transaction
        .selectFrom("email_verification_tokens")
        .select(["expires_at", "invalidated_at", "used_at"])
        .where("id", "=", tokenIdentity.id)
        .forUpdate()
        .executeTakeFirst();

      if (
        token === undefined ||
        token.used_at !== null ||
        token.invalidated_at !== null ||
        token.expires_at.getTime() <= Date.now()
      ) {
        throw new TokenInvalidOrExpiredException();
      }

      const useQuery = transaction
        .updateTable("email_verification_tokens")
        .set({ used_at: transactionNow })
        .where("id", "=", tokenIdentity.id)
        .where("used_at", "is", null)
        .where("invalidated_at", "is", null)
        .where("expires_at", ">", transactionNow);
      const used = this.mariaDb
        ? authUpdateSucceeded(await useQuery.executeTakeFirstOrThrow())
        : (await useQuery.returning("id").executeTakeFirst()) !== undefined;

      if (!used) {
        throw new TokenInvalidOrExpiredException();
      }

      await transaction
        .updateTable("users")
        .set({ email_verified_at: transactionNow, updated_at: transactionNow })
        .where("id", "=", tokenIdentity.user_id)
        .executeTakeFirstOrThrow();
    });

    return { email_verified: true, next_action: "LOGIN" };
  }

  async resendVerification(
    userId: string,
    clientIp: string,
    requestContext: AuthRequestContext = {
      requestId: randomUUID(),
      userAgent: undefined,
    },
  ): Promise<ResendEmailResult> {
    await this.consumeResendLimits(userId, clientIp);
    const verificationToken = issueVerificationToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DAY_MS);

    const email = await this.database.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom("users")
        .select([
          "deleted_at",
          "email_normalized",
          "email_verified_at",
          "signup_approved_at",
          "is_active",
        ])
        .where("id", "=", userId)
        .forUpdate()
        .executeTakeFirst();

      if (user === undefined || !user.is_active || user.deleted_at !== null) {
        throw new AccountUnavailableException();
      }

      if (user.email_verified_at !== null) {
        throw new EmailAlreadyVerifiedException();
      }

      // A newly registered account must redeem its administrator approval first.
      // Email verification alone must not activate the pending account.
      if (user.signup_approved_at === null) throw new SignupApprovalInvalidException();

      await admitAuthMail(
        this.rateLimiter,
        this.config,
        user.email_normalized,
        "email-verification",
        {
          clientIp,
          actor: { kind: "user", id: userId },
        },
      );

      await transaction
        .selectFrom("email_verification_tokens")
        .select("id")
        .where("user_id", "=", userId)
        .where("used_at", "is", null)
        .where("invalidated_at", "is", null)
        .forUpdate()
        .execute();

      await transaction
        .updateTable("email_verification_tokens")
        .set({ invalidated_at: authDateValue(now, this.mariaDb) })
        .where("user_id", "=", userId)
        .where("used_at", "is", null)
        .where("invalidated_at", "is", null)
        .execute();

      await transaction
        .insertInto("email_verification_tokens")
        .values({
          expires_at: authDateValue(expiresAt, this.mariaDb),
          token_hash: verificationToken.hash,
          user_id: userId,
        })
        .execute();

      return user.email_normalized;
    });

    try {
      await this.mailer.sendVerificationEmail(email, verificationToken.raw);
    } catch {
      await this.publishEmailDeliveryFailure({
        clientIp,
        email,
        path: "/api/v1/auth/email-verifications/resend",
        requestContext,
        userId,
      });
      return { verification_delivery_status: "failed" };
    }

    return { verification_delivery_status: "sent" };
  }

  private async consumeSignUpLimits(email: string, clientIp: string): Promise<void> {
    const [ipLimit, emailLimit] = await Promise.all([
      this.rateLimiter.consume({
        key: `signup:ip:${this.privateSubject("signup_ip", clientIp)}`,
      }),
      this.rateLimiter.consume({
        key: `signup:email:${this.privateSubject("signup_email", email)}`,
      }),
    ]);

    if (!ipLimit.allowed || !emailLimit.allowed) {
      throw new RateLimitedException(
        blockedRetryAfterSeconds(ipLimit, emailLimit),
        !emailLimit.allowed ? emailLimit : ipLimit,
      );
    }
  }

  private async consumeGuardianConsentRequestLimits(
    email: string,
    clientIp: string,
  ): Promise<void> {
    const [ipLimit, emailLimit] = await Promise.all([
      this.rateLimiter.consume({
        key: `guardian-consent-request:ip:${this.privateSubject(
          "guardian_consent_request_ip",
          clientIp,
        )}`,
      }),
      this.rateLimiter.consume({
        key: `guardian-consent-request:email:${this.privateSubject(
          "guardian_consent_request_email",
          email,
        )}`,
      }),
    ]);

    if (!ipLimit.allowed || !emailLimit.allowed) {
      throw new RateLimitedException(
        blockedRetryAfterSeconds(ipLimit, emailLimit),
        !emailLimit.allowed ? emailLimit : ipLimit,
      );
    }
  }

  private async consumeResendLimits(userId: string, clientIp: string): Promise<void> {
    const [accountLimit, ipLimit] = await Promise.all([
      this.rateLimiter.consume({
        key: `email-verification-resend:account:${userId}`,
      }),
      this.rateLimiter.consume({
        key: `email-verification-resend:ip:${this.privateSubject("resend_ip", clientIp)}`,
      }),
    ]);

    if (!accountLimit.allowed || !ipLimit.allowed) {
      throw new RateLimitedException(
        blockedRetryAfterSeconds(accountLimit, ipLimit),
        !accountLimit.allowed ? accountLimit : ipLimit,
      );
    }
  }

  private privateSubject(namespace: string, value: string): string {
    return createPrivacySafeSubject(
      this.config.emailHmacKey,
      this.config.emailHmacKeyVersion,
      namespace,
      value,
    );
  }

  private async publishEmailDeliveryFailure(input: {
    clientIp: string;
    email: string;
    path: string;
    requestContext: AuthRequestContext;
    userId: string;
  }): Promise<void> {
    const event: SecurityAuditEvent = {
      version: 1,
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      actor_user_id: input.userId,
      actor_email_hmac: createPrivacySafeDigest(
        this.config.emailHmacKey,
        "security_audit_email",
        input.email,
      ),
      hmac_key_version: this.config.emailHmacKeyVersion,
      actor_ip: input.clientIp,
      actor_class_id: null,
      target_class_id: null,
      action: "email.delivery_failed",
      resource: "email_verification",
      sanitized_path: input.path,
      method: "POST",
      deny_reason: null,
      failure_code: "smtp_delivery_failed",
      request_id: input.requestContext.requestId,
      user_agent: sanitizeSecurityAuditUserAgent(input.requestContext.userAgent),
    };
    await publishSecurityAuditBestEffort(this.securityAuditPublisher, event);
  }
}
