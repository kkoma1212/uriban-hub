import {
  parseSecurityAuditEvent,
  SECURITY_AUDIT_CONSUMER_GROUP,
  SECURITY_AUDIT_DEAD_LETTER_INDEX,
  SECURITY_AUDIT_DEAD_LETTER_STREAM,
  SECURITY_AUDIT_EVENT_FIELD,
  SECURITY_AUDIT_EVENT_ID_FIELD,
  SECURITY_AUDIT_OCCURRED_AT_FIELD,
  SECURITY_AUDIT_STREAM,
  serializeSecurityAuditEvent,
  type DB,
  type SecurityAuditEvent,
} from "@classhub/db";
import type { Kysely } from "kysely";
import type { RedisClientType } from "redis";
import { PostgresSecurityAuditStore } from "./postgres-security-audit-store.js";
import type { SecurityAuditStore } from "./security-audit-store.js";
import {
  classifySecurityAuditStoreFailure,
  type SecurityAuditStoreFailureCounts,
} from "./store-failure.js";

const RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const SECURITY_AUDIT_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_CLAIM_PAGES = 5;
const DEAD_LETTER_INDEX_SCAN_COUNT = 1_000;
const ACK_AND_DELETE_SCRIPT = `
local acknowledged = redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
if acknowledged == 1 then
  redis.call('XDEL', KEYS[1], ARGV[2])
end
return acknowledged
`;
const DEAD_LETTER_SCRIPT = `
local existing = redis.call('HGET', KEYS[3], ARGV[1])
local added = 0

if not existing then
  local dead_letter_id = redis.call(
    'XADD', KEYS[2], '*',
    'source_message_id', ARGV[2],
    'event_id', ARGV[3],
    'occurred_at', ARGV[4],
    'final_failure_code', ARGV[5],
    'dead_lettered_at', ARGV[6],
    'event', ARGV[7]
  )
  redis.call('HSET', KEYS[3], ARGV[1], dead_letter_id)
  redis.call('EXPIRE', KEYS[3], 15552000)
  added = 1
end

local acknowledged = redis.call('XACK', KEYS[1], ARGV[8], ARGV[2])
if acknowledged == 1 then
  redis.call('XDEL', KEYS[1], ARGV[2])
end
return { added, acknowledged }
`;
const TRIM_DEAD_LETTERS_SCRIPT = `
redis.call('XTRIM', KEYS[1], 'MINID', ARGV[1])

local scan = redis.call('HSCAN', KEYS[2], ARGV[2], 'COUNT', ARGV[3])
local entries = scan[2]
local removed = 0

for index = 1, #entries, 2 do
  local dead_letter_id = entries[index + 1]
  local separator = string.find(dead_letter_id, '-', 1, true)
  if separator then
    local timestamp = tonumber(string.sub(dead_letter_id, 1, separator - 1))
    if timestamp and timestamp < tonumber(ARGV[4]) then
      redis.call('HDEL', KEYS[2], entries[index])
      removed = removed + 1
    end
  end
end

return { scan[1], removed }
`;

export type SecurityAuditRedisClient = RedisClientType;

export interface SecurityAuditWorkerLogger {
  error(
    entry: {
      action: "security_audit.dead_lettered";
      event_id: string;
      failure_code: "database_retry_window_exceeded" | "invalid_event";
      source_message_id: string;
    },
    message?: string,
  ): void;
}

export interface SecurityAuditWorkerOptions {
  consumerName: string;
  persistence?: SecurityAuditStore;
  retryMinIdleMs?: number;
  batchSize?: number;
  maxClaimPages?: number;
  now?: () => Date;
}

interface StreamMessage {
  id: string;
  message: Record<string, string>;
}

interface DecodedMessage {
  event: SecurityAuditEvent;
  serialized: string;
}

export interface SecurityAuditWorkerCycleResult {
  databaseFailures?: SecurityAuditStoreFailureCounts;
  acknowledged: number;
  deadLettered: number;
  deferred: number;
  invalid: number;
}

function emptyCycleResult(): SecurityAuditWorkerCycleResult {
  return { acknowledged: 0, deadLettered: 0, deferred: 0, invalid: 0 };
}

function recordDatabaseFailure(result: SecurityAuditWorkerCycleResult, error: unknown): void {
  const reason = classifySecurityAuditStoreFailure(error);
  const counts = (result.databaseFailures ??= {});
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("BUSYGROUP");
}

function parseDeadLetterResult(value: unknown): { acknowledged: boolean; added: boolean } {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError("Redis dead-letter script returned an invalid result.");
  }

  return { added: Number(value[0]) === 1, acknowledged: Number(value[1]) === 1 };
}

function parseDeadLetterTrimResult(value: unknown): { nextCursor: string; removed: number } {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError("Redis dead-letter trim script returned an invalid result.");
  }

  const nextCursor = String(value[0]);
  const removed = Number(value[1]);
  if (!/^\d+$/u.test(nextCursor) || !Number.isSafeInteger(removed) || removed < 0) {
    throw new TypeError("Redis dead-letter trim script returned invalid values.");
  }

  return { nextCursor, removed };
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }

  return value;
}

export class SecurityAuditWorker {
  private claimCursor = "0-0";
  private deadLetterIndexCursor = "0";
  private initialized = false;
  private readonly batchSize: number;
  private readonly maxClaimPages: number;
  private readonly retryMinIdleMs: number;
  private readonly now: () => Date;
  private readonly persistence: SecurityAuditStore;

  constructor(
    private readonly redis: SecurityAuditRedisClient,
    database: Kysely<DB>,
    private readonly logger: SecurityAuditWorkerLogger,
    private readonly options: SecurityAuditWorkerOptions,
  ) {
    this.batchSize = requirePositiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
    this.maxClaimPages = requirePositiveInteger(
      options.maxClaimPages ?? DEFAULT_MAX_CLAIM_PAGES,
      "maxClaimPages",
    );
    this.retryMinIdleMs = options.retryMinIdleMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
    this.persistence = options.persistence ?? new PostgresSecurityAuditStore(database);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.redis.xGroupCreate(SECURITY_AUDIT_STREAM, SECURITY_AUDIT_CONSUMER_GROUP, "0", {
        MKSTREAM: true,
      });
    } catch (error) {
      if (!isBusyGroupError(error)) throw error;
    }

    this.initialized = true;
  }

  async runOnce(blockMs = 0): Promise<SecurityAuditWorkerCycleResult> {
    await this.initialize();
    await this.trimExpiredDeadLetters();
    const result = emptyCycleResult();
    let processedClaimedMessage = false;

    for (let page = 0; page < this.maxClaimPages; page += 1) {
      const claimed = await this.redis.xAutoClaim(
        SECURITY_AUDIT_STREAM,
        SECURITY_AUDIT_CONSUMER_GROUP,
        this.options.consumerName,
        this.retryMinIdleMs,
        this.claimCursor,
        { COUNT: this.batchSize },
      );
      const claimedMessages = claimed.messages.filter(
        (message): message is StreamMessage => message !== null,
      );

      if (claimedMessages.length > 0) {
        processedClaimedMessage = true;
        await this.processMessages(claimedMessages, result);
      }

      this.claimCursor = claimed.nextId;
      if (this.claimCursor === "0-0") break;
    }

    const streams = await this.redis.xReadGroup(
      SECURITY_AUDIT_CONSUMER_GROUP,
      this.options.consumerName,
      { id: ">", key: SECURITY_AUDIT_STREAM },
      {
        COUNT: this.batchSize,
        ...(blockMs > 0 && !processedClaimedMessage ? { BLOCK: blockMs } : {}),
      },
    );

    for (const stream of streams ?? []) {
      await this.processMessages(stream.messages, result);
    }
    return result;
  }

  private async processMessages(
    messages: StreamMessage[],
    result: SecurityAuditWorkerCycleResult,
  ): Promise<void> {
    for (const message of messages) {
      const decoded = this.decodeMessage(message);
      if (decoded === null) {
        result.invalid += 1;
        if (await this.deadLetter(message, null, "invalid_event", "", this.now().toISOString())) {
          result.deadLettered += 1;
        }
        continue;
      }

      const processedAt = this.now();
      const ageMs = processedAt.getTime() - new Date(decoded.event.occurred_at).getTime();
      if (ageMs < -MAX_FUTURE_CLOCK_SKEW_MS) {
        result.invalid += 1;
        if (await this.deadLetter(message, null, "invalid_event", "", processedAt.toISOString())) {
          result.deadLettered += 1;
        }
        continue;
      }

      if (ageMs >= RETRY_WINDOW_MS) {
        let checkingDatabase = true;
        try {
          const alreadyHandled = await this.persistence.isEventAlreadyHandled(decoded.event);
          checkingDatabase = false;
          if (alreadyHandled) {
            if (await this.acknowledge(message.id)) result.acknowledged += 1;
            continue;
          }
        } catch (error) {
          // The existing fallback also catches a failed Redis ACK after a successful DB read.
          if (checkingDatabase) recordDatabaseFailure(result, error);
          // The 24-hour retry ceiling is authoritative even when the final DB probe is unavailable.
          // Dead-lettering below preserves only the validated canonical event, never the raw payload.
        }

        if (
          await this.deadLetter(
            message,
            decoded.event,
            "database_retry_window_exceeded",
            decoded.serialized,
            processedAt.toISOString(),
          )
        ) {
          result.deadLettered += 1;
        }
        continue;
      }

      try {
        await this.persistence.insertEvent(decoded.event);
      } catch (error) {
        recordDatabaseFailure(result, error);
        result.deferred += 1;
        continue;
      }

      if (await this.acknowledge(message.id)) result.acknowledged += 1;
    }
  }

  private decodeMessage(message: StreamMessage): DecodedMessage | null {
    const serialized = message.message[SECURITY_AUDIT_EVENT_FIELD];
    const envelopeEventId = message.message[SECURITY_AUDIT_EVENT_ID_FIELD];
    const envelopeOccurredAt = message.message[SECURITY_AUDIT_OCCURRED_AT_FIELD];

    if (
      serialized === undefined ||
      envelopeEventId === undefined ||
      envelopeOccurredAt === undefined
    ) {
      return null;
    }

    try {
      const event = parseSecurityAuditEvent(serialized);
      if (event.event_id !== envelopeEventId || event.occurred_at !== envelopeOccurredAt) {
        return null;
      }
      return { event, serialized: serializeSecurityAuditEvent(event) };
    } catch {
      return null;
    }
  }

  private async acknowledge(messageId: string): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(ACK_AND_DELETE_SCRIPT, {
          arguments: [SECURITY_AUDIT_CONSUMER_GROUP, messageId],
          keys: [SECURITY_AUDIT_STREAM],
        }),
      ) === 1
    );
  }

  private async trimExpiredDeadLetters(): Promise<void> {
    const cutoffMs = Math.max(0, this.now().getTime() - SECURITY_AUDIT_RETENTION_MS);
    const rawResult = await this.redis.eval(TRIM_DEAD_LETTERS_SCRIPT, {
      arguments: [
        `${cutoffMs}-0`,
        this.deadLetterIndexCursor,
        String(DEAD_LETTER_INDEX_SCAN_COUNT),
        String(cutoffMs),
      ],
      keys: [SECURITY_AUDIT_DEAD_LETTER_STREAM, SECURITY_AUDIT_DEAD_LETTER_INDEX],
    });
    this.deadLetterIndexCursor = parseDeadLetterTrimResult(rawResult).nextCursor;
  }

  private async deadLetter(
    message: StreamMessage,
    event: SecurityAuditEvent | null,
    failureCode: "database_retry_window_exceeded" | "invalid_event",
    safeSerializedEvent: string,
    deadLetteredAt: string,
  ): Promise<boolean> {
    const eventId = event?.event_id ?? "unknown";
    const occurredAt = event?.occurred_at ?? "unknown";
    const dedupKey = event === null ? `invalid:${message.id}` : `event:${event.event_id}`;
    const rawResult = await this.redis.eval(DEAD_LETTER_SCRIPT, {
      arguments: [
        dedupKey,
        message.id,
        eventId,
        occurredAt,
        failureCode,
        deadLetteredAt,
        safeSerializedEvent,
        SECURITY_AUDIT_CONSUMER_GROUP,
      ],
      keys: [
        SECURITY_AUDIT_STREAM,
        SECURITY_AUDIT_DEAD_LETTER_STREAM,
        SECURITY_AUDIT_DEAD_LETTER_INDEX,
      ],
    });
    const outcome = parseDeadLetterResult(rawResult);

    if (outcome.added) {
      this.logger.error(
        {
          action: "security_audit.dead_lettered",
          event_id: eventId,
          failure_code: failureCode,
          source_message_id: message.id,
        },
        "Security audit event moved to the dead-letter stream.",
      );
    }

    return outcome.added && outcome.acknowledged;
  }
}
