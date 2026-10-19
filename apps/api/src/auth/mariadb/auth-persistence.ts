import { types } from "node:util";
import type { DB } from "@classhub/db";
import { InternalServerErrorException } from "@nestjs/common";
import { sql, type KyselyPlugin, type Transaction, type UpdateResult } from "kysely";

export function authPersistenceFailure(): InternalServerErrorException {
  return new InternalServerErrorException({
    code: "INTERNAL_ERROR",
    message: "인증 요청을 처리하지 못했습니다.",
  });
}
const nullableDates = new Set([
  "approved_at",
  "consumed_at",
  "invalidated_at",
  "revoked_at",
  "deleted_at",
  "email_verified_at",
  "signup_approved_at",
  "used_at",
]);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
export function authNumericId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw authPersistenceFailure();
  return value;
}
export function authMariaDate(value: unknown): Date {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{3}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(value)
  )
    throw authPersistenceFailure();
  const iso = value.slice(0, 10) + "T" + value.slice(11, 23) + "Z";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso)
    throw authPersistenceFailure();
  return date;
}
/** Result conversion is private to AuthService; SQL is never rewritten. */
export function createAuthMariaRowCodec(): KyselyPlugin {
  return {
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => ({
      ...result,
      rows: result.rows.map((row) => {
        const decoded = { ...row };
        for (const [key, value] of Object.entries(row)) {
          if (key === "expires_at" || nullableDates.has(key))
            decoded[key] = value === null && nullableDates.has(key) ? null : authMariaDate(value);
          else if (key === "id")
            decoded[key] =
              typeof value === "string" && uuid.test(value) ? value : authNumericId(value);
          else if (key === "user_id" || key === "issued_by_admin_account_id")
            decoded[key] = value === null ? null : authNumericId(value);
          else if (key === "is_active") {
            if (value !== 0 && value !== 1) throw authPersistenceFailure();
            decoded[key] = value === 1;
          } else if (
            key === "failed_attempts" &&
            (typeof value !== "number" || !Number.isInteger(value) || value < 0)
          )
            throw authPersistenceFailure();
        }
        return decoded;
      }),
    }),
  };
}
export function authDateValue(value: Date, mariaDb: boolean) {
  if (!mariaDb) return value;
  if (!Number.isFinite(value.getTime())) throw authPersistenceFailure();
  const encoded = value.toISOString().replace("T", " ").replace("Z", "000");
  return sql<Date>`${encoded}`;
}
/** Preserve PG now() as one transaction instant; Maria captures DB6 immediately after BEGIN. */
export async function authTransactionNow(transaction: Transaction<DB>, mariaDb: boolean) {
  if (!mariaDb) return sql<Date>`now()`;
  const result = await sql<{ auth_clock: string }>`SELECT UTC_TIMESTAMP(6) AS auth_clock`.execute(
    transaction,
  );
  const value = result.rows[0]?.auth_clock;
  authMariaDate(value);
  return sql<Date>`${value}`;
}
export function authUpdateSucceeded(result: UpdateResult): boolean {
  if (result.numUpdatedRows !== 0n && result.numUpdatedRows !== 1n) throw authPersistenceFailure();
  return result.numUpdatedRows === 1n;
}
export class SignupInsertCollision extends Error {
  constructor() {
    super("Signup insert requires post-rollback identity verification");
  }
}
/** Used only around users INSERT. Do not parse duplicate values/messages or nested causes. */
export function isMariaSignupDuplicate(error: unknown): boolean {
  if (typeof error !== "object" || error === null || types.isProxy(error)) return false;
  return (
    Object.getOwnPropertyDescriptor(error, "errno")?.value === 1062 &&
    Object.getOwnPropertyDescriptor(error, "sqlState")?.value === "23000" &&
    Object.getOwnPropertyDescriptor(error, "code")?.value === "ER_DUP_ENTRY"
  );
}
