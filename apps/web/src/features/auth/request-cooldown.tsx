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
  return (
    <div
      className="my-4 flex items-start gap-3 rounded-xl border border-warning-border bg-warning-surface p-4 text-warning-text"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <Clock3 aria-hidden className="mt-0.5 shrink-0" size={20} />
      <p className="text-sm font-semibold leading-6">
        {cooldown.maxAttempts === undefined
          ? "요청이 잠시 제한됐어요."
          : `총 ${cooldown.maxAttempts}회 중 ${remainingAttempts}회 시도가 남았어요.`}{" "}
        {seconds > 0 ? (
          <>
            <strong className="tabular-nums">
              {minutes}분 {remainingSeconds}초
            </strong>{" "}
            {blocked ? "뒤에 다시 시도할 수 있어요." : "뒤에 시도 횟수가 초기화돼요."}
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
