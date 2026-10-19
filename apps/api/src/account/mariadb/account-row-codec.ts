import type { KyselyPlugin } from "kysely";
import { parseMariaDbSessionDate } from "../../auth/mariadb/session-row-codec.js";
import { accountInternalError } from "./account-errors.js";

export function accountId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw accountInternalError();
  return value;
}

export function accountDate(value: unknown): Date {
  try {
    return parseMariaDbSessionDate(value);
  } catch {
    throw accountInternalError();
  }
}

/** Service-local read codec. Raw OUT timestamps keep all six digits for SQL comparisons. */
export function createMariaDbAccountRowCodec(): KyselyPlugin {
  return {
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => ({
      ...result,
      rows: result.rows.map((row) => {
        const decoded = { ...row };
        for (const [key, value] of Object.entries(row)) {
          if (["id", "class_id", "row_version"].includes(key)) decoded[key] = accountId(value);
          else if (["now", "updated_at", "expires_at", "deleted_at", "revoked_at"].includes(key)) {
            decoded[key] =
              value === null && ["deleted_at", "revoked_at"].includes(key)
                ? null
                : accountDate(value);
          } else if (["is_active", "temporary_password_must_change"].includes(key)) {
            if (value !== 0 && value !== 1) throw accountInternalError();
            decoded[key] = value === 1;
          }
        }
        return decoded;
      }),
    }),
  };
}
