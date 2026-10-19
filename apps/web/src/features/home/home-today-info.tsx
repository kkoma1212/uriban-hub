import {
  Backpack,
  CalendarClock,
  CalendarDays,
  ChevronRight,
  Megaphone,
  NotebookPen,
  Soup,
} from "lucide-react";
import { Link } from "react-router";

import { type HomeResponse } from "../../api/auth";
import type { studentHomeQuickActionTargets } from "./student-home-quick-actions";
import { formatKstDateTime } from "../../lib/kst-format";
import { MealSourceBadge } from "../meals/meal-source-badge";

function latestPublishedItem<T extends { published_at: string }>(
  items: readonly T[],
): T | undefined {
  let latest: T | undefined;
  let latestTime = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const publishedTime = Date.parse(item.published_at);
    if (latest === undefined || (!Number.isNaN(publishedTime) && publishedTime > latestTime)) {
      latest = item;
      latestTime = Number.isNaN(publishedTime) ? latestTime : publishedTime;
    }
  }

  return latest;
}

/** 첫 줄: 교사는 최근 전달, 학생은 아직 안 본 소식 개수(같은 자리·같은 모양). */
function LatestRow({ home, role }: { home: HomeResponse; role: "student" | "teacher" }) {
  if (role === "student") {
    // 서버가 소식 탭 '안 한 것'과 같은 기준으로 센 수(2026-10-03 총검수 B2-01). 홈에 보이는 일부만
    // 세면 남은 게 있어도 '모두 확인'이 나왔다. 못 셌으면(null·옛 서버) 숫자를 짓지 않는다.
    const unresolved = home.unresolved_count;
    const counted = typeof unresolved === "number";
    return (
      <Link
        className="flex min-h-16 min-w-0 items-center gap-3 rounded-xl bg-home-latest-soft px-3 py-2 transition-colors hover:bg-app-surface-muted"
        to={unresolved === 0 ? "/updates" : "/updates?filter=unresolved"}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-home-latest-soft text-home-latest">
          <Megaphone aria-hidden="true" size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-bold text-home-latest">아직 안 본 것</span>
          <span className="mt-0.5 block break-words text-sm font-extrabold text-app-text">
            {!counted
              ? "소식에서 확인해 주세요"
              : unresolved === 0
                ? "모두 확인했어요"
                : `${unresolved}개 남았어요`}
          </span>
        </span>
        <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={17} />
      </Link>
    );
  }
  const recentNotice =
    home.notices.status === "ok" ? latestPublishedItem(home.notices.data) : undefined;
  const noticesFailed = home.notices.status === "error";
  return (
    <Link
      className="flex min-h-16 min-w-0 items-center gap-3 rounded-xl bg-home-latest-soft px-3 py-2 transition-colors hover:bg-app-surface-muted"
      to={recentNotice === undefined ? "/notices" : `/notices/${recentNotice.id}`}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-home-latest-soft text-home-latest">
        <Megaphone aria-hidden="true" size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-bold text-home-latest">최근 전달</span>
        <span
          className={`mt-0.5 line-clamp-1 break-words text-sm font-extrabold ${
            noticesFailed ? "text-rose-700" : "text-app-text"
          }`}
        >
          {noticesFailed
            ? "최근 전달을 불러오지 못했어요."
            : (recentNotice?.title ?? "아직 공지가 없어요.")}
        </span>
        {recentNotice === undefined ? null : (
          <span className="mt-1 block text-xs font-medium text-app-muted">
            {formatKstDateTime(recentNotice.published_at)}
          </span>
        )}
      </span>
      <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={17} />
    </Link>
  );
}

/** 날짜 차이(KST 달력 날짜끼리). 홈이 받은 server_today 기준으로 센다. */
function daysFrom(today: string, date: string): number {
  return Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}
function dayLabel(days: number): string {
  return days <= 0 ? "오늘" : days === 1 ? "내일" : `D-${days}`;
}

function TodayRow({
  badge,
  detail,
  failed,
  icon,
  label,
  text,
  to,
  tone,
}: {
  badge: string | null;
  detail: string | null;
  failed: boolean;
  icon: React.ReactNode;
  label: string;
  text: string;
  to: string;
  tone: "spatial" | "supplies";
}): React.JSX.Element {
  // 클래스 이름은 빌드가 찾을 수 있게 통째로 적는다.
  const soft = tone === "supplies" ? "bg-home-supplies-soft" : "bg-home-spatial-soft";
  const ink = tone === "supplies" ? "text-home-supplies" : "text-home-spatial";
  return (
    <Link
      className={`flex min-h-16 min-w-0 items-center gap-3 rounded-xl ${soft} px-3 py-2 transition-colors hover:bg-app-surface-muted`}
      to={to}
    >
      <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${soft} ${ink}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-xs font-bold ${ink}`}>{label}</span>
        <span
          className={`mt-0.5 block break-words text-sm font-extrabold ${failed ? "text-rose-700" : "text-app-text"}`}
        >
          {text}
        </span>
        {detail === null ? null : (
          <span className="mt-1 block text-xs font-medium text-app-muted">{detail}</span>
        )}
      </span>
      {badge === null ? null : (
        <span
          className={`shrink-0 rounded-lg bg-app-surface-raised px-2 py-1 text-xs font-bold ${ink}`}
        >
          {badge}
        </span>
      )}
      <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={17} />
    </Link>
  );
}

/** 학생: 오늘·내일 챙길 준비물(안 챙긴 것을 먼저 이름 두 개까지). 2026-10-03 사용자 요청. */
function SupplyRow({ home }: { home: HomeResponse }): React.JSX.Element {
  const failed = home.supplies.status === "error";
  const items = (home.supplies.status === "ok" ? home.supplies.data : [])
    .filter((item) => item.category === "general")
    .sort((a, b) => a.needed_on.localeCompare(b.needed_on));
  const unchecked = items.filter((item) => item.check_state !== "checked");
  const shown = (unchecked.length > 0 ? unchecked : items).slice(0, 2);
  const first = shown[0];
  return (
    <TodayRow
      badge={first === undefined ? null : dayLabel(daysFrom(home.server_today, first.needed_on))}
      detail={
        failed || items.length === 0
          ? null
          : unchecked.length === 0
            ? "모두 챙겼어요"
            : `아직 안 챙긴 것 ${unchecked.length}개`
      }
      failed={failed}
      icon={<Backpack aria-hidden="true" size={18} />}
      label="챙길 준비물"
      text={
        failed
          ? "준비물을 불러오지 못했어요."
          : items.length === 0
            ? "오늘·내일 챙길 준비물이 없어요."
            : shown.map((item) => item.title).join(" · ")
      }
      to={unchecked.length === 1 && first !== undefined ? `/supplies/${first.id}` : "/supplies"}
      tone="supplies"
    />
  );
}

/** 학생: 마감이 가장 가까운 숙제(아직 안 한 것 먼저). 2026-10-03 사용자 요청. */
function HomeworkRow({ home }: { home: HomeResponse }): React.JSX.Element {
  const failed = home.supplies.status === "error";
  const homework = (home.supplies.status === "ok" ? home.supplies.data : [])
    .filter((item) => item.category === "homework")
    .sort((a, b) => a.needed_on.localeCompare(b.needed_on));
  const next = homework.find((item) => item.check_state !== "checked") ?? homework[0];
  return (
    <TodayRow
      badge={next === undefined ? null : dayLabel(daysFrom(home.server_today, next.needed_on))}
      detail={
        failed || next === undefined
          ? null
          : next.check_state === "checked"
            ? "다 했어요"
            : "아직 안 했어요"
      }
      failed={failed}
      icon={<NotebookPen aria-hidden="true" size={18} />}
      label="가까운 숙제"
      text={failed ? "숙제를 불러오지 못했어요." : (next?.title ?? "다가오는 숙제가 없어요.")}
      to={next === undefined ? "/supplies" : `/supplies/${next.id}`}
      tone="spatial"
    />
  );
}

/*
 * 홈 오른쪽(좁은 화면은 소식 아래) '오늘 정보' 한 판. 2026-10-02 사용자 결정: 학생 홈도 교사 홈과
 * 같은 모양(아이콘+목록 한 판)을 쓰고, 첫 줄만 역할에 맞게 바꾼다.
 */
export function TodayInfoSection({
  home,
  role,
  studentQuickActions,
}: {
  home: HomeResponse;
  role: "student" | "teacher";
  studentQuickActions?: ReturnType<typeof studentHomeQuickActionTargets>;
}): React.JSX.Element {
  // 모바일·태블릿의 교사/학생 보조 글자는 같은 최소12px 크기로 읽을 수 있게 한다.
  const smallText = "text-xs";
  const meal = home.meal.status === "ok" ? home.meal.data : null;
  const mealFailed = home.meal.status === "error";
  const noticesFailed = role === "teacher" && home.notices.status === "error";
  const schedulesFailed = home.schedules.status === "error";
  const nextSchedule = home.schedules.status === "ok" ? home.schedules.data[0] : undefined;
  const quickCount = studentQuickActions?.unresolvedCount;
  const duplicatesQuickCount =
    role === "student" &&
    typeof quickCount === "number" &&
    Number.isSafeInteger(quickCount) &&
    quickCount > 0 &&
    quickCount === home.unresolved_count;
  const duplicatesQuickSchedule =
    role === "student" &&
    nextSchedule !== undefined &&
    nextSchedule.subject === null &&
    studentQuickActions?.nextSchedule?.id === nextSchedule.id;
  const failedLabels = [
    noticesFailed ? "최근 전달" : null,
    mealFailed ? "급식" : null,
    schedulesFailed ? "일정" : null,
  ].filter((label): label is string => label !== null);

  return (
    <section
      aria-labelledby={`${role}-home-today-title`}
      className="teacher-home-today-surface min-w-0 rounded-card border border-app-border p-4 shadow-card xl:flex-1"
      data-home-today-section={role}
      {...(role === "teacher" ? { "data-teacher-home-section": "today" } : {})}
    >
      <div className="flex min-h-11 min-w-0 items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-home-schedule text-app-canvas shadow-sm">
          <CalendarClock aria-hidden="true" size={18} />
        </span>
        <div className="min-w-0">
          <p className={`${smallText} font-bold text-app-muted`}>오늘의 흐름</p>
          <h2 className="text-base font-extrabold text-app-text" id={`${role}-home-today-title`}>
            오늘 정보
          </h2>
        </div>
      </div>

      {failedLabels.length > 0 ? (
        <p className="sr-only" role="alert">
          {failedLabels.join(", ")} 정보를 불러오지 못했습니다.
        </p>
      ) : null}

      <ul className="mt-3 space-y-2">
        <li className={duplicatesQuickCount ? "hidden md:list-item" : undefined}>
          <LatestRow home={home} role={role} />
        </li>
        {/* 학생만: 오늘 할 일에 바로 닿는 두 줄(2026-10-03 사용자 요청 — 처리할 일 칸이 없는 학생 홈). */}
        {role === "student" ? (
          <>
            <li>
              <SupplyRow home={home} />
            </li>
            <li>
              <HomeworkRow home={home} />
            </li>
          </>
        ) : null}
        <li>
          <Link
            className="flex min-h-16 min-w-0 items-center gap-3 rounded-xl bg-home-meal-soft px-3 py-2 transition-colors hover:bg-app-surface-muted"
            to="/meals"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-home-meal-soft text-home-meal">
              <Soup aria-hidden="true" size={18} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs font-bold text-home-meal">
                <span>오늘 급식</span>
                {meal === null ? null : <MealSourceBadge meal={meal} />}
              </span>
              <span
                className={`mt-0.5 block break-words text-sm font-extrabold ${
                  mealFailed ? "text-rose-700" : "text-app-text"
                }`}
              >
                {mealFailed
                  ? "급식을 불러오지 못했어요."
                  : meal === null
                    ? "오늘 등록된 급식이 없어요."
                    : meal.menu
                        .slice(0, 2)
                        .map((item) => item.name)
                        .join(" · ")}
              </span>
            </span>
            <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={17} />
          </Link>
        </li>
        <li className={duplicatesQuickSchedule ? "hidden md:list-item" : undefined}>
          <Link
            className="flex min-h-16 min-w-0 items-center gap-3 rounded-xl bg-home-schedule-soft px-3 py-2 transition-colors hover:bg-app-surface-muted"
            to={nextSchedule === undefined ? "/schedules" : `/schedules/${nextSchedule.id}`}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-home-schedule-soft text-home-schedule">
              <CalendarDays aria-hidden="true" size={18} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-bold text-home-schedule">가까운 일정</span>
              <span
                className={`mt-0.5 block break-words text-sm font-extrabold ${
                  schedulesFailed ? "text-rose-700" : "text-app-text"
                }`}
              >
                {schedulesFailed
                  ? "일정을 불러오지 못했어요."
                  : (nextSchedule?.title ?? "다가오는 일정이 없어요.")}
              </span>
              {nextSchedule === undefined ? null : (
                <span className={`mt-1 block ${smallText} font-medium text-app-muted`}>
                  {nextSchedule.subject ?? "반 일정"}
                </span>
              )}
            </span>
            {nextSchedule === undefined ? null : (
              <span
                className={`shrink-0 rounded-lg bg-app-surface-raised px-2 py-1 ${smallText} font-bold text-home-schedule`}
              >
                {nextSchedule.d_day_label}
              </span>
            )}
            <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={17} />
          </Link>
        </li>
      </ul>
    </section>
  );
}
