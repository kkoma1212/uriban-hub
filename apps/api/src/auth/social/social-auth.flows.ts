import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable, type OnModuleInit, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Kysely } from "kysely";
import type { DB } from "@classhub/db";
import { DATABASE, type ClassHubDatabase } from "../../database/database.module.js";
import { authDateValue } from "../mariadb/auth-persistence.js";
import { socialDatabase } from "./social-auth.database.js";
import {
  SocialAuthProvider,
  socialDenied,
  type OAuthProof,
  type SocialIdentity,
} from "./social-auth.provider.js";
import type { SocialProvider } from "./social-auth.environment.js";

export type OAuthFlow = {
  stage: "oauth";
  proof: OAuthProof;
  intent: "login" | "signup_over_14";
  link?: { userId: string; sessionHash: string };
};
export type SignupFlow = { stage: "signup"; identity: SocialIdentity };
const hash = (value: string) => createHash("sha256").update(value).digest();
const validSecret = (value: string | undefined): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);

@Injectable()
export class SocialAuthFlows implements OnModuleInit, OnApplicationShutdown {
  private readonly maria: boolean;
  private readonly installed: boolean;
  private cleanup: ReturnType<typeof setInterval> | undefined;
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Inject(ConfigService) config: ConfigService,
    @Inject(SocialAuthProvider) private readonly provider: SocialAuthProvider,
  ) {
    this.maria = config.get("DATABASE_ENGINE") === "mariadb";
    this.installed =
      provider.settings.SOCIAL_AUTH_ENABLED ||
      ["social", "all"].includes(String(config.get("AUTH_DATABASE_EXTENSIONS")));
  }
  async onModuleInit() {
    if (!this.installed) return;
    await this.purgeExpired();
    this.cleanup = setInterval(() => {
      void this.purgeExpired().catch(() => undefined);
    }, 30000);
    this.cleanup.unref();
  }
  onApplicationShutdown() {
    if (this.cleanup) clearInterval(this.cleanup);
  }
  private async purgeExpired() {
    await socialDatabase(this.database, this.maria)
      .deleteFrom("social_oauth_flows")
      .where("expires_at", "<=", authDateValue(new Date(), this.maria))
      .execute();
  }
  private encrypt(id: string, provider: SocialProvider, value: OAuthFlow | SignupFlow) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.provider.flowKey(), iv);
    cipher.setAAD(Buffer.from(`${id}:${provider}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
  }
  private decrypt(id: string, provider: SocialProvider, value: string): OAuthFlow | SignupFlow {
    try {
      const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
      if (!iv || !tag || !encrypted || iv.length !== 12 || tag.length !== 16) throw socialDenied();
      const decipher = createDecipheriv("aes-256-gcm", this.provider.flowKey(), iv);
      decipher.setAAD(Buffer.from(`${id}:${provider}`));
      decipher.setAuthTag(tag);
      return JSON.parse(
        Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"),
      ) as OAuthFlow | SignupFlow;
    } catch {
      throw socialDenied();
    }
  }
  async create(provider: SocialProvider, payload: OAuthFlow | SignupFlow) {
    this.provider.require(provider);
    const db = socialDatabase(this.database, this.maria),
      id = randomUUID(),
      browserSecret = randomBytes(32).toString("base64url"),
      now = new Date();
    await this.purgeExpired();
    await db
      .insertInto("social_oauth_flows")
      .values({
        flow_id: id,
        provider,
        stage: payload.stage,
        state_hash: hash(
          payload.stage === "oauth" ? payload.proof.state : `signup:${browserSecret}`,
        ),
        browser_hash: hash(browserSecret),
        encrypted_payload: this.encrypt(id, provider, payload),
        created_at: authDateValue(now, this.maria),
        expires_at: authDateValue(new Date(now.getTime() + 600000), this.maria),
        consumed_at: null,
      })
      .execute();
    return browserSecret;
  }
  async consumeOAuth(
    provider: SocialProvider,
    state: string | undefined,
    browserSecret: string | undefined,
  ) {
    this.provider.require(provider);
    if (!validSecret(state) || !validSecret(browserSecret)) throw socialDenied();
    return this.database.transaction().execute(async (transaction) => {
      const db = socialDatabase(transaction, this.maria);
      const flow = await db
        .selectFrom("social_oauth_flows")
        .selectAll()
        .where("provider", "=", provider)
        .where("stage", "=", "oauth")
        .where("state_hash", "=", hash(state))
        .where("browser_hash", "=", hash(browserSecret))
        .where("consumed_at", "is", null)
        .where("expires_at", ">", authDateValue(new Date(), this.maria))
        .forUpdate()
        .executeTakeFirst();
      if (!flow?.encrypted_payload) throw socialDenied();
      const payload = this.decrypt(flow.flow_id, provider, flow.encrypted_payload);
      if (payload.stage !== "oauth") throw socialDenied();
      await db
        .updateTable("social_oauth_flows")
        .set({ consumed_at: authDateValue(new Date(), this.maria), encrypted_payload: null })
        .where("flow_id", "=", flow.flow_id)
        .execute();
      return payload;
    });
  }
  async signup(
    browserSecret: string | undefined,
    transaction?: Kysely<DB>,
  ): Promise<SocialIdentity> {
    if (!validSecret(browserSecret)) throw socialDenied();
    const db = socialDatabase(transaction ?? this.database, this.maria);
    let query = db
      .selectFrom("social_oauth_flows")
      .selectAll()
      .where("stage", "=", "signup")
      .where("state_hash", "=", hash(`signup:${browserSecret}`))
      .where("browser_hash", "=", hash(browserSecret))
      .where("consumed_at", "is", null)
      .where("expires_at", ">", authDateValue(new Date(), this.maria));
    if (transaction) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row?.encrypted_payload) throw socialDenied();
    const payload = this.decrypt(
      row.flow_id,
      row.provider as SocialProvider,
      row.encrypted_payload,
    );
    if (payload.stage !== "signup") throw socialDenied();
    this.provider.require(payload.identity.provider);
    if (transaction)
      await db
        .updateTable("social_oauth_flows")
        .set({ consumed_at: authDateValue(new Date(), this.maria), encrypted_payload: null })
        .where("flow_id", "=", row.flow_id)
        .execute();
    return payload.identity;
  }
  async discardSignup(browserSecret: string | undefined) {
    if (!validSecret(browserSecret) || !this.installed) return;
    await socialDatabase(this.database, this.maria)
      .deleteFrom("social_oauth_flows")
      .where("stage", "=", "signup")
      .where("browser_hash", "=", hash(browserSecret))
      .execute();
  }
}
