import type { DB } from "@classhub/db";
import type { Transaction } from "kysely";

export const DELETED_GUARDIAN_EMAIL = "deleted-guardian@redacted.invalid";

/** The account-deletion transaction already holds the user's row lock. */
export async function minimizeDeletedAccountGuardianConsent(
  transaction: Transaction<DB>,
  userId: string,
): Promise<void> {
  // Preserve completed consent evidence; its retention starts at users.deleted_at.
  await transaction
    .updateTable("guardian_consent_requests")
    .set({
      guardian_email_normalized: DELETED_GUARDIAN_EMAIL,
      approval_token_hash: null,
      completion_token_hash: null,
    })
    .where("user_id", "=", userId)
    .where("consumed_at", "is not", null)
    .execute();
}
