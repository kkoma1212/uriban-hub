import { isIP } from "node:net";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type {
  RateLimitRequest,
  RateLimitResult,
  RedisRateLimiter,
} from "../common/rate-limit/redis-rate-limiter.js";
import { createPrivacySafeSubject } from "./auth-crypto.js";
import type { AuthConfig } from "./auth.types.js";

/** Keep IPv4-mapped addresses together and prevent IPv6 interface-ID rotation. */
export function loginNetworkSubject(address: string): string {
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6 || address.includes("%")) return "unknown";
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const halves = canonical.split("::");
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const groups = [
    ...left,
    ...Array<string>(8 - left.length - right.length).fill("0"),
    ...right,
  ].map((value) => Number.parseInt(value, 16));
  if (groups.slice(0, 5).every((value) => value === 0) && groups[5] === 65535) {
    return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((value) => value.toString(16))
    .join(":")}::/64`;
}

/*
 * 2026-10-02 사용자 결정(총검수 I1-01·I1-02): 인터넷 주소와 상관없이 '계정' 기준으로 점점 기다리게 한다.
 * 친구가 장난으로 남의 계정을 오래 잠그지 못하도록 강한 잠금 대신 간격을 둔다.
 * - 1시간에 5번 틀린 뒤부터는 30초에 한 번만 시도할 수 있다.
 * - 1시간에 30번 넘게 틀리면 15분 동안 그 계정 로그인을 받지 않는다.
 * - 바른 비밀번호로 로그인하거나 비밀번호를 재설정하면 바로 풀린다.
 * 한 주소에서 1분에 60번 넘게 틀리면 공용 검증 한도를 쓰지 못하게 해, 몇 개 주소로 모두의 로그인을 막지 못하게 한다.
 */
const ACCOUNT_SLOW_AFTER = { limit: 5, windowSeconds: 3_600 } as const;
const ACCOUNT_SPACING = { limit: 1, windowSeconds: 30 } as const;
const ACCOUNT_LOCK_AFTER = { limit: 30, windowSeconds: 3_600 } as const;
const ACCOUNT_LOCK = { limit: 1, windowSeconds: 900 } as const;
const NETWORK_FAILURES = { limit: 60, windowSeconds: 60 } as const;

/** 계정 기준 대기 한도 묶음. 일반 로그인('login')과 관리자 로그인('admin-login')이 같은 규칙을 쓴다. */
export interface AccountWaitBudgets {
  accountSlow: Required<RateLimitRequest>;
  accountSpacing: Required<RateLimitRequest>;
  accountLockAfter: Required<RateLimitRequest>;
  accountLock: Required<RateLimitRequest>;
}

export function accountWaitBudgets(prefix: string, subject: string): AccountWaitBudgets {
  return {
    accountSlow: { key: `${prefix}-failure:account:${subject}`, ...ACCOUNT_SLOW_AFTER },
    accountSpacing: { key: `${prefix}-spacing:account:${subject}`, ...ACCOUNT_SPACING },
    accountLockAfter: { key: `${prefix}-failure:account-lock:${subject}`, ...ACCOUNT_LOCK_AFTER },
    accountLock: { key: `${prefix}-lock:account:${subject}`, ...ACCOUNT_LOCK },
  };
}

/** 확인 전: 15분 대기 중이면 거절하고, 1시간 5번 실패를 넘었으면 30초 간격을 쓴다. */
export async function enterAccountWait(
  limiter: RedisRateLimiter,
  budgets: AccountWaitBudgets,
): Promise<void> {
  const locked = await limiter.peek(budgets.accountLock);
  if (!locked.allowed) throw new RateLimitedException(locked.retryAfterSeconds, locked);
  const slow = await limiter.peek(budgets.accountSlow);
  if (slow.allowed) return;
  const spacing = await limiter.consume(budgets.accountSpacing);
  if (!spacing.allowed) throw new RateLimitedException(spacing.retryAfterSeconds, spacing);
}

/** 틀렸을 때: 실패를 세고, 1시간 30번째면 15분 대기를 걸어 그 결과를 돌려준다. */
export async function recordAccountFailure(
  limiter: RedisRateLimiter,
  budgets: Pick<AccountWaitBudgets, "accountSlow" | "accountLockAfter" | "accountLock">,
): Promise<RateLimitResult | undefined> {
  await limiter.consume(budgets.accountSlow);
  const lockAfter = await limiter.consume(budgets.accountLockAfter);
  if (lockAfter.allowed && lockAfter.remaining > 0) return undefined;
  return limiter.consume(budgets.accountLock);
}

/** 주인 확인(바른 로그인·재설정) 뒤: 대기를 비운다. 지우기 실패가 본 작업을 막지는 않는다. */
export async function clearAccountWait(
  limiter: RedisRateLimiter,
  budgets: Partial<AccountWaitBudgets>,
): Promise<void> {
  await Promise.all(
    Object.values(budgets).map((request) => limiter.clear(request).catch(() => undefined)),
  );
}

/** 로그인 실패 때 함께 세는 한도들. pair는 기존 '주소+이메일' 한도다. */
export interface LoginFailureBudgets extends Pick<
  AccountWaitBudgets,
  "accountSlow" | "accountLockAfter" | "accountLock"
> {
  pair: RateLimitRequest;
  network: RateLimitRequest;
}

export class LoginAdmission {
  constructor(
    private readonly limiter: RedisRateLimiter,
    private readonly config: AuthConfig,
  ) {}

  private subject(purpose: string, value: string): string {
    return createPrivacySafeSubject(
      this.config.emailHmacKey,
      this.config.emailHmacKeyVersion,
      purpose,
      value,
    );
  }

  /** 계정 기준 한도. 성공 로그인·비밀번호 재설정 때 지우려고 따로 계산한다. */
  accountBudgets(email: string): AccountWaitBudgets {
    return accountWaitBudgets("login", this.subject("login_account", email));
  }

  async enter(email: string, address: string): Promise<LoginFailureBudgets> {
    const network = loginNetworkSubject(address);
    // Fixed security ceilings cannot be relaxed by the business request-limit setting.
    // Charge every request to its origin before reserving shared verification capacity.
    for (const request of [
      {
        key: `login-admission:network:${this.subject("login_network", network)}`,
        limit: 300,
        windowSeconds: 60,
      },
      {
        key: `login-admission:pair:${this.subject("login_pair", JSON.stringify([network, email]))}`,
        limit: 10,
        windowSeconds: 60,
      },
    ]) {
      const limit = await this.limiter.consume(request);
      if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds, limit);
    }
    const serviceRequest = { key: "login-admission:service:v1", limit: 600, windowSeconds: 60 };
    const service = await this.limiter.peek(serviceRequest);
    if (!service.allowed) throw new RateLimitedException(service.retryAfterSeconds, service);
    const policy = await this.limiter.getPolicy();
    const failureRequest = {
      key: `login-failure:pair:${this.subject("login_pair", JSON.stringify([network, email]))}`,
      limit: Math.min(policy.max_attempts, 5),
      windowSeconds: Math.max(policy.cooldown_seconds, 60),
    };
    const limit = await this.limiter.peek(failureRequest);
    if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds, limit);
    const networkFailures = {
      key: `login-failure:network:${this.subject("login_network", network)}`,
      ...NETWORK_FAILURES,
    };
    const account = this.accountBudgets(email);
    const blocked = await this.limiter.peek(networkFailures);
    if (!blocked.allowed) throw new RateLimitedException(blocked.retryAfterSeconds, blocked);
    await enterAccountWait(this.limiter, account);
    // Only admissible requests spend the shared budget. Consume atomically after peek,
    // so concurrent requests cannot overbook the last available verification slot.
    const reserved = await this.limiter.consume(serviceRequest);
    if (!reserved.allowed) throw new RateLimitedException(reserved.retryAfterSeconds, reserved);
    return {
      pair: failureRequest,
      network: networkFailures,
      accountSlow: account.accountSlow,
      accountLockAfter: account.accountLockAfter,
      accountLock: account.accountLock,
    };
  }
}
