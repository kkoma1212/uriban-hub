import { SECURITY_AUDIT_CONSUMER_GROUP } from "@classhub/db";
import type { RedisClientType } from "redis";
import { describe, expect, it, vi } from "vitest";

import { readSecurityAuditQueueMetadata } from "./queue-metadata.js";

function client(result: unknown) {
  const transaction = {
    xLen: vi.fn().mockReturnThis(),
    xInfoGroups: vi.fn().mockReturnThis(),
    xPending: vi.fn().mockReturnThis(),
    xRevRange: vi.fn().mockReturnThis(),
    execTyped: vi.fn().mockResolvedValue(result),
  };
  const redis = { multi: vi.fn(() => transaction) } as unknown as RedisClientType;
  return { redis, transaction };
}

describe("readSecurityAuditQueueMetadata", () => {
  it("returns aggregate counts and enqueue time without exposing consumer or message identifiers", async () => {
    const timestamp = Date.now() - 65_000;
    const { redis, transaction } = client([
      3,
      [{ name: SECURITY_AUDIT_CONSUMER_GROUP, pending: 2, lag: 1 }],
      {
        pending: 2,
        firstId: `${timestamp}-123`,
        consumers: [{ name: "private-host:private-pid", deliveriesCounter: 2 }],
      },
      130,
      [{ id: "1789993800000-4", message: { event: "private-event-body" } }],
    ]);
    const result = await readSecurityAuditQueueMetadata(redis);
    expect(result).toEqual({
      queueEntries: 3,
      pendingEntries: 2,
      undeliveredLag: 1,
      oldestPendingEnqueuedAtMs: timestamp,
      quarantineEntries: 130,
      latestQuarantineAtMs: 1789993800000,
    });
    // 격리 기록 본문은 버리고 시각만 남긴다.
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain(`${timestamp}-123`);
    expect(transaction.execTyped).toHaveBeenCalledWith();
  });

  it.each([null, `${Date.now() + 86_400_000}-0`, "malformed-id", "999999999999999999999-1"])(
    "keeps unprovable pending age unknown: %s",
    async (firstId) => {
      const { redis } = client([
        1,
        [{ name: SECURITY_AUDIT_CONSUMER_GROUP, pending: 1, lag: null }],
        { pending: 1, firstId },
        0,
        [],
      ]);
      await expect(readSecurityAuditQueueMetadata(redis)).resolves.toMatchObject({
        oldestPendingEnqueuedAtMs: null,
        undeliveredLag: null,
      });
    },
  );

  it.each([
    [0, [], { pending: 0, firstId: null }, 0],
    [
      0,
      [{ name: SECURITY_AUDIT_CONSUMER_GROUP, pending: 1, lag: 0 }],
      { pending: 0, firstId: null },
      0,
    ],
    [
      -1,
      [{ name: SECURITY_AUDIT_CONSUMER_GROUP, pending: 0, lag: 0 }],
      { pending: 0, firstId: null },
      0,
    ],
    [
      0,
      [{ name: SECURITY_AUDIT_CONSUMER_GROUP, pending: 0, lag: "0" }],
      { pending: 0, firstId: null },
      0,
    ],
    [
      0,
      [{ name: SECURITY_AUDIT_CONSUMER_GROUP, pending: 0, lag: 0 }],
      { pending: 0, firstId: null },
      Number.MAX_SAFE_INTEGER + 1,
    ],
  ])(
    "rejects absent, inconsistent, or invalid metadata without claiming an empty queue",
    async (...result) => {
      const { redis } = client(result);
      await expect(readSecurityAuditQueueMetadata(redis)).rejects.toThrow(TypeError);
    },
  );
});
