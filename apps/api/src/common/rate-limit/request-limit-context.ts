import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyReply } from "fastify";
import type { RateLimitResult } from "./redis-rate-limiter.js";

interface RequestLimits {
  reply: FastifyReply;
  results: Map<string, RateLimitResult & { cooldownSeconds: number }>;
}

const context = new AsyncLocalStorage<RequestLimits>();

export function withRequestLimitContext(reply: FastifyReply, next: () => void): void {
  context.run({ reply, results: new Map() }, next);
}

/** Expose only counts and times, never Redis keys or account identities. */
export function recordRequestLimit(
  key: string,
  result: RateLimitResult,
  cooldownSeconds: number,
): void {
  const current = context.getStore();
  if (current === undefined || current.reply.sent) return;
  current.results.set(key, { ...result, cooldownSeconds });
  const governing = [...current.results.values()].sort(
    (left, right) =>
      left.remaining - right.remaining || right.retryAfterSeconds - left.retryAfterSeconds,
  )[0]!;
  void current.reply.header("X-RateLimit-Limit", governing.limit);
  void current.reply.header("X-RateLimit-Remaining", governing.remaining);
  void current.reply.header(
    "X-RateLimit-Reset-After",
    governing.count === 0 ? 0 : governing.retryAfterSeconds,
  );
  void current.reply.header("X-RateLimit-Cooldown", governing.cooldownSeconds);
}
