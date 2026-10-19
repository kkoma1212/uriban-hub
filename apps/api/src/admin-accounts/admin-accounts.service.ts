import { randomBytes } from "node:crypto";

import {
  hashPassword,
  matchesDatabaseConstraint,
  NFC_PASSWORD_INPUT_VERSION,
  type AdminRole,
  type JsonValue,
} from "@classhub/db";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Transaction } from "kysely";
import type { DB } from "@classhub/db";

import {
  adminAuthDate,
  adminAuthJson,
  type AdminAuthDatabaseEngine,
} from "../admin-auth/admin-auth.database.js";
import { adminFactorDatabase } from "../admin-auth/admin-passkeys.database.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  adminAccountsDatabase,
  AdminAccountInsertCollision,
  insertAdminAccount,
  lockAdminAccountEmail,
  lockAdminAccountLiveness,
} from "./admin-accounts.database.js";
import type { AdminAccountMutableStatus } from "./admin-accounts.dto.js";
import {
  SECURITY_CHANGE_MAILER,
  notifySecurityChange,
  type SecurityChangeMailer,
  type SecurityChangeNotice,
} from "../mail/security-change-mailer.js";
import { adminError } from "../admin-management/admin-error.js";

const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;

function isDatabaseId(value: string): boolean {
  if (!/^[1-9]\d*$/u.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_DATABASE_ID;
  } catch {
    return false;
  }
}

function normalizedAdminEmail(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

function normalizedDisplayName(value: string): string {
  return value.normalize("NFC").trim();
}

function createInitialPassword(): string {
  return `A1-${randomBytes(24).toString("base64url")}`;
}

function assertResettableAccountStatus(status: string): void {
  if (status === "revoked") throw adminError(BadRequestException, "ADMIN_ACCOUNT_REVOKED");
  if (status === "suspended") {
    throw adminError(BadRequestException, "ADMIN_ACCOUNT_STATUS_TRANSITION_INVALID");
  }
}

@Injectable()
export class AdminAccountsService {
  private readonly engine: AdminAuthDatabaseEngine;
  private readonly passkeyTablesInstalled: boolean;

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    config: ConfigService<AppEnvironment, true>,
    @Optional()
    @Inject(SECURITY_CHANGE_MAILER)
    private readonly securityMailer?: SecurityChangeMailer,
  ) {
    ({ database: this.database, engine: this.engine } = adminAccountsDatabase(database, config));
    // 패스키·복구 코드 표는 PostgreSQL에는 항상, MariaDB에는 인증 확장(passkeys/all)을 설치했을 때만 있다.
    this.passkeyTablesInstalled =
      this.engine !== "mariadb" ||
      ["passkeys", "all"].includes(String(config.get("AUTH_DATABASE_EXTENSIONS", { infer: true })));
  }

  async list() {
    const accountRows = await this.database
      .selectFrom("admin_accounts as account")
      .select([
        "account.id",
        "account.email_normalized",
        "account.display_name",
        "account.status",
        "account.last_login_at",
        "account.created_at",
        "account.updated_at",
      ])
      .orderBy("account.created_at", "desc")
      .orderBy("account.id", "desc")
      .limit(201)
      .execute();
    const truncated = accountRows.length > 200;
    const visibleAccounts = accountRows.slice(0, 200);
    const roleRows =
      visibleAccounts.length === 0
        ? []
        : await this.database
            .selectFrom("admin_account_roles")
            .select(["admin_account_id", "role"])
            .where(
              "admin_account_id",
              "in",
              visibleAccounts.map(({ id }) => id),
            )
            .execute();
    const rolesByAccount = new Map<string, AdminRole[]>();
    for (const row of roleRows) {
      const roles = rolesByAccount.get(row.admin_account_id) ?? [];
      roles.push(row.role as AdminRole);
      rolesByAccount.set(row.admin_account_id, roles);
    }

    return {
      accounts: visibleAccounts.map(
        (
          row,
        ): {
          id: string;
          email: string;
          display_name: string;
          status: string;
          roles: AdminRole[];
          last_login_at: Date | null;
          created_at: Date;
          updated_at: Date;
        } => ({
          id: row.id,
          email: row.email_normalized,
          display_name: row.display_name,
          status: row.status,
          roles: rolesByAccount.get(row.id) ?? [],
          last_login_at: row.last_login_at,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }),
      ),
      truncated,
    };
  }

  async create(
    input: { email: string; display_name: string; roles: AdminRole[] },
    actorAdminId: string,
    requestId: string,
  ) {
    const rawInitialPassword = createInitialPassword();
    const passwordHash = await hashPassword(rawInitialPassword);
    const email = normalizedAdminEmail(input.email);
    const displayName = normalizedDisplayName(input.display_name);
    const requestedRoles = [...input.roles].sort() as AdminRole[];

    try {
      return await this.database.transaction().execute(async (transaction) => {
        await this.lockAccountEmail(transaction, email);
        const duplicate = await transaction
          .selectFrom("admin_accounts")
          .select(["id", "status"])
          .where("email_normalized", "=", email)
          .forUpdate()
          .executeTakeFirst();
        if (duplicate !== undefined) {
          return this.existingCreateResult(transaction, duplicate, requestedRoles);
        }

        const account = await insertAdminAccount(
          transaction,
          {
            created_by_admin_account_id: actorAdminId,
            display_name: displayName,
            email_normalized: email,
            password_hash: passwordHash,
            password_input_version: NFC_PASSWORD_INPUT_VERSION,
          },
          this.engine,
        );

        await transaction
          .insertInto("admin_account_roles")
          .values(
            requestedRoles.map((role) => ({
              admin_account_id: account.id,
              granted_by_admin_account_id: actorAdminId,
              role,
            })),
          )
          .execute();
        await this.audit(
          transaction,
          actorAdminId,
          "admin.account.created",
          account.id,
          null,
          {
            roles: requestedRoles,
            status: account.status,
          },
          null,
          requestId,
        );
        return {
          account: { id: account.id, roles: requestedRoles, status: account.status },
          created: true,
          initial_password: rawInitialPassword,
        };
      });
    } catch (error) {
      const collision =
        this.engine === "mariadb"
          ? error instanceof AdminAccountInsertCollision
          : matchesDatabaseConstraint(error, {
              kind: "unique_violation",
              objectName: "admin_accounts_email_normalized_key",
            });
      if (!collision) {
        throw error;
      }
      return this.database.transaction().execute(async (transaction) => {
        await this.lockAccountEmail(transaction, email);
        const duplicate = await transaction
          .selectFrom("admin_accounts")
          .select(["id", "status"])
          .where("email_normalized", "=", email)
          .forUpdate()
          .executeTakeFirst();
        if (duplicate === undefined)
          throw error instanceof AdminAccountInsertCollision ? error.insertError : error;
        return this.existingCreateResult(transaction, duplicate, requestedRoles);
      });
    }
  }

  private async lockAccountEmail(transaction: Transaction<DB>, email: string): Promise<void> {
    await lockAdminAccountEmail(transaction, email, this.engine);
  }

  private async existingCreateResult(
    transaction: Transaction<DB>,
    account: { id: string; status: string },
    requestedRoles: AdminRole[],
  ) {
    if (account.status !== "pending_mfa" && account.status !== "active") {
      throw adminError(ConflictException, "ADMIN_ACCOUNT_STATUS_CONFLICT");
    }
    const existingRoles = (
      await transaction
        .selectFrom("admin_account_roles")
        .select("role")
        .where("admin_account_id", "=", account.id)
        .execute()
    )
      .map(({ role }) => role as AdminRole)
      .sort();
    if (
      existingRoles.length !== requestedRoles.length ||
      existingRoles.some((role, index) => role !== requestedRoles[index])
    ) {
      throw adminError(ConflictException, "ADMIN_ACCOUNT_ROLE_CONFLICT");
    }
    return {
      account: { id: account.id, roles: existingRoles, status: account.status },
      created: false,
      initial_password: null,
    };
  }

  async updateStatus(
    targetId: string,
    status: AdminAccountMutableStatus,
    reason: string,
    actorAdminId: string,
    requestId: string,
  ) {
    if (targetId === actorAdminId && status !== "active") {
      throw adminError(BadRequestException, "ADMIN_CANNOT_DISABLE_SELF");
    }
    let notice: SecurityChangeNotice | undefined;
    const result = await this.database.transaction().execute(async (transaction) => {
      await this.lockSuperAdminLiveness(transaction);
      const target = await this.lockAccount(transaction, targetId);
      if (target.status === "revoked" || (status === "active" && target.status !== "suspended")) {
        throw adminError(BadRequestException, "ADMIN_ACCOUNT_STATUS_TRANSITION_INVALID");
      }
      if (status !== "active") await this.assertAnotherViableSuperAdmin(transaction, targetId);
      const now = adminAuthDate(new Date(), this.engine);
      const update = transaction
        .updateTable("admin_accounts")
        .set({ status, locked_until: null, updated_at: now })
        .where("id", "=", targetId);
      const fields = ["id", "status", "updated_at"] as const;
      let updated;
      if (this.engine === "mariadb") {
        if ((await update.executeTakeFirstOrThrow()).numUpdatedRows !== 1n)
          throw new Error("Unexpected administrator account status update result.");
        updated = await transaction
          .selectFrom("admin_accounts")
          .select(fields)
          .where("id", "=", targetId)
          .executeTakeFirstOrThrow();
      } else updated = await update.returning(fields).executeTakeFirstOrThrow();
      if (status !== "active") {
        await transaction
          .updateTable("admin_sessions")
          .set({ revoked_at: now })
          .where("admin_account_id", "=", targetId)
          .where("revoked_at", "is", null)
          .execute();
      }
      if (status === "revoked") {
        await transaction
          .updateTable("admin_mfa_factors")
          .set({ status: "revoked", revoked_at: now })
          .where("admin_account_id", "=", targetId)
          .where("revoked_at", "is", null)
          .execute();
      }
      await this.audit(
        transaction,
        actorAdminId,
        "admin.account.status_changed",
        targetId,
        {
          status: target.status,
        },
        { status },
        reason,
        requestId,
      );
      if (target.status !== status)
        notice = {
          email: target.email_normalized,
          kind:
            status === "active"
              ? "admin_account_enabled"
              : status === "suspended"
                ? "admin_account_suspended"
                : "admin_account_revoked",
          occurredAt: new Date(),
        };
      return { account: updated };
    });
    await notifySecurityChange(this.securityMailer, notice);
    return result;
  }

  async replaceRoles(
    targetId: string,
    roles: AdminRole[],
    reason: string,
    actorAdminId: string,
    requestId: string,
  ) {
    let notice: SecurityChangeNotice | undefined;
    const result = await this.database.transaction().execute(async (transaction) => {
      await this.lockSuperAdminLiveness(transaction);
      const target = await this.lockAccount(transaction, targetId);
      if (target.status === "revoked")
        throw adminError(BadRequestException, "ADMIN_ACCOUNT_REVOKED");
      const previous = await transaction
        .selectFrom("admin_account_roles")
        .select("role")
        .where("admin_account_id", "=", targetId)
        .execute();
      const previousRoles = previous.map(({ role }) => role as AdminRole);
      if (previousRoles.includes("super_admin") && !roles.includes("super_admin")) {
        await this.assertAnotherViableSuperAdmin(transaction, targetId);
      }
      await transaction
        .deleteFrom("admin_account_roles")
        .where("admin_account_id", "=", targetId)
        .execute();
      await transaction
        .insertInto("admin_account_roles")
        .values(
          roles.map((role) => ({
            admin_account_id: targetId,
            granted_by_admin_account_id: actorAdminId,
            role,
          })),
        )
        .execute();
      await this.audit(
        transaction,
        actorAdminId,
        "admin.account.roles_changed",
        targetId,
        {
          roles: previousRoles,
        },
        { roles },
        reason,
        requestId,
      );
      if (
        previousRoles.length !== roles.length ||
        previousRoles.some((role) => !roles.includes(role))
      )
        notice = {
          email: target.email_normalized,
          kind: "admin_roles_changed",
          occurredAt: new Date(),
        };
      return { account: { id: targetId, roles } };
    });
    await notifySecurityChange(this.securityMailer, notice);
    return result;
  }

  async resetCredentials(
    targetId: string,
    reason: string,
    actorAdminId: string,
    requestId: string,
  ) {
    if (!isDatabaseId(targetId)) throw adminError(NotFoundException, "ADMIN_ACCOUNT_NOT_FOUND");
    const rawInitialPassword = createInitialPassword();
    const passwordHash = await hashPassword(rawInitialPassword);
    const notice = await this.database.transaction().execute(async (transaction) => {
      await this.lockSuperAdminLiveness(transaction);
      const target = await this.lockAccount(transaction, targetId);
      assertResettableAccountStatus(target.status);
      await this.assertAnotherViableSuperAdmin(transaction, targetId);
      const now = new Date();
      const date = adminAuthDate(now, this.engine);
      const updated = await transaction
        .updateTable("admin_accounts")
        .set({
          failed_login_attempts: 0,
          locked_until: null,
          password_hash: passwordHash,
          password_input_version: NFC_PASSWORD_INPUT_VERSION,
          password_last_changed_at: date,
          status: "pending_mfa",
          updated_at: date,
        })
        .where("id", "=", targetId)
        .executeTakeFirstOrThrow();
      if (this.engine === "mariadb" && updated.numUpdatedRows !== 1n)
        throw new Error("Unexpected administrator account credentials update result.");
      await this.revokeFactorsAndSessions(transaction, targetId, now);
      await this.audit(
        transaction,
        actorAdminId,
        "admin.account.credentials_reset",
        targetId,
        {
          status: target.status,
        },
        { status: "pending_mfa" },
        reason,
        requestId,
      );
      return {
        email: target.email_normalized,
        kind: "admin_credentials_reset" as const,
        occurredAt: now,
      };
    });
    await notifySecurityChange(this.securityMailer, notice);
    return { account_id: targetId, initial_password: rawInitialPassword, status: "pending_mfa" };
  }

  async resetMfa(targetId: string, reason: string, actorAdminId: string, requestId: string) {
    const notice = await this.database.transaction().execute(async (transaction) => {
      await this.lockSuperAdminLiveness(transaction);
      const target = await this.lockAccount(transaction, targetId);
      assertResettableAccountStatus(target.status);
      await this.assertAnotherViableSuperAdmin(transaction, targetId);
      const now = new Date();
      await this.revokeFactorsAndSessions(transaction, targetId, now);
      const updated = await transaction
        .updateTable("admin_accounts")
        .set({ status: "pending_mfa", updated_at: adminAuthDate(now, this.engine) })
        .where("id", "=", targetId)
        .executeTakeFirstOrThrow();
      if (this.engine === "mariadb" && updated.numUpdatedRows !== 1n)
        throw new Error("Unexpected administrator account MFA update result.");
      await this.audit(
        transaction,
        actorAdminId,
        "admin.account.mfa_reset",
        targetId,
        {
          status: target.status,
        },
        { status: "pending_mfa" },
        reason,
        requestId,
      );
      return { email: target.email_normalized, kind: "admin_mfa_reset" as const, occurredAt: now };
    });
    await notifySecurityChange(this.securityMailer, notice);
    return { account_id: targetId, status: "pending_mfa" };
  }

  private async lockAccount(transaction: Transaction<DB>, id: string) {
    if (!isDatabaseId(id)) throw adminError(NotFoundException, "ADMIN_ACCOUNT_NOT_FOUND");
    const account = await transaction
      .selectFrom("admin_accounts")
      .select(["id", "status", "email_normalized"])
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (account === undefined) throw adminError(NotFoundException, "ADMIN_ACCOUNT_NOT_FOUND");
    return account;
  }

  private async assertAnotherViableSuperAdmin(transaction: Transaction<DB>, excludedId: string) {
    const another = await transaction
      .selectFrom("admin_account_roles as role")
      .innerJoin("admin_accounts as account", "account.id", "role.admin_account_id")
      .select("account.id")
      .where("role.role", "=", "super_admin")
      .where("account.id", "!=", excludedId)
      .where("account.status", "=", "active")
      .executeTakeFirst();
    if (another === undefined) throw adminError(ConflictException, "LAST_SUPER_ADMIN_REQUIRED");
  }

  private async lockSuperAdminLiveness(transaction: Transaction<DB>): Promise<void> {
    await lockAdminAccountLiveness(transaction, this.engine);
  }

  private async revokeFactorsAndSessions(
    transaction: Transaction<DB>,
    targetId: string,
    now: Date,
  ) {
    const date = adminAuthDate(now, this.engine);
    await transaction
      .updateTable("admin_mfa_factors")
      .set({ status: "revoked", revoked_at: date })
      .where("admin_account_id", "=", targetId)
      .where("revoked_at", "is", null)
      .execute();
    await transaction
      .updateTable("admin_sessions")
      .set({ revoked_at: date })
      .where("admin_account_id", "=", targetId)
      .where("revoked_at", "is", null)
      .execute();
    // 총검수 C1-01: 2차 인증·자격 초기화 뒤 옛 패스키·복구 코드로 다시 들어오지 못하게 함께 폐기한다.
    if (!this.passkeyTablesInstalled) return;
    const factors = adminFactorDatabase(transaction);
    await factors
      .updateTable("admin_passkeys")
      .set({ revoked_at: date })
      .where("admin_account_id", "=", targetId)
      .where("revoked_at", "is", null)
      .execute();
    await factors
      .updateTable("admin_recovery_codes")
      .set({ revoked_at: date })
      .where("admin_account_id", "=", targetId)
      .where("revoked_at", "is", null)
      .execute();
  }

  private async audit(
    transaction: Transaction<DB>,
    actorAdminId: string,
    action: string,
    targetId: string,
    before: JsonValue | null,
    after: JsonValue | null,
    reason: string | null,
    requestId: string,
  ) {
    await transaction
      .insertInto("admin_operation_audit_logs")
      .values({
        action,
        actor_admin_account_id: actorAdminId,
        after_json: adminAuthJson(after, this.engine),
        before_json: adminAuthJson(before, this.engine),
        reason,
        request_id: requestId,
        target_id: targetId,
        target_type: "admin_account",
      })
      .execute();
  }
}
