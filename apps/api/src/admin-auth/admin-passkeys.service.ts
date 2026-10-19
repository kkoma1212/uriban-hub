import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DB } from "@classhub/db";
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  notifySecurityChange,
  SECURITY_CHANGE_MAILER,
  type SecurityChangeKind,
  type SecurityChangeMailer,
} from "../mail/security-change-mailer.js";
import { ConfigService } from "@nestjs/config";
import type { Kysely } from "kysely";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { createPrivacySafeDigest } from "../auth/auth-crypto.js";
import { AUTH_RATE_LIMITER } from "../auth/auth.tokens.js";
import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbCount,
  mariaDbDateTime,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { sanitizeSecurityAuditUserAgent } from "../security-audit/security-audit-metadata.js";
import {
  adminAuthDatabase,
  adminAuthDate,
  type AdminAuthDatabaseEngine,
} from "./admin-auth.database.js";
import { AdminMfaInvalidException, AdminSessionRequiredException } from "./admin-auth.errors.js";
import {
  ADMIN_STEP_UP_LIFETIME_MS,
  type AdminRequestMetadata,
  type AuthenticatedAdminSession,
} from "./admin-auth.types.js";
import { adminFactorDatabase } from "./admin-passkeys.database.js";

export type AdminSecondFactor =
  | { kind: "totp"; code: string }
  | { kind: "recovery"; code: string }
  | { kind: "passkey"; ceremonyId: string; response: AuthenticationResponseJSON };
const hash = (value: string) => createHash("sha256").update(value).digest();
const factorCodec = createMariaDbRowCodec({
  signature_counter: mariaDbCount,
  backed_up: mariaDbBoolean,
  verified_at: mariaDbDateTime,
  used_at: mariaDbNullable(mariaDbDateTime),
});
type FactorAudit =
  | "passkey_registered"
  | "passkey_deleted"
  | "totp_revoked"
  | "recovery_codes_issued"
  | "recovery_code_used"
  | "factor_change_failed";

@Injectable()
export class AdminPasskeysService {
  private readonly engine: AdminAuthDatabaseEngine;
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly config: ConfigService<AppEnvironment, true>,
    @Inject(AUTH_RATE_LIMITER) private readonly limiter: RedisRateLimiter,
    @Optional()
    @Inject(SECURITY_CHANGE_MAILER)
    private readonly securityMailer?: SecurityChangeMailer,
  ) {
    ({ database: this.database, engine: this.engine } = adminAuthDatabase(database, config));
  }
  /** 총검수 C1-05: 로그인 수단이 바뀐 뒤(commit 후) 본인에게 알린다. 메일 실패가 작업을 되돌리지는 않는다. */
  private notify(session: AuthenticatedAdminSession, kind: SecurityChangeKind): Promise<void> {
    return notifySecurityChange(this.securityMailer, {
      email: session.email,
      kind,
      occurredAt: new Date(),
    });
  }
  enabled(): boolean {
    return this.config.get("ADMIN_PASSKEYS_ENABLED", { infer: true }) === true;
  }
  private requireEnabled(): void {
    if (!this.enabled()) throw new NotFoundException();
  }
  private db(database: Kysely<DB>) {
    const extended = adminFactorDatabase(database);
    return this.engine === "mariadb" ? extended.withPlugin(factorCodec) : extended;
  }
  private date(value: Date) {
    return adminAuthDate(value, this.engine);
  }
  private rp() {
    this.requireEnabled();
    return {
      rpID: this.config.get("ADMIN_WEBAUTHN_RP_ID", { infer: true })!,
      expectedOrigin: this.config.get("PUBLIC_APP_ORIGIN", { infer: true }),
    };
  }
  private async throttle(accountId: string, metadata: AdminRequestMetadata) {
    const key = createPrivacySafeDigest(
      this.config.get("EMAIL_HMAC_KEY", { infer: true }),
      "admin_mfa_options",
      `${accountId}:${metadata.clientIp}`,
    );
    const limit = await this.limiter.consume({ key: `admin-mfa-options:${key}` });
    if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds, limit);
  }
  private async audit(
    database: Kysely<DB>,
    accountId: string,
    action: FactorAudit,
    metadata: AdminRequestMetadata,
  ) {
    await database
      .insertInto("admin_auth_audit_logs")
      .values({
        action: `admin.auth.${action}`,
        admin_account_id: accountId,
        actor_ip_hmac: createPrivacySafeDigest(
          this.config.get("EMAIL_HMAC_KEY", { infer: true }),
          "admin_audit_ip",
          metadata.clientIp,
        ),
        actor_email_hmac: null,
        deny_reason: null,
        event_id: randomUUID(),
        hmac_key_version: this.config.get("EMAIL_HMAC_KEY_VERSION", { infer: true }),
        request_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
          metadata.requestId,
        )
          ? metadata.requestId
          : randomUUID(),
        user_agent: sanitizeSecurityAuditUserAgent(metadata.userAgent),
      })
      .execute();
  }
  async hasPasskey(database: Kysely<DB>, accountId: string): Promise<boolean> {
    if (!this.enabled()) return false;
    return (
      (await this.db(database)
        .selectFrom("admin_passkeys")
        .select("credential_id")
        .where("admin_account_id", "=", accountId)
        .where("revoked_at", "is", null)
        .executeTakeFirst()) !== undefined
    );
  }
  async loginMethods(
    database: Kysely<DB>,
    accountId: string,
    hasTotp: boolean,
  ): Promise<AdminSecondFactor["kind"][]> {
    const methods: AdminSecondFactor["kind"][] = hasTotp ? ["totp"] : [];
    if (await this.hasPasskey(database, accountId)) methods.push("passkey");
    const recovery = await this.db(database)
      .selectFrom("admin_recovery_codes")
      .select("id as recovery_id")
      .where("admin_account_id", "=", accountId)
      .where("used_at", "is", null)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (recovery) methods.push("recovery");
    return methods;
  }
  async factors(session: AuthenticatedAdminSession) {
    if (!this.enabled()) return { enabled: false as const };
    const db = this.db(this.database);
    const [passkeys, recovery, totp] = await Promise.all([
      db
        .selectFrom("admin_passkeys")
        .select(["credential_id", "label", "created_at", "used_at"])
        .where("admin_account_id", "=", session.adminAccountId)
        .where("revoked_at", "is", null)
        .execute(),
      db
        .selectFrom("admin_recovery_codes")
        .select("id as recovery_id")
        .where("admin_account_id", "=", session.adminAccountId)
        .where("used_at", "is", null)
        .where("revoked_at", "is", null)
        .execute(),
      db
        .selectFrom("admin_mfa_factors")
        .select("id")
        .where("admin_account_id", "=", session.adminAccountId)
        .where("status", "=", "active")
        .where("revoked_at", "is", null)
        .executeTakeFirst(),
    ]);
    return {
      enabled: true as const,
      passkeys: passkeys.map((p) => ({
        id: p.credential_id,
        label: p.label,
        created_at: p.created_at.toISOString(),
        used_at: p.used_at?.toISOString() ?? null,
      })),
      recovery_codes_remaining: recovery.length,
      totp_enabled: totp !== undefined,
    };
  }
  async recordStepUp(
    database: Kysely<DB>,
    sessionId: string,
    method: AdminSecondFactor["kind"],
    now: Date,
  ) {
    if (!this.enabled()) return;
    const db = this.db(database);
    await db.deleteFrom("admin_mfa_stepups").where("session_id", "=", sessionId).execute();
    await db
      .insertInto("admin_mfa_stepups")
      .values({ session_id: sessionId, method, verified_at: this.date(now) })
      .execute();
  }
  private async strongStepUp(database: Kysely<DB>, session: AuthenticatedAdminSession) {
    const db = this.db(database);
    const account = await db
      .selectFrom("admin_accounts")
      .select("status")
      .where("id", "=", session.adminAccountId)
      .forUpdate()
      .executeTakeFirst();
    const stored = await db
      .selectFrom("admin_sessions")
      .select(["admin_account_id", "revoked_at", "absolute_expires_at", "reauthenticated_at"])
      .where("id", "=", session.sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (
      account?.status !== "active" ||
      !stored ||
      stored.admin_account_id !== session.adminAccountId ||
      stored.revoked_at !== null ||
      stored.absolute_expires_at.getTime() <= Date.now()
    )
      throw new AdminSessionRequiredException();
    const proof = await db
      .selectFrom("admin_mfa_stepups")
      .selectAll()
      .where("session_id", "=", session.sessionId)
      .executeTakeFirst();
    const verified = proof?.verified_at.getTime();
    if (
      !proof ||
      proof.method === "recovery" ||
      verified !== stored.reauthenticated_at?.getTime() ||
      verified === undefined ||
      verified > Date.now() ||
      Date.now() - verified >= ADMIN_STEP_UP_LIFETIME_MS
    ) {
      throw new ForbiddenException({
        code: "ADMIN_STRONG_STEP_UP_REQUIRED",
        message: "인증 수단을 바꾸려면 인증 앱 또는 기존 패스키로 다시 확인해 주세요.",
      });
    }
  }
  private async saveCeremony(
    database: Kysely<DB>,
    accountId: string,
    binding: string,
    purpose: string,
    challenge: string,
    userHandle: string | null = null,
  ) {
    const db = this.db(database),
      now = new Date(),
      id = randomUUID();
    await db
      .updateTable("admin_webauthn_challenges")
      .set({ consumed_at: this.date(now) })
      .where("admin_account_id", "=", accountId)
      .where("binding_hash", "=", hash(binding))
      .where("purpose", "=", purpose)
      .where("consumed_at", "is", null)
      .execute();
    await db
      .insertInto("admin_webauthn_challenges")
      .values({
        id,
        admin_account_id: accountId,
        binding_hash: hash(binding),
        purpose,
        challenge,
        user_handle: userHandle,
        created_at: this.date(now),
        expires_at: this.date(new Date(now.getTime() + 120000)),
        consumed_at: null,
      })
      .execute();
    return id;
  }
  private async consumeCeremony(
    database: Kysely<DB>,
    accountId: string,
    binding: string,
    purpose: string,
    id: string,
  ) {
    const db = this.db(database);
    const row = await db
      .selectFrom("admin_webauthn_challenges")
      .select(["id as ceremony_id", "challenge", "user_handle", "expires_at", "consumed_at"])
      .where("id", "=", id)
      .where("admin_account_id", "=", accountId)
      .where("binding_hash", "=", hash(binding))
      .where("purpose", "=", purpose)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.consumed_at !== null || row.expires_at.getTime() <= Date.now()) return null;
    await db
      .updateTable("admin_webauthn_challenges")
      .set({ consumed_at: this.date(new Date()) })
      .where("id", "=", id)
      .execute();
    return row;
  }
  async authenticationOptions(
    database: Kysely<DB>,
    accountId: string,
    binding: string,
    purpose: "login" | "step_up",
    metadata: AdminRequestMetadata,
  ) {
    const { rpID } = this.rp();
    await this.throttle(accountId, metadata);
    const passkeys = await this.db(database)
      .selectFrom("admin_passkeys")
      .select("credential_id")
      .where("admin_account_id", "=", accountId)
      .where("revoked_at", "is", null)
      .execute();
    if (passkeys.length === 0) throw new AdminMfaInvalidException();
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      timeout: 120000,
      allowCredentials: passkeys.map((p) => ({ id: p.credential_id })),
    });
    return {
      ceremony_id: await this.saveCeremony(
        database,
        accountId,
        binding,
        purpose,
        options.challenge,
      ),
      options,
    };
  }
  async verify(
    database: Kysely<DB>,
    accountId: string,
    binding: string,
    purpose: "login" | "step_up",
    factor: Exclude<AdminSecondFactor, { kind: "totp" }>,
    metadata: AdminRequestMetadata,
  ): Promise<boolean> {
    this.requireEnabled();
    const db = this.db(database),
      now = new Date();
    if (factor.kind === "recovery") {
      const canonical = factor.code.trim().replaceAll("-", "").toUpperCase();
      if (!/^[A-F0-9]{32}$/u.test(canonical)) return false;
      const row = await db
        .selectFrom("admin_recovery_codes")
        .select("id as recovery_id")
        .where("admin_account_id", "=", accountId)
        .where("code_hash", "=", hash(canonical))
        .where("used_at", "is", null)
        .where("revoked_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return false;
      await db
        .updateTable("admin_recovery_codes")
        .set({ used_at: this.date(now) })
        .where("id", "=", row.recovery_id)
        .execute();
      await this.audit(database, accountId, "recovery_code_used", metadata);
      return true;
    }
    const ceremony = await this.consumeCeremony(
      database,
      accountId,
      binding,
      purpose,
      factor.ceremonyId,
    );
    if (!ceremony || typeof factor.response?.id !== "string" || factor.response.id.length > 1400)
      return false;
    const credential = await db
      .selectFrom("admin_passkeys")
      .selectAll()
      .where("admin_account_id", "=", accountId)
      .where("credential_id", "=", factor.response.id)
      .where("revoked_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (
      !credential ||
      (factor.response.response?.userHandle &&
        factor.response.response.userHandle !== credential.user_handle)
    )
      return false;
    let result;
    try {
      const { rpID, expectedOrigin } = this.rp();
      result = await verifyAuthenticationResponse({
        response: factor.response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: credential.credential_id,
          publicKey: new Uint8Array(credential.public_key),
          counter: credential.signature_counter,
        },
      });
    } catch {
      return false;
    }
    if (!result.verified) return false;
    await db
      .updateTable("admin_passkeys")
      .set({
        signature_counter: result.authenticationInfo.newCounter,
        backed_up: result.authenticationInfo.credentialBackedUp,
        used_at: this.date(now),
      })
      .where("credential_id", "=", credential.credential_id)
      .execute();
    return true;
  }
  async registrationOptions(session: AuthenticatedAdminSession, metadata: AdminRequestMetadata) {
    const { rpID } = this.rp();
    await this.throttle(session.adminAccountId, metadata);
    return this.database.transaction().execute(async (transaction) => {
      await this.strongStepUp(transaction, session);
      const existing = await this.db(transaction)
        .selectFrom("admin_passkeys")
        .select("credential_id")
        .where("admin_account_id", "=", session.adminAccountId)
        .where("revoked_at", "is", null)
        .execute();
      if (existing.length >= 10)
        throw new ForbiddenException({
          code: "ADMIN_FACTOR_LIMIT",
          message: "패스키는 10개까지 등록할 수 있습니다.",
        });
      const userID = randomBytes(32);
      const options = await generateRegistrationOptions({
        rpName: "우리반 허브 관리자",
        rpID,
        userName: session.email,
        userID: new Uint8Array(userID),
        attestationType: "none",
        timeout: 120000,
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "preferred",
          userVerification: "required",
        },
        excludeCredentials: existing.map((p) => ({ id: p.credential_id })),
      });
      return {
        ceremony_id: await this.saveCeremony(
          transaction,
          session.adminAccountId,
          `session:${session.sessionId}`,
          "register",
          options.challenge,
          userID.toString("base64url"),
        ),
        options,
      };
    });
  }
  async register(
    session: AuthenticatedAdminSession,
    id: string,
    response: RegistrationResponseJSON,
    label: string,
    metadata: AdminRequestMetadata,
  ) {
    const { rpID, expectedOrigin } = this.rp();
    const successful = await this.database.transaction().execute(async (transaction) => {
      await this.strongStepUp(transaction, session);
      const ceremony = await this.consumeCeremony(
        transaction,
        session.adminAccountId,
        `session:${session.sessionId}`,
        "register",
        id,
      );
      let result;
      if (ceremony) {
        try {
          result = await verifyRegistrationResponse({
            response,
            expectedChallenge: ceremony.challenge,
            expectedOrigin,
            expectedRPID: rpID,
            requireUserVerification: true,
            requireUserPresence: true,
          });
        } catch {
          /* no raw response in logs */
        }
      }
      if (
        !ceremony?.user_handle ||
        !result?.verified ||
        !result.registrationInfo ||
        result.registrationInfo.credential.id.length > 1400
      ) {
        await this.audit(transaction, session.adminAccountId, "factor_change_failed", metadata);
        return false;
      }
      const info = result.registrationInfo;
      const duplicate = await this.db(transaction)
        .selectFrom("admin_passkeys")
        .select("credential_id")
        .where("credential_id", "=", info.credential.id)
        .executeTakeFirst();
      const active = await this.db(transaction)
        .selectFrom("admin_passkeys")
        .select("credential_id")
        .where("admin_account_id", "=", session.adminAccountId)
        .where("revoked_at", "is", null)
        .execute();
      if (duplicate || active.length >= 10) {
        await this.audit(transaction, session.adminAccountId, "factor_change_failed", metadata);
        return false;
      }
      await this.db(transaction)
        .insertInto("admin_passkeys")
        .values({
          credential_id: info.credential.id,
          admin_account_id: session.adminAccountId,
          public_key: Buffer.from(info.credential.publicKey),
          user_handle: ceremony.user_handle,
          signature_counter: info.credential.counter,
          transports_json: JSON.stringify(info.credential.transports ?? []),
          device_type: info.credentialDeviceType,
          backed_up: info.credentialBackedUp,
          label,
          created_at: this.date(new Date()),
          used_at: null,
          revoked_at: null,
        })
        .execute();
      await this.audit(transaction, session.adminAccountId, "passkey_registered", metadata);
      return true;
    });
    if (!successful) throw new AdminMfaInvalidException();
    await this.notify(session, "admin_passkey_registered");
    return { registered: true };
  }
  async regenerateRecoveryCodes(
    session: AuthenticatedAdminSession,
    metadata: AdminRequestMetadata,
  ) {
    this.requireEnabled();
    await this.throttle(session.adminAccountId, metadata);
    const codes = Array.from({ length: 10 }, () => randomBytes(16).toString("hex").toUpperCase());
    await this.database.transaction().execute(async (transaction) => {
      await this.strongStepUp(transaction, session);
      const db = this.db(transaction),
        now = this.date(new Date());
      await db
        .updateTable("admin_recovery_codes")
        .set({ revoked_at: now })
        .where("admin_account_id", "=", session.adminAccountId)
        .where("revoked_at", "is", null)
        .execute();
      await db
        .insertInto("admin_recovery_codes")
        .values(
          codes.map((code) => ({
            id: randomUUID(),
            admin_account_id: session.adminAccountId,
            code_hash: hash(code),
            created_at: now,
            used_at: null,
            revoked_at: null,
          })),
        )
        .execute();
      await this.audit(transaction, session.adminAccountId, "recovery_codes_issued", metadata);
    });
    await this.notify(session, "admin_recovery_codes_issued");
    return { codes: codes.map((code) => code.match(/.{8}/gu)!.join("-")) };
  }
  async revoke(
    session: AuthenticatedAdminSession,
    credentialId: string | null,
    metadata: AdminRequestMetadata,
  ) {
    this.requireEnabled();
    await this.database.transaction().execute(async (transaction) => {
      await this.strongStepUp(transaction, session);
      const db = this.db(transaction);
      const passkeys = await db
        .selectFrom("admin_passkeys")
        .select("credential_id")
        .where("admin_account_id", "=", session.adminAccountId)
        .where("revoked_at", "is", null)
        .execute();
      const totp = await db
        .selectFrom("admin_mfa_factors")
        .select("id")
        .where("admin_account_id", "=", session.adminAccountId)
        .where("status", "=", "active")
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (credentialId === null ? !totp : !passkeys.some((p) => p.credential_id === credentialId))
        throw new NotFoundException();
      if (passkeys.length + (totp ? 1 : 0) <= 1)
        throw new ForbiddenException({
          code: "ADMIN_LAST_FACTOR",
          message: "마지막 2차 인증 수단은 삭제할 수 없습니다.",
        });
      if (credentialId === null) {
        await db
          .updateTable("admin_mfa_factors")
          .set({ status: "revoked", revoked_at: this.date(new Date()) })
          .where("id", "=", totp!.id)
          .execute();
      } else {
        await db
          .updateTable("admin_passkeys")
          .set({ revoked_at: this.date(new Date()) })
          .where("credential_id", "=", credentialId)
          .where("admin_account_id", "=", session.adminAccountId)
          .execute();
      }
      await this.audit(
        transaction,
        session.adminAccountId,
        credentialId === null ? "totp_revoked" : "passkey_deleted",
        metadata,
      );
    });
    await this.notify(
      session,
      credentialId === null ? "admin_totp_removed" : "admin_passkey_removed",
    );
    return { revoked: true };
  }
}
