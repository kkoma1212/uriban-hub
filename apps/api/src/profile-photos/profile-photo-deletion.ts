import type { DB } from "@classhub/db";
import { sql, type Transaction } from "kysely";

/**
 * Call inside the account-deletion transaction after its users-first lock and password check.
 * The presence check deliberately ignores the display feature switch, so disabling photos
 * cannot leave a deleted account's picture behind. It also permits pre-migration deployment.
 *
 * declaredInstalled = PROFILE_PHOTOS_DATABASE_INSTALLED, whose exact grants are attested at
 * startup. Then the DELETE runs unconditionally: information_schema hides a table the app role
 * cannot access, so "not visible" must not mean "not installed" (Codex review R4, 2026-09-29).
 * A missing grant makes the DELETE fail and the whole account deletion roll back instead of
 * committing with the photo left behind.
 */
export async function deleteAccountProfilePhotoIfInstalled(
  transaction: Transaction<DB>,
  mariaDb: boolean,
  userId: string,
  { declaredInstalled = false }: { declaredInstalled?: boolean } = {},
): Promise<void> {
  if (declaredInstalled) {
    await transaction.deleteFrom("user_profile_photos").where("user_id", "=", userId).execute();
    return;
  }
  const installed = await sql
    .raw<{ installed: number }>(
      mariaDb
        ? "SELECT 1 AS installed FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'user_profile_photos' AND table_type = 'BASE TABLE'"
        : "SELECT 1 AS installed FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'user_profile_photos' AND table_type = 'BASE TABLE'",
    )
    .execute(transaction);
  if (installed.rows.length === 0) return;
  await transaction.deleteFrom("user_profile_photos").where("user_id", "=", userId).execute();
}
