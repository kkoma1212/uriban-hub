import { randomUUID } from "node:crypto";

import { createClient } from "redis";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisClientErrorBuckets } from "../src/client-errors/client-errors.redis.js";

let container: StartedNativeTestService;
let buckets: RedisClientErrorBuckets;
let observer: ReturnType<typeof createClient>;

beforeAll(async () => {
  container = await startNativeTestService("redis");
  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  buckets = new RedisClientErrorBuckets(url);
  observer = createClient({ url });
  observer.on("error", () => undefined);
  await observer.connect();
});

afterAll(async () => {
  if (observer?.isReady) await observer.quit();
  buckets?.onApplicationShutdown();
  await container?.stop();
});

describe("RedisClientErrorBuckets", () => {
  it("counts a kind, keeps its first and last time, and expires the bucket after 25 hours", async () => {
    const key = `classhub:client-errors:test:${randomUUID()}`;
    expect(await buckets.increment(key, "script|TypeError|/a|student|phone", 1000, 2)).toBe(true);
    expect(await buckets.increment(key, "script|TypeError|/a|student|phone", 2000, 2)).toBe(true);

    const [bucket] = await buckets.read([key]);
    expect(bucket).toEqual({
      "c:script|TypeError|/a|student|phone": "2",
      "f:script|TypeError|/a|student|phone": "1000",
      "l:script|TypeError|/a|student|phone": "2000",
    });
    const ttl = await observer.ttl(key);
    expect(ttl).toBeGreaterThan(24 * 60 * 60);
    expect(ttl).toBeLessThanOrEqual(25 * 60 * 60);
  });

  it("refuses a new kind when the bucket is full but keeps counting existing ones", async () => {
    const key = `classhub:client-errors:test:${randomUUID()}`;
    expect(await buckets.increment(key, "a", 1, 2)).toBe(true);
    expect(await buckets.increment(key, "b", 2, 2)).toBe(true);
    expect(await buckets.increment(key, "c", 3, 2)).toBe(false);
    expect(await buckets.increment(key, "a", 4, 2)).toBe(true);
    const [bucket] = await buckets.read([key]);
    expect(bucket?.["c:a"]).toBe("2");
    expect(bucket?.["c:c"]).toBeUndefined();
  });

  it("reads missing buckets as empty", async () => {
    expect(await buckets.read([`classhub:client-errors:test:${randomUUID()}`])).toEqual([{}]);
  });
});
