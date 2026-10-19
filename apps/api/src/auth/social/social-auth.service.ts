import { randomUUID } from "node:crypto";
import type { DB } from "@classhub/db";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import { InvalidCurrentPasswordException } from "../../account/account.errors.js";
import {
  notifySecurityChange,
  SECURITY_CHANGE_MAILER,
  type SecurityChangeMailer,
} from "../../mail/security-change-mailer.js";
import { verifyPassword } from "../password-hasher.js";
import { passwordForVerification } from "../password-input-policy.js";

const LINK_RECENT_LOGIN_MS = 10 * 60 * 1000;
import { ConfigService } from "@nestjs/config";
import type { Kysely } from "kysely";
import { DATABASE, type ClassHubDatabase } from "../../database/database.module.js";
import { RateLimitedException } from "../../common/rate-limit/rate-limit.errors.js";
import type { RedisRateLimiter } from "../../common/rate-limit/redis-rate-limiter.js";
import { createPrivacySafeDigest } from "../auth-crypto.js";
import { AUTH_RATE_LIMITER } from "../auth.tokens.js";
import { AuthService } from "../auth.service.js";
import type {
  AuthRequestContext,
  AuthenticatedSession,
  LoginSession,
  SignUpCommand,
} from "../auth.types.js";
import { SessionService } from "../session.service.js";
import { hashSessionSecret, isSessionSecret, issueSessionSecrets } from "../session-crypto.js";
import { createMariaDbSessionRowCodec } from "../mariadb/session-row-codec.js";
import { authDateValue, authMariaDate } from "../mariadb/auth-persistence.js";
import { SOCIAL_ONLY_PASSWORD, socialDatabase } from "./social-auth.database.js";
import { SocialAuthFlows } from "./social-auth.flows.js";
import { SocialAuthProvider, socialDenied, type SocialIdentity } from "./social-auth.provider.js";
import type { SocialProvider } from "./social-auth.environment.js";
import { fetchProviderPicture } from "./social-profile-picture.js";
import { ProfilePhotoImageService } from "../../profile-photos/profile-photo-image.service.js";

@Injectable()
export class SocialAuthService {
  private readonly maria: boolean;
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AUTH_RATE_LIMITER) private readonly limiter: RedisRateLimiter,
    @Inject(SocialAuthProvider) readonly provider: SocialAuthProvider,
    @Inject(SocialAuthFlows) private readonly flows: SocialAuthFlows,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ProfilePhotoImageService) private readonly photos: ProfilePhotoImageService,
    @Optional()
    @Inject(SECURITY_CHANGE_MAILER)
    private readonly securityMailer?: SecurityChangeMailer,
  ) {
    this.maria = config.get("DATABASE_ENGINE") === "mariadb";
  }

  private throttleKey(clientIp: string) {
    const digest = createPrivacySafeDigest(
      this.config.getOrThrow<string>("EMAIL_HMAC_KEY"),
      "social-auth-ip",
      clientIp,
    );
    return `social-auth:${digest}`;
  }
  private async throttle(clientIp: string) {
    const result = await this.limiter.consume({ key: this.throttleKey(clientIp) });
    if (!result.allowed) throw new RateLimitedException(result.retryAfterSeconds, result);
  }
  /**
   * 2026-10-03 사용자 지적: 연결·로그인에 성공하면 시도 횟수에서 빼지 않는다.
   * 시작할 때 센 이 주소의 횟수를 성공 뒤 비운다(실패만 쌓이게). 비우기 실패가 성공을 막지는 않는다.
   */
  private async refundThrottle(clientIp: string) {
    const policy = await this.limiter.getPolicy();
    await this.limiter
      .clear({
        key: this.throttleKey(clientIp),
        limit: policy.max_attempts,
        windowSeconds: policy.cooldown_seconds,
      })
      .catch(() => undefined);
  }
  /*
   * 2026-10-02 사용자 결정(총검수 I1-03): 연결 전에 본인을 다시 확인한다. 비밀번호가 있는 계정은
   * 현재 비밀번호를, 소셜로만 가입한 계정은 10분 안에 로그인한 세션인지를 본다.
   * 비밀번호 오답은 계정 기준 15분 5회로 제한한다.
   */
  async confirmLinkIdentity(session: AuthenticatedSession, currentPassword: string | undefined) {
    const user = await this.database
      .selectFrom("users")
      .select(["password_hash", "password_input_version"])
      .where("id", "=", session.userId)
      .executeTakeFirst();
    const issued = await this.database
      .selectFrom("sessions")
      .select("issued_at")
      .where("id", "=", session.sessionId)
      .executeTakeFirst();
    if (!user || !issued) throw socialDenied();
    const hasPassword =
      user.password_hash !== SOCIAL_ONLY_PASSWORD && user.password_hash.startsWith("$argon2id$");
    if (!hasPassword) {
      const issuedAt = this.maria ? authMariaDate(issued.issued_at) : issued.issued_at;
      if (Date.now() - issuedAt.getTime() <= LINK_RECENT_LOGIN_MS) return;
      throw new ForbiddenException({
        code: "SOCIAL_RECENT_LOGIN_REQUIRED",
        message: "보안을 위해 다시 로그인한 뒤 10분 안에 연결해 주세요.",
      });
    }
    const failures = {
      key: `social-link-password:user:${createPrivacySafeDigest(
        this.config.getOrThrow<string>("EMAIL_HMAC_KEY"),
        "social-link-user",
        session.userId,
      )}`,
      limit: 5,
      windowSeconds: 900,
    };
    const blocked = await this.limiter.peek(failures);
    if (!blocked.allowed) throw new RateLimitedException(blocked.retryAfterSeconds, blocked);
    const candidate = passwordForVerification(currentPassword ?? "", user.password_input_version);
    if (candidate !== null && (await verifyPassword(candidate, user.password_hash))) {
      // 맞히면 앞서 틀린 횟수도 비운다(일반 로그인과 같은 원칙).
      await this.limiter.clear(failures).catch(() => undefined);
      return;
    }
    const limit = await this.limiter.consume(failures);
    if (!limit.allowed || limit.remaining === 0)
      throw new RateLimitedException(limit.retryAfterSeconds, limit);
    throw new InvalidCurrentPasswordException();
  }

  private async notify(userId: string, kind: "social_linked" | "social_unlinked") {
    const user = await this.database
      .selectFrom("users")
      .select(["email_normalized", "email_verified_at"])
      .where("id", "=", userId)
      .executeTakeFirst();
    // 비밀번호 재설정 알림과 같이, 주인이 확인한 메일 주소에만 보낸다.
    if (!user || user.email_verified_at === null) return;
    await notifySecurityChange(this.securityMailer, {
      email: user.email_normalized,
      kind,
      occurredAt: new Date(),
    });
  }

  async start(
    provider: SocialProvider,
    clientIp: string,
    link?: { session: AuthenticatedSession; rawSession: string },
    intent: "login" | "signup_over_14" = "login",
  ) {
    this.provider.require(provider);
    await this.throttle(clientIp);
    const { url, proof } = await this.provider.begin(provider);
    const browserSecret = await this.flows.create(provider, {
      stage: "oauth",
      proof,
      intent,
      ...(link
        ? {
            link: {
              userId: link.session.userId,
              sessionHash: hashSessionSecret(link.rawSession).toString("base64url"),
            },
          }
        : {}),
    });
    return { url, browserSecret };
  }
  async callback(
    provider: SocialProvider,
    parameters: URLSearchParams,
    browserSecret: string | undefined,
    rawSession: string | undefined,
    clientIp: string,
    userAgent?: string,
  ) {
    this.provider.require(provider);
    if (parameters.getAll("state").length !== 1 || parameters.getAll("code").length > 1)
      throw socialDenied();
    const flow = await this.flows.consumeOAuth(
      provider,
      parameters.get("state") ?? undefined,
      browserSecret,
    );
    const identity = await this.provider.complete(provider, parameters, flow.proof);
    if (flow.link) {
      if (
        !isSessionSecret(rawSession) ||
        flow.link.sessionHash !== hashSessionSecret(rawSession).toString("base64url")
      )
        throw socialDenied();
      const session = await this.sessions.authenticate(rawSession);
      if (session.userId !== flow.link.userId) throw socialDenied();
      await this.database.transaction().execute(async (transaction) => {
        await this.lockUser(transaction, session.userId);
        // Locking the user serializes link/unlink and the last-login-method check.
        await this.attach(transaction, identity, session.userId);
      });
      await this.notify(session.userId, "social_linked");
      await this.refundThrottle(clientIp);
      return { kind: "linked" as const };
    }
    const existing = await socialDatabase(this.database, this.maria)
      .selectFrom("social_identities")
      .select("user_id")
      .where("provider", "=", provider)
      .where("issuer", "=", identity.issuer)
      .where("subject", "=", identity.subject)
      .executeTakeFirst();
    if (existing) {
      const session = await this.database.transaction().execute(async (transaction) => {
        const issued = await this.issueSession(transaction, existing.user_id, clientIp, userAgent);
        const db = socialDatabase(transaction, this.maria);
        // Recheck after the account lock so a concurrent unlink cannot authorize a new login.
        const current = await db
          .selectFrom("social_identities")
          .select("identity_id")
          .where("user_id", "=", existing.user_id)
          .where("provider", "=", provider)
          .where("issuer", "=", identity.issuer)
          .where("subject", "=", identity.subject)
          .forUpdate()
          .executeTakeFirst();
        if (!current) throw socialDenied();
        await db
          .updateTable("social_identities")
          .set({ used_at: authDateValue(new Date(), this.maria) })
          .where("identity_id", "=", current.identity_id)
          .execute();
        return issued;
      });
      await this.refundThrottle(clientIp);
      return { kind: "session" as const, session };
    }
    // A returning-user login cannot collect a new child's signup profile before guardian consent.
    if (flow.intent !== "signup_over_14")
      throw new ForbiddenException({
        code: "SOCIAL_SIGNUP_REQUIRED",
        message: "먼저 가입 방법을 선택해 주세요.",
      });
    // Email claims never authorize linking, even when the provider verified that email.
    return {
      kind: "signup" as const,
      browserSecret: await this.flows.create(provider, { stage: "signup", identity }),
    };
  }
  async pendingSignup(secret: string | undefined) {
    const identity = await this.flows.signup(secret);
    return {
      provider: identity.provider,
      email: identity.email,
      email_verified: identity.emailVerified,
      // 가입 화면이 기본 이름을 미리 채우고, 사진이 있을 때만 '프로필 사진 쓰기'를 보여 준다.
      display_name: identity.name ?? null,
      has_picture: this.profilePhotosOn() && typeof identity.picture === "string",
    };
  }
  private profilePhotosOn(): boolean {
    return (
      this.config.get("PROFILE_PHOTOS_ENABLED") === true &&
      (!this.maria || this.config.get("PROFILE_PHOTOS_DATABASE_INSTALLED") === true)
    );
  }
  async discardSignup(secret: string | undefined) {
    await this.flows.discardSignup(secret);
    return { discarded: true };
  }
  async signUp(
    secret: string | undefined,
    {
      use_provider_picture: usePicture,
      ...command
    }: Omit<SignUpCommand, "password"> & {
      use_provider_picture?: boolean;
    },
    clientIp: string,
    context: AuthRequestContext,
  ) {
    if (command.age_route !== "over_14") throw socialDenied();
    const identity = await this.flows.signup(secret);
    // 본인이 고른 경우에만, 계정 만들기 전에 받아 256px로 바꿔 둔다. 실패하면 사진 없이 가입한다.
    let pictureBytes: Buffer | undefined;
    if (usePicture === true && this.profilePhotosOn() && typeof identity.picture === "string") {
      const source = await fetchProviderPicture(identity.provider, identity.picture);
      if (source !== null) pictureBytes = await this.photos.encode(source).catch(() => undefined);
    }
    let createdId: string | undefined;
    await this.auth.signUpWithSocialIdentity(command, clientIp, context, {
      emailVerified:
        identity.emailVerified && identity.email === command.email.trim().toLowerCase(),
      attach: async (transaction, userId) => {
        const proof = await this.flows.signup(secret, transaction);
        if (
          proof.provider !== identity.provider ||
          proof.issuer !== identity.issuer ||
          proof.subject !== identity.subject
        )
          throw socialDenied();
        await this.attach(transaction, proof, userId);
        if (pictureBytes !== undefined)
          await transaction
            .insertInto("user_profile_photos")
            .values({ user_id: userId, photo_version: randomUUID(), image_bytes: pictureBytes })
            .execute();
        createdId = userId;
      },
    });
    if (!createdId) throw socialDenied();
    const session = await this.database
      .transaction()
      .execute((transaction) =>
        this.issueSession(transaction, createdId!, clientIp, context.userAgent),
      );
    await this.refundThrottle(clientIp);
    return session;
  }
  private async attach(transaction: Kysely<DB>, identity: SocialIdentity, userId: string) {
    const db = socialDatabase(transaction, this.maria);
    const existing = await db
      .selectFrom("social_identities")
      .select(["user_id", "provider", "subject", "issuer"])
      .where((eb) =>
        eb.or([
          eb.and([
            eb("provider", "=", identity.provider),
            eb("issuer", "=", identity.issuer),
            eb("subject", "=", identity.subject),
          ]),
          eb.and([eb("user_id", "=", userId), eb("provider", "=", identity.provider)]),
        ]),
      )
      .forUpdate()
      .execute();
    if (
      existing.length === 1 &&
      existing[0]?.user_id === userId &&
      existing[0]?.subject === identity.subject &&
      existing[0]?.issuer === identity.issuer
    )
      return;
    // 2026-10-01 사용자 요청: 왜 연결이 안 되는지 구분해 알린다(어느 계정인지는 알리지 않는다).
    if (existing.some((row) => row.user_id !== userId))
      throw new ConflictException({
        code: "SOCIAL_LINKED_ELSEWHERE",
        message: "이 계정은 이미 다른 우리반 허브 계정에 연결돼 있어요.",
      });
    if (existing.length)
      throw new ConflictException({
        code: "SOCIAL_PROVIDER_ALREADY_LINKED",
        message: "이 우리반 허브 계정에는 이미 같은 회사의 다른 계정이 연결돼 있어요.",
      });
    await db
      .insertInto("social_identities")
      .values({
        identity_id: randomUUID(),
        provider: identity.provider,
        issuer: identity.issuer,
        subject: identity.subject,
        user_id: userId,
        created_at: authDateValue(new Date(), this.maria),
        used_at: null,
      })
      .execute();
  }
  private async lockUser(database: Kysely<DB>, userId: string) {
    const db = this.maria
      ? database.withoutPlugins().withPlugin(createMariaDbSessionRowCodec())
      : database;
    const user = await db
      .selectFrom("users")
      .select(["id", "is_active", "deleted_at", "password_hash"])
      .where("id", "=", userId)
      .forUpdate()
      .executeTakeFirst();
    if (!user || !user.is_active || user.deleted_at !== null) throw socialDenied();
    return user;
  }
  private async issueSession(
    transaction: Kysely<DB>,
    userId: string,
    clientIp: string,
    userAgent: string | undefined,
  ): Promise<LoginSession> {
    const user = await this.lockUser(transaction, userId);
    const db = this.maria
      ? transaction.withoutPlugins().withPlugin(createMariaDbSessionRowCodec())
      : transaction;
    const now = new Date();
    const profile = await db
      .selectFrom("teacher_profiles")
      .select(["temporary_password_expires_at", "temporary_password_must_change"])
      .where("user_id", "=", user.id)
      .executeTakeFirst();
    if (
      profile?.temporary_password_must_change === true &&
      profile.temporary_password_expires_at !== null &&
      profile.temporary_password_expires_at.getTime() <= now.getTime()
    )
      throw socialDenied();
    const active = await db
      .selectFrom("sessions")
      .select("id")
      .where("user_id", "=", user.id)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", authDateValue(now, this.maria))
      .orderBy("issued_at", "asc")
      .orderBy("id", "asc")
      .forUpdate()
      .execute();
    const revoke = active.slice(0, Math.max(0, active.length - 4));
    if (revoke.length)
      await db
        .updateTable("sessions")
        .set({ revoked_at: authDateValue(now, this.maria) })
        .where(
          "id",
          "in",
          revoke.map((row) => row.id),
        )
        .execute();
    const secrets = issueSessionSecrets(),
      expiresAt = new Date(now.getTime() + 7 * 86400000);
    await db
      .insertInto("sessions")
      .values({
        user_id: user.id,
        session_hash: secrets.sessionTokenHash,
        csrf_token_hash: secrets.csrfTokenHash,
        issued_at: authDateValue(now, this.maria),
        expires_at: authDateValue(expiresAt, this.maria),
        created_ip: clientIp,
        user_agent: userAgent?.slice(0, 512) ?? null,
      })
      .execute();
    return {
      sessionToken: secrets.sessionToken,
      csrfToken: secrets.csrfToken,
      expiresAt,
      next_action: "BOOTSTRAP",
    };
  }
  async connections(session: AuthenticatedSession) {
    if (!this.provider.enabled().length) return { enabled: false as const, connections: [] };
    const rows = await socialDatabase(this.database, this.maria)
      .selectFrom("social_identities")
      .select("provider")
      .where("user_id", "=", session.userId)
      .execute();
    const user = await this.database
      .selectFrom("users")
      .select("password_hash")
      .where("id", "=", session.userId)
      .executeTakeFirst();
    return {
      enabled: true as const,
      providers: this.provider.enabled(),
      connections: rows.map((row) => row.provider),
      // 화면이 연결 전에 현재 비밀번호를 물을지 정한다(confirmLinkIdentity와 같은 기준).
      password_required:
        user !== undefined &&
        user.password_hash !== SOCIAL_ONLY_PASSWORD &&
        user.password_hash.startsWith("$argon2id$"),
    };
  }
  async unlink(session: AuthenticatedSession, provider: SocialProvider) {
    this.provider.require(provider);
    await this.database.transaction().execute(async (transaction) => {
      const user = await this.lockUser(transaction, session.userId),
        db = socialDatabase(transaction, this.maria);
      const identities = await db
        .selectFrom("social_identities")
        .select(["provider", "issuer"])
        .where("user_id", "=", session.userId)
        .forUpdate()
        .execute();
      if (!identities.some((row) => row.provider === provider)) throw socialDenied();
      const alternatives = identities.filter(
        (row) =>
          row.provider !== provider &&
          this.provider.enabled().includes(row.provider as SocialProvider) &&
          this.provider.currentIssuer(row.provider as SocialProvider) === row.issuer,
      );
      if (
        (user.password_hash === SOCIAL_ONLY_PASSWORD ||
          !user.password_hash.startsWith("$argon2id$")) &&
        alternatives.length === 0
      )
        throw new ForbiddenException({
          code: "SOCIAL_LAST_LOGIN_METHOD",
          message:
            "마지막 로그인 방법은 해제할 수 없습니다. 다른 로그인 계정을 먼저 연결해 주세요.",
        });
      await db
        .deleteFrom("social_identities")
        .where("user_id", "=", session.userId)
        .where("provider", "=", provider)
        .execute();
    });
    await this.notify(session.userId, "social_unlinked");
    return { unlinked: true };
  }
}
