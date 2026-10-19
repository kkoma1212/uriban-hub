import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { matchesDatabaseConstraint, NFC_PASSWORD_INPUT_VERSION, type DB } from "@classhub/db";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Transaction } from "kysely";

import { hashPassword, verifyPassword } from "../auth/password-hasher.js";
import { OriginNotAllowedException } from "../auth/auth.errors.js";
import { requireAcceptedNewPassword } from "../auth/password-input-policy-http.js";
import type { AppEnvironment } from "../config/environment.js";
import type { ClassHubDatabase } from "../database/database.module.js";
import {
  LocalAdminCsrfInvalidException,
  LocalAdminInvalidCredentialsException,
  LocalAdminSessionRequiredException,
  LocalTestAccountAlreadyExistsException,
  LocalTestAccountEmailRequiredException,
  LocalTestAccountHasMembershipException,
  LocalTestAccountNotFoundException,
} from "./local-test-admin.errors.js";
import type {
  DeletedLocalTestAccount,
  LocalAdminLoginResult,
  LocalTestAccount,
} from "./local-test-admin.types.js";
import { LocalTestAdminDatabase } from "./local-test-admin.database.js";

const ADMIN_SESSION_MS = 2 * 60 * 60 * 1_000;
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

interface LocalAdminSession {
  csrfHash: Buffer;
  expiresAt: Date;
  operatorId: string;
}

interface CreateAccountCommand {
  display_name: string;
  email: string;
  email_verified: boolean;
  password: string;
}

function hashSecret(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

function issueSecret(): string {
  return randomBytes(32).toString("base64url");
}

function isUniqueViolation(error: unknown): boolean {
  return matchesDatabaseConstraint(error, { kind: "unique_violation" });
}

function isForeignKeyViolation(error: unknown): boolean {
  return matchesDatabaseConstraint(error, { kind: "foreign_key_violation" });
}

@Injectable()
export class LocalTestAdminService {
  private readonly logger = new Logger(LocalTestAdminService.name);
  private readonly sessions = new Map<string, LocalAdminSession>();

  constructor(
    private readonly localAdminDatabase: LocalTestAdminDatabase,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  private get database(): ClassHubDatabase {
    return this.localAdminDatabase.get();
  }

  assertOrigin(origin: string | undefined): void {
    const expected = new URL(this.config.get("PUBLIC_APP_ORIGIN", { infer: true })).origin;
    if (origin !== expected) throw new OriginNotAllowedException();
  }

  async login(usernameInput: string, password: string): Promise<LocalAdminLoginResult> {
    const expectedUsername = this.config.get("LOCAL_TEST_ADMIN_USERNAME", { infer: true });
    const passwordHash = this.config.get("LOCAL_TEST_ADMIN_PASSWORD_HASH", { infer: true });
    const operatorEmail = this.config.get("LOCAL_TEST_ADMIN_OPERATOR_EMAIL", { infer: true });
    if (
      expectedUsername === undefined ||
      passwordHash === undefined ||
      operatorEmail === undefined
    ) {
      throw new LocalAdminInvalidCredentialsException();
    }

    const [passwordMatches, operator] = await Promise.all([
      verifyPassword(password, passwordHash),
      this.database
        .selectFrom("operators")
        .select("id")
        .where("email_normalized", "=", operatorEmail)
        .where("status", "=", "active")
        .executeTakeFirst(),
    ]);
    if (usernameInput.trim() !== expectedUsername || !passwordMatches || operator === undefined) {
      throw new LocalAdminInvalidCredentialsException();
    }

    const sessionToken = issueSecret();
    const csrfToken = issueSecret();
    const expiresAt = new Date(Date.now() + ADMIN_SESSION_MS);
    this.sessions.set(hashSecret(sessionToken).toString("base64url"), {
      csrfHash: hashSecret(csrfToken),
      expiresAt,
      operatorId: operator.id,
    });
    this.removeExpiredSessions();

    return { csrfToken, expiresAt, operatorId: operator.id, sessionToken };
  }

  async requireSession(rawSession: string | undefined): Promise<LocalAdminSession> {
    if (rawSession === undefined || !RAW_TOKEN_PATTERN.test(rawSession)) {
      throw new LocalAdminSessionRequiredException();
    }

    const key = hashSecret(rawSession).toString("base64url");
    const session = this.sessions.get(key);
    if (session === undefined || session.expiresAt.getTime() <= Date.now()) {
      this.sessions.delete(key);
      throw new LocalAdminSessionRequiredException();
    }

    const operator = await this.database
      .selectFrom("operators")
      .select("id")
      .where("id", "=", session.operatorId)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (operator === undefined) {
      this.sessions.delete(key);
      throw new LocalAdminSessionRequiredException();
    }

    return session;
  }

  async requireMutation(
    rawSession: string | undefined,
    rawCsrf: string | undefined,
  ): Promise<LocalAdminSession> {
    const session = await this.requireSession(rawSession);
    if (rawCsrf === undefined || !RAW_TOKEN_PATTERN.test(rawCsrf)) {
      throw new LocalAdminCsrfInvalidException();
    }

    const candidate = hashSecret(rawCsrf);
    if (!timingSafeEqual(candidate, session.csrfHash)) {
      throw new LocalAdminCsrfInvalidException();
    }
    return session;
  }

  logout(rawSession: string | undefined): void {
    if (rawSession !== undefined && RAW_TOKEN_PATTERN.test(rawSession)) {
      this.sessions.delete(hashSecret(rawSession).toString("base64url"));
    }
  }

  async listAccounts(): Promise<LocalTestAccount[]> {
    const users = await this.database
      .selectFrom("users")
      .select(["created_at", "display_name", "email_normalized", "email_verified_at", "id"])
      .where("email_normalized", "like", "%@example.com")
      .where("deleted_at", "is", null)
      .orderBy("id", "desc")
      .execute();

    return Promise.all(
      users.map(async (user) => {
        const [memberships, sessions] = await Promise.all([
          this.countRows("class_members", "user_id", user.id),
          this.countRows("sessions", "user_id", user.id),
        ]);
        return {
          created_at: user.created_at.toISOString(),
          display_name: user.display_name,
          email: user.email_normalized,
          email_verified: user.email_verified_at !== null,
          id: user.id,
          membership_count: memberships,
          session_count: sessions,
        };
      }),
    );
  }

  async createAccount(command: CreateAccountCommand, clientIp: string): Promise<LocalTestAccount> {
    const email = command.email.trim().toLowerCase();
    if (!email.endsWith("@example.com")) throw new LocalTestAccountEmailRequiredException();

    const normalizedPassword = requireAcceptedNewPassword(command.password, {
      displayName: command.display_name,
      email,
    });
    const passwordHash = await hashPassword(normalizedPassword);
    const now = new Date();
    let userId: string;

    try {
      userId = await this.database.transaction().execute(async (transaction) => {
        const user = await transaction
          .insertInto("users")
          .values({
            display_name: command.display_name.trim(),
            email_normalized: email,
            email_verified_at: command.email_verified ? now : null,
            password_hash: passwordHash,
            password_input_version: NFC_PASSWORD_INPUT_VERSION,
          })
          .returning("id")
          .executeTakeFirstOrThrow();

        await transaction
          .insertInto("user_consents")
          .values([
            {
              accepted_at: now,
              consent_type: "terms",
              ip_address: clientIp,
              policy_version: this.config.get("TERMS_POLICY_VERSION", { infer: true }),
              user_id: user.id,
            },
            {
              accepted_at: now,
              consent_type: "privacy",
              ip_address: clientIp,
              policy_version: this.config.get("PRIVACY_POLICY_VERSION", { infer: true }),
              user_id: user.id,
            },
            {
              accepted_at: now,
              consent_type: "age_over_14",
              ip_address: clientIp,
              policy_version: this.config.get("AGE_POLICY_VERSION", { infer: true }),
              user_id: user.id,
            },
          ])
          .execute();
        return user.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new LocalTestAccountAlreadyExistsException();
      throw error;
    }

    this.logger.log({ action: "local_test_account.created", user_id: userId });
    const account = (await this.listAccounts()).find((item) => item.id === userId);
    if (account === undefined) throw new LocalTestAccountNotFoundException();
    return account;
  }

  async deleteAccount(id: string, expectedEmailInput: string): Promise<DeletedLocalTestAccount> {
    if (!/^\d+$/u.test(id)) throw new LocalTestAccountNotFoundException();
    const expectedEmail = expectedEmailInput.trim().toLowerCase();

    let result: DeletedLocalTestAccount;
    try {
      result = await this.database.transaction().execute(async (transaction) => {
        const user = await transaction
          .selectFrom("users")
          .select(["email_normalized", "id"])
          .where("id", "=", id)
          .executeTakeFirst();
        if (
          user === undefined ||
          user.email_normalized !== expectedEmail ||
          !user.email_normalized.endsWith("@example.com")
        ) {
          throw new LocalTestAccountNotFoundException();
        }

        const membershipCount = await transaction
          .selectFrom("class_members")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", id)
          .executeTakeFirstOrThrow();
        if (membershipCount.count !== "0") throw new LocalTestAccountHasMembershipException();

        const [consents, emailTokens, idempotencyKeys, resetTokens, sessions] = await Promise.all([
          this.countRowsInTransaction(transaction, "user_consents", "user_id", id),
          this.countRowsInTransaction(transaction, "email_verification_tokens", "user_id", id),
          this.countRowsInTransaction(transaction, "api_idempotency_keys", "actor_user_id", id),
          this.countRowsInTransaction(transaction, "password_reset_tokens", "user_id", id),
          this.countRowsInTransaction(transaction, "sessions", "user_id", id),
        ]);

        // The DELETE itself is the concurrency boundary: the expected email is
        // rechecked atomically, while FK RESTRICT prevents a membership created
        // concurrently from being removed with the account. This avoids giving
        // the local-only role UPDATE solely to support SELECT ... FOR UPDATE.
        const deleted = await transaction
          .deleteFrom("users")
          .where("id", "=", id)
          .where("email_normalized", "=", expectedEmail)
          .returning("id")
          .executeTakeFirst();
        if (deleted === undefined) throw new LocalTestAccountNotFoundException();

        return {
          deleted: true as const,
          deleted_counts: {
            consents,
            email_tokens: emailTokens,
            idempotency_keys: idempotencyKeys,
            password_reset_tokens: resetTokens,
            sessions,
            users: 1 as const,
          },
        };
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new LocalTestAccountHasMembershipException();
      throw error;
    }

    this.logger.warn({ action: "local_test_account.deleted", user_id: id });
    return result;
  }

  private removeExpiredSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt.getTime() <= now) this.sessions.delete(key);
    }
  }

  private async countRows(
    table: "class_members" | "sessions",
    column: "user_id",
    userId: string,
  ): Promise<number> {
    const result = await this.database
      .selectFrom(table)
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where(column, "=", userId)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  private async countRowsInTransaction(
    transaction: Transaction<DB>,
    table:
      | "api_idempotency_keys"
      | "email_verification_tokens"
      | "password_reset_tokens"
      | "sessions"
      | "user_consents",
    column: "actor_user_id" | "user_id",
    userId: string,
  ): Promise<number> {
    const result = await transaction
      .selectFrom(table)
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where(column, "=", userId)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }
}
