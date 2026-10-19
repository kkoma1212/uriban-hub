import {
  SECURITY_AUDIT_CONSUMER_GROUP,
  SECURITY_AUDIT_DEAD_LETTER_STREAM,
  SECURITY_AUDIT_STREAM,
} from "@classhub/db";
import type { RedisClientType } from "redis";

import type { SecurityAuditQueueMetadata } from "./processing-status.js";

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Invalid audit queue metadata count.");
  }
  return value;
}

export async function readSecurityAuditQueueMetadata(
  redis: RedisClientType,
): Promise<SecurityAuditQueueMetadata> {
  // EXEC keeps the metadata reads coherent. The newest dead-letter entry is fetched only for its
  // stream ID (= quarantine time); its body is dropped here and never logged or returned.
  const [entries, groups, pending, quarantine, newestQuarantine] = await redis
    .multi()
    .xLen(SECURITY_AUDIT_STREAM)
    .xInfoGroups(SECURITY_AUDIT_STREAM)
    .xPending(SECURITY_AUDIT_STREAM, SECURITY_AUDIT_CONSUMER_GROUP)
    .xLen(SECURITY_AUDIT_DEAD_LETTER_STREAM)
    .xRevRange(SECURITY_AUDIT_DEAD_LETTER_STREAM, "+", "-", { COUNT: 1 })
    .execTyped();
  const group = groups.find((candidate) => candidate.name === SECURITY_AUDIT_CONSUMER_GROUP);
  if (group === undefined || count(group.pending) !== count(pending.pending)) {
    throw new TypeError("Audit queue consumer group metadata is unavailable.");
  }
  const rawTimestamp =
    typeof pending.firstId === "string" && /^\d+-\d+$/u.test(pending.firstId)
      ? Number(pending.firstId.split("-", 1)[0])
      : Number.NaN;
  const newestQuarantineId = Array.isArray(newestQuarantine) ? newestQuarantine[0]?.id : undefined;
  const quarantineTimestamp =
    typeof newestQuarantineId === "string" && /^\d+-\d+$/u.test(newestQuarantineId)
      ? Number(newestQuarantineId.split("-", 1)[0])
      : Number.NaN;
  const oldestPendingEnqueuedAtMs =
    Number.isSafeInteger(rawTimestamp) && rawTimestamp >= 0 && rawTimestamp <= Date.now()
      ? rawTimestamp
      : null;
  return {
    queueEntries: count(entries),
    pendingEntries: count(pending.pending),
    // Redis may return null when it cannot calculate lag; never turn that into zero.
    undeliveredLag: group.lag == null ? null : count(group.lag),
    oldestPendingEnqueuedAtMs,
    quarantineEntries: count(quarantine),
    latestQuarantineAtMs:
      Number.isSafeInteger(quarantineTimestamp) && quarantineTimestamp >= 0
        ? quarantineTimestamp
        : null,
  };
}
