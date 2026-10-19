import { describe, expect, it } from "vitest";

import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import {
  clientErrorBucketKey,
  ClientErrorStore,
  normalizeClientErrorRoute,
  type ClientErrorBuckets,
  type ClientErrorReport,
} from "./client-errors.store.js";

const report = (values: Partial<ClientErrorReport> = {}): ClientErrorReport => ({
  device: "phone",
  name: "TypeError",
  role: "student",
  route: "/notices/:id",
  source: "script",
  ...values,
});
const HOUR = 60 * 60 * 1000;
const START = Date.parse("2026-10-05T00:00:00.000Z");

/** Redis 해시와 같은 규칙(c:/f:/l: 칸, 종류 상한)으로 메모리에서 흉내 낸다. */
function memoryBuckets(): ClientErrorBuckets & { keys: () => string[] } {
  const store = new Map<string, Record<string, string>>();
  return {
    keys: () => [...store.keys()],
    async increment(key, field, at, maxKinds) {
      const bucket = store.get(key) ?? {};
      if (bucket[`c:${field}`] === undefined && Object.keys(bucket).length >= maxKinds * 3)
        return false;
      bucket[`c:${field}`] = String(Number(bucket[`c:${field}`] ?? 0) + 1);
      bucket[`f:${field}`] ??= String(at);
      bucket[`l:${field}`] = String(at);
      store.set(key, bucket);
      return true;
    },
    async read(keys) {
      return keys.map((key) => ({ ...(store.get(key) ?? {}) }));
    },
  };
}

function limiter(limitPerSender = 30) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const fake = {
    async consume({ key }: { key: string }) {
      keys.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { allowed: count <= limitPerSender };
    },
  };
  return { keys, limiter: fake as unknown as RedisRateLimiter };
}

describe("ClientErrorStore", () => {
  it("adds the same kind across hourly buckets and lists the most frequent first", async () => {
    const store = new ClientErrorStore(memoryBuckets(), limiter().limiter);
    await store.record("1", report(), START);
    await store.record("2", report(), START + 2 * HOUR);
    await store.record("3", report({ name: "ChunkLoadError", source: "chunk" }), START + 3 * HOUR);

    const summary = await store.summary(START + 3 * HOUR + 1000);
    expect(summary).toMatchObject({ total: 3, window_hours: 24 });
    expect(summary.kinds.map((kind) => [kind.name, kind.count])).toEqual([
      ["TypeError", 2],
      ["ChunkLoadError", 1],
    ]);
    expect(summary.kinds[0]).toMatchObject({
      first_seen_at: "2026-10-05T00:00:00.000Z",
      last_seen_at: "2026-10-05T02:00:00.000Z",
    });
  });

  it("reads only the last 24 hourly buckets", async () => {
    const store = new ClientErrorStore(memoryBuckets(), limiter().limiter);
    await store.record("1", report(), START);
    expect((await store.summary(START + 23 * HOUR)).total).toBe(1);
    expect((await store.summary(START + 24 * HOUR)).kinds).toEqual([]);
  });

  it("keeps the sender out of keys and results and stops when the sender's budget is used", async () => {
    const buckets = memoryBuckets();
    const budget = limiter(2);
    const store = new ClientErrorStore(buckets, budget.limiter);
    expect(await store.record("42", report(), START)).toBe(true);
    expect(await store.record("42", report(), START)).toBe(true);
    expect(await store.record("42", report(), START)).toBe(false);
    expect((await store.summary(START)).total).toBe(2);
    expect(budget.keys[0]).toMatch(/^classhub:client-errors:sender:[0-9a-f]{32}$/u);
    expect(JSON.stringify([budget.keys, buckets.keys(), await store.summary(START)])).not.toMatch(
      /:42\b|"42"/u,
    );
  });

  it("refuses new kinds once an hourly bucket holds 200", async () => {
    const store = new ClientErrorStore(memoryBuckets(), limiter(1_000).limiter);
    for (let index = 0; index < 200; index++)
      expect(await store.record(String(index), report({ route: `/r${index}` }), START)).toBe(true);
    expect(await store.record("x", report({ route: "/new" }), START)).toBe(false);
    // 이미 있는 종류는 계속 센다.
    expect(await store.record("x", report({ route: "/r0" }), START)).toBe(true);
    expect((await store.summary(START)).kinds).toHaveLength(200);
  });

  it("uses one key per hour and normalizes routes", () => {
    expect(clientErrorBucketKey(START)).toBe(clientErrorBucketKey(START + HOUR - 1));
    expect(clientErrorBucketKey(START)).not.toBe(clientErrorBucketKey(START + HOUR));
    expect(normalizeClientErrorRoute("/notices/123")).toBe("/notices/:id");
    expect(normalizeClientErrorRoute("/signup-approval/abcdefghijklmnopqrstuvwxyz0123")).toBe(
      "/signup-approval/:id",
    );
    expect(normalizeClientErrorRoute("/help-requests/ask")).toBe("/help-requests/ask");
  });
});
