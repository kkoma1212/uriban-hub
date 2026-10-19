export interface RequestCooldown {
  deadline: number;
  attempts?: number;
  maxAttempts?: number;
  remainingAttempts?: number;
  cooldownSeconds?: number;
}

const listeners = new Set<() => void>();
const active = new Map<string, RequestCooldown>();
const storageKey = "classhub-request-cooldowns-v1";

export function clearRequestCooldown(scope: string): void {
  // Load persisted scopes before removing just the completed operation's notice.
  currentRequestCooldown(scope);
  active.delete(scope);
  try {
    sessionStorage.setItem(storageKey, JSON.stringify([...active]));
  } catch {
    /* memory is sufficient */
  }
  listeners.forEach((listener) => listener());
}

export function rememberRequestCooldown(
  details: Readonly<Record<string, unknown>>,
  scope = window.location.pathname,
): void {
  const seconds = Number(details.retry_after_seconds);
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const entry: RequestCooldown = {
    deadline: Date.now() + Math.min(Math.ceil(seconds), 86400) * 1000,
    ...(typeof details.attempts === "number" ? { attempts: details.attempts } : {}),
    ...(typeof details.max_attempts === "number" ? { maxAttempts: details.max_attempts } : {}),
    remainingAttempts:
      typeof details.remaining_attempts === "number" ? details.remaining_attempts : 0,
    ...(typeof details.cooldown_seconds === "number"
      ? { cooldownSeconds: details.cooldown_seconds }
      : {}),
  };
  active.set(scope, entry);
  try {
    sessionStorage.setItem(storageKey, JSON.stringify([...active]));
  } catch {
    /* memory is sufficient */
  }
  listeners.forEach((listener) => listener());
}

export function rememberRequestLimitHeaders(headers: Headers, scope: string): void {
  if (!headers.has("X-RateLimit-Limit")) return;
  const maxAttempts = Number(headers.get("X-RateLimit-Limit"));
  const remainingAttempts = Number(headers.get("X-RateLimit-Remaining"));
  const resetSeconds = Number(headers.get("X-RateLimit-Reset-After"));
  const cooldownSeconds = Number(headers.get("X-RateLimit-Cooldown"));
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 20 ||
    !Number.isInteger(remainingAttempts) ||
    remainingAttempts < 0 ||
    remainingAttempts > maxAttempts ||
    !Number.isFinite(resetSeconds) ||
    resetSeconds < 0 ||
    !Number.isInteger(cooldownSeconds) ||
    cooldownSeconds < 1 ||
    cooldownSeconds > 3600
  )
    return;
  rememberRequestCooldown(
    {
      attempts: maxAttempts - remainingAttempts,
      max_attempts: maxAttempts,
      remaining_attempts: remainingAttempts,
      cooldown_seconds: cooldownSeconds,
      retry_after_seconds: resetSeconds,
    },
    scope,
  );
}

export function currentRequestCooldown(scope: string): RequestCooldown | undefined {
  if (!active.has(scope)) {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]");
      if (Array.isArray(stored))
        for (const pair of stored) {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") continue;
          const value = pair[1] as Partial<RequestCooldown> | null;
          if (
            value &&
            typeof value.deadline === "number" &&
            value.deadline > Date.now() &&
            value.deadline <= Date.now() + 86400000
          )
            active.set(pair[0], value as RequestCooldown);
        }
    } catch {
      /* browser storage can be unavailable */
    }
  }
  return active.get(scope);
}

export function subscribeRequestCooldown(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
