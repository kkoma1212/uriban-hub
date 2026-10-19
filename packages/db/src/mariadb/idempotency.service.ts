import { timingSafeEqual } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseErrorClassifier } from "../database-error-classifier.js";
import type { DB, JsonValue } from "../generated/database.js";
import { normalizeIdempotencyKey } from "../idempotency/canonical.js";
import {
  IdempotencyKeyReusedError,
  type IdempotencyExecutionResult,
  type IdempotencyRequest,
  type IdempotentOperation,
} from "../idempotency/idempotency.service.js";
import { withSerializationRetry } from "../transaction-retry.js";

export class MariaDbIdempotencyError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "invalid_response"
      | "invalid_stored_response"
      | "reservation_conflict"
      | "reservation_lost",
  ) {
    super(`MariaDB idempotency rejected operation: ${code}`);
    this.name = "MariaDbIdempotencyError";
  }
}

class ReservationConflict extends MariaDbIdempotencyError {
  constructor() {
    super("reservation_conflict");
  }
}

function nativeError(error: unknown, errno: number, state: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (
    Object.getOwnPropertyDescriptor(error, "errno")?.value === errno &&
    Object.getOwnPropertyDescriptor(error, "sqlState")?.value === state
  );
}

// Only whole transactions are retried. A routine's application-defined 40001,
// lock timeout, connection loss or uncertain COMMIT acknowledgement is not enough.
const retryClassifier: DatabaseErrorClassifier = {
  classify(error) {
    if (error instanceof ReservationConflict)
      return { kind: "serialization_failure", vendorCode: "reservation_conflict" };
    if (nativeError(error, 1213, "40001")) return { kind: "deadlock", vendorCode: "1213" };
    return { kind: "unknown" };
  },
};

function snapshotRequest(input: IdempotencyRequest): IdempotencyRequest {
  if (
    typeof input.actorUserId !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(input.actorUserId) ||
    BigInt(input.actorUserId) > 9223372036854775807n ||
    typeof input.routeKey !== "string" ||
    input.routeKey.trim() === "" ||
    [...input.routeKey].length > 255 ||
    input.routeKey.endsWith(" ") ||
    /[\uD800-\uDFFF]/u.test(input.routeKey) ||
    !Buffer.isBuffer(input.requestHash) ||
    input.requestHash.length !== 32
  )
    throw new MariaDbIdempotencyError("invalid_request");
  return {
    ...input,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    requestHash: Buffer.from(input.requestHash),
  };
}

function successStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 200 && value <= 299;
}

function responseJson(body: JsonValue): string {
  try {
    const encoded = JSON.stringify(body);
    if (encoded !== undefined) return encoded;
  } catch {
    /* Do not expose response values or native serialization errors. */
  }
  throw new MariaDbIdempotencyError("invalid_response");
}

type StoredResponse = {
  id: string;
  request_hash: Buffer;
  response_body_json: string;
  response_status: number;
};

function replay<TBody extends JsonValue>(
  stored: StoredResponse,
  request: IdempotencyRequest,
): IdempotencyExecutionResult<TBody> {
  if (
    !Buffer.isBuffer(stored.request_hash) ||
    stored.request_hash.length !== 32 ||
    typeof stored.response_body_json !== "string" ||
    !successStatus(stored.response_status)
  )
    throw new MariaDbIdempotencyError("invalid_stored_response");
  if (!timingSafeEqual(stored.request_hash, request.requestHash))
    throw new IdempotencyKeyReusedError();
  try {
    return {
      body: JSON.parse(stored.response_body_json) as TBody,
      replayed: true,
      statusCode: stored.response_status,
    };
  } catch {
    throw new MariaDbIdempotencyError("invalid_stored_response");
  }
}

/**
 * Opt-in MariaDB candidate; use only with the guarded READ COMMITTED driver and
 * the attested app account. The callback owns authorization, audit and every
 * business write, and must have no effects outside this transaction. It may be
 * rerun after a deadlock. Authentication/date checks that precede replay stay
 * with the caller. This is not the general advisory-lock replacement.
 */
export class MariaDbIdempotencyService {
  constructor(private readonly database: Kysely<DB>) {}

  async execute<TBody extends JsonValue>(
    input: IdempotencyRequest,
    operation: IdempotentOperation<TBody>,
  ): Promise<IdempotencyExecutionResult<TBody>> {
    const request = snapshotRequest(input);
    return withSerializationRetry(
      () =>
        this.database.transaction().execute(async (transaction) => {
          const stored =
            await sql<StoredResponse>`SELECT id, request_hash, response_body_json, response_status
        FROM api_idempotency_keys WHERE actor_user_id=${request.actorUserId}
          AND route_key=${request.routeKey} AND idempotency_key=${request.idempotencyKey}
        FOR UPDATE`.execute(transaction);
          if (stored.rows[0]) {
            // Evaluate expiry in a new statement after the row lock wait. NOW at
            // the start of the waiting SELECT can be older than expires_at.
            const expiry = await sql<{
              unexpired: number;
            }>`SELECT expires_at > UTC_TIMESTAMP(6) AS unexpired
              FROM api_idempotency_keys WHERE id=${stored.rows[0].id}`.execute(transaction);
            if (expiry.rows[0]?.unexpired === 1) return replay<TBody>(stored.rows[0], request);
            if (expiry.rows[0]?.unexpired !== 0)
              throw new MariaDbIdempotencyError("invalid_stored_response");
            await sql`DELETE FROM api_idempotency_keys WHERE id=${stored.rows[0].id}`.execute(
              transaction,
            );
          }

          const reservation = await this.reserve(transaction, request);
          const result = await operation(transaction);
          if (!successStatus(result.statusCode))
            throw new MariaDbIdempotencyError("invalid_response");
          const body = responseJson(result.body);
          // App has SELECT/INSERT/DELETE, deliberately no UPDATE. The temporary 2xx
          // row is uncommitted, invisible to other RC readers, and never survives a
          // callback/final-write failure. Replacing it needs no new schema or grant.
          const deleted =
            await sql`DELETE FROM api_idempotency_keys WHERE id=${reservation}`.execute(
              transaction,
            );
          if (deleted.numAffectedRows !== 1n) throw new MariaDbIdempotencyError("reservation_lost");
          await sql`INSERT INTO api_idempotency_keys
        (actor_user_id, route_key, idempotency_key, request_hash, response_status, response_body_json, created_at, expires_at)
        VALUES (${request.actorUserId}, ${request.routeKey}, ${request.idempotencyKey}, ${request.requestHash},
          ${result.statusCode}, ${body}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6) + INTERVAL 24 HOUR)`.execute(
            transaction,
          );
          return {
            body: JSON.parse(body) as TBody,
            statusCode: result.statusCode,
            replayed: false,
          };
        }),
      { errorClassifier: retryClassifier },
    );
  }

  private async reserve(
    transaction: Transaction<DB>,
    request: IdempotencyRequest,
  ): Promise<string> {
    try {
      const result = await sql`INSERT INTO api_idempotency_keys
        (actor_user_id, route_key, idempotency_key, request_hash, response_status, response_body_json, created_at, expires_at)
        VALUES (${request.actorUserId}, ${request.routeKey}, ${request.idempotencyKey}, ${request.requestHash},
          200, 'null', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6) + INTERVAL 24 HOUR)`.execute(transaction);
      if (result.insertId === undefined) throw new MariaDbIdempotencyError("reservation_lost");
      return result.insertId.toString();
    } catch (error) {
      // This single INSERT omits the auto id and has only the request identity
      // unique key. A 1062 here means another transaction won; the driver marks
      // this transaction rollback-only. Retry only after Kysely rolls it back.
      if (nativeError(error, 1062, "23000")) throw new ReservationConflict();
      throw error;
    }
  }
}
