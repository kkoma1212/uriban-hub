import { Clock3 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router";
import { currentRequestCooldown, subscribeRequestCooldown } from "../../lib/request-cooldown";

function useRequestLimitState() {
  const { pathname } = useLocation();
  const cooldown = useSyncExternalStore(subscribeRequestCooldown, () =>
    currentRequestCooldown(pathname),
  );
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (cooldown === undefined || cooldown.deadline <= Date.now()) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (cooldown.deadline <= Date.now()) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [cooldown]);
  const seconds = Math.max(
    0,
    Math.ceil(((cooldown?.deadline ?? 0) - Math.max(now, Date.now())) / 1000),
  );
  return { cooldown, seconds };
}

export function useRequestCooldown(): number {
  const { cooldown, seconds } = useRequestLimitState();
  return (cooldown?.remainingAttempts ?? 0) === 0 ? seconds : 0;
}

export function RequestCooldownNotice(): React.JSX.Element | null {
  const { cooldown, seconds } = useRequestLimitState();
  if (cooldown === undefined) return null;
  const remainingAttempts =
    seconds === 0 ? cooldown.maxAttempts : (cooldown.remainingAttempts ?? 0);
  const blocked = remainingAttempts === 0 && seconds > 0;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  // '총 3회 중 2회'가 본문의 '5회 틀리면 새 번호'와 같은 횟수로 읽혔다(2026-10-21 첫 사용 점검 8).
  // 이 안내는 짧은 시간의 요청 제한이라 문장에서 그렇게 드러낸다.
  return (
    <div
      className="my-4 flex items-start gap-3 rounded-xl border border-warning-border bg-warning-surface p-4 text-warning-text"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <Clock3 aria-hidden className="mt-0.5 shrink-0" size={20} />
      <p className="break-keep text-sm font-semibold leading-6">
        {cooldown.maxAttempts === undefined
          ? "요청이 잠시 제한됐어요."
          : blocked
            ? `짧은 시간에 ${cooldown.maxAttempts}번을 모두 시도했어요.`
            : `짧은 시간에는 ${cooldown.maxAttempts}번까지 시도할 수 있어요. 남은 횟수는 ${remainingAttempts}번이에요.`}{" "}
        {seconds > 0 ? (
          <>
            <strong className="tabular-nums">
              {minutes}분 {remainingSeconds}초
            </strong>{" "}
            {blocked ? "뒤에 다시 시도할 수 있어요." : "뒤에 횟수가 다시 채워져요."}
          </>
        ) : (
          "지금 다시 시도할 수 있어요."
        )}
        {cooldown.cooldownSeconds === undefined ? null : (
          <span className="block">
            제한에 도달하면 {Math.floor(cooldown.cooldownSeconds / 60)}분{" "}
            {cooldown.cooldownSeconds % 60}초 동안 대기해요.
          </span>
        )}
      </p>
    </div>
  );
}
