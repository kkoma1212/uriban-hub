import { timingSafeEqual } from "node:crypto";

import { sql, type Kysely, type Transaction } from "kysely";

import {
  postgresDatabaseErrorClassifier,
  type DatabaseErrorClassifier,
} from "../database-error-classifier.js";
import type { DB, JsonValue } from "../generated/database.js";
import {
  createPostgresTransactionLockManager,
  type TransactionLockManager,
} from "../transaction-lock.js";
import { withSerializationRetry } from "../transaction-retry.js";
import { normalizeIdempotencyKey } from "./canonical.js";

export class IdempotencyKeyReusedError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("Idempotency-Key was already used with a different request.");
    this.name = "IdempotencyKeyReusedError";
  }
}

export interface IdempotencyRequest {
  actorUserId: string;
  idempotencyKey: string;
  requestHash: Buffer;
  routeKey: string;
}

export interface IdempotencySuccess<TBody extends JsonValue> {
  body: TBody;
  statusCode: number;
}

export interface IdempotencyExecutionResult<
  TBody extends JsonValue,
> extends IdempotencySuccess<TBody> {
  replayed: boolean;
}

export type IdempotentOperation<TBody extends JsonValue> = (
  transaction: Transaction<DB>,
) => Promise<IdempotencySuccess<TBody>>;

export interface IdempotencyServiceOptions {
  errorClassifier?: DatabaseErrorClassifier;
  transactionLockManager?: TransactionLockManager<DB>;
}

function requestHashesMatch(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function validateRequest(request: IdempotencyRequest): IdempotencyRequest {
  if (request.actorUserId.length === 0) {
    throw new RangeError("actorUserId must not be empty.");
  }

  if (request.routeKey.length === 0) {
    throw new RangeError("routeKey must not be empty.");
  }

  if (request.requestHash.length !== 32) {
    throw new RangeError("requestHash must be a SHA-256 digest.");
  }

  return {
    ...request,
    idempotencyKey: normalizeIdempotencyKey(request.idempotencyKey),
  };
}

export class IdempotencyService {
  private readonly errorClassifier: DatabaseErrorClassifier;
  private readonly transactionLockManager: TransactionLockManager<DB>;

  constructor(
    private readonly database: Kysely<DB>,
    options: IdempotencyServiceOptions = {},
  ) {
    this.errorClassifier = options.errorClassifier ?? postgresDatabaseErrorClassifier;
    this.transactionLockManager =
      options.transactionLockManager ?? createPostgresTransactionLockManager<DB>();
  }

  async execute<TBody extends JsonValue>(
    input: IdempotencyRequest,
    operation: IdempotentOperation<TBody>,
  ): Promise<IdempotencyExecutionResult<TBody>> {
    const request = validateRequest(input);

    /*
     * 학급 범위 쓰기가 여기를 지난다. 이 경로들은 classes를 먼저 잡고 명부의 users를
     * 나중에 잡는데, 반나가기·계정삭제는 반대 순서라 겹치면 PostgreSQL이 한쪽을
     * 40P01로 중단시킨다(2026-08-01 감사 P1-02). 잠금 순서 통일이 근본 해결이고
     * 이건 그때까지의 그물이다.
     *
     * 여기가 재시도를 걸 자리인 이유: 멱등성 키 기록과 작업이 같은 트랜잭션 안이라
     * 중단되면 함께 롤백된다. 부분 적용이 남지 않으므로 다시 실행하면 된다.
     * 다만 operation이 DB 밖 부수효과를 내면 그것까지 두 번 일어난다 — 현재
     * 이 경로를 쓰는 서비스 9개 중 메일러를 주입하는 것은 없다.
     */
    return withSerializationRetry(
      () =>
        this.database.transaction().execute(async (transaction) => {
          const lockIdentity = JSON.stringify([
            request.actorUserId,
            request.routeKey,
            request.idempotencyKey,
          ]);

          await this.transactionLockManager.acquire(transaction, lockIdentity);

          await transaction
            .deleteFrom("api_idempotency_keys")
            .where("actor_user_id", "=", request.actorUserId)
            .where("route_key", "=", request.routeKey)
            .where("idempotency_key", "=", request.idempotencyKey)
            .where("expires_at", "<=", sql<Date>`now()`)
            .execute();

          const stored = await transaction
            .selectFrom("api_idempotency_keys")
            .select(["request_hash", "response_body_json", "response_status"])
            .where("actor_user_id", "=", request.actorUserId)
            .where("route_key", "=", request.routeKey)
            .where("idempotency_key", "=", request.idempotencyKey)
            .executeTakeFirst();

          if (stored !== undefined) {
            if (!requestHashesMatch(stored.request_hash, request.requestHash)) {
              throw new IdempotencyKeyReusedError();
            }

            return {
              body: stored.response_body_json as TBody,
              replayed: true,
              statusCode: stored.response_status,
            };
          }

          const result = await operation(transaction);
          if (
            !Number.isInteger(result.statusCode) ||
            result.statusCode < 200 ||
            result.statusCode > 299
          ) {
            throw new RangeError("Only 2xx idempotency responses can be stored.");
          }

          await transaction
            .insertInto("api_idempotency_keys")
            .values({
              actor_user_id: request.actorUserId,
              expires_at: sql<Date>`now() + interval '24 hours'`,
              idempotency_key: request.idempotencyKey,
              request_hash: request.requestHash,
              response_body_json: result.body,
              response_status: result.statusCode,
              route_key: request.routeKey,
            })
            .execute();

          return {
            ...result,
            replayed: false,
          };
        }),
      { errorClassifier: this.errorClassifier },
    );
  }
}
