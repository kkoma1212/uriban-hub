import { Clock3 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiRequestError } from "../../api/auth";

/*
 * 등교 시간 로그인 몰림(T-LOGIN-RUSH-UX, 부하 시험 verification/school-capacity-20261005):
 * 같은 학교 주소 1분 300회 한도(429 RATE_LIMITED)와 비밀번호 확인 과부하 차단(503 SERVICE_UNAVAILABLE,
 * 2초)에 걸린 학생이 같은 순간 다시 누르면 또 몰린다. 서버가 준 대기 시간에 무작위 시간을 더해
 * 자동으로 다시 시도해 재시도 시각을 흩는다. 서버의 보안 한도는 그대로이고, 계정 잠금
 * (ACCOUNT_LOCKED)·비밀번호 틀림은 자동으로 다시 보내지 않는다.
 */

/** 시험의 전교 600명/60초에서 503까지 다시 시도하면 최대 6번 만에 모두 들어갔다 — 첫 시도 + 5번. */
export const MAX_LOGIN_AUTO_RETRIES = 5;
/** 1분 한도에 막힌 수백 명이 한도가 풀리는 순간 몰리지 않게 최대 10초 안에 흩는다. */
const MAX_SPREAD_SECONDS = 10;
const MIN_SPREAD_SECONDS = 2;

export function loginAutoRetryDelayMs(
  error: unknown,
  random: () => number = Math.random,
): number | undefined {
  if (!(error instanceof ApiRequestError)) return undefined;
  const overloaded =
    (error.status === 429 && error.code === "RATE_LIMITED") ||
    (error.status === 503 && error.code === "SERVICE_UNAVAILABLE");
  const seconds = error.details?.retry_after_seconds;
  if (!overloaded || typeof seconds !== "number" || !(seconds > 0)) return undefined;
  const spread = Math.min(MAX_SPREAD_SECONDS, Math.max(MIN_SPREAD_SECONDS, seconds / 2));
  return Math.round((seconds + random() * spread) * 1000);
}

interface PendingRetry {
  deadline: number;
}

export function useLoginAutoRetry() {
  const timer = useRef<number | undefined>(undefined);
  const [pending, setPending] = useState<PendingRetry>();
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState(Date.now);

  const cancel = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    setPending(undefined);
  }, []);
  // 화면을 떠나면 예약한 재시도를 지운다.
  useEffect(() => cancel, [cancel]);

  useEffect(() => {
    if (pending === undefined) return;
    const ticker = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(ticker);
  }, [pending]);

  /** 자동으로 다시 시도할 오류면 예약하고 true. retriesSoFar는 이미 자동으로 다시 보낸 횟수. */
  const schedule = useCallback(
    (error: unknown, retriesSoFar: number, retry: () => Promise<void>): boolean => {
      if (retriesSoFar >= MAX_LOGIN_AUTO_RETRIES) return false;
      const delay = loginAutoRetryDelayMs(error);
      if (delay === undefined) return false;
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      setNow(Date.now());
      setPending({ deadline: Date.now() + delay });
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        setPending(undefined);
        setRunning(true);
        void retry().finally(() => setRunning(false));
      }, delay);
      return true;
    },
    [],
  );

  const seconds =
    pending === undefined
      ? 0
      : Math.max(1, Math.ceil((pending.deadline - Math.max(now, Date.now())) / 1000));
  return { cancel, pending: pending !== undefined, running, schedule, seconds };
}

export function LoginAutoRetryNotice({
  onCancel,
  seconds,
}: {
  onCancel: () => void;
  seconds: number;
}): React.JSX.Element {
  return (
    <div
      className="mt-4 flex items-start gap-3 rounded-xl border border-warning-border bg-warning-surface p-4 text-warning-text"
      data-login-auto-retry="true"
    >
      <Clock3 aria-hidden className="mt-0.5 shrink-0" size={20} />
      <div className="min-w-0 text-sm leading-6">
        {/* 매초 바뀌는 숫자는 알림 영역 밖에 둔다 — 화면 읽기 프로그램이 초마다 읽지 않게. */}
        <p className="break-keep font-semibold" role="status">
          지금 로그인하는 사람이 많아요. 잠시 뒤 자동으로 다시 시도할게요.
        </p>
        <p className="mt-1 break-keep">
          <strong className="tabular-nums">{seconds}초</strong> 뒤 다시 시도해요. 이 화면을 닫지
          않고 기다려 주세요.
        </p>
        <button
          className="ui-button ui-button-secondary mt-3 min-h-11 text-sm"
          onClick={onCancel}
          type="button"
        >
          자동 재시도 멈추기
        </button>
      </div>
    </div>
  );
}
