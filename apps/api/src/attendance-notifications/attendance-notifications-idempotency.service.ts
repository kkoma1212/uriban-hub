import { timingSafeEqual } from "node:crypto";

import { IdempotencyKeyReusedError, normalizeIdempotencyKey, type DB } from "@classhub/db";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type Transaction } from "kysely";

import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AppEnvironment } from "../config/environment.js";
import {
  attendanceDatabaseEngine,
  attendanceJson,
  attendanceMariaDbRowCodec,
  type AttendanceDatabaseEngine,
} from "./attendance-notifications.database.js";
import type { AttendanceMutationItem } from "./attendance-notifications-command.types.js";

interface AttendanceIdempotencyRequest {
  actorUserId: string;
  beforeCommit: (transaction: Transaction<DB>) => Promise<void>;
  beforeLookup: (transaction: Transaction<DB>) => Promise<void>;
  idempotencyKey: string | string[] | undefined;
  operation: (
    transaction: Transaction<DB>,
  ) => Promise<{ body: AttendanceMutationItem; statusCode: 200 | 201 }>;
  requestHash: Buffer;
  routeKey: string;
}

export interface AttendanceIdempotencyResult {
  body: AttendanceMutationItem;
  replayed: boolean;
  statusCode: 200 | 201;
}

function hashesMatch(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function isStoredStatus(value: number): value is 200 | 201 {
  return value === 200 || value === 201;
}

function storedItem(value: unknown): AttendanceMutationItem {
  return value as AttendanceMutationItem;
}

@Injectable()
export class AttendanceNotificationsIdempotencyService {
  private readonly engine: AttendanceDatabaseEngine;
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    this.engine = attendanceDatabaseEngine(config);
    if (this.engine === "mariadb") this.database = database.withPlugin(attendanceMariaDbRowCodec);
  }

  async execute(request: AttendanceIdempotencyRequest): Promise<AttendanceIdempotencyResult> {
    if (this.engine === "mariadb")
      request = { ...request, requestHash: Buffer.from(request.requestHash) };
    const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
    if (request.actorUserId.length === 0 || request.routeKey.length === 0) {
      throw new RangeError("출결 멱등 요청 식별자는 비어 있을 수 없습니다.");
    }
    if (request.requestHash.length !== 32) {
      throw new RangeError("출결 멱등 requestHash는 SHA-256 digest여야 합니다.");
    }

    return this.database.transaction().execute(async (transaction) => {
      if (this.engine === "postgres") {
        const lockIdentity = JSON.stringify([
          request.actorUserId,
          request.routeKey,
          idempotencyKey,
        ]);
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))`.execute(
          transaction,
        );
      }

      // 날짜·권한 검증은 stored replay와 hash 비교보다 반드시 먼저 수행한다.
      // MariaDB beforeLookup owns users/class/member/notification locks until COMMIT.
      // This serializes same-actor keys without changing replay authorization or adding retries.
      await request.beforeLookup(transaction);

      await transaction
        .deleteFrom("api_idempotency_keys")
        .where("actor_user_id", "=", request.actorUserId)
        .where("route_key", "=", request.routeKey)
        .where("idempotency_key", "=", idempotencyKey)
        .where(
          "expires_at",
          "<=",
          this.engine === "mariadb" ? sql<Date>`UTC_TIMESTAMP(6)` : sql<Date>`clock_timestamp()`,
        )
        .execute();

      const stored = await transaction
        .selectFrom("api_idempotency_keys")
        .select(["request_hash", "response_body_json", "response_status"])
        .where("actor_user_id", "=", request.actorUserId)
        .where("route_key", "=", request.routeKey)
        .where("idempotency_key", "=", idempotencyKey)
        .$if(this.engine === "mariadb", (query) => query.forUpdate())
        .executeTakeFirst();

      if (stored !== undefined) {
        if (!hashesMatch(stored.request_hash, request.requestHash)) {
          throw new IdempotencyKeyReusedError();
        }
        if (!isStoredStatus(stored.response_status)) {
          throw new Error("저장된 출결 멱등 응답 status가 계약과 맞지 않습니다.");
        }
        let body = storedItem(stored.response_body_json);
        if (this.engine === "mariadb") {
          if (typeof stored.response_body_json !== "string")
            throw new Error("Invalid attendance stored response.");
          try {
            body = storedItem(JSON.parse(stored.response_body_json));
          } catch {
            throw new Error("Invalid attendance stored response.");
          }
        }
        await request.beforeCommit(transaction);
        return {
          body,
          replayed: true,
          statusCode: stored.response_status,
        };
      }

      const result = await request.operation(transaction);
      await transaction
        .insertInto("api_idempotency_keys")
        .values({
          actor_user_id: request.actorUserId,
          expires_at:
            this.engine === "mariadb"
              ? sql<Date>`UTC_TIMESTAMP(6) + INTERVAL 24 HOUR`
              : sql<Date>`clock_timestamp() + interval '24 hours'`,
          idempotency_key: idempotencyKey,
          request_hash: request.requestHash,
          response_body_json: attendanceJson(result.body, this.engine),
          response_status: result.statusCode,
          route_key: request.routeKey,
        })
        .execute();

      await request.beforeCommit(transaction);
      return { ...result, replayed: false };
    });
  }
}
