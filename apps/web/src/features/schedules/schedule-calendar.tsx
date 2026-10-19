import { LoaderCircle, RefreshCw } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router";

import {
  getAttendanceHistory,
  type AttendanceNotificationType,
  type AttendanceStudentHistory,
} from "../../api/attendance-notifications";
import { ApiRequestError } from "../../api/auth";
import { listScheduleCalendar, type ScheduleCalendarResponse } from "../../api/schedules";
import {
  dateStatusLabel,
  eventCountLabel,
  historyByDate,
  holidayNamesByDate,
  itemsByDate,
  mergeScheduleCalendarResponses,
  supplementalWeekRange,
  weekDatesFor,
} from "./schedule-calendar-data";
import {
  addScheduleCalendarDays,
  calendarGridForMonth,
  formatScheduleCalendarDate,
  formatScheduleCalendarMonth,
  monthForScheduleCalendarDate,
  moveScheduleCalendarDate,
  scheduleCalendarDayKind,
  shiftScheduleCalendarMonth,
  type ScheduleCalendarDayKind,
  type ScheduleCalendarNavigationKey,
} from "./schedule-calendar-date";
import { ContentSplit } from "../layout/content-frame";
import { ScheduleAgendaCard, scheduleCategory } from "./schedule-agenda-card";
import { selectContentInPlace } from "../updates/content-list-view";

const WEEKDAYS = [
  { full: "일요일", short: "일" },
  { full: "월요일", short: "월" },
  { full: "화요일", short: "화" },
  { full: "수요일", short: "수" },
  { full: "목요일", short: "목" },
  { full: "금요일", short: "금" },
  { full: "토요일", short: "토" },
] as const;

const WEEK_STRIP_WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"] as const;

/**
 * 법정공휴일임을 화면과 스크린리더 양쪽에 알릴 때 쓰는 말. 색만으로 전달하지 않는다.
 */
const HOLIDAY_SOURCE_LABEL = "법정공휴일";

/*
 * 의미색은 날짜 칸의 면·경계·숫자에만 쓴다. 선택 상태는 여기가 아니라 역할색 배경과
 * `aria-selected`로 따로 표현한다 — 그래야 "빨간 날"과 "고른 날"이 서로를 지우지 않는다.
 */
const DAY_KIND_SURFACE: Record<ScheduleCalendarDayKind, string> = {
  holiday: "border-calendar-holiday-line bg-calendar-holiday-soft",
  saturday: "border-calendar-saturday-line bg-calendar-saturday-soft",
  sunday: "border-calendar-holiday-line bg-calendar-holiday-soft",
  weekday: "border-app-border bg-app-surface-raised",
};

const DAY_KIND_NUMBER: Record<ScheduleCalendarDayKind, string> = {
  holiday: "text-calendar-holiday",
  saturday: "text-calendar-saturday",
  sunday: "text-calendar-holiday",
  weekday: "",
};

const NAVIGATION_KEYS = new Set<ScheduleCalendarNavigationKey>([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
]);

interface ScheduleCalendarProps {
  attendanceEnabled?: boolean;
  serverToday: string;
  detail?: ReactNode;
  onSelectDate?(): void;
  onSelectSchedule?: ((id: string) => void) | undefined;
}

const ATTENDANCE_TYPE_LABEL: Record<AttendanceNotificationType, string> = {
  absent: "결석",
  early: "조퇴",
  late: "지각",
};

function attendanceTypeClassName(type: AttendanceNotificationType): string {
  if (type === "absent") return "border-danger bg-danger-surface text-danger";
  if (type === "late") return "border-home-meal-line bg-home-meal-soft text-home-meal";
  return "border-role-border bg-role-soft text-role-primary";
}

export function ScheduleCalendar({
  attendanceEnabled = false,
  serverToday,
  detail,
  onSelectDate,
  onSelectSchedule,
}: ScheduleCalendarProps): React.JSX.Element {
  const navigate = useNavigate();
  const [today, setToday] = useState(serverToday);
  const [month, setMonth] = useState(() => monthForScheduleCalendarDate(serverToday));
  const [selectedDate, setSelectedDate] = useState(serverToday);
  const [calendar, setCalendar] = useState<ScheduleCalendarResponse>();
  const [attendanceHistory, setAttendanceHistory] = useState<AttendanceStudentHistory>();
  const [attendanceLoading, setAttendanceLoading] = useState(false);
  const [attendanceError, setAttendanceError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [monthExpandedOnNarrow, setMonthExpandedOnNarrow] = useState(false);
  const [retrySequence, setRetrySequence] = useState(0);
  // 좁은 화면 월 보기에서도 달력이 스크롤 없이 한 화면에 들어오도록, 달력 판 위쪽부터 보이는 본문 끝까지의
  // 높이를 재어 CSS 변수로 준다(schedule-special.css). 본문을 스크롤한 상태와 무관하게 계산한다.
  const calendarSectionRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const section = calendarSectionRef.current;
    const body = section?.closest<HTMLElement>(".content-frame-body");
    if (!section || !body) return;
    const measure = () => {
      const panel = section.querySelector<HTMLElement>(".schedule-month-panel");
      if (!panel) return;
      const bodyRect = body.getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(body).paddingBottom) || 0;
      const top = panel.getBoundingClientRect().top + body.scrollTop - bodyRect.top;
      const visible = body.clientHeight - top - padding;
      section.style.setProperty("--schedule-month-visible-height", `${Math.max(280, visible)}px`);
    };
    measure();
    // content-input-frame과 같이, ResizeObserver가 없는 환경(jsdom 검사 등)에서는 한 번 잰 값만 쓴다.
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(body);
    return () => observer?.disconnect();
  }, [monthExpandedOnNarrow]);
  const grid = useMemo(() => calendarGridForMonth(month), [month]);
  const weekDates = useMemo(() => weekDatesFor(selectedDate), [selectedDate]);
  const weekStartDate = weekDates[0] ?? selectedDate;
  const weekEndDate = weekDates.at(-1) ?? selectedDate;
  const supplementalRange = useMemo(
    () => supplementalWeekRange(grid.startDate, grid.endDate, weekStartDate, weekEndDate),
    [grid.endDate, grid.startDate, weekEndDate, weekStartDate],
  );
  const coverageStartDate =
    supplementalRange !== undefined && supplementalRange.startDate < grid.startDate
      ? supplementalRange.startDate
      : grid.startDate;
  const coverageEndDate =
    supplementalRange !== undefined && supplementalRange.endDate > grid.endDate
      ? supplementalRange.endDate
      : grid.endDate;
  const dateButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusDateRef = useRef<string | undefined>(undefined);
  const monthLabel = formatScheduleCalendarMonth(month);
  const groupedItems = useMemo(() => itemsByDate(calendar?.items ?? []), [calendar]);
  const groupedAttendance = useMemo(
    () => historyByDate(attendanceHistory?.items ?? []),
    [attendanceHistory],
  );
  const holidayNames = useMemo(() => holidayNamesByDate(calendar?.holidays), [calendar]);
  const selectedItems = groupedItems.get(selectedDate) ?? [];
  const selectedAttendance = groupedAttendance.get(selectedDate);
  const selectedHolidayName = holidayNames.get(selectedDate);
  const currentMonthItems = (calendar?.items ?? []).filter((item) =>
    item.due_date.startsWith(`${month}-`),
  );
  const currentMonthAttendance = (attendanceHistory?.items ?? []).filter((item) =>
    item.notification_date.startsWith(`${month}-`),
  );
  const oldestVisibleDate = calendar?.oldest_visible_date ?? addScheduleCalendarDays(today, -90);
  const minimumVisibleDate = attendanceEnabled
    ? addScheduleCalendarDays(today, -365)
    : oldestVisibleDate;
  const minimumMonth = monthForScheduleCalendarDate(minimumVisibleDate);
  const previousMonth = shiftScheduleCalendarMonth(month, -1);
  const selectedScheduleReady =
    calendar !== undefined &&
    calendar.start_date <= weekStartDate &&
    calendar.end_date >= weekEndDate;
  const selectedAttendanceReady =
    !attendanceEnabled ||
    selectedDate > today ||
    attendanceError ||
    (attendanceHistory !== undefined &&
      attendanceHistory.range.from <= selectedDate &&
      attendanceHistory.range.to >= selectedDate);
  const selectedDayBusy = (!error && !selectedScheduleReady) || !selectedAttendanceReady;
  const calendarDataBusy = loading || attendanceLoading || selectedDayBusy;

  useEffect(() => {
    let active = true;
    setCalendar(undefined);
    setError(false);
    setLoading(true);
    const request =
      supplementalRange === undefined
        ? listScheduleCalendar(grid.startDate, grid.endDate)
        : Promise.all([
            listScheduleCalendar(grid.startDate, grid.endDate),
            listScheduleCalendar(supplementalRange.startDate, supplementalRange.endDate),
          ]).then(([primary, supplemental]) =>
            mergeScheduleCalendarResponses(primary, supplemental),
          );
    void request
      .then((result) => {
        if (!active) return;
        setCalendar(result);
        setToday(result.server_today);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [grid.endDate, grid.startDate, navigate, retrySequence, supplementalRange]);

  useEffect(() => {
    let active = true;
    setAttendanceHistory(undefined);
    setAttendanceError(false);
    if (!attendanceEnabled || coverageStartDate > today) {
      setAttendanceLoading(false);
      return () => {
        active = false;
      };
    }

    setAttendanceLoading(true);
    const historyStartDate =
      coverageStartDate < addScheduleCalendarDays(today, -365)
        ? addScheduleCalendarDays(today, -365)
        : coverageStartDate;
    const historyEndDate = coverageEndDate < today ? coverageEndDate : today;
    void getAttendanceHistory(historyStartDate, historyEndDate)
      .then((result) => {
        if (!active) return;
        setAttendanceHistory(result);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setAttendanceError(true);
      })
      .finally(() => {
        if (active) setAttendanceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attendanceEnabled, coverageEndDate, coverageStartDate, navigate, retrySequence, today]);

  useLayoutEffect(() => {
    const pendingDate = pendingFocusDateRef.current;
    if (pendingDate === undefined) return;
    const target = dateButtonRefs.current.get(pendingDate);
    if (target === undefined) return;
    pendingFocusDateRef.current = undefined;
    target.focus();
  }, [month, selectedDate]);

  function selectDate(date: string, focus: boolean): void {
    const targetMonth = monthForScheduleCalendarDate(date);
    if (date < minimumVisibleDate || targetMonth < minimumMonth) return;
    onSelectDate?.();
    if (focus) pendingFocusDateRef.current = date;
    if (targetMonth !== month) setCalendar(undefined);
    setSelectedDate(date);
    if (targetMonth !== month) setMonth(targetMonth);
  }

  function moveMonth(offset: number): void {
    onSelectDate?.();
    const targetMonth = shiftScheduleCalendarMonth(month, offset);
    const monthStart = `${targetMonth}-01`;
    // 최소 경계 달에서는 1일이 이미 비활성이다. 그대로 선택하면 roving tabindex가
    // 비활성 칸에 머물러 그리드로 키보드 진입이 아예 막힌다.
    const targetDate =
      targetMonth === monthForScheduleCalendarDate(today)
        ? today
        : monthStart < minimumVisibleDate
          ? minimumVisibleDate
          : monthStart;
    pendingFocusDateRef.current = targetDate;
    setCalendar(undefined);
    setMonth(targetMonth);
    setSelectedDate(targetDate);
  }

  function moveToToday(): void {
    onSelectDate?.();
    const targetMonth = monthForScheduleCalendarDate(today);
    pendingFocusDateRef.current = today;
    if (targetMonth !== month) setCalendar(undefined);
    setMonth(targetMonth);
    setSelectedDate(today);
  }

  function handleDateKeyDown(event: KeyboardEvent<HTMLButtonElement>, date: string): void {
    if (!NAVIGATION_KEYS.has(event.key as ScheduleCalendarNavigationKey)) return;
    event.preventDefault();
    const targetDate = moveScheduleCalendarDate(date, event.key as ScheduleCalendarNavigationKey);
    selectDate(targetDate, true);
  }

  const selectedDayPane = (
    <div className="min-w-0 h-full" data-schedule-calendar-pane="selected-day" key={selectedDate}>
      <div
        aria-busy={selectedDayBusy}
        aria-live="polite"
        className="content-card h-full p-4 sm:p-5"
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold text-role-primary">선택한 날짜</p>
            <h3 className="mt-1 break-keep text-base font-extrabold text-app-text sm:text-lg">
              {formatScheduleCalendarDate(selectedDate)}
            </h3>
            {selectedHolidayName === undefined ? null : (
              <p className="schedule-holiday-line" data-selected-day-holiday={selectedHolidayName}>
                {selectedHolidayName} · {HOLIDAY_SOURCE_LABEL}
              </p>
            )}
            <p className="mt-1 text-sm font-medium text-app-muted">
              {selectedDayBusy
                ? "일정 확인 중"
                : error
                  ? selectedAttendance === undefined
                    ? "일정 확인 불가"
                    : "출결 1건 · 반·학교 일정 확인 불가"
                  : eventCountLabel(
                      selectedItems.length + (selectedAttendance === undefined ? 0 : 1),
                    )}
            </p>
          </div>
        </div>

        {selectedDayBusy ? (
          <p
            className="mt-4 flex items-center gap-2 break-keep text-sm font-bold text-role-primary"
            role="status"
          >
            <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
            선택한 날짜의 일정을 불러오고 있어요.
          </p>
        ) : (
          <>
            {error ? (
              <p className="mt-4 break-keep text-sm leading-6 text-app-muted">
                반·학교 일정은 지금 확인할 수 없어요.
              </p>
            ) : selectedDate < oldestVisibleDate && selectedAttendance === undefined ? (
              <p className="mt-4 break-keep text-sm leading-6 text-app-muted">
                최근 90일 이전 일정은 현재 열람 범위에 포함되지 않아요.
              </p>
            ) : selectedItems.length === 0 && selectedAttendance === undefined ? (
              <p className="mt-4 break-keep text-sm leading-6 text-app-muted">
                선택한 날짜에 등록된 일정이 없어요.
              </p>
            ) : null}

            {selectedAttendance === undefined && (error || selectedItems.length === 0) ? null : (
              <ul className="mt-4 grid gap-2">
                {selectedAttendance === undefined ? null : (
                  <li data-source="attendance">
                    <Link
                      className={`group flex min-w-0 items-center justify-between gap-3 rounded-xl border p-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2 focus-visible:ring-offset-app-canvas ${attendanceTypeClassName(
                        selectedAttendance.notification_type,
                      )}`}
                      to="/attendance"
                    >
                      <span className="min-w-0">
                        <span className="text-xs font-extrabold">내가 알린 출결</span>
                        <span className="mt-1 block text-sm font-extrabold">
                          {ATTENDANCE_TYPE_LABEL[selectedAttendance.notification_type]}
                          {selectedAttendance.expected_time === null
                            ? ""
                            : ` · ${selectedAttendance.expected_time} 예정`}
                        </span>
                        <span className="mt-1 block text-xs font-bold opacity-80">
                          {selectedAttendance.status === "acknowledged"
                            ? "담임 선생님 확인"
                            : "확인 대기"}
                        </span>
                      </span>
                      <span aria-hidden="true">→</span>
                    </Link>
                  </li>
                )}
                {error
                  ? null
                  : selectedItems.map((item) => (
                      <li data-source={item.source} key={`${item.source}:${item.id}`}>
                        <ScheduleAgendaCard
                          item={item}
                          onClick={(event) => {
                            if (onSelectSchedule && selectContentInPlace(event)) {
                              onSelectSchedule(item.id);
                            }
                          }}
                        />
                      </li>
                    ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <section
      aria-labelledby="schedule-calendar-title"
      className="mb-4 min-w-0"
      data-feature-surface="schedules-calendar"
      data-calendar-view={monthExpandedOnNarrow ? "month" : "week"}
      ref={calendarSectionRef}
    >
      <h2 className="sr-only" id="schedule-calendar-title">
        선택한 날짜와 월간 일정
      </h2>

      {error ? (
        <div
          className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger bg-app-surface-raised px-4 py-3"
          role="alert"
        >
          <p className="break-keep text-sm font-bold text-app-text">
            이 달의 일정을 불러오지 못했어요.
          </p>
          <button
            className="ui-button ui-button-primary shrink-0 text-sm"
            onClick={() => setRetrySequence((current) => current + 1)}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={17} />
            다시 시도
          </button>
        </div>
      ) : null}

      {attendanceError ? (
        <div
          className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-2xl border border-home-meal-line bg-home-meal-soft px-4 py-3"
          role="alert"
        >
          <p className="break-keep text-sm font-bold text-app-text">
            출결 기록만 불러오지 못했어요. 다른 일정은 그대로 볼 수 있어요.
          </p>
          <button
            className="ui-button ui-button-secondary shrink-0 text-sm"
            onClick={() => setRetrySequence((current) => current + 1)}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={17} />
            다시 시도
          </button>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 xl:hidden">
        <div className="schedule-week-navigation flex min-w-0 items-center gap-1">
          <button
            aria-label="이전 주"
            className="ui-icon-button"
            disabled={addScheduleCalendarDays(weekStartDate, -1) < minimumVisibleDate || loading}
            onClick={() => selectDate(addScheduleCalendarDays(selectedDate, -7), false)}
            type="button"
          >
            ‹
          </button>
          <span className="text-sm font-extrabold">{monthLabel}</span>
          <button
            aria-label="다음 주"
            className="ui-icon-button"
            disabled={loading}
            onClick={() => selectDate(addScheduleCalendarDays(selectedDate, 7), false)}
            type="button"
          >
            ›
          </button>
        </div>
        <div aria-label="일정 달력 보기 방식" className="flex items-center gap-1" role="group">
          <button
            aria-label="주 보기"
            aria-controls="schedule-month-calendar"
            aria-pressed={!monthExpandedOnNarrow}
            className="content-filter min-w-11"
            onClick={() => setMonthExpandedOnNarrow(false)}
            type="button"
          >
            주
          </button>
          <button
            aria-label="월 보기"
            aria-controls="schedule-month-calendar"
            aria-pressed={monthExpandedOnNarrow}
            className="content-filter min-w-11"
            onClick={() => setMonthExpandedOnNarrow(true)}
            type="button"
          >
            월
          </button>
        </div>
      </div>
      <div
        aria-busy={calendarDataBusy}
        aria-label="선택한 날짜가 포함된 주"
        className="schedule-week-strip mt-3 grid grid-cols-7 gap-px xl:hidden"
        data-schedule-week-strip="true"
        role="group"
      >
        {weekDates.map((date, index) => {
          const dayItems = groupedItems.get(date) ?? [];
          const attendanceItem = groupedAttendance.get(date);
          const recordCount = dayItems.length + (attendanceItem === undefined ? 0 : 1);
          const beforeMinimum = date < minimumVisibleDate;
          const selected = date === selectedDate;
          const current = date === today;
          const holidayName = holidayNames.get(date);
          const dayKind = scheduleCalendarDayKind(date, holidayName !== undefined);

          return (
            <button
              aria-current={current ? "date" : undefined}
              aria-label={`${formatScheduleCalendarDate(date)}, ${holidayName === undefined ? "" : `${holidayName} ${HOLIDAY_SOURCE_LABEL}, `}${dateStatusLabel(recordCount, calendarDataBusy, error)}${attendanceItem === undefined ? "" : `, 내가 알린 출결 ${ATTENDANCE_TYPE_LABEL[attendanceItem.notification_type]}`}${current ? ", 오늘" : ""}`}
              aria-pressed={selected}
              className={`schedule-week-day grid min-h-24 min-w-0 place-items-center content-start rounded-xl border px-1 py-2 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2 focus-visible:ring-offset-app-canvas disabled:cursor-not-allowed disabled:opacity-40 ${`${DAY_KIND_SURFACE[dayKind]} ${DAY_KIND_NUMBER[dayKind] || "text-app-muted"}`}`}
              data-schedule-week-day={date}
              disabled={beforeMinimum}
              key={date}
              onClick={() => selectDate(date, false)}
              type="button"
            >
              <span>{WEEK_STRIP_WEEKDAYS[index]}</span>
              <strong className="mt-1 text-[19px] leading-none">{Number(date.slice(-2))}</strong>
              {holidayName === undefined ? null : (
                <span
                  className="schedule-calendar-holiday mt-1 text-[10px] font-bold text-calendar-holiday"
                  title={holidayName}
                >
                  {holidayName}
                </span>
              )}
              <span
                aria-hidden="true"
                className="mt-1 flex min-h-2 items-center justify-center gap-1"
              >
                {attendanceItem === undefined ? null : (
                  <span className="size-1.5 rounded-full bg-home-people" />
                )}
                {dayItems.slice(0, attendanceItem === undefined ? 3 : 2).map((item) => (
                  <span
                    className="schedule-kind-dot"
                    data-schedule-kind={scheduleCategory(item)}
                    key={item.source + ":" + item.id}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <ContentSplit
        className="schedule-calendar-pair mt-4 xl:mt-0"
        data-calendar-view={monthExpandedOnNarrow ? "month" : "week"}
        data-schedule-calendar-pair="true"
        asideLabel="선택한 날짜의 일정"
        asideOnMobile
        aside={detail ?? selectedDayPane}
      >
        <div
          className="content-card schedule-month-panel min-w-0 p-1 sm:p-4"
          data-schedule-calendar-pane="calendar"
          key="calendar"
        >
          <div className="min-w-0" data-schedule-month-calendar="true" id="schedule-month-calendar">
            <div className="mb-4 flex min-h-11 items-center gap-1">
              <button
                aria-label="이전 달"
                className="ui-icon-button ui-button-secondary"
                disabled={previousMonth < minimumMonth || loading}
                onClick={() => moveMonth(-1)}
                type="button"
              >
                ‹
              </button>
              <h3
                aria-live="polite"
                className="min-w-0 flex-1 text-center text-base font-extrabold text-app-text sm:text-lg"
              >
                {monthLabel}
              </h3>
              <div className="flex items-center gap-1">
                <button
                  className="ui-button ui-button-secondary shrink-0 px-2 text-sm"
                  onClick={moveToToday}
                  type="button"
                >
                  오늘
                </button>
                <button
                  aria-label="다음 달"
                  className="ui-icon-button ui-button-secondary"
                  disabled={loading}
                  onClick={() => moveMonth(1)}
                  type="button"
                >
                  ›
                </button>
              </div>
            </div>

            <div
              aria-busy={calendarDataBusy}
              aria-label={`${monthLabel} 일정 달력`}
              className="schedule-month-grid min-w-0"
              role="grid"
            >
              <div className="grid grid-cols-7 gap-px sm:gap-2" role="row">
                {WEEKDAYS.map((weekday, index) => (
                  <span
                    aria-label={weekday.full}
                    className={`py-2 text-center text-xs font-extrabold sm:text-sm ${
                      index === 0
                        ? "text-calendar-holiday"
                        : index === 6
                          ? "text-calendar-saturday"
                          : "text-app-muted"
                    }`}
                    key={weekday.full}
                    role="columnheader"
                  >
                    {weekday.short}
                  </span>
                ))}
              </div>

              {Array.from({ length: 6 }, (_unused, rowIndex) => (
                <div
                  className="schedule-month-week mt-1 grid grid-cols-7 gap-px sm:gap-2"
                  key={rowIndex}
                  role="row"
                >
                  {grid.dates.slice(rowIndex * 7, rowIndex * 7 + 7).map((date) => {
                    const dayItems = groupedItems.get(date) ?? [];
                    const attendanceItem = groupedAttendance.get(date);
                    const recordCount = dayItems.length + (attendanceItem === undefined ? 0 : 1);
                    const beforeMinimum = date < minimumVisibleDate;
                    const selected = date === selectedDate;
                    const current = date === today;
                    const outsideMonth = monthForScheduleCalendarDate(date) !== month;
                    const holidayName = holidayNames.get(date);
                    const dayKind = scheduleCalendarDayKind(date, holidayName !== undefined);
                    return (
                      <button
                        aria-current={current ? "date" : undefined}
                        aria-describedby={
                          attendanceItem === undefined ? undefined : `attendance-calendar-${date}`
                        }
                        aria-label={`${formatScheduleCalendarDate(date)}, ${holidayName === undefined ? "" : `${holidayName} ${HOLIDAY_SOURCE_LABEL}, `}${dateStatusLabel(dayItems.length, calendarDataBusy, error)}${current ? ", 오늘" : ""}`}
                        aria-selected={selected}
                        className={`schedule-month-cell relative flex min-h-20 min-w-0 flex-col items-stretch justify-start rounded-xl border p-1.5 text-left transition focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2 focus-visible:ring-offset-app-canvas disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-24 sm:p-2 ${
                          selected
                            ? "border-app-border bg-app-surface-muted text-app-text"
                            : outsideMonth
                              ? "border-app-border bg-app-surface-muted text-app-muted"
                              : `${DAY_KIND_SURFACE[dayKind]} text-app-text hover:border-role-border`
                        }`}
                        data-calendar-day-kind={dayKind}
                        disabled={beforeMinimum}
                        key={date}
                        onClick={() => selectDate(date, true)}
                        onKeyDown={(event) => handleDateKeyDown(event, date)}
                        ref={(element) => {
                          if (element === null) dateButtonRefs.current.delete(date);
                          else dateButtonRefs.current.set(date, element);
                        }}
                        role="gridcell"
                        tabIndex={selected ? 0 : -1}
                        type="button"
                      >
                        <span
                          className={`block text-left text-xs font-extrabold sm:text-sm ${
                            DAY_KIND_NUMBER[dayKind] || (current ? "text-role-primary" : "")
                          } ${
                            /*
                             * 오늘 표시를 색이 아니라 밑줄로도 준다. 의미색이 숫자 색을 가져가는
                             * 날(빨간 날·토요일)에도 "오늘"이 사라지지 않게 하려는 것이다.
                             */
                            current
                              ? "underline decoration-role-primary decoration-2 underline-offset-2"
                              : ""
                          }`}
                        >
                          {Number(date.slice(-2))}
                        </span>
                        {holidayName === undefined ? null : (
                          <span
                            aria-hidden="true"
                            className="schedule-calendar-holiday mt-1 text-[10px] font-extrabold text-calendar-holiday"
                            data-calendar-day-holiday={holidayName}
                          >
                            {holidayName}
                          </span>
                        )}
                        {attendanceItem === undefined ? null : (
                          <span className="sr-only" id={`attendance-calendar-${date}`}>
                            내가 알린 출결 {ATTENDANCE_TYPE_LABEL[attendanceItem.notification_type]}
                          </span>
                        )}
                        {recordCount === 0 ? null : (
                          <span
                            aria-hidden="true"
                            className="schedule-month-count mt-1 flex items-center justify-center gap-1 text-[11px] font-extrabold text-role-primary lg:hidden"
                            /* 검수가 붙잡을 자리. 화면폭 클래스로 찾으면
                         중단점을 조정할 때마다 조용히 어긋난다(sm→md에서 실제로 겪음). */
                            data-calendar-day-detail="compact"
                          >
                            <span className="size-1.5 rounded-full bg-role-primary" />
                            {recordCount}
                          </span>
                        )}
                        <span
                          aria-hidden="true"
                          className="schedule-month-events mt-2 hidden space-y-1 lg:block"
                          data-calendar-day-detail="full"
                        >
                          {attendanceItem === undefined ? null : (
                            <span
                              className={`block whitespace-normal break-words rounded-md border px-1.5 py-1 text-[11px] font-extrabold ${attendanceTypeClassName(
                                attendanceItem.notification_type,
                              )}`}
                            >
                              출결 · {ATTENDANCE_TYPE_LABEL[attendanceItem.notification_type]}
                            </span>
                          )}
                          {dayItems.slice(0, attendanceItem === undefined ? 2 : 1).map((item) => (
                            <span
                              className="schedule-kind-chip schedule-month-title px-1 py-1 text-[11px] leading-snug"
                              data-schedule-kind={scheduleCategory(item)}
                              key={`${item.source}:${item.id}`}
                              title={item.title}
                            >
                              {item.source === "school" ? "학교 · " : ""}
                              {item.title}
                            </span>
                          ))}
                          {recordCount > 2 ? (
                            <span className="block px-1 text-[11px] font-bold text-role-primary">
                              +{recordCount - 2}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {loading ? (
              <p
                aria-live="polite"
                className="mt-4 flex items-center justify-center gap-2 text-sm font-bold text-role-primary"
                role="status"
              >
                <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />이 달의 일정을
                불러오고 있어요.
              </p>
            ) : calendar !== undefined &&
              currentMonthItems.length === 0 &&
              currentMonthAttendance.length === 0 ? (
              <p
                className="mt-4 rounded-2xl bg-role-soft px-4 py-3 text-center text-sm font-bold text-app-text"
                role="status"
              >
                이 달에 등록된 일정이 없어요.
              </p>
            ) : null}
          </div>
        </div>
      </ContentSplit>
    </section>
  );
}
