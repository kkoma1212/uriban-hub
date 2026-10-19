import { LoaderCircle, RefreshCw, Soup } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import {
  getMonthMeals,
  getTodayMeal,
  getWeekMeals,
  type MonthMealsResponse,
  type TodayMealResponse,
  type WeekMealsResponse,
} from "../../api/meals";
import { AppShell } from "../layout/app-shell";
import { AsyncStatePanel, StaleDataAlert } from "../layout/async-state";
import {
  ContentFrameBody,
  ContentFrameHeader,
  ContentFilters,
  ContentSplit,
} from "../layout/content-frame";
import { EmptyMeal, MealDateCard } from "./meal-date-card";
import { formatMealDate } from "./meal-format";
import { getNextWeekMeals } from "./next-week-meals";

type MealView = "month" | "today" | "week";

const VIEW_ORDER: MealView[] = ["today", "week", "month"];
const MONTH_PATTERN = /^(?:20[0-9]{2}|2100)-(?:0[1-9]|1[0-2])$/u;
const KST_DAY_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  day: "numeric",
  timeZone: "Asia/Seoul",
});
const KST_WEEKDAY_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  weekday: "short",
});

function mobileDayLabel(value: string): { day: string; weekday: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return { day: value, weekday: "요일" };
  const date = new Date(`${value}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return { day: value, weekday: "요일" };
  return {
    day: KST_DAY_FORMATTER.format(date),
    weekday: KST_WEEKDAY_FORMATTER.format(date),
  };
}

function mealWeekDates(today: string): { date: string }[] {
  const date = new Date(today + "T00:00:00.000Z");
  if (Number.isNaN(date.getTime())) return [];
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return Array.from({ length: 5 }, (_, offset) => {
    const value = new Date(date);
    value.setUTCDate(date.getUTCDate() + offset);
    return { date: value.toISOString().slice(0, 10) };
  });
}

function MealWeekPicker({
  items,
  selectedDate,
  onSelect,
}: {
  items: { date: string; status?: "ok" | "empty" }[];
  selectedDate: string | undefined;
  onSelect(date: string): void;
}): React.JSX.Element {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">요일 선택</legend>
      <div className="grid min-w-0 grid-cols-5 gap-2" data-meal-day-selector>
        {items.map((day) => {
          const label = mobileDayLabel(day.date);
          const selected = day.date === selectedDate;
          return (
            <label
              className={
                "flex min-h-[4.5rem] min-w-0 cursor-pointer touch-manipulation flex-col items-center justify-center rounded-2xl px-1 py-2 text-center focus-within:ring-2 focus-within:ring-[#2b6149] focus-within:ring-offset-2 focus-within:ring-offset-app-canvas " +
                (selected
                  ? "bg-[#2b6149] text-white shadow-sm"
                  : "content-card text-app-muted hover:text-app-text")
              }
              key={day.date}
            >
              <input
                aria-controls="meal-selected-day"
                aria-label={
                  formatMealDate(day.date) +
                  (day.status === undefined
                    ? ""
                    : day.status === "ok"
                      ? " · 급식 있음"
                      : " · 급식 없음")
                }
                checked={selected}
                className="sr-only"
                name="meal-week-day"
                onChange={() => onSelect(day.date)}
                type="radio"
                value={day.date}
              />
              <span className="text-xs font-bold">{label.weekday}</span>
              <span className="mt-1 text-[17px] font-extrabold">{label.day}</span>
              {day.status === undefined ? null : (
                <span
                  aria-hidden
                  className={
                    "mt-1 h-1 w-1 rounded-full " +
                    (day.status === "ok"
                      ? selected
                        ? "bg-white"
                        : "bg-[#2b6149]"
                      : "bg-transparent")
                  }
                />
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function currentKstMonth(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }).slice(0, 7);
}

function shiftMonth(month: string, offset: number): string {
  const value = new Date(`${month}-01T00:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + offset);
  return value.toISOString().slice(0, 7);
}

function formatMonth(month: string): string {
  return `${Number(month.slice(0, 4))}년 ${Number(month.slice(5, 7))}월`;
}

function MonthCalendar({
  month,
  onChangeMonth,
}: {
  month: MonthMealsResponse;
  onChangeMonth(month: string): void;
}) {
  const [selectedDate, setSelectedDate] = useState<string>();
  const firstWeekday = new Date(`${month.month}-01T00:00:00.000Z`).getUTCDay();
  const selectedDay =
    month.items.find((day) => day.date === selectedDate) ??
    month.items.find((day) => day.date === month.server_today) ??
    month.items.find((day) => day.status === "ok") ??
    month.items[0]!;
  const futureEmpty =
    month.month > month.server_today.slice(0, 7) && !month.items.some((day) => day.status === "ok");

  return (
    <ContentSplit
      asideLabel="선택한 날짜의 급식"
      asideOnMobile
      aside={
        selectedDay === undefined ? (
          <EmptyMeal today={false} />
        ) : (
          <MealDateCard
            panel
            date={selectedDay.date}
            label={selectedDay.date === month.server_today ? "오늘" : "선택한 날"}
            sourceDetailed
            {...(selectedDay.status === "ok" ? { meal: selectedDay.data } : {})}
          />
        )
      }
    >
      <div className="content-card p-4">
        <div className="meal-month-nav">
          <button
            aria-label="이전 달 급식 보기"
            className="ui-icon-button ui-button-secondary"
            onClick={() => onChangeMonth(shiftMonth(month.month, -1))}
          >
            ‹
          </button>
          <button
            aria-label="다음 달 급식 보기"
            className="ui-icon-button ui-button-secondary"
            onClick={() => onChangeMonth(shiftMonth(month.month, 1))}
          >
            ›
          </button>
        </div>

        {futureEmpty ? (
          <p className="meal-month-empty">아직 학교에서 이 달의 급식을 제공하지 않았어요.</p>
        ) : null}

        <div className="meal-month-calendar">
          <div className="meal-month-weekdays">
            {"일월화수목금토".split("").map((weekday) => (
              <span key={weekday}>{weekday}</span>
            ))}
          </div>
          <div className="meal-month-days">
            {month.items.map((day, index) => {
              const selected = day.date === selectedDay.date;
              /*
               * 오늘이 어디인지 색으로만 알려주면 색을 못 보는 사람에게는 없는 표시다.
               * 읽어주는 이름에도 "오늘"을 넣는다.
               */
              const today = day.date === month.server_today;
              return (
                <button
                  aria-label={`${today ? "오늘 · " : ""}${formatMealDate(day.date)} · ${
                    day.status === "ok" ? "급식 있음" : "급식 없음"
                  }`}
                  aria-pressed={selected}
                  className="meal-month-day"
                  data-selected={selected}
                  data-today={today}
                  key={day.date}
                  onClick={() => setSelectedDate(day.date)}
                  style={index === 0 ? { gridColumnStart: firstWeekday + 1 } : undefined}
                  type="button"
                >
                  <span>{Number(day.date.slice(8, 10))}</span>
                  {day.status === "ok" ? (
                    <span aria-hidden="true" className="meal-month-dot" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </ContentSplit>
  );
}

export function MealsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedView: MealView =
    searchParams.get("view") === "month"
      ? "month"
      : searchParams.get("view") === "week"
        ? "week"
        : "today";
  const requestedMonth = MONTH_PATTERN.test(searchParams.get("month") ?? "")
    ? (searchParams.get("month") as string)
    : currentKstMonth();
  const requestedWeek = searchParams.get("week") === "next" ? 1 : 0;
  const [activeView, setActiveView] = useState<MealView>(requestedView);
  const [focusedView, setFocusedView] = useState<MealView>(requestedView);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [today, setToday] = useState<TodayMealResponse>();
  const [loadedWeek, setWeek] = useState<WeekMealsResponse & { offset: number }>();
  const week = loadedWeek?.offset === requestedWeek ? loadedWeek : undefined;
  const [month, setMonth] = useState<MonthMealsResponse>();
  const [loading, setLoading] = useState(true);
  const [bootstrapLoadAttempt, setBootstrapLoadAttempt] = useState(0);
  const [selectedWeekDate, setSelectedWeekDate] = useState<string>();
  const [errorsByView, setErrorsByView] = useState<Partial<Record<MealView, string | undefined>>>(
    {},
  );
  const activeViewRef = useRef<MealView>(requestedView);
  const generationRef = useRef<Record<MealView, number>>({ month: 0, today: 0, week: 0 });
  const tabRefs = useRef<Record<MealView, HTMLButtonElement | null>>({
    month: null,
    today: null,
    week: null,
  });

  async function load(view: MealView, targetMonth = requestedMonth): Promise<void> {
    const generation = ++generationRef.current[view];
    const existingData =
      view === "today"
        ? today
        : view === "week"
          ? week
          : month?.month === targetMonth
            ? month
            : undefined;
    setLoading(true);
    if (existingData === undefined) {
      setErrorsByView((current) => ({ ...current, [view]: undefined }));
    }
    try {
      const result =
        view === "today"
          ? await getTodayMeal()
          : view === "week"
            ? await (requestedWeek === 1 ? getNextWeekMeals() : getWeekMeals())
            : await getMonthMeals(targetMonth);
      if (generation !== generationRef.current[view]) return;
      if (view === "today") setToday(result as TodayMealResponse);
      else if (view === "week") {
        const nextWeek = result as WeekMealsResponse;
        setWeek({ ...nextWeek, offset: requestedWeek });
        setSelectedWeekDate((current) => {
          if (current !== undefined && nextWeek.items.some((day) => day.date === current)) {
            return current;
          }
          return (
            nextWeek.items.find((day) => day.date === nextWeek.server_today)?.date ??
            nextWeek.items[0]?.date
          );
        });
      } else setMonth(result as MonthMealsResponse);
      setErrorsByView((current) => ({ ...current, [view]: undefined }));
    } catch (requestError) {
      if (generation !== generationRef.current[view]) return;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setErrorsByView((current) => ({
        ...current,
        [view]:
          requestError instanceof Error ? requestError.message : "급식을 불러오지 못했습니다.",
      }));
    } finally {
      if (generation === generationRef.current[view] && activeViewRef.current === view) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    let active = true;
    void getBootstrap()
      .then((result) => {
        if (!active) return;
        if (
          result.destination !== "HOME" ||
          result.current_membership === null ||
          !result.allowed_actions.includes("VIEW_CLASS")
        ) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        setBootstrap(result);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setErrorsByView((current) => ({
          ...current,
          [requestedView]:
            requestError instanceof Error
              ? requestError.message
              : "급식 화면을 준비하지 못했습니다.",
        }));
        setLoading(false);
      });
    return () => {
      active = false;
      generationRef.current.month += 1;
      generationRef.current.today += 1;
      generationRef.current.week += 1;
    };
  }, [bootstrapLoadAttempt, navigate]);

  useEffect(() => {
    if (bootstrap === undefined) return;
    const requestedMonthChanged = requestedView === "month" && requestedMonth !== month?.month;
    const requestedWeekChanged = requestedView === "week" && loadedWeek?.offset !== requestedWeek;
    const requestedData =
      requestedView === "today"
        ? today
        : requestedView === "week"
          ? week
          : month?.month === requestedMonth
            ? month
            : undefined;
    if (
      requestedView === activeView &&
      !requestedMonthChanged &&
      !requestedWeekChanged &&
      requestedData !== undefined
    )
      return;
    activeViewRef.current = requestedView;
    setActiveView(requestedView);
    setFocusedView(requestedView);
    if (requestedData === undefined) void load(requestedView, requestedMonth);
    else setLoading(false);
  }, [bootstrap, requestedMonth, requestedView, requestedWeek]);

  function switchView(view: MealView): void {
    setFocusedView(view);
    if (view === activeView) return;
    const next = new URLSearchParams(searchParams);
    if (view === "today") {
      next.delete("view");
      next.delete("month");
      next.delete("week");
    } else if (view === "week") {
      next.set("view", "week");
      next.delete("month");
    } else {
      next.set("view", "month");
      next.set("month", requestedMonth);
    }
    setLoading(true);
    setSearchParams(next);
  }

  function changeMonth(nextMonth: string): void {
    const next = new URLSearchParams(searchParams);
    next.set("view", "month");
    next.set("month", nextMonth);
    setLoading(true);
    setSearchParams(next);
  }

  function changeWeek(offset: number): void {
    if (requestedWeek === offset) return;
    const next = new URLSearchParams(searchParams);
    next.set("view", "week");
    next.delete("month");
    if (offset === 1) next.set("week", "next");
    else next.delete("week");
    setLoading(true);
    setSearchParams(next);
  }

  function moveTabFocus(event: React.KeyboardEvent<HTMLButtonElement>, current: MealView): void {
    const currentIndex = VIEW_ORDER.indexOf(current);
    let targetIndex: number | undefined;
    if (event.key === "ArrowLeft")
      targetIndex = (currentIndex - 1 + VIEW_ORDER.length) % VIEW_ORDER.length;
    else if (event.key === "ArrowRight") targetIndex = (currentIndex + 1) % VIEW_ORDER.length;
    else if (event.key === "Home") targetIndex = 0;
    else if (event.key === "End") targetIndex = VIEW_ORDER.length - 1;
    else return;
    event.preventDefault();
    const target = VIEW_ORDER[targetIndex];
    if (target === undefined) return;
    setFocusedView(target);
    tabRefs.current[target]?.focus();
  }

  const error = errorsByView[activeView];

  function retryBootstrap(): void {
    setErrorsByView((current) => ({ ...current, [activeView]: undefined }));
    setLoading(true);
    setBootstrapLoadAttempt((attempt) => attempt + 1);
  }

  if (bootstrap === undefined) {
    return (
      <AppShell alignedFrame contentFrame width="wide">
        <ContentFrameHeader title="급식" />
        <ContentFrameBody>
          <div
            aria-live={loading ? "polite" : "assertive"}
            className="text-center"
            role={loading ? "status" : "alert"}
          >
            {loading ? (
              <LoaderCircle
                aria-hidden="true"
                className="mx-auto animate-spin text-role-primary"
                size={32}
              />
            ) : (
              <Soup aria-hidden="true" className="mx-auto text-danger" size={32} />
            )}
            <p className="mt-4 font-bold text-app-text">
              {loading ? "급식 화면을 준비하고 있어요." : error}
            </p>
            {loading ? null : (
              <button
                className="ui-button ui-button-primary mt-5 text-sm"
                onClick={retryBootstrap}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={18} />
                다시 시도
              </button>
            )}
          </div>
        </ContentFrameBody>
      </AppShell>
    );
  }

  const teacher = bootstrap.current_membership?.role === "teacher";
  const activeData =
    activeView === "today"
      ? today
      : activeView === "week"
        ? week
        : month?.month === requestedMonth
          ? month
          : undefined;
  const initialLoading = loading && activeData === undefined;
  const serverToday =
    activeView === "today"
      ? today?.server_today
      : activeView === "week"
        ? week?.server_today
        : month?.month === requestedMonth
          ? month.server_today
          : undefined;

  const selectedWeekDay =
    week?.items.find((day) => day.date === selectedWeekDate) ?? week?.items[0];
  return (
    <AppShell
      alignedFrame
      contentFrame
      navigationRole={teacher ? "teacher" : "student"}
      width="wide"
    >
      <ContentFrameHeader title="급식">
        <ContentFilters label="급식 조회 기간" role="tablist">
          {VIEW_ORDER.map((view) => (
            <button
              aria-controls={`meal-panel-${view}`}
              aria-selected={activeView === view}
              className="content-filter"
              id={`meal-tab-${view}`}
              key={view}
              onClick={() => switchView(view)}
              onFocus={() => setFocusedView(view)}
              onKeyDown={(event) => moveTabFocus(event, view)}
              ref={(element) => {
                tabRefs.current[view] = element;
              }}
              role="tab"
              tabIndex={focusedView === view ? 0 : -1}
              type="button"
            >
              {view === "today" ? "오늘 급식" : view === "week" ? "주간 급식" : "월간 급식"}
            </button>
          ))}
        </ContentFilters>
      </ContentFrameHeader>

      <ContentFrameBody>
        {VIEW_ORDER.filter((view) => view !== activeView).map((view) => (
          <div
            aria-labelledby={`meal-tab-${view}`}
            hidden
            id={`meal-panel-${view}`}
            key={view}
            role="tabpanel"
          />
        ))}

        <section
          aria-busy={loading}
          aria-labelledby={`meal-tab-${activeView}`}
          className="mt-3 min-w-0"
          data-feature-surface="meals-main"
          id={`meal-panel-${activeView}`}
          role="tabpanel"
          tabIndex={0}
        >
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="mt-1 break-keep text-xl font-extrabold text-app-text">
                {activeView === "today"
                  ? "오늘의 메뉴"
                  : activeView === "week"
                    ? `${requestedWeek === 1 ? "다음" : "이번"} 주 월요일부터 금요일`
                    : `${formatMonth(requestedMonth)} 급식`}
              </h2>
            </div>
            <button
              aria-busy={loading}
              aria-label={`${
                activeView === "today" ? "오늘" : activeView === "week" ? "주간" : "월간"
              } 급식 새로고침`}
              className="ui-icon-button ui-button-secondary"
              disabled={loading}
              onClick={() => void load(activeView)}
              type="button"
            >
              <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} size={18} />
            </button>
          </div>

          {activeView === "week" ? (
            <ContentFilters label="급식 주 선택">
              {[0, 1].map((offset) => (
                <button
                  aria-pressed={requestedWeek === offset}
                  className="content-filter"
                  key={offset}
                  onClick={() => changeWeek(offset)}
                  type="button"
                >
                  {offset === 0 ? "이번 주" : "다음 주"}
                </button>
              ))}
            </ContentFilters>
          ) : null}

          {error !== undefined && activeData !== undefined ? (
            <StaleDataAlert
              busy={loading}
              description="이전에 불러온 급식을 계속 표시하고 있어 최신 정보와 다를 수 있어요."
              onRetry={() => void load(activeView)}
              title="최신 급식 정보를 확인하지 못했어요."
            />
          ) : null}

          {initialLoading ? (
            <AsyncStatePanel kind="loading" title="급식을 불러오는 중입니다." tone="meal" />
          ) : error !== undefined && activeData === undefined ? (
            <AsyncStatePanel
              action={
                <button
                  aria-busy={loading}
                  className="ui-button ui-button-primary text-sm"
                  disabled={loading}
                  onClick={() => void load(activeView)}
                  type="button"
                >
                  다시 시도
                </button>
              }
              description="잠시 후 다시 시도해 주세요."
              kind="error"
              title="급식을 불러오지 못했어요."
              tone="meal"
            />
          ) : activeView === "today" ? (
            <div className="mt-4 grid w-full min-w-0 gap-4">
              <MealWeekPicker
                items={
                  week !== undefined &&
                  requestedWeek === 0 &&
                  today !== undefined &&
                  week.server_today === today.server_today
                    ? week.items
                    : mealWeekDates(today?.server_today ?? bootstrap.server_today)
                }
                selectedDate={today?.server_today}
                onSelect={(date) => {
                  if (date === today?.server_today) return;
                  setSelectedWeekDate(date);
                  switchView("week");
                }}
              />
              <div id="meal-selected-day">
                <MealDateCard
                  panel
                  date={today?.server_today ?? bootstrap.server_today}
                  featured
                  id={"meal-week-day-" + (today?.server_today ?? bootstrap.server_today)}
                  label="오늘"
                  sourceDetailed
                  {...(today?.status === "ok" ? { meal: today.data } : {})}
                />
              </div>
            </div>
          ) : activeView === "week" ? (
            <div className="mt-4 grid w-full min-w-0 gap-4">
              <MealWeekPicker
                items={week?.items ?? []}
                selectedDate={selectedWeekDay?.date}
                onSelect={setSelectedWeekDate}
              />
              <div className="grid min-w-0 gap-3" id="meal-selected-day" data-meal-date-list="week">
                {requestedWeek === 1 && selectedWeekDay?.status === "empty" ? (
                  <p className="meal-month-empty" role="status">
                    다음 주 급식이 아직 올라오지 않았어요.
                  </p>
                ) : null}
                {selectedWeekDay === undefined ? (
                  <EmptyMeal today={false} />
                ) : (
                  <MealDateCard
                    panel
                    date={selectedWeekDay.date}
                    featured={selectedWeekDay.date === week?.server_today}
                    id={"meal-week-day-" + selectedWeekDay.date}
                    key={selectedWeekDay.date}
                    label={
                      selectedWeekDay.date === week?.server_today
                        ? "오늘"
                        : mobileDayLabel(selectedWeekDay.date).weekday
                    }
                    mobileSelected
                    sourceDetailed
                    {...(selectedWeekDay.status === "ok" ? { meal: selectedWeekDay.data } : {})}
                  />
                )}
              </div>
            </div>
          ) : month?.month === requestedMonth ? (
            <MonthCalendar month={month} onChangeMonth={changeMonth} />
          ) : null}

          {serverToday === undefined ? null : (
            <p className="mt-5 text-right text-xs font-medium text-app-muted">
              기준일 <time dateTime={serverToday}>{formatMealDate(serverToday)}</time>
            </p>
          )}
        </section>
      </ContentFrameBody>
    </AppShell>
  );
}
