import type { DB } from "@classhub/db";
import { sql, type Kysely } from "kysely";

import { SessionServiceUnavailableException } from "../auth.errors.js";
import type { SecurityAuditSessionIdentity } from "../auth.types.js";

function isEnrichmentAccessDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errno" in error &&
    (error.errno === 1142 || error.errno === 1143) &&
    "sqlState" in error &&
    error.sqlState === "42000"
  );
}

/** The database handle must include the session row codec. No UPDATE RETURNING in MariaDB. */
export async function logoutMariaDbSession(
  database: Kysely<DB>,
  sessionHash: Buffer,
): Promise<SecurityAuditSessionIdentity | null> {
  let enrichmentFailure: unknown;
  const revoke = (enrich: boolean) =>
    database.transaction().execute(async (transaction) => {
      const classSelection = enrich
        ? sql<string | null>`(
            SELECT CASE WHEN COUNT(*) = 1 THEN MIN(current_membership.class_id) ELSE NULL END
            FROM class_members AS current_membership
            WHERE current_membership.user_id = sessions.user_id
              AND current_membership.status IN ('pending', 'approved')
          )`
        : sql<null>`NULL`;
      const session = await transaction
        .selectFrom("sessions")
        .select([
          "id",
          "user_id",
          classSelection.as("current_class_id"),
          sql<boolean>`expires_at > CURRENT_TIMESTAMP(6)`.as("was_active"),
        ])
        .where("session_hash", "=", sessionHash)
        .where("revoked_at", "is", null)
        .forUpdate()
        .executeTakeFirst()
        .catch((error: unknown) => {
          if (enrich && isEnrichmentAccessDenied(error)) enrichmentFailure = error;
          throw error;
        });
      if (session === undefined) return null;

      const result = await transaction
        .updateTable("sessions")
        .set({ revoked_at: sql`CURRENT_TIMESTAMP(6)` })
        .where("id", "=", session.id)
        .where("session_hash", "=", sessionHash)
        .where("revoked_at", "is", null)
        .executeTakeFirstOrThrow();
      if (result.numUpdatedRows !== 1n) throw new SessionServiceUnavailableException();
      return session.was_active
        ? { currentClassId: session.current_class_id, userId: session.user_id }
        : null;
    });

  try {
    try {
      return await revoke(true);
    } catch (error) {
      // Failed statements poison their transaction. Only an ACL failure may use the
      // PG enrichment fallback, after rollback, in a fresh transaction. Never retry
      // deadlocks, lock timeouts, uncertain commits, or malformed database results.
      if (enrichmentFailure === undefined || error !== enrichmentFailure) throw error;
      return await revoke(false);
    }
  } catch {
    throw new SessionServiceUnavailableException();
  }
}
