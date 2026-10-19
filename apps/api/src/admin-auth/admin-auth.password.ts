import { NFC_PASSWORD_INPUT_VERSION, type DB } from "@classhub/db";
import type { Kysely } from "kysely";

import { hashPassword } from "../auth/password-hasher.js";
import { requireAcceptedNewPassword } from "../auth/password-input-policy-http.js";
import {
  adminAuthDate,
  adminAuthJson,
  type AdminAuthDatabaseEngine,
} from "./admin-auth.database.js";
import { AdminSessionRequiredException } from "./admin-auth.errors.js";
import type { AdminRequestMetadata, AuthenticatedAdminSession } from "./admin-auth.types.js";
import { notifySecurityChange, type SecurityChangeMailer } from "../mail/security-change-mailer.js";

/** Existing password flow, kept separate from login/MFA persistence. The caller's guards own step-up and CSRF. */
export async function changeAdminPassword(
  database: Kysely<DB>,
  engine: AdminAuthDatabaseEngine,
  session: AuthenticatedAdminSession,
  newPassword: string,
  metadata: AdminRequestMetadata,
  securityMailer?: SecurityChangeMailer,
): Promise<{ password_changed: true }> {
  const identity = await database
    .selectFrom("admin_accounts")
    .select(["display_name", "email_normalized", "status"])
    .where("id", "=", session.adminAccountId)
    .executeTakeFirst();
  if (identity === undefined || identity.status !== "active")
    throw new AdminSessionRequiredException();
  const normalizedPassword = requireAcceptedNewPassword(newPassword, {
    displayName: identity.display_name,
    email: identity.email_normalized,
    accountType: "administrator",
  });
  const passwordHash = await hashPassword(normalizedPassword);
  const notice = await database.transaction().execute(async (transaction) => {
    const account = await transaction
      .selectFrom("admin_accounts")
      .select(["id", "display_name", "email_normalized", "status"])
      .where("id", "=", session.adminAccountId)
      .forUpdate()
      .executeTakeFirst();
    if (account === undefined || account.status !== "active")
      throw new AdminSessionRequiredException();
    requireAcceptedNewPassword(normalizedPassword, {
      displayName: account.display_name,
      email: account.email_normalized,
      accountType: "administrator",
    });
    const occurredAt = new Date();
    const now = adminAuthDate(occurredAt, engine);
    await transaction
      .updateTable("admin_accounts")
      .set({
        password_hash: passwordHash,
        password_input_version: NFC_PASSWORD_INPUT_VERSION,
        password_last_changed_at: now,
        updated_at: now,
      })
      .where("id", "=", session.adminAccountId)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("admin_sessions")
      .set({ revoked_at: now })
      .where("admin_account_id", "=", session.adminAccountId)
      .where("id", "!=", session.sessionId)
      .where("revoked_at", "is", null)
      .execute();
    await transaction
      .insertInto("admin_operation_audit_logs")
      .values({
        action: "admin.account.password_changed",
        actor_admin_account_id: session.adminAccountId,
        after_json: adminAuthJson({ other_sessions_revoked: true }, engine),
        before_json: null,
        reason: null,
        request_id: metadata.requestId,
        target_id: session.adminAccountId,
        target_type: "admin_account",
      })
      .execute();
    return { email: account.email_normalized, kind: "admin_password_changed" as const, occurredAt };
  });
  await notifySecurityChange(securityMailer, notice);
  return { password_changed: true };
}
