import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type {
  RateLimitRequest,
  RedisRateLimiter,
} from "../common/rate-limit/redis-rate-limiter.js";

/*
 * 총검수 C1-04: 2단계 확인(인증번호·패스키·복구 코드) 오답을 '로그인 시도'가 아니라 '관리자 계정' 기준으로 센다.
 * 비밀번호를 다시 맞혀 새 확인 단계를 받아도 누적이 이어진다. 1시간에 10번 틀리면 남은 시간 동안
 * 그 계정의 2단계 확인을 받지 않고, 처음 넘는 순간 그 관리자에게 보안 알림 메일을 한 번 보낸다.
 */
const MFA_FAILURES = { limit: 10, windowSeconds: 3_600 } as const;

export function adminMfaFailureBudget(accountSubject: string): Required<RateLimitRequest> {
  return { key: `admin-mfa-failure:account:${accountSubject}`, ...MFA_FAILURES };
}

export async function enterAdminMfa(
  limiter: RedisRateLimiter,
  budget: Required<RateLimitRequest>,
): Promise<void> {
  const result = await limiter.peek(budget);
  if (!result.allowed) throw new RateLimitedException(result.retryAfterSeconds, result);
}

/** 오답을 세고, 이번 오답으로 처음 한도에 닿았으면 true(알림을 한 번만 보내기 위해). */
export async function recordAdminMfaFailure(
  limiter: RedisRateLimiter,
  budget: Required<RateLimitRequest>,
): Promise<boolean> {
  const result = await limiter.consume(budget);
  return result.allowed && result.count === budget.limit;
}
