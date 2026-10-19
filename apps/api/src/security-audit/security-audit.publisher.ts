import { createHash } from "node:crypto";

import {
  securityAuditDeduplicationScope,
  SECURITY_AUDIT_EVENT_FIELD,
  SECURITY_AUDIT_EVENT_ID_FIELD,
  SECURITY_AUDIT_OCCURRED_AT_FIELD,
  SECURITY_AUDIT_STREAM,
  serializeSecurityAuditEvent,
  type SecurityAuditEvent,
} from "@classhub/db";
import { createClient } from "redis";

import type {
  SecurityAuditFallbackLogger,
  SecurityAuditPublisher,
} from "./security-audit.types.js";
const SECURITY_AUDIT_PUBLISH_DEDUP_PREFIX = "{classhub-security-audit}:publish-dedup:v1:";
const XADD_WITH_DEDUP_GATE_SCRIPT = `
if redis.call("EXISTS", KEYS[2]) == 1 then
  return false
end
local stream_id = redis.call(
  "XADD", KEYS[1], "*",
  ARGV[1], ARGV[2],
  ARGV[3], ARGV[4],
  ARGV[5], ARGV[6]
)
redis.call("PSETEX", KEYS[2], ARGV[7], "1")
return stream_id
`;

const REDIS_OPERATION_TIMEOUT_MS = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function safeIdentifier(value: unknown): string {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : "unknown";
}

function createSecurityAuditClient(url: string) {
  return createClient({
    disableOfflineQueue: true,
    socket: {
      connectTimeout: REDIS_OPERATION_TIMEOUT_MS,
      reconnectStrategy: false,
    },
    url,
  });
}

type SecurityAuditRedisClient = ReturnType<typeof createSecurityAuditClient>;

export class RedisSecurityAuditPublisher implements SecurityAuditPublisher {
  private connectPromise: Promise<void> | undefined;

  constructor(
    private readonly client: SecurityAuditRedisClient,
    private readonly fallbackLogger: SecurityAuditFallbackLogger,
  ) {}

  async publish(event: SecurityAuditEvent): Promise<void> {
    let serialized: string;
    try {
      serialized = serializeSecurityAuditEvent(event);
    } catch {
      this.logFallback({
        action: "security_audit.publish_failed",
        event_id: safeIdentifier(event.event_id),
        failure_code: "security_event_invalid",
        request_id: safeIdentifier(event.request_id),
      });
      return;
    }

    try {
      await this.runWithDeadline(async () => {
        await this.ensureConnected();
        await this.appendWithUpstreamDeduplication(event, serialized);
      });
    } catch {
      this.destroyClient();
      this.logFallback({
        action: "security_audit.publish_failed",
        event_id: event.event_id,
        failure_code: "security_stream_unavailable",
        request_id: event.request_id,
      });
    }
  }

  private async appendWithUpstreamDeduplication(
    event: SecurityAuditEvent,
    serialized: string,
  ): Promise<void> {
    const scope = securityAuditDeduplicationScope(event);
    if (scope === null) {
      await this.client.xAdd(SECURITY_AUDIT_STREAM, "*", {
        [SECURITY_AUDIT_EVENT_FIELD]: serialized,
        [SECURITY_AUDIT_EVENT_ID_FIELD]: event.event_id,
        [SECURITY_AUDIT_OCCURRED_AT_FIELD]: event.occurred_at,
      });
      return;
    }

    const digest = createHash("sha256").update(scope.identity).digest("base64url");
    await this.client.eval(XADD_WITH_DEDUP_GATE_SCRIPT, {
      keys: [SECURITY_AUDIT_STREAM, `${SECURITY_AUDIT_PUBLISH_DEDUP_PREFIX}${digest}`],
      arguments: [
        SECURITY_AUDIT_EVENT_FIELD,
        serialized,
        SECURITY_AUDIT_EVENT_ID_FIELD,
        event.event_id,
        SECURITY_AUDIT_OCCURRED_AT_FIELD,
        event.occurred_at,
        String(scope.windowMs),
      ],
    });
  }

  async close(): Promise<void> {
    this.destroyClient();
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isReady) return;

    if (this.connectPromise !== undefined) {
      await this.connectPromise;
      return;
    }

    if (this.client.isOpen) {
      throw new Error("Security audit Redis client is open but not ready.");
    }

    this.connectPromise = this.client.connect().then(() => undefined);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async runWithDeadline<T>(operation: () => Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        this.destroyClient();
        reject(new Error("Security audit Redis operation timed out."));
      }, REDIS_OPERATION_TIMEOUT_MS);
      timeout.unref();
    });

    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private logFallback(entry: Parameters<SecurityAuditFallbackLogger["error"]>[0]): void {
    try {
      this.fallbackLogger.error(entry);
    } catch {
      // A broken stderr adapter must not escape the best-effort audit boundary.
    }
  }

  private destroyClient(): void {
    try {
      if (this.client.isOpen) this.client.destroy();
    } catch {
      // Redis cleanup is best effort and must not change the product decision.
    }
  }
}

export function createRedisSecurityAuditPublisher(
  redisUrl: string,
  fallbackLogger: SecurityAuditFallbackLogger,
): RedisSecurityAuditPublisher {
  const client = createSecurityAuditClient(redisUrl);
  client.on("error", () => undefined);
  return new RedisSecurityAuditPublisher(client, fallbackLogger);
}
