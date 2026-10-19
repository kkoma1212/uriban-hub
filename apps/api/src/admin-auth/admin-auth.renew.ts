import type { DB } from "@classhub/db";
import type { Kysely, Transaction } from "kysely";
import { adminAuthDate, type AdminAuthDatabaseEngine } from "./admin-auth.database.js";
import {
  ADMIN_SESSION_LIFETIME_MS,
  ADMIN_SESSION_MAX_AGE_MS,
  type AuthenticatedAdminSession,
} from "./admin-auth.types.js";

/** Only an already authenticated, CSRF-protected caller may reach this operation.
 * Session lock is shared with authenticate/logout; expiry is rechecked after waiting.
 * Renewal is not password/MFA verification, so neither its timestamp nor audit is forged.
 */
export async function renewAdminSession(
  database: Kysely<DB>,
  engine: AdminAuthDatabaseEngine,
  session: AuthenticatedAdminSession,
  auditExpired: (transaction: Transaction<DB>) => Promise<void>,
): Promise<AuthenticatedAdminSession | null> {
  return database.transaction().execute(async (transaction) => {
    const stored = await transaction
      .selectFrom("admin_sessions")
      .select(["id", "revoked_at", "absolute_expires_at", "last_seen_at", "mfa_verified_at"])
      .where("id", "=", session.sessionId)
      .where("admin_account_id", "=", session.adminAccountId)
      .forUpdate()
      .executeTakeFirst();
    if (stored === undefined || stored.revoked_at !== null) return null;
    const account = await transaction
      .selectFrom("admin_accounts")
      .select("status")
      .where("id", "=", session.adminAccountId)
      .executeTakeFirst();
    const now = new Date();
    // 연장은 인증을 새로 한 것이 아니므로 로그인 때 2단계 인증 시각부터 최대 수명을 센다(I1-12).
    const maxExpiresAt = stored.mfa_verified_at.getTime() + ADMIN_SESSION_MAX_AGE_MS;
    if (
      stored.absolute_expires_at.getTime() <= now.getTime() ||
      maxExpiresAt <= now.getTime() ||
      stored.last_seen_at.getTime() + ADMIN_SESSION_LIFETIME_MS <= now.getTime() ||
      account?.status !== "active"
    ) {
      await transaction
        .updateTable("admin_sessions")
        .set({ revoked_at: adminAuthDate(now, engine) })
        .where("id", "=", stored.id)
        .where("revoked_at", "is", null)
        .execute();
      await auditExpired(transaction);
      return null;
    }
    const absoluteExpiresAt = new Date(
      Math.min(now.getTime() + ADMIN_SESSION_LIFETIME_MS, maxExpiresAt),
    );
    await transaction
      .updateTable("admin_sessions")
      .set({
        absolute_expires_at: adminAuthDate(absoluteExpiresAt, engine),
        last_seen_at: adminAuthDate(now, engine),
      })
      .where("id", "=", stored.id)
      .execute();
    return { ...session, absoluteExpiresAt, lastSeenAt: now };
  });
}
