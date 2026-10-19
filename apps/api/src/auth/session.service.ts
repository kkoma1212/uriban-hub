import { timingSafeEqual } from "node:crypto";

import type { DB } from "@classhub/db";
import { Inject, Injectable, Optional, type OnModuleInit } from "@nestjs/common";
import { sql, type Transaction } from "kysely";

import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RateLimitResult, RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { hasApprovedAccountAccess } from "./account-access-policy.js";
import {
  CsrfInvalidException,
  EmailNotVerifiedException,
  InvalidCredentialsException,
  SessionServiceUnavailableException,
  UnauthenticatedException,
} from "./auth.errors.js";
import { hashPassword, passwordNeedsRehash, verifyPassword } from "./password-hasher.js";
import {
  clearAccountWait,
  LoginAdmission,
  recordAccountFailure,
  type LoginFailureBudgets,
} from "./login-admission.js";
import { passwordForVerification } from "./password-input-policy.js";
import { logoutMariaDbSession } from "./mariadb/session-logout.js";
import { MARIA_DB_SESSION_OPTIONS, type MariaDbSessionOptions } from "./mariadb/session-options.js";
import { createMariaDbSessionRowCodec } from "./mariadb/session-row-codec.js";
import {
  hashSessionSecret,
  isSessionSecret,
  issueCsrfToken,
  issueSessionSecrets,
} from "./session-crypto.js";
import { AUTH_CONFIG, AUTH_RATE_LIMITER } from "./auth.tokens.js";
import type {
  AuthenticatedSession,
  AuthenticationOptions,
  AuthConfig,
  LoginCommand,
  LoginSession,
  RefreshedCsrf,
  SecurityAuditSessionIdentity,
} from "./auth.types.js";

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SIGNED_INT8 = 9_223_372_036_854_775_807n;
const MAX_ACTIVE_SESSIONS = 5;
const MAX_LOGIN_PREVERIFICATION_ATTEMPTS = 2;
const DUMMY_PASSWORD = "classhub-server-dummy-password-1";

type LoginTransactionResult =
  | { kind: "invalid" }
  | { kind: "rate_limited"; retryAfterSeconds: number; limit: RateLimitResult }
  | { kind: "success"; session: LoginSession };

type LoginPreverification =
  | { kind: "invalid" }
  | {
      kind: "verified";
      passwordHash: string;
      passwordInputVersion: string;
      replacementHash: string | undefined;
      userId: string;
    };

type LoginCommitResult = LoginTransactionResult | { kind: "retry" };

type TemporaryPasswordState =
  | {
      temporary_password_expires_at: Date | null;
      temporary_password_must_change: boolean | null;
    }
  | undefined;

type CsrfRefreshSessionState =
  | { kind: "invalid" }
  | { kind: "temporary_password_expired" }
  | { expiresAt: Date; kind: "eligible"; sessionId: string };

type CsrfRefreshTransactionResult =
  | Exclude<CsrfRefreshSessionState, { kind: "eligible" }>
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "refreshed"; refreshed: RefreshedCsrf };

export function resolveCurrentClassId(
  memberships: ReadonlyArray<{ class_id: string }>,
): string | null {
  if (memberships.length !== 1) return null;
  const classId = memberships[0]?.class_id;
  if (typeof classId !== "string" || !/^[1-9][0-9]{0,18}$/u.test(classId)) return null;
  try {
    return BigInt(classId) <= MAX_SIGNED_INT8 ? classId : null;
  } catch {
    return null;
  }
}

function currentClassIdSelection() {
  return sql<string | null>`(
    SELECT CASE WHEN COUNT(*) = 1 THEN MIN(current_membership.class_id) ELSE NULL END
    FROM class_members AS current_membership
    WHERE current_membership.user_id = users.id
      AND current_membership.status IN ('pending', 'approved')
  )`.as("current_class_id");
}

function logoutCurrentClassIdSelection() {
  return sql<string | null>`(
    SELECT CASE WHEN COUNT(*) = 1 THEN MIN(current_membership.class_id) ELSE NULL END
    FROM class_members AS current_membership
    WHERE current_membership.user_id = sessions.user_id
      AND current_membership.status IN ('pending', 'approved')
  )`.as("current_class_id");
}

export function notifySecurityAuditIdentity(
  observer: AuthenticationOptions["onSecurityAuditIdentity"],
  identity: SecurityAuditSessionIdentity,
): void {
  if (observer === undefined) return;
  try {
    observer(identity);
  } catch {
    // Security-audit context enrichment must not change the authentication decision.
  }
}

function isTemporaryPasswordExpired(profile: TemporaryPasswordState, now: Date): boolean {
  return (
    profile?.temporary_password_must_change === true &&
    profile.temporary_password_expires_at !== null &&
    profile.temporary_password_expires_at.getTime() <= now.getTime()
  );
}

@Injectable()
export class SessionService implements OnModuleInit {
  private dummyPasswordHash: Promise<string> | undefined;
  private readonly database: ClassHubDatabase;
  private readonly mariaDb: boolean;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Optional() @Inject(MARIA_DB_SESSION_OPTIONS) options?: MariaDbSessionOptions,
  ) {
    if (options !== undefined && options.dialect !== "mariadb") {
      throw new SessionServiceUnavailableException();
    }
    this.mariaDb = options?.dialect === "mariadb";
    this.database = this.mariaDb ? database.withPlugin(createMariaDbSessionRowCodec()) : database;
  }

  async onModuleInit(): Promise<void> {
    await this.getDummyPasswordHash();
  }

  async login(command: LoginCommand, clientIp: string, userAgent?: string): Promise<LoginSession> {
    const email = command.email.trim().toLowerCase();
    const admission = new LoginAdmission(this.rateLimiter, this.config);
    const failureBudgets = await admission.enter(email, clientIp);
    const dummyHash = await this.getDummyPasswordHash();

    for (let attempt = 0; attempt < MAX_LOGIN_PREVERIFICATION_ATTEMPTS; attempt += 1) {
      const preverification = await this.preverifyLogin(email, command.password, dummyHash);
      if (preverification.kind === "invalid") {
        return this.unwrapLoginResult(await this.failedLoginResult(failureBudgets));
      }
      const result = await this.database
        .transaction()
        .execute((transaction) =>
          this.commitLoginAttempt(transaction, preverification, email, clientIp, userAgent),
        );

      if (result.kind === "retry") continue;
      if (result.kind === "invalid") {
        return this.unwrapLoginResult(await this.failedLoginResult(failureBudgets));
      }
      if (result.kind === "success") await this.forgetAccountFailures(admission, email);
      return this.unwrapLoginResult(result);
    }

    return this.unwrapLoginResult(await this.failedLoginResult(failureBudgets));
  }

  private async preverifyLogin(
    email: string,
    password: string,
    dummyHash: string,
  ): Promise<LoginPreverification> {
    const user = await this.database
      .selectFrom("users")
      .select(["deleted_at", "id", "is_active", "password_hash", "password_input_version"])
      .where("email_normalized", "=", email)
      .executeTakeFirst();

    if (user === undefined || !user.is_active || user.deleted_at !== null) {
      await verifyPassword(password, dummyHash);
      return { kind: "invalid" };
    }

    const verificationPassword = passwordForVerification(password, user.password_input_version);
    const passwordMatches = await verifyPassword(
      verificationPassword ?? password,
      user.password_hash,
    );
    if (verificationPassword === null || !passwordMatches) return { kind: "invalid" };
    return {
      kind: "verified",
      passwordHash: user.password_hash,
      passwordInputVersion: user.password_input_version,
      replacementHash: passwordNeedsRehash(user.password_hash)
        ? await hashPassword(verificationPassword)
        : undefined,
      userId: user.id,
    };
  }

  private async commitLoginAttempt(
    transaction: Transaction<DB>,
    preverification: Extract<LoginPreverification, { kind: "verified" }>,
    email: string,
    clientIp: string,
    userAgent: string | undefined,
  ): Promise<LoginCommitResult> {
    const now = new Date();
    const user = await transaction
      .selectFrom("users")
      .select(["deleted_at", "id", "is_active", "password_hash", "password_input_version"])
      .where("email_normalized", "=", email)
      .forUpdate()
      .executeTakeFirst();
    const eligible = user !== undefined && user.is_active && user.deleted_at === null;

    if (!eligible || user.id !== preverification.userId) return { kind: "retry" };
    if (user.password_hash !== preverification.passwordHash) return { kind: "retry" };
    if (user.password_input_version !== preverification.passwordInputVersion) {
      return { kind: "retry" };
    }

    const teacherProfile = await transaction
      .selectFrom("teacher_profiles")
      .select(["temporary_password_expires_at", "temporary_password_must_change"])
      .where("user_id", "=", user.id)
      .executeTakeFirst();
    const temporaryPasswordExpired = isTemporaryPasswordExpired(teacherProfile, now);

    if (temporaryPasswordExpired) return { kind: "invalid" };

    const activeSessions = await transaction
      .selectFrom("sessions")
      .select("id")
      .where("user_id", "=", user.id)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", now)
      .orderBy("issued_at", "asc")
      .orderBy("id", "asc")
      .forUpdate()
      .execute();
    const revokeCount = Math.max(0, activeSessions.length - MAX_ACTIVE_SESSIONS + 1);

    if (revokeCount > 0) {
      await transaction
        .updateTable("sessions")
        .set({ revoked_at: now })
        .where(
          "id",
          "in",
          activeSessions.slice(0, revokeCount).map((session) => session.id),
        )
        .execute();
    }

    const secrets = issueSessionSecrets();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    await transaction
      .insertInto("sessions")
      .values({
        created_ip: clientIp,
        csrf_token_hash: secrets.csrfTokenHash,
        expires_at: expiresAt,
        issued_at: now,
        session_hash: secrets.sessionTokenHash,
        user_agent: userAgent?.slice(0, 512) ?? null,
        user_id: user.id,
      })
      .execute();
    await transaction
      .updateTable("users")
      .set({
        failed_login_attempts: 0,
        locked_until: null,
        updated_at: now,
        ...(preverification.replacementHash === undefined
          ? {}
          : { password_hash: preverification.replacementHash }),
      })
      .where("id", "=", user.id)
      .execute();

    return {
      kind: "success",
      session: {
        csrfToken: secrets.csrfToken,
        expiresAt,
        next_action: "BOOTSTRAP",
        sessionToken: secrets.sessionToken,
      },
    };
  }

  private async getDummyPasswordHash(): Promise<string> {
    const currentHash = (this.dummyPasswordHash ??= hashPassword(DUMMY_PASSWORD));

    try {
      return await currentHash;
    } catch (error) {
      if (this.dummyPasswordHash === currentHash) {
        this.dummyPasswordHash = undefined;
      }
      throw error;
    }
  }

  async authenticate(
    rawSessionToken: string | undefined,
    options: AuthenticationOptions = {},
  ): Promise<AuthenticatedSession> {
    return this.resolveAuthenticatedSession(rawSessionToken, options);
  }

  async authenticateWithCsrf(
    rawSessionToken: string | undefined,
    rawCsrfCookie: string | undefined,
    rawCsrfHeader: string | undefined,
    options: AuthenticationOptions = {},
  ): Promise<AuthenticatedSession> {
    const csrfCandidates =
      isSessionSecret(rawCsrfCookie) && isSessionSecret(rawCsrfHeader)
        ? {
            cookieHash: hashSessionSecret(rawCsrfCookie),
            headerHash: hashSessionSecret(rawCsrfHeader),
          }
        : null;
    return this.resolveAuthenticatedSession(rawSessionToken, options, csrfCandidates);
  }

  async resolveSecurityAuditIdentity(
    rawSessionToken: string | undefined,
  ): Promise<SecurityAuditSessionIdentity | null> {
    if (!isSessionSecret(rawSessionToken)) return null;

    try {
      const session = await this.database
        .selectFrom("sessions")
        .innerJoin("users", "users.id", "sessions.user_id")
        .leftJoin("teacher_profiles", "teacher_profiles.user_id", "users.id")
        .select([currentClassIdSelection(), "sessions.user_id"])
        .where("sessions.session_hash", "=", hashSessionSecret(rawSessionToken))
        .where("sessions.revoked_at", "is", null)
        .where("sessions.expires_at", ">", this.databaseNow())
        .where("users.is_active", "=", true)
        .where("users.deleted_at", "is", null)
        .where(
          sql<boolean>`NOT (
          COALESCE(teacher_profiles.temporary_password_must_change, FALSE)
          AND teacher_profiles.temporary_password_expires_at IS NOT NULL
          AND teacher_profiles.temporary_password_expires_at <= ${this.databaseNow()}
        )`,
        )
        .executeTakeFirst();

      if (session === undefined) return null;
      return {
        currentClassId: resolveCurrentClassId(
          session.current_class_id === null ? [] : [{ class_id: session.current_class_id }],
        ),
        userId: session.user_id,
      };
    } catch {
      return null;
    }
  }

  private async resolveAuthenticatedSession(
    rawSessionToken: string | undefined,
    options: AuthenticationOptions,
    csrfCandidates?: null | { cookieHash: Buffer; headerHash: Buffer },
  ): Promise<AuthenticatedSession> {
    if (!isSessionSecret(rawSessionToken)) throw new UnauthenticatedException();

    const sessionHash = hashSessionSecret(rawSessionToken);
    /*
     * 요청마다 부르는 경로라 잠금 없는 조회 한 번으로 세션과 계정을 함께 읽는다. 예전에는 거래 안에서
     * 세션 줄을 FOR UPDATE로 잠갔는데, 한 화면의 동시 요청 3~4개가 같은 줄을 기다리며 DB 연결(기본 10개)을
     * 붙잡아 반 전체가 동시에 열 때 SESSION_SERVICE_UNAVAILABLE이 났다(100명 동시 26건 실측, 2026-09-28).
     * 잠금이 필요했던 것은 임시 비밀번호 만료 시 세션 끊기뿐이고, 그 갱신은 revoked_at IS NULL 조건이라
     * 여러 번 실행돼도 결과가 같으므로 따로 실행한다. 판정 규칙은 예전과 같다.
     */
    const result = await (async () => {
      const now = new Date();
      const row = await this.database
        .selectFrom("sessions")
        .innerJoin("users", "users.id", "sessions.user_id")
        .leftJoin("teacher_profiles", "teacher_profiles.user_id", "users.id")
        .select([
          "sessions.csrf_token_hash",
          "sessions.expires_at",
          "sessions.id",
          "sessions.revoked_at",
          "sessions.user_id",
          currentClassIdSelection(),
          "teacher_profiles.temporary_password_expires_at",
          "teacher_profiles.temporary_password_must_change",
          "users.deleted_at",
          "users.email_verified_at",
          "users.is_active",
          "users.signup_approved_at",
          "users.signup_role",
        ])
        .where("sessions.session_hash", "=", sessionHash)
        .executeTakeFirst();

      if (
        row === undefined ||
        row.revoked_at !== null ||
        row.expires_at.getTime() <= now.getTime() ||
        !row.is_active ||
        row.deleted_at !== null
      ) {
        return { kind: "invalid" as const };
      }
      const session = row;
      const account = row;

      const temporaryPasswordExpired = isTemporaryPasswordExpired(account, now);

      if (temporaryPasswordExpired) {
        await this.database
          .updateTable("sessions")
          .set({ revoked_at: now })
          .where("id", "=", session.id)
          .where("revoked_at", "is", null)
          .execute();
        return { kind: "temporary_password_expired" as const };
      }

      const authenticatedSession: AuthenticatedSession = {
        currentClassId: resolveCurrentClassId(
          account.current_class_id === null ? [] : [{ class_id: account.current_class_id }],
        ),
        expiresAt: session.expires_at,
        sessionId: session.id,
        userId: session.user_id,
      };

      if (
        csrfCandidates !== undefined &&
        (csrfCandidates === null ||
          !timingSafeEqual(session.csrf_token_hash, csrfCandidates.cookieHash) ||
          !timingSafeEqual(session.csrf_token_hash, csrfCandidates.headerHash))
      ) {
        return { kind: "csrf_invalid" as const, session: authenticatedSession };
      }

      if (!options.allowUnverifiedEmail && !hasApprovedAccountAccess(account)) {
        return { kind: "email_not_verified" as const, session: authenticatedSession };
      }

      return {
        kind: "authenticated" as const,
        session: authenticatedSession,
      };
    })().catch(() => {
      throw new SessionServiceUnavailableException();
    });

    const authenticatedSession = "session" in result ? result.session : null;
    if (authenticatedSession !== null) {
      notifySecurityAuditIdentity(options.onSecurityAuditIdentity, authenticatedSession);
    }

    if (result.kind === "csrf_invalid") throw new CsrfInvalidException();
    if (result.kind === "email_not_verified") throw new EmailNotVerifiedException();
    if (result.kind !== "authenticated" || authenticatedSession === null) {
      throw new UnauthenticatedException();
    }
    return authenticatedSession;
  }

  async logout(rawSessionToken: string | undefined): Promise<SecurityAuditSessionIdentity | null> {
    if (!isSessionSecret(rawSessionToken)) return null;

    const sessionHash = hashSessionSecret(rawSessionToken);
    if (this.mariaDb) return logoutMariaDbSession(this.database, sessionHash);
    try {
      const revoked = await this.database
        .updateTable("sessions")
        .set({ revoked_at: sql`COALESCE(revoked_at, now())` })
        .where("session_hash", "=", sessionHash)
        .where("revoked_at", "is", null)
        .returning([
          "user_id",
          logoutCurrentClassIdSelection(),
          sql<boolean>`expires_at > CURRENT_TIMESTAMP`.as("was_active"),
        ])
        .executeTakeFirst();
      if (revoked === undefined || !revoked.was_active) return null;
      return {
        currentClassId: resolveCurrentClassId(
          revoked.current_class_id === null ? [] : [{ class_id: revoked.current_class_id }],
        ),
        userId: revoked.user_id,
      };
    } catch {
      const revoked = await this.database
        .updateTable("sessions")
        .set({ revoked_at: sql`COALESCE(revoked_at, now())` })
        .where("session_hash", "=", sessionHash)
        .where("revoked_at", "is", null)
        .returning(["user_id", sql<boolean>`expires_at > CURRENT_TIMESTAMP`.as("was_active")])
        .executeTakeFirst();
      return revoked === undefined || !revoked.was_active
        ? null
        : { currentClassId: null, userId: revoked.user_id };
    }
  }

  async refreshCsrf(rawSessionToken: string | undefined): Promise<RefreshedCsrf> {
    if (!isSessionSecret(rawSessionToken)) throw new UnauthenticatedException();

    const sessionHash = hashSessionSecret(rawSessionToken);
    const preflight = await this.database
      .transaction()
      .execute((transaction) => this.lockCsrfRefreshSession(transaction, sessionHash, new Date()));
    if (preflight.kind !== "eligible") throw new UnauthenticatedException();

    const limit = await this.rateLimiter.consume({
      key: `csrf-refresh:session:${sessionHash.toString("base64url")}`,
    });

    const result: CsrfRefreshTransactionResult = await this.database
      .transaction()
      .execute(async (transaction) => {
        const session = await this.lockCsrfRefreshSession(transaction, sessionHash, new Date());
        if (session.kind !== "eligible") return session;
        if (!limit.allowed) {
          return { kind: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds };
        }

        const csrf = issueCsrfToken();
        await transaction
          .updateTable("sessions")
          .set({ csrf_token_hash: csrf.hash })
          .where("id", "=", session.sessionId)
          .execute();

        return {
          kind: "refreshed",
          refreshed: { csrfToken: csrf.raw, expiresAt: session.expiresAt },
        };
      });

    if (result.kind === "rate_limited") {
      throw new RateLimitedException(result.retryAfterSeconds, limit);
    }
    if (result.kind !== "refreshed") throw new UnauthenticatedException();
    return result.refreshed;
  }

  private async lockCsrfRefreshSession(
    transaction: Transaction<DB>,
    sessionHash: Buffer,
    now: Date,
  ): Promise<CsrfRefreshSessionState> {
    const session = await transaction
      .selectFrom("sessions")
      .select(["expires_at", "id", "revoked_at", "user_id"])
      .where("session_hash", "=", sessionHash)
      .forUpdate()
      .executeTakeFirst();

    if (
      session === undefined ||
      session.revoked_at !== null ||
      session.expires_at.getTime() <= now.getTime()
    ) {
      return { kind: "invalid" };
    }

    const account = await transaction
      .selectFrom("users")
      .leftJoin("teacher_profiles", "teacher_profiles.user_id", "users.id")
      .select([
        "teacher_profiles.temporary_password_expires_at",
        "teacher_profiles.temporary_password_must_change",
        "users.deleted_at",
        "users.is_active",
      ])
      .where("users.id", "=", session.user_id)
      .executeTakeFirst();
    if (account === undefined || !account.is_active || account.deleted_at !== null) {
      return { kind: "invalid" };
    }

    if (isTemporaryPasswordExpired(account, now)) {
      await transaction
        .updateTable("sessions")
        .set({ revoked_at: now })
        .where("id", "=", session.id)
        .where("revoked_at", "is", null)
        .execute();
      return { kind: "temporary_password_expired" };
    }

    return { expiresAt: session.expires_at, kind: "eligible", sessionId: session.id };
  }

  private async failedLoginResult(budgets: LoginFailureBudgets): Promise<LoginTransactionResult> {
    const limit = await this.rateLimiter.consume(budgets.pair);
    await this.rateLimiter.consume(budgets.network);
    // 1시간에 30번째 실패면 이 계정은 15분 동안 로그인을 받지 않는다(login-admission.ts 설명 참고).
    const lock = await recordAccountFailure(this.rateLimiter, budgets);
    if (lock !== undefined)
      return { kind: "rate_limited", retryAfterSeconds: lock.retryAfterSeconds, limit: lock };

    return limit.allowed && limit.remaining > 0
      ? { kind: "invalid" }
      : { kind: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds, limit };
  }

  /** 주인이 바른 비밀번호로 들어오면 계정 기준 대기를 비운다. 지우기 실패가 로그인을 막지는 않는다. */
  private async forgetAccountFailures(admission: LoginAdmission, email: string): Promise<void> {
    const { accountSlow, accountSpacing, accountLockAfter } = admission.accountBudgets(email);
    await clearAccountWait(this.rateLimiter, { accountSlow, accountSpacing, accountLockAfter });
  }

  private unwrapLoginResult(result: LoginTransactionResult): LoginSession {
    if (result.kind === "success") return result.session;
    if (result.kind === "rate_limited")
      throw new RateLimitedException(result.retryAfterSeconds, result.limit);
    throw new InvalidCredentialsException();
  }

  private databaseNow() {
    return this.mariaDb ? sql<Date>`CURRENT_TIMESTAMP(6)` : sql<Date>`CURRENT_TIMESTAMP`;
  }
}
