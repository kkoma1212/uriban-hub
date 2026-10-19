import { CalendarDays, Megaphone } from "lucide-react";
import { Link } from "react-router";

import type { HomeResponse } from "../../api/auth";

function calendarDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

/** 빠른 카드가 실제로 표시하는 확인된 대상. 아래 정보와 중복 판정에도 같은 선택을 쓴다. */
export function studentHomeQuickActionTargets(home: HomeResponse) {
  const count = home.unresolved_count;
  const hasUnresolved = typeof count === "number" && Number.isSafeInteger(count) && count > 0;
  const today = calendarDay(home.server_today);
  const next =
    today !== null && home.schedules.status === "ok"
      ? home.schedules.data
          .filter((item) => {
            const date = calendarDay(item.due_date);
            return date !== null && date >= today;
          })
          .slice()
          .sort((a, b) => a.due_date.localeCompare(b.due_date))[0]
      : undefined;
  return { unresolvedCount: hasUnresolved ? count : undefined, nextSchedule: next, today };
}

/** 서버의 KST 날짜와 확인된 자료만 사용한다. 휴대폰에서 상세 목록으로 가는 지름길이다. */
export function StudentHomeQuickActions({
  home,
}: {
  home: HomeResponse;
}): React.JSX.Element | null {
  const { unresolvedCount: count, nextSchedule: next, today } = studentHomeQuickActionTargets(home);
  const hasUnresolved = count !== undefined;
  if (!hasUnresolved && next === undefined) return null;
  const days =
    next === undefined || today === null ? 0 : (calendarDay(next.due_date)! - today) / 86_400_000;
  const when = days === 0 ? "오늘" : days === 1 ? "내일" : `D-${days}`;
  return (
    <nav
      aria-label="학생 빠른 확인"
      className={`mt-3 grid min-w-0 gap-2 md:hidden ${hasUnresolved && next !== undefined ? "grid-cols-1 min-[400px]:grid-cols-2" : "grid-cols-1"}`}
    >
      {hasUnresolved ? (
        <Link
          aria-label={`아직 안 본 소식 ${count}개 확인하기`}
          className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl border border-app-border bg-home-latest-soft px-3 py-2 text-home-latest"
          to="/updates?filter=unresolved"
        >
          <Megaphone aria-hidden="true" className="shrink-0" size={18} />
          <span className="min-w-0">
            <span className="block text-xs font-bold">아직 안 본 것</span>
            <span className="block truncate text-sm font-extrabold text-app-text">
              {count}개 확인하기
            </span>
          </span>
        </Link>
      ) : null}
      {next === undefined ? null : (
        <Link
          aria-label={`${when} 일정: ${next.title}`}
          className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl border border-app-border bg-home-spatial-soft px-3 py-2 text-home-spatial"
          to={`/schedules/${next.id}`}
        >
          <CalendarDays aria-hidden="true" className="shrink-0" size={18} />
          <span className="min-w-0">
            <span className="inline-flex rounded-full bg-home-spatial-soft px-2 py-0.5 text-xs font-bold">
              {when} 일정
            </span>
            <span className="mt-1 block line-clamp-2 break-words text-sm font-extrabold leading-5 text-app-text [overflow-wrap:anywhere]">
              {next.title}
            </span>
          </span>
        </Link>
      )}
    </nav>
  );
}
