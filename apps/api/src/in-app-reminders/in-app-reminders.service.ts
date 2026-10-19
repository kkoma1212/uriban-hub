import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  type DB,
  type JsonValue,
  IdempotencyKeyReusedError,
  normalizeIdempotencyKey,
} from "@classhub/db";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type RawBuilder, type Transaction } from "kysely";

import { AUTH_RATE_LIMITER } from "../auth/auth.tokens.js";
import {
  createMariaDbRowCodec,
  mariaDbDateBinding,
  mariaDbDateTime,
  mariaDbId,
  mariaDbTimestamp,
} from "../common/database/mariadb-values.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { PushOutbox } from "../push-subscriptions/push-outbox.js";
import {
  InAppReminderContentRevisionChangedException,
  InAppReminderCooldownException,
  InAppReminderNoUnresolvedRecipientsException,
} from "./in-app-reminders.errors.js";
import type {
  CreateInAppReminderCommand,
  InAppReminderResult,
  InAppReminderType,
  ResolveInAppRemindersCommand,
} from "./in-app-reminders.types.js";

const COOLDOWN_HOURS = 24;
const reminderLogger = new Logger("InAppReminders");

interface InAppReminderResultJson extends InAppReminderResult {
  [key: string]: null | number | string;
}

function hashesMatch(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function routeFor(reminderType: InAppReminderType, resourceId: string): string {
  return `/${reminderType === "notice" ? "notices" : "supplies"}/${resourceId}/reminders`;
}

function rateLimitKey(actorUserId: string): string {
  const actorDigest = createHash("sha256").update(actorUserId, "utf8").digest("base64url");
  return `in-app-reminder:v1:actor:${actorDigest}`;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function storedResult(value: unknown): InAppReminderResult {
  if (typeof value !== "object" || value === null) {
    throw new Error("Stored in-app reminder response body is invalid.");
  }
  const body = value as Record<string, unknown>;
  const counts = [
    body.cooldown_suppressed_count,
    body.created_count,
    body.current_unresolved_count,
  ];
  if (
    typeof body.batch_id !== "string" ||
    typeof body.created_at !== "string" ||
    !counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0) ||
    (body.next_available_at !== null && typeof body.next_available_at !== "string")
  ) {
    throw new Error("Stored in-app reminder response body does not match the API contract.");
  }
  return value as InAppReminderResult;
}

@Injectable()
export class InAppRemindersService {
  private readonly dialect: "postgres" | "mariadb";

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
    // 웹 푸시가 켜져 있을 때만 주입된다. 없으면 앱 안 재알림만 동작한다.
    @Optional() private readonly pushOutbox?: PushOutbox,
  ) {
    const dialect = config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (dialect !== "postgres" && dialect !== "mariadb")
      throw new Error("Unsupported in-app reminder database engine.");
    this.dialect = dialect;
    if (dialect === "mariadb") {
      this.database = database.withPlugin(
        createMariaDbRowCodec({
          now: mariaDbDateTime,
          latest_created_at: mariaDbDateTime,
          member_id: mariaDbId,
        }),
      );
    }
  }

  async create(command: CreateInAppReminderCommand): Promise<InAppReminderResult> {
    const idempotencyKey = normalizeIdempotencyKey(command.idempotencyKey);
    // 같은 요청의 재전송(저장된 응답 반환)에는 푸시를 다시 넣지 않는다.
    let createdNow = false;

    const created = await this.database.transaction().execute(async (transaction) => {
      // MariaDB exposes statement time: pin the first DB6 reading before any lock wait.
      const transactionTime =
        this.dialect === "mariadb" ? await this.readTransactionTime(transaction) : sql<Date>`now()`;
      // Authorization and the current resource lock deliberately precede replay lookup.
      const context = await command.lockContext(transaction);
      if (context.resourceId !== command.resourceId) {
        throw new Error("Locked in-app reminder resource does not match the requested resource.");
      }

      const routeKey = createIdempotencyRouteKey(
        routeFor(command.reminderType, command.resourceId),
        context.classId,
      );
      const requestHash = createIdempotencyRequestHash({
        body: { content_revision: command.contentRevision },
        effectiveClassId: context.classId,
      });
      const lockIdentity = JSON.stringify([command.actorUserId, routeKey, idempotencyKey]);

      if (this.dialect === "postgres") {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))`.execute(
          transaction,
        );
      }
      // Both callers first lock the actor's users row, then class/member/resource rows.
      // That actor lock serializes every matching MariaDB idempotency key until commit.
      // Do not retry this callback: a new operation consumes the external Redis limiter.

      const stored = await transaction
        .selectFrom("api_idempotency_keys")
        .select(["request_hash", "response_body_json", "response_status"])
        .where("actor_user_id", "=", command.actorUserId)
        .where("route_key", "=", routeKey)
        .where("idempotency_key", "=", idempotencyKey)
        .where("expires_at", ">", transactionTime)
        .executeTakeFirst();
      if (stored !== undefined) {
        if (!hashesMatch(stored.request_hash, requestHash)) {
          throw new IdempotencyKeyReusedError();
        }
        if (stored.response_status !== 201) {
          throw new Error(
            "Stored in-app reminder response status does not match the API contract.",
          );
        }
        let response: unknown = stored.response_body_json;
        if (this.dialect === "mariadb") {
          if (typeof response !== "string")
            throw new Error("Stored in-app reminder response body is invalid.");
          try {
            response = JSON.parse(response) as unknown;
          } catch {
            throw new Error("Stored in-app reminder response body is invalid.");
          }
        }
        return storedResult(response);
      }

      if (context.contentRevision !== command.contentRevision) {
        throw new InAppReminderContentRevisionChangedException(context.contentRevision);
      }

      // Replays do not consume the technical limiter. New operations fail closed before any write.
      const limit = await this.rateLimiter.consume({
        key: rateLimitKey(command.actorUserId),
        limit: 30,
        windowSeconds: 60,
      });
      if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds, limit);

      await transaction
        .deleteFrom("api_idempotency_keys")
        .where("actor_user_id", "=", command.actorUserId)
        .where("route_key", "=", routeKey)
        .where("idempotency_key", "=", idempotencyKey)
        .where("expires_at", "<=", transactionTime)
        .execute();

      const clock = await transaction
        .selectNoFrom(
          (this.dialect === "mariadb"
            ? sql<Date>`UTC_TIMESTAMP(6)`
            : sql<Date>`clock_timestamp()`
          ).as("now"),
        )
        .executeTakeFirstOrThrow();
      const unresolvedMemberIds = await this.findUnresolvedMemberIds(
        transaction,
        command.reminderType,
        context.classId,
        context.resourceId,
        context.contentRevision,
      );
      if (unresolvedMemberIds.length === 0) {
        throw new InAppReminderNoUnresolvedRecipientsException();
      }

      const latestRequests = await this.findLatestRequests(
        transaction,
        command.reminderType,
        context.classId,
        context.resourceId,
        context.contentRevision,
        unresolvedMemberIds,
        clock.now,
      );
      const latestByMember = new Map(
        latestRequests.map((row) => [row.member_id, asDate(row.latest_created_at)]),
      );
      const eligibleMemberIds = unresolvedMemberIds.filter(
        (memberId) => !latestByMember.has(memberId),
      );
      const nextAvailableAt =
        latestRequests.length === 0
          ? null
          : new Date(
              Math.min(
                ...latestRequests.map(
                  (row) =>
                    asDate(row.latest_created_at).getTime() + COOLDOWN_HOURS * 60 * 60 * 1_000,
                ),
              ),
            );

      if (eligibleMemberIds.length === 0) {
        const next = nextAvailableAt as Date;
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((next.getTime() - asDate(clock.now).getTime()) / 1_000),
        );
        throw new InAppReminderCooldownException(next.toISOString(), retryAfterSeconds);
      }

      const batchId = randomUUID();
      // The existing cooldown policy uses an application Date (milliseconds) for both writes.
      const createdAt = this.dialect === "mariadb" ? mariaDbDateBinding(clock.now) : clock.now;
      await transaction
        .insertInto("in_app_reminder_batches")
        .values({
          class_id: context.classId,
          content_revision: context.contentRevision,
          created_at: createdAt,
          created_by_member_id: context.actorMemberId,
          id: batchId,
          notice_id: command.reminderType === "notice" ? context.resourceId : null,
          supply_id: command.reminderType === "supply" ? context.resourceId : null,
        })
        .execute();
      await transaction
        .insertInto("in_app_reminder_recipients")
        .values(
          eligibleMemberIds.map((memberId) => ({
            batch_id: batchId,
            class_id: context.classId,
            created_at: createdAt,
            member_id: memberId,
            resolved_at: null,
          })),
        )
        .execute();

      const result: InAppReminderResultJson = {
        batch_id: batchId,
        cooldown_suppressed_count: latestRequests.length,
        created_at: asDate(clock.now).toISOString(),
        created_count: eligibleMemberIds.length,
        current_unresolved_count: unresolvedMemberIds.length,
        next_available_at: nextAvailableAt?.toISOString() ?? null,
      };
      await transaction
        .insertInto("audit_logs")
        .values({
          action:
            command.reminderType === "notice"
              ? "notice.reminder_created"
              : "supply.reminder_created",
          actor_display_name_snapshot: context.actorDisplayName,
          actor_member_id: context.actorMemberId,
          actor_role_snapshot: "teacher",
          actor_user_id: command.actorUserId,
          after_json: this.json({
            reminder_batch_id: batchId,
            content_revision: context.contentRevision,
            current_unresolved_count: unresolvedMemberIds.length,
            created_count: eligibleMemberIds.length,
            cooldown_suppressed_count: latestRequests.length,
          }),
          ...(this.dialect === "mariadb" ? { created_at: transactionTime } : {}),
          before_json: null,
          class_id: context.classId,
          reason: null,
          request_id: command.requestId,
          target_id: context.resourceId,
          target_snapshot: null,
          target_type: command.reminderType,
        })
        .execute();
      await transaction
        .insertInto("api_idempotency_keys")
        .values({
          actor_user_id: command.actorUserId,
          expires_at:
            this.dialect === "mariadb"
              ? sql<Date>`${transactionTime} + INTERVAL 24 HOUR`
              : sql<Date>`now() + interval '24 hours'`,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          response_body_json: this.json(result),
          response_status: 201,
          route_key: routeKey,
          ...(this.dialect === "mariadb" ? { created_at: transactionTime } : {}),
        })
        .execute();

      createdNow = true;
      return result;
    });
    if (createdNow && created.created_count > 0 && this.pushOutbox) {
      try {
        await this.pushOutbox.enqueueReminderBatch(created.batch_id);
      } catch {
        // 푸시 대기열 실패가 이미 저장된 재알림을 실패로 만들지 않게 한다.
        reminderLogger.warn({ failure_code: "push_enqueue_failed" });
      }
    }
    return created;
  }

  async resolve(
    transaction: Transaction<DB>,
    command: ResolveInAppRemindersCommand,
  ): Promise<void> {
    if (this.dialect === "mariadb") {
      const resourceColumn =
        command.reminderType === "notice" ? sql.ref("batch.notice_id") : sql.ref("batch.supply_id");
      await sql`
        UPDATE in_app_reminder_recipients AS recipient
        SET resolved_at = UTC_TIMESTAMP(6)
        WHERE recipient.class_id = ${mariaDbId(command.classId)}
          AND recipient.member_id = ${mariaDbId(command.memberId)}
          AND recipient.resolved_at IS NULL
          AND EXISTS (
            SELECT 1 FROM in_app_reminder_batches AS batch
            WHERE batch.id = recipient.batch_id
              AND batch.class_id = ${mariaDbId(command.classId)}
              AND ${resourceColumn} = ${mariaDbId(command.resourceId)}
              AND batch.content_revision = ${mariaDbId(command.contentRevision)}
          )
      `.execute(transaction);
      return;
    }
    if (command.reminderType === "notice") {
      await sql`
        UPDATE in_app_reminder_recipients AS recipient
        SET resolved_at = clock_timestamp()
        WHERE recipient.class_id = ${command.classId}::bigint
          AND recipient.member_id = ${command.memberId}::bigint
          AND recipient.resolved_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM in_app_reminder_batches AS batch
            WHERE batch.id = recipient.batch_id
              AND batch.class_id = ${command.classId}::bigint
              AND batch.notice_id = ${command.resourceId}::bigint
              AND batch.content_revision = ${command.contentRevision}::bigint
          )
      `.execute(transaction);
      return;
    }

    await sql`
      UPDATE in_app_reminder_recipients AS recipient
      SET resolved_at = clock_timestamp()
      WHERE recipient.class_id = ${command.classId}::bigint
        AND recipient.member_id = ${command.memberId}::bigint
        AND recipient.resolved_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM in_app_reminder_batches AS batch
          WHERE batch.id = recipient.batch_id
            AND batch.class_id = ${command.classId}::bigint
            AND batch.supply_id = ${command.resourceId}::bigint
            AND batch.content_revision = ${command.contentRevision}::bigint
        )
    `.execute(transaction);
  }

  private async findUnresolvedMemberIds(
    transaction: Transaction<DB>,
    reminderType: InAppReminderType,
    classId: string,
    resourceId: string,
    contentRevision: string,
  ): Promise<string[]> {
    if (reminderType === "notice") {
      const result = await sql<{ member_id: string }>`
        SELECT member.id AS member_id
        FROM class_members AS member
        INNER JOIN users AS account ON account.id = member.user_id
        LEFT JOIN notice_reads AS notice_read
          ON notice_read.member_id = member.id
          AND notice_read.notice_id = ${this.bigint(resourceId)}
        WHERE member.class_id = ${this.bigint(classId)}
          AND member.role = 'student'
          AND member.status = 'approved'
          AND account.is_active = TRUE
          AND account.deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM notices AS source_notice
            WHERE source_notice.id = ${this.bigint(resourceId)}
              AND source_notice.class_id = ${this.bigint(classId)}
              AND (
                source_notice.audience_mode = 'legacy_class'
                OR EXISTS (
                  SELECT 1
                  FROM notice_recipients AS audience_recipient
                  WHERE audience_recipient.notice_id = source_notice.id
                    AND audience_recipient.class_id = source_notice.class_id
                    AND audience_recipient.member_id = member.id
                )
              )
          )
          AND (
            notice_read.id IS NULL
            OR notice_read.confirmed_revision < ${this.bigint(contentRevision)}
          )
        ORDER BY member.id ASC
      `.execute(transaction);
      return result.rows.map((row) => row.member_id);
    }

    const result = await sql<{ member_id: string }>`
      SELECT member.id AS member_id
      FROM class_members AS member
      INNER JOIN users AS account ON account.id = member.user_id
      LEFT JOIN supply_checks AS supply_check
        ON supply_check.member_id = member.id
        AND supply_check.supply_id = ${this.bigint(resourceId)}
      WHERE member.class_id = ${this.bigint(classId)}
        AND member.role = 'student'
        AND member.status = 'approved'
        AND account.is_active = TRUE
        AND account.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM supplies AS source_supply
          WHERE source_supply.id = ${this.bigint(resourceId)}
            AND source_supply.class_id = ${this.bigint(classId)}
            AND (
              source_supply.audience_mode = 'legacy_class'
              OR EXISTS (
                SELECT 1
                FROM supply_recipients AS audience_recipient
                WHERE audience_recipient.supply_id = source_supply.id
                  AND audience_recipient.class_id = source_supply.class_id
                  AND audience_recipient.member_id = member.id
              )
            )
        )
        AND (
          supply_check.id IS NULL
          OR supply_check.is_checked = FALSE
          OR supply_check.confirmed_revision IS NULL
          OR supply_check.confirmed_revision < ${this.bigint(contentRevision)}
        )
      ORDER BY member.id ASC
    `.execute(transaction);
    return result.rows.map((row) => row.member_id);
  }

  private async findLatestRequests(
    transaction: Transaction<DB>,
    reminderType: InAppReminderType,
    classId: string,
    resourceId: string,
    contentRevision: string,
    memberIds: string[],
    now: Date,
  ): Promise<Array<{ latest_created_at: Date | string; member_id: string }>> {
    let query = transaction
      .selectFrom("in_app_reminder_recipients as recipient")
      .innerJoin("in_app_reminder_batches as batch", "batch.id", "recipient.batch_id")
      .select(["recipient.member_id", sql<Date>`MAX(recipient.created_at)`.as("latest_created_at")])
      .where("recipient.member_id", "in", memberIds)
      .where("batch.class_id", "=", classId)
      .where("batch.content_revision", "=", contentRevision)
      .where(
        "recipient.created_at",
        ">",
        this.dialect === "mariadb"
          ? sql<Date>`${mariaDbDateBinding(now)} - INTERVAL 24 HOUR`
          : sql<Date>`${now}::timestamptz - interval '24 hours'`,
      );
    query =
      reminderType === "notice"
        ? query.where("batch.notice_id", "=", resourceId)
        : query.where("batch.supply_id", "=", resourceId);
    return query.groupBy("recipient.member_id").execute();
  }

  private bigint(value: string) {
    return this.dialect === "mariadb" ? sql`${mariaDbId(value)}` : sql`${value}::bigint`;
  }

  private json(value: JsonValue): JsonValue | RawBuilder<JsonValue> {
    return this.dialect === "mariadb" ? sql<JsonValue>`${JSON.stringify(value)}` : value;
  }

  private async readTransactionTime(transaction: Transaction<DB>): Promise<RawBuilder<Date>> {
    const row = await transaction
      .selectNoFrom(
        sql<string>`DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f')`.as("transaction_time"),
      )
      .executeTakeFirstOrThrow();
    return mariaDbDateBinding(mariaDbTimestamp(row.transaction_time));
  }
}
