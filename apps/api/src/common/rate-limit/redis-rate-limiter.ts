import { createClient } from "redis";

import { RateLimitServiceUnavailableException } from "./rate-limit.errors.js";
import { DEFAULT_REQUEST_LIMIT_POLICY, type RequestLimitPolicy } from "./request-limit-policy.js";
import { recordRequestLimit } from "./request-limit-context.js";
import { ATOMIC_BUDGET_SCRIPT } from "./atomic-budget-script.js";

// TTL은 남은 시간을 반올림해 최대 0.5초 짧게 알려 준다. 재시도 안내가 실제보다 짧으면 화면이 일찍
// 풀려 다시 막히므로 PTTL을 초 단위로 올림한다(-1·-2 '만료 없음·키 없음'은 그대로 둔다).
const INCREMENT_WITH_TTL_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then ttl = math.ceil(ttl / 1000) end
if current >= tonumber(ARGV[2]) then
  if ttl < 0 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
    ttl = tonumber(ARGV[1])
  end
  return { current, ttl, 0 }
end
current = redis.call('INCR', KEYS[1])
if current == 1 or current == tonumber(ARGV[2]) or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end

return { current, ttl, 1 }
`;
const READ_WITH_TTL_SCRIPT = `
local current = redis.call('GET', KEYS[1])

if not current then
  return { 0, 0 }
end

local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then ttl = math.ceil(ttl / 1000) end
return { tonumber(current), ttl }
`;
const REDIS_OPERATION_TIMEOUT_MS = 1_000;

class RedisOperationTimeoutError extends Error {
  constructor() {
    super(`Redis operation exceeded ${REDIS_OPERATION_TIMEOUT_MS}ms.`);
    this.name = "RedisOperationTimeoutError";
  }
}

function createRateLimitClient(url: string) {
  return createClient({
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 1_000,
      reconnectStrategy: false,
    },
    url,
  });
}

type RedisClient = ReturnType<typeof createRateLimitClient>;

export interface RateLimitRequest {
  /** Opaque, privacy-safe Redis key. Never pass a raw email address. */
  key: string;
  limit?: number;
  windowSeconds?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function parseScriptResult(result: unknown): [count: number, ttl: number, allowed: boolean] {
  if (!Array.isArray(result) || result.length !== 3) {
    throw new TypeError("Redis rate limit script returned an invalid result.");
  }

  const count = Number(result[0]);
  const ttl = Number(result[1]);
  const allowed = Number(result[2]);

  if (
    !Number.isInteger(count) ||
    count <= 0 ||
    !Number.isInteger(ttl) ||
    ttl < 0 ||
    ![0, 1].includes(allowed)
  ) {
    throw new TypeError("Redis rate limit script returned invalid counter values.");
  }

  return [count, ttl, allowed === 1];
}

function parseReadScriptResult(result: unknown): [count: number, ttl: number] {
  if (!Array.isArray(result) || result.length !== 2) {
    throw new TypeError("Redis rate limit read script returned an invalid result.");
  }

  const count = Number(result[0]);
  const ttl = Number(result[1]);

  if (
    !Number.isInteger(count) ||
    count < 0 ||
    !Number.isInteger(ttl) ||
    ttl < 0 ||
    (count === 0 && ttl !== 0)
  ) {
    throw new TypeError("Redis rate limit read script returned invalid counter values.");
  }

  return [count, ttl];
}

export class RedisRateLimiter {
  private connectPromise: Promise<void> | undefined;

  constructor(
    private readonly client: RedisClient,
    private readonly policyProvider: () => Promise<RequestLimitPolicy> = async () => ({
      ...DEFAULT_REQUEST_LIMIT_POLICY,
    }),
  ) {}

  async getPolicy(): Promise<RequestLimitPolicy> {
    try {
      return await this.policyProvider();
    } catch (error) {
      throw new RateLimitServiceUnavailableException(error);
    }
  }

  private async resolveRequest(request: RateLimitRequest): Promise<Required<RateLimitRequest>> {
    const policy =
      request.limit === undefined || request.windowSeconds === undefined
        ? await this.getPolicy()
        : undefined;
    const limit = request.limit ?? policy!.max_attempts;
    const windowSeconds = request.windowSeconds ?? policy!.cooldown_seconds;
    requirePositiveInteger(limit, "limit");
    requirePositiveInteger(windowSeconds, "windowSeconds");
    return { key: request.key, limit, windowSeconds };
  }

  async consume(request: RateLimitRequest): Promise<RateLimitResult> {
    if (request.key.length === 0) {
      throw new RangeError("key must not be empty.");
    }

    const settings = await this.resolveRequest(request);

    try {
      const rawResult = await this.runWithDeadline(async () => {
        await this.ensureConnected();
        return this.client.eval(INCREMENT_WITH_TTL_SCRIPT, {
          arguments: [String(settings.windowSeconds), String(settings.limit)],
          keys: [`${request.key}:policy:${settings.limit}:${settings.windowSeconds}`],
        });
      });
      const [count, ttl, allowed] = parseScriptResult(rawResult);

      const result = {
        allowed,
        count,
        limit: settings.limit,
        remaining: Math.max(0, settings.limit - count),
        retryAfterSeconds: Math.max(1, ttl),
      };
      recordRequestLimit(request.key, result, settings.windowSeconds);
      return result;
    } catch (error) {
      throw new RateLimitServiceUnavailableException(error);
    }
  }

  async peek(request: RateLimitRequest): Promise<RateLimitResult> {
    if (request.key.length === 0) {
      throw new RangeError("key must not be empty.");
    }

    const settings = await this.resolveRequest(request);

    try {
      const rawResult = await this.runWithDeadline(async () => {
        await this.ensureConnected();
        return this.client.eval(READ_WITH_TTL_SCRIPT, {
          arguments: [],
          keys: [`${request.key}:policy:${settings.limit}:${settings.windowSeconds}`],
        });
      });
      const [count, ttl] = parseReadScriptResult(rawResult);

      const result = {
        allowed: count < settings.limit,
        count,
        limit: settings.limit,
        remaining: Math.max(0, settings.limit - count),
        retryAfterSeconds: Math.max(1, ttl),
      };
      recordRequestLimit(request.key, result, settings.windowSeconds);
      return result;
    } catch (error) {
      throw new RateLimitServiceUnavailableException(error);
    }
  }

  /** 성공 로그인·비밀번호 재설정처럼 '정상 주인 확인'이 된 뒤 그 한도를 비운다. */
  async clear(request: Required<RateLimitRequest>): Promise<void> {
    if (request.key.length === 0) throw new RangeError("key must not be empty.");
    try {
      await this.runWithDeadline(async () => {
        await this.ensureConnected();
        await this.client.del(`${request.key}:policy:${request.limit}:${request.windowSeconds}`);
      });
    } catch (error) {
      throw new RateLimitServiceUnavailableException(error);
    }
  }

  /** Reserves all fixed budgets together, without extending their original expiry. */
  async consumeAll(requests: readonly Required<RateLimitRequest>[]): Promise<RateLimitResult> {
    if (requests.length === 0 || requests.length > 16) {
      throw new RangeError("Between one and sixteen budgets are required.");
    }
    const keys = requests.map((request) => {
      if (request.key.length === 0) throw new RangeError("key must not be empty.");
      requirePositiveInteger(request.limit, "limit");
      requirePositiveInteger(request.windowSeconds, "windowSeconds");
      if (request.limit > 1_000_000_000 || request.windowSeconds > 1_000_000_000) {
        throw new RangeError("Budget values exceed the supported range.");
      }
      return `${request.key}:fixed:${request.limit}:${request.windowSeconds}`;
    });
    if (new Set(keys).size !== keys.length) throw new RangeError("Budget keys must be distinct.");
    try {
      const raw = await this.runWithDeadline(async () => {
        await this.ensureConnected();
        return this.client.eval(ATOMIC_BUDGET_SCRIPT, {
          keys,
          arguments: requests.flatMap((request) => [
            String(request.windowSeconds),
            String(request.limit),
          ]),
        });
      });
      if (!Array.isArray(raw) || raw.length !== 4) throw new TypeError("Invalid budget result.");
      const index = Number(raw[0]);
      if (!Number.isInteger(index) || index < 1 || index > requests.length) {
        throw new TypeError("Invalid governing budget.");
      }
      const [count, ttl, allowed] = parseScriptResult(raw.slice(1));
      const limit = requests[index - 1]!.limit;
      // Do not expose successful service-wide counters in per-user response headers.
      return {
        allowed,
        count,
        limit,
        remaining: Math.max(0, limit - count),
        retryAfterSeconds: Math.max(1, ttl),
      };
    } catch (error) {
      throw new RateLimitServiceUnavailableException(error);
    }
  }

  async ensureAvailable(): Promise<void> {
    try {
      await this.runWithDeadline(async () => {
        await this.ensureConnected();
        await this.client.ping();
      });
    } catch (error) {
      throw new RateLimitServiceUnavailableException(error);
    }
  }

  async close(): Promise<void> {
    if (this.client.isOpen) {
      this.client.destroy();
    }
  }

  private async runWithDeadline<T>(operation: () => Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new RedisOperationTimeoutError());
        if (this.client.isOpen) {
          this.client.destroy();
        }
      }, REDIS_OPERATION_TIMEOUT_MS);
      timeout.unref();
    });

    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isReady) {
      return;
    }

    if (this.connectPromise !== undefined) {
      await this.connectPromise;
      return;
    }

    if (this.client.isOpen) {
      throw new Error("Redis client is open but not ready.");
    }

    this.connectPromise = this.client.connect().then(() => undefined);

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }
}

export function createRedisRateLimiter(
  url: string,
  policyProvider?: () => Promise<RequestLimitPolicy>,
): RedisRateLimiter {
  const client = createRateLimitClient(url);

  client.on("error", () => undefined);

  return new RedisRateLimiter(client, policyProvider);
}
