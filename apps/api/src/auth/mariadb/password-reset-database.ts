import type { DB } from "@classhub/db";
import { sql, type KyselyPlugin, type RawBuilder, type Transaction } from "kysely";

const timestamps = new Set(["deleted_at", "used_at", "invalidated_at"]);
const identifiers = new Set(["id", "user_id"]);
function invalid(): never {
  throw new Error("Invalid MariaDB password-reset database value.");
}

// The business policy only tests nullable timestamps for null; preserve all six fractional digits.
export function createPasswordResetMariaDbRowCodec(): KyselyPlugin {
  return {
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => ({
      ...result,
      rows: result.rows.map((row) => {
        const decoded = { ...row };
        for (const [name, value] of Object.entries(row)) {
          if (name === "is_active") {
            if (value !== 0 && value !== 1) invalid();
            decoded[name] = value === 1;
          } else if (identifiers.has(name)) {
            if (
              typeof value !== "string" ||
              !/^[1-9]\d{0,18}$/u.test(value) ||
              BigInt(value) > 9223372036854775807n
            )
              invalid();
          } else if (timestamps.has(name) && value !== null) {
            if (
              typeof value !== "string" ||
              !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(value)
            )
              invalid();
          }
        }
        return decoded;
      }),
    }),
  };
}

/** MariaDB has statement time; pin one server timestamp before locks for PG's transaction-time policy. */
export async function readPasswordResetTransactionTime(
  transaction: Transaction<DB>,
): Promise<RawBuilder<Date>> {
  const result = await sql<{
    transaction_time: string;
  }>`SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS transaction_time`.execute(
    transaction,
  );
  const value = result.rows[0]?.transaction_time;
  if (
    result.rows.length !== 1 ||
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(value)
  )
    invalid();
  return sql<Date>`${value}`;
}
