import type { ClassHubDatabase } from "../../database/database.module.js";

export interface RequestLimitPolicy {
  max_attempts: number;
  cooldown_seconds: number;
}

export const DEFAULT_REQUEST_LIMIT_POLICY: Readonly<RequestLimitPolicy> = {
  max_attempts: 3,
  cooldown_seconds: 60,
};

export function parseRequestLimitPolicy(value: unknown): RequestLimitPolicy {
  if (typeof value === "string") value = JSON.parse(value) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid request limit policy.");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    !Number.isInteger(input.max_attempts) ||
    Number(input.max_attempts) < 1 ||
    Number(input.max_attempts) > 20 ||
    !Number.isInteger(input.cooldown_seconds) ||
    Number(input.cooldown_seconds) < 1 ||
    Number(input.cooldown_seconds) > 3600
  )
    throw new Error("Invalid request limit policy.");
  return {
    max_attempts: Number(input.max_attempts),
    cooldown_seconds: Number(input.cooldown_seconds),
  };
}

export const REQUEST_LIMIT_POLICY_CACHE_MS = 2_000;
let policyGeneration = 0;

/** Call only after the administrator's transaction commits. Other API processes expire in 2s. */
export function invalidateRequestLimitPolicy(): void {
  policyGeneration += 1;
}

export function cachedRequestLimitPolicy(
  load: () => Promise<RequestLimitPolicy>,
  now: () => number = Date.now,
): () => Promise<RequestLimitPolicy> {
  let cached: { value: RequestLimitPolicy; expiresAt: number; generation: number } | undefined;
  let pending: Promise<void> | undefined;
  let failed: { error: unknown; retryAt: number; generation: number } | undefined;
  return async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (
        cached !== undefined &&
        cached.generation === policyGeneration &&
        now() < cached.expiresAt
      )
        return { ...cached.value };
      if (failed !== undefined && failed.generation === policyGeneration && now() < failed.retryAt)
        throw failed.error;
      if (pending === undefined) {
        const generation = policyGeneration;
        pending = (async () => {
          try {
            const value = parseRequestLimitPolicy(await load());
            if (generation === policyGeneration) {
              cached = { value, expiresAt: now() + REQUEST_LIMIT_POLICY_CACHE_MS, generation };
              failed = undefined;
            }
          } catch (error) {
            cached = undefined;
            failed = { error, retryAt: now() + 250, generation };
            throw error;
          } finally {
            pending = undefined;
          }
        })();
      }
      await pending;
    }
    if (cached !== undefined && cached.generation === policyGeneration && now() < cached.expiresAt)
      return { ...cached.value };
    throw new Error("Request limit policy changed during refresh.");
  };
}

const databasePolicies = new WeakMap<ClassHubDatabase, () => Promise<RequestLimitPolicy>>();

export function databaseRequestLimitPolicy(
  database: ClassHubDatabase,
): () => Promise<RequestLimitPolicy> {
  const existing = databasePolicies.get(database);
  if (existing !== undefined) return existing;
  const provider = cachedRequestLimitPolicy(async () => {
    const stored = await database
      .selectFrom("admin_system_state")
      .select("value_json")
      .where("key", "=", "request_limits")
      .executeTakeFirst();
    return stored === undefined
      ? { ...DEFAULT_REQUEST_LIMIT_POLICY }
      : parseRequestLimitPolicy(stored.value_json);
  });
  databasePolicies.set(database, provider);
  return provider;
}
