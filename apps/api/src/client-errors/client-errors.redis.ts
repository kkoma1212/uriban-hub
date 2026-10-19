import type { OnApplicationShutdown } from "@nestjs/common";
import { createClient } from "redis";

import type { ClientErrorBuckets } from "./client-errors.store.js";

/** 25시간 — 24시간 창의 가장 오래된 묶음도 읽을 때까지 남게 한 시간 여유를 둔다. */
const BUCKET_TTL_SECONDS = 25 * 60 * 60;
const REDIS_OPERATION_TIMEOUT_MS = 1_000;

// 새 종류는 묶음이 꽉 차지 않았을 때만 받는다(한 종류 = 칸 3개). 원자적으로 검사·기록한다.
const INCREMENT_SCRIPT = `
local count = 'c:' .. ARGV[1]
if redis.call('HEXISTS', KEYS[1], count) == 0 and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) * 3 then
  return 0
end
redis.call('HINCRBY', KEYS[1], count, 1)
redis.call('HSETNX', KEYS[1], 'f:' .. ARGV[1], ARGV[2])
redis.call('HSET', KEYS[1], 'l:' .. ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`;

function createBucketClient(url: string) {
  return createClient({
    disableOfflineQueue: true,
    socket: { connectTimeout: 1_000, reconnectStrategy: false },
    url,
  });
}

/** 요청 제한과 같은 연결 규칙(1초 안에 안 되면 실패, 끊기면 다음 호출 때 다시 연결). */
export class RedisClientErrorBuckets implements ClientErrorBuckets, OnApplicationShutdown {
  private readonly client: ReturnType<typeof createBucketClient>;
  private connectPromise: Promise<void> | undefined;

  constructor(url: string) {
    this.client = createBucketClient(url);
    this.client.on("error", () => undefined);
  }

  async increment(key: string, field: string, at: number, maxKinds: number): Promise<boolean> {
    const result = await this.withDeadline(() =>
      this.client.eval(INCREMENT_SCRIPT, {
        arguments: [field, String(at), String(maxKinds), String(BUCKET_TTL_SECONDS)],
        keys: [key],
      }),
    );
    return Number(result) === 1;
  }

  async read(keys: string[]): Promise<Array<Record<string, string>>> {
    return this.withDeadline(() => Promise.all(keys.map((key) => this.client.hGetAll(key))));
  }

  onApplicationShutdown(): void {
    if (this.client.isOpen) this.client.destroy();
  }

  private async withDeadline<T>(operation: () => Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error("Client error store timed out."));
        if (this.client.isOpen) this.client.destroy();
      }, REDIS_OPERATION_TIMEOUT_MS);
      timeout.unref();
    });
    try {
      return await Promise.race([this.connect().then(operation), deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async connect(): Promise<void> {
    if (this.client.isReady) return;
    if (this.connectPromise === undefined) {
      if (this.client.isOpen) throw new Error("Redis client is open but not ready.");
      this.connectPromise = this.client
        .connect()
        .then(() => undefined)
        .finally(() => {
          this.connectPromise = undefined;
        });
    }
    await this.connectPromise;
  }
}
