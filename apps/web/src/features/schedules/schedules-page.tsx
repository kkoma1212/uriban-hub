import { CalendarDays, CheckCircle2, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import {
  createSchedule,
  listSchedules,
  type ScheduleItem,
  type ScheduleListResponse,
  type ScheduleScope,
  type ScheduleType,
  type ScheduleWriteRequest,
} from "../../api/schedules";
import { useIdempotentContentCreate } from "../../lib/use-idempotent-content-create";
import { AppShell } from "../layout/app-shell";
import { AsyncStatePanel, StaleDataAlert } from "../layout/async-state";
import { ScheduleDetailPage } from "./schedule-detail-page";
import {
  ContentMore,
  DateGroupedList,
  ListSearch,
  selectContentInPlace,
  useContentDesktop,
  useContentListPosition,
  readContentList,
} from "../updates/content-list-view";
import { ContentFrameBody, ContentFrameHeader, ContentFilters } from "../layout/content-frame";
import { contentPageCursor, type ContentPageSnapshot } from "../layout/content-pagination";
import {
  itemListHistoryEntry,
  itemListOwner,
  restorableItemListView,
  itemListOriginState,
  rememberItemListPosition,
} from "../layout/item-list-history";
import { ScheduleCalendar } from "./schedule-calendar";
import { ScheduleAgendaCard } from "./schedule-agenda-card";
import { formatScheduleDate, scheduleTypeLabel } from "./schedule-format";
import { ScheduleForm } from "./schedule-form";

const SCOPE_ORDER: ScheduleScope[] = ["upcoming", "today", "this_week", "past"];
const TYPE_ORDER: ScheduleType[] = ["assignment", "performance", "exam", "other"];
type ScheduleLoadFailure = "append" | "refresh";

function scopeValues<T>(value: T): Record<ScheduleScope, T> {
  return { upcoming: value, today: value, this_week: value, past: value };
}

function isRelativeScope(scope: ScheduleScope): boolean {
  return scope === "today" || scope === "this_week";
}

const scopeConfig: Record<
  ScheduleScope,
  { empty: string; label: string; loading: string; summary: string }
> = {
  upcoming: {
    empty: "다가오는 일정이 없어요.",
    label: "다가오는 일정",
    loading: "다가오는 일정을 불러오고 있어요.",
    summary: "오늘부터 예정된 일정을 가까운 날짜순으로 확인해요.",
  },
  today: {
    empty: "오늘 마감인 일정이 없어요.",
    label: "오늘",
    loading: "오늘 마감인 일정을 불러오고 있어요.",
    summary: "한국 시간 기준, 오늘 마감인 일정을 확인해요.",
  },
  this_week: {
    empty: "이번 주 일정이 없어요.",
    label: "이번 주",
    loading: "이번 주 일정을 불러오고 있어요.",
    summary: "월요일부터 일요일까지, 지난 날짜도 포함해 날짜순으로 확인해요.",
  },
  past: {
    empty: "최근 90일 동안 지난 일정이 없어요.",
    label: "지난 일정",
    loading: "지난 일정을 불러오고 있어요.",
    summary: "최근 90일 일정을 최신 날짜부터 돌아볼 수 있어요.",
  },
};

interface SchedulesLocationState {
  notice?: string;
}

function locationNotice(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const notice = (value as SchedulesLocationState).notice;
  return typeof notice === "string" ? notice : undefined;
}

function scopeFromSearch(searchParams: URLSearchParams): ScheduleScope {
  return SCOPE_ORDER.find((scope) => scope === searchParams.get("scope")) ?? "upcoming";
}

function typeFromSearch(searchParams: URLSearchParams): ScheduleType | undefined {
  const value = searchParams.get("schedule_type");
  return TYPE_ORDER.find((type) => type === value);
}

function isScheduleWriteRequest(value: unknown): value is ScheduleWriteRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<ScheduleWriteRequest>;
  return (
    (request.description === null || typeof request.description === "string") &&
    typeof request.due_date === "string" &&
    ["assignment", "exam", "other", "performance"].includes(request.schedule_type ?? "") &&
    (request.subject === null || typeof request.subject === "string") &&
    typeof request.title === "string"
  );
}

export function SchedulesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeScope = scopeFromSearch(searchParams);
  const activeType = typeFromSearch(searchParams);
  const [scheduleSearchTerm, setScheduleSearchTerm] = useState<string | undefined>();
  const scheduleSearchRef = useRef<string | undefined>(undefined);
  const activeTypeRef = useRef(activeType);
  activeTypeRef.current = activeType;
  const previousTypeRef = useRef(activeType);
  const desktop = useContentDesktop();
  const [selectedId, setSelectedId] = useState<string>();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [focusedScope, setFocusedScope] = useState<ScheduleScope>(activeScope);
  const [itemsByScope, setItemsByScope] = useState<
    Record<ScheduleScope, ScheduleItem[] | undefined>
  >(scopeValues(undefined));
  const [cursorByScope, setCursorByScope] = useState<Record<ScheduleScope, string | null>>(
    scopeValues(null),
  );
  const [dateRangesByScope, setDateRangesByScope] = useState<
    Partial<Record<ScheduleScope, ScheduleListResponse["date_range"]>>
  >({});
  const [serverToday, setServerToday] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [bootstrapLoadAttempt, setBootstrapLoadAttempt] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [loadFailuresByScope, setLoadFailuresByScope] = useState<
    Partial<Record<ScheduleScope, ScheduleLoadFailure>>
  >({});
  const [notice, setNotice] = useState<string | undefined>(() => locationNotice(location.state));
  const activeScopeRef = useRef(activeScope);
  activeScopeRef.current = activeScope;
  const itemsByScopeRef = useRef(itemsByScope);
  const tabRefs = useRef<Record<ScheduleScope, HTMLButtonElement | null>>(scopeValues(null));
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const periodTabsRef = useRef<HTMLDivElement>(null);
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const listScrollRef = useRef<HTMLUListElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const scheduleLinkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const loadGenerationRef = useRef<Record<ScheduleScope, number>>(scopeValues(0));
  const previousScopeRef = useRef(activeScope);
  const restoredLocationKeyRef = useRef<string | undefined>(undefined);
  const { page: contentPage, received: receivedPage } = useContentListPosition();
  const currentPage = contentPage(activeScope, itemsByScope[activeScope]);
  const pageSnapshotRef = useRef(currentPage.snapshot);
  pageSnapshotRef.current = currentPage.snapshot;
  const restorePageRef = useRef<ContentPageSnapshot | undefined>(undefined);
  const failedRequestsRef = useRef<
    Partial<
      Record<
        ScheduleScope,
        { cursor: string | undefined; restore: ContentPageSnapshot | undefined }
      >
    >
  >({});
  const viewCriteria = JSON.stringify([activeScope, activeType ?? null]);

  const loadScope = useCallback(
    async (scope: ScheduleScope, cursor?: string, restore?: ContentPageSnapshot): Promise<void> => {
      const generation = ++loadGenerationRef.current[scope];
      const appending = cursor !== undefined && restore === undefined;
      const changingPage = cursor !== undefined || restore !== undefined;
      if (activeScopeRef.current === scope) {
        if (changingPage) setLoadingMore(true);
        else setLoading(true);
      }
      if (itemsByScopeRef.current[scope] === undefined) {
        setLoadFailuresByScope((current) => ({ ...current, [scope]: undefined }));
      }
      try {
        const scheduleType = activeTypeRef.current;
        const search = scheduleSearchRef.current;
        const loaded = await readContentList(
          (next) => listSchedules(scope, next, scheduleType, search),
          cursor,
          restore,
        );
        const { result } = loaded;
        if (generation !== loadGenerationRef.current[scope]) return;
        receivedPage(
          scope,
          itemsByScopeRef.current[scope]?.length ?? 0,
          result.items.length,
          appending,
          loaded.cursor,
          loaded.restore,
        );
        const nextItemsByScope = {
          ...itemsByScopeRef.current,
          [scope]: appending
            ? [...(itemsByScopeRef.current[scope] ?? []), ...result.items]
            : result.items,
        };
        itemsByScopeRef.current = nextItemsByScope;
        setItemsByScope(nextItemsByScope);
        setCursorByScope((current) => ({ ...current, [scope]: result.next_cursor }));
        setDateRangesByScope((current) => ({ ...current, [scope]: result.date_range }));
        delete failedRequestsRef.current[scope];
        setLoadFailuresByScope((current) => ({ ...current, [scope]: undefined }));
        if (activeScopeRef.current === scope) setServerToday(result.server_today);
      } catch (requestError) {
        if (generation !== loadGenerationRef.current[scope]) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        if (
          isRelativeScope(scope) &&
          cursor !== undefined &&
          requestError instanceof ApiRequestError &&
          requestError.status === 400 &&
          requestError.code === "INVALID_CURSOR"
        ) {
          setNotice("조회 기간이 바뀌어 목록을 처음부터 다시 불러옵니다.");
          return loadScope(scope);
        }
        failedRequestsRef.current[scope] = { cursor, restore };
        setLoadFailuresByScope((current) => ({
          ...current,
          [scope]: changingPage ? "append" : "refresh",
        }));
      } finally {
        if (generation === loadGenerationRef.current[scope] && activeScopeRef.current === scope) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [navigate, receivedPage],
  );

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
        const view = restorableItemListView("schedules", location.key, result, viewCriteria);
        restorePageRef.current = view?.page;
        if (view !== undefined) {
          scheduleSearchRef.current = view.search;
          setScheduleSearchTerm(view.search);
        }
        setBootstrap(result);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setError(
          requestError instanceof Error ? requestError.message : "일정 화면을 준비하지 못했습니다.",
        );
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bootstrapLoadAttempt, navigate]);

  useEffect(
    () => () => {
      for (const scope of SCOPE_ORDER) loadGenerationRef.current[scope] += 1;
    },
    [],
  );

  const scheduleCreate = useIdempotentContentCreate<ScheduleWriteRequest>({
    actionLabel: "일정 추가 요청",
    create: createSchedule,
    isRequest: isScheduleWriteRequest,
    membershipId: bootstrap?.current_membership?.id,
    onCreated: (scheduleId) => {
      void navigate(`/schedules/${scheduleId}`, {
        state: { notice: "일정을 등록했습니다." },
      });
    },
    onUnauthorized: () => void navigate("/login", { replace: true }),
    readServerToday: async () => (await listSchedules(activeScope)).server_today,
    resource: "schedules",
    serverToday,
  });

  const invalidateResults = useCallback(() => {
    for (const scope of SCOPE_ORDER) loadGenerationRef.current[scope] += 1;
    itemsByScopeRef.current = scopeValues(undefined);
    setItemsByScope(itemsByScopeRef.current);
    setCursorByScope(scopeValues(null));
    setDateRangesByScope({});
    setLoadFailuresByScope({});
    failedRequestsRef.current = {};
    restorePageRef.current = undefined;
    setLoadingMore(false);
    setLoading(true);
  }, []);

  useEffect(() => {
    if (previousTypeRef.current === activeType) return;
    previousTypeRef.current = activeType;
    invalidateResults();
  }, [activeType, invalidateResults]);

  useEffect(() => {
    if (previousScopeRef.current !== activeScope) {
      previousScopeRef.current = activeScope;
      setFocusedScope(activeScope);
      setFormOpen(false);
      setNotice(undefined);
      setError(undefined);
      setLoadingMore(false);
      if (isRelativeScope(activeScope)) {
        loadGenerationRef.current[activeScope] += 1;
        itemsByScopeRef.current = { ...itemsByScopeRef.current, [activeScope]: undefined };
        setItemsByScope(itemsByScopeRef.current);
        setDateRangesByScope((current) => ({ ...current, [activeScope]: undefined }));
      }
    }
    if (bootstrap === undefined) return;
    if (itemsByScopeRef.current[activeScope] === undefined) {
      const restore = restorePageRef.current;
      restorePageRef.current = undefined;
      void loadScope(activeScope, contentPageCursor(restore), restore);
    } else setLoading(false);
  }, [activeScope, activeType, bootstrap, loadScope]);

  useEffect(() => {
    if (bootstrap === undefined || !isRelativeScope(activeScope)) return;
    let pending = false;
    const refreshPeriod = () => {
      if (
        document.visibilityState === "hidden" ||
        pending ||
        itemsByScopeRef.current[activeScope] === undefined
      )
        return;
      pending = true;
      const restore = pageSnapshotRef.current;
      void loadScope(activeScope, contentPageCursor(restore), restore).finally(() => {
        pending = false;
      });
    };
    window.addEventListener("focus", refreshPeriod);
    document.addEventListener("visibilitychange", refreshPeriod);
    return () => {
      window.removeEventListener("focus", refreshPeriod);
      document.removeEventListener("visibilitychange", refreshPeriod);
    };
  }, [activeScope, bootstrap, loadScope]);

  useLayoutEffect(() => {
    const activeItems = itemsByScope[activeScope];
    if (activeItems === undefined || restoredLocationKeyRef.current === location.key) return;
    const historyEntry = itemListHistoryEntry("schedules", location.key);
    if (historyEntry === undefined) return;
    if (
      historyEntry.view !== undefined &&
      (bootstrap === undefined ||
        restorableItemListView("schedules", location.key, bootstrap, viewCriteria) === undefined)
    )
      return;
    restoredLocationKeyRef.current = location.key;
    const listScroll = listScrollRef.current?.closest<HTMLElement>(".content-split-main");
    if (listScroll) listScroll.scrollTop = historyEntry.view?.listScrollTop ?? 0;
    window.scrollTo({ behavior: "auto", left: 0, top: historyEntry.scrollY });
    const focusTarget = scheduleLinkRefs.current.get(historyEntry.itemId) ?? listTitleRef.current;
    focusTarget?.focus({ preventScroll: true });
  }, [activeScope, itemsByScope, location.key, bootstrap, viewCriteria]);

  function showResults(): void {
    resultsRef.current?.focus({ preventScroll: true });
    resultsRef.current?.scrollIntoView?.({ block: "start" });
  }

  function rememberCurrentPosition(scheduleId: string): void {
    rememberItemListPosition("schedules", location.key, scheduleId, window.scrollY, {
      owner: itemListOwner(bootstrap!),
      criteria: viewCriteria,
      page: currentPage.snapshot,
      listScrollTop:
        listScrollRef.current?.closest<HTMLElement>(".content-split-main")?.scrollTop ?? 0,
      search: scheduleSearchRef.current,
    });
  }

  function retryScope(): void {
    const failed = failedRequestsRef.current[activeScope];
    void loadScope(activeScope, failed?.cursor, failed?.restore);
  }

  function switchType(type: ScheduleType | undefined): void {
    if (type === activeType) return;
    const nextSearchParams = new URLSearchParams(searchParams);
    if (type === undefined) nextSearchParams.delete("schedule_type");
    else nextSearchParams.set("schedule_type", type);
    setSearchParams(nextSearchParams);
  }

  function searchSchedules(term: string | undefined): void {
    scheduleSearchRef.current = term;
    setScheduleSearchTerm(term);
    invalidateResults();
    void loadScope(activeScope);
  }

  function clearFilters(): void {
    if (activeType === undefined) searchSchedules(undefined);
    else {
      scheduleSearchRef.current = undefined;
      setScheduleSearchTerm(undefined);
      switchType(undefined);
    }
  }

  function switchScope(scope: ScheduleScope): void {
    setFocusedScope(scope);
    if (scope === activeScope) return;
    loadGenerationRef.current[activeScope] += 1;
    setFormOpen(false);
    setNotice(undefined);
    setError(undefined);
    setLoadingMore(false);
    setLoading(itemsByScopeRef.current[scope] === undefined);
    const nextSearchParams = new URLSearchParams(searchParams);
    if (scope === "upcoming") nextSearchParams.delete("scope");
    else nextSearchParams.set("scope", scope);
    setSearchParams(nextSearchParams);
  }

  function moveTabFocus(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: ScheduleScope,
  ): void {
    const currentIndex = SCOPE_ORDER.indexOf(current);
    let targetIndex: number | undefined;
    if (event.key === "ArrowLeft") {
      targetIndex = (currentIndex - 1 + SCOPE_ORDER.length) % SCOPE_ORDER.length;
    } else if (event.key === "ArrowRight") {
      targetIndex = (currentIndex + 1) % SCOPE_ORDER.length;
    } else if (event.key === "Home") {
      targetIndex = 0;
    } else if (event.key === "End") {
      targetIndex = SCOPE_ORDER.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const target = SCOPE_ORDER[targetIndex];
    if (target === undefined) return;
    setFocusedScope(target);
    tabRefs.current[target]?.focus();
  }

  function cancelCreate(): void {
    setFormOpen(false);
    createButtonRef.current?.focus();
  }

  function retryBootstrap(): void {
    setError(undefined);
    setLoading(true);
    setBootstrapLoadAttempt((attempt) => attempt + 1);
  }

  if (bootstrap === undefined) {
    return (
      <AppShell alignedFrame contentFrame width="wide">
        <ContentFrameHeader title="일정" />
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
              <CalendarDays aria-hidden="true" className="mx-auto text-danger" size={32} />
            )}
            <p className="mt-4 font-bold text-app-text">
              {loading ? "일정 화면을 준비하고 있어요." : error}
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
  const activeItems = itemsByScope[activeScope];
  const dateRange = dateRangesByScope[activeScope];
  const activeLoadFailure = loadFailuresByScope[activeScope];
  const initialLoading = (loading || loadingMore) && activeItems === undefined;
  const filtered = activeType !== undefined || scheduleSearchTerm !== undefined;

  return (
    <AppShell
      alignedFrame
      contentFrame
      hideMobileNavigation={formOpen}
      navigationRole={teacher ? "teacher" : "student"}
      width="wide"
    >
      <ContentFrameHeader
        actions={
          <>
            <ListSearch
              label="과목·일정 검색"
              searchTerm={scheduleSearchTerm}
              onSearch={searchSchedules}
              placeholder="과목·제목·설명 검색"
            />
            <button
              aria-label={scopeConfig[activeScope].label + " 새로고침"}
              className="ui-icon-button"
              disabled={loading || loadingMore}
              onClick={() => void loadScope(activeScope)}
              type="button"
            >
              <RefreshCw aria-hidden className={loading ? "animate-spin" : ""} size={18} />
            </button>
            {teacher ? (
              <button
                aria-label="쓰기 (일정 추가)"
                aria-controls="schedule-create-panel"
                aria-expanded={formOpen}
                className="content-write"
                disabled={scheduleCreate.busy}
                onClick={() => {
                  setFormOpen((current) => !current);
                  scheduleCreate.clearResolvedError();
                  setNotice(undefined);
                }}
                ref={createButtonRef}
                type="button"
              >
                <Plus aria-hidden="true" size={18} />
                쓰기
              </button>
            ) : null}
          </>
        }
        data-schedule-page-intro="true"
        title="일정"
      />
      <ContentFrameBody>
        {scheduleCreate.error === undefined ? null : (
          <div
            className="mt-5 rounded-2xl border border-danger bg-app-surface-raised px-4 py-3 text-sm font-bold text-app-text"
            role="alert"
          >
            <p>{scheduleCreate.error}</p>
          </div>
        )}

        {teacher && formOpen ? (
          <section className="my-4 min-w-0" id="schedule-create-panel">
            <ScheduleForm
              busy={scheduleCreate.busy}
              initialValue={scheduleCreate.pendingRequest}
              locked={scheduleCreate.outcomeUnknown}
              onCancel={cancelCreate}
              onSubmit={(request) => {
                setNotice(undefined);
                void scheduleCreate.submit(request);
              }}
              submitLabel={scheduleCreate.outcomeUnknown ? "결과 다시 확인" : "등록하기"}
            />
          </section>
        ) : null}

        {notice === undefined ? null : (
          <p
            aria-live="polite"
            className="mt-5 flex items-center gap-2 rounded-2xl border border-role-border bg-role-soft px-4 py-3 text-sm font-bold text-role-primary"
            role="status"
          >
            <CheckCircle2 aria-hidden="true" size={18} />
            {notice}
          </p>
        )}

        <ScheduleCalendar
          attendanceEnabled={
            !teacher && bootstrap.allowed_actions.includes("MANAGE_OWN_ATTENDANCE_NOTIFICATION")
          }
          serverToday={serverToday ?? bootstrap.server_today}
          onSelectDate={() => setSelectedId(undefined)}
          onSelectSchedule={desktop ? setSelectedId : undefined}
          detail={
            desktop && selectedId ? (
              <ScheduleDetailPage
                key={selectedId}
                embeddedId={selectedId}
                onClose={() => {
                  setSelectedId(undefined);
                  void loadScope(activeScope, undefined, currentPage.snapshot);
                }}
              />
            ) : undefined
          }
        />
        <ContentFilters aria-label="일정 기간" role="tablist" ref={periodTabsRef}>
          {SCOPE_ORDER.map((scope) => (
            <button
              aria-controls={"schedule-panel-" + scope}
              aria-selected={activeScope === scope}
              className="content-filter"
              id={"schedule-tab-" + scope}
              key={scope}
              onClick={() => switchScope(scope)}
              onFocus={() => setFocusedScope(scope)}
              onKeyDown={(event) => moveTabFocus(event, scope)}
              ref={(element) => {
                tabRefs.current[scope] = element;
              }}
              role="tab"
              tabIndex={focusedScope === scope ? 0 : -1}
              type="button"
            >
              {scopeConfig[scope].label}
            </button>
          ))}
        </ContentFilters>

        {SCOPE_ORDER.filter((scope) => scope !== activeScope).map((scope) => (
          <div
            aria-labelledby={`schedule-tab-${scope}`}
            hidden
            id={`schedule-panel-${scope}`}
            key={scope}
            role="tabpanel"
          />
        ))}

        <section
          aria-busy={loading || loadingMore}
          aria-labelledby={`schedule-tab-${activeScope}`}
          className="mt-3 min-w-0"
          data-feature-surface="schedules-list"
          id={`schedule-panel-${activeScope}`}
          role="tabpanel"
          tabIndex={0}
        >
          <h2
            className="sr-only focus:not-sr-only focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2"
            ref={listTitleRef}
            tabIndex={-1}
          >
            {scopeConfig[activeScope].label}
          </h2>
          {dateRange === undefined ? null : (
            <p
              className="mt-2 break-keep text-sm font-bold text-role-primary"
              data-schedule-date-range="true"
            >
              조회 기간{" "}
              <time dateTime={dateRange.start_date}>
                {formatScheduleDate(dateRange.start_date)}
              </time>
              {dateRange.end_date === dateRange.start_date ? null : (
                <>
                  {" "}
                  ~{" "}
                  <time dateTime={dateRange.end_date}>
                    {formatScheduleDate(dateRange.end_date)}
                  </time>
                </>
              )}
            </p>
          )}

          <ContentFilters label="일정 종류">
            {[undefined, ...TYPE_ORDER].map((type) => (
              <button
                aria-pressed={activeType === type}
                className="content-filter"
                key={type ?? "all"}
                onClick={() => switchType(type)}
                type="button"
              >
                {type === undefined ? "전체" : scheduleTypeLabel[type]}
              </button>
            ))}
          </ContentFilters>
          {filtered ? (
            <div className="mb-2 flex flex-wrap gap-2">
              <button
                className="ui-button ui-button-secondary text-sm"
                onClick={showResults}
                type="button"
              >
                조회 결과 보기
              </button>
              <button
                className="ui-button ui-button-tertiary text-sm"
                onClick={clearFilters}
                type="button"
              >
                검색·종류 초기화
              </button>
            </div>
          ) : null}

          {activeLoadFailure !== undefined && activeItems !== undefined ? (
            <StaleDataAlert
              busy={loading || loadingMore}
              description={
                activeLoadFailure === "append"
                  ? "지금까지 불러온 목록은 유지했습니다. 이어지는 항목을 다시 불러올 수 있어요."
                  : "이전에 불러온 일정을 계속 표시하고 있어 최신 정보와 다를 수 있어요."
              }
              onRetry={retryScope}
              title={
                activeLoadFailure === "append"
                  ? "일정 더 보기를 완료하지 못했어요."
                  : "최신 일정을 확인하지 못했어요."
              }
            />
          ) : null}

          <div
            aria-label="일정 조회 결과"
            className="mt-6 scroll-mt-4 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary"
            ref={resultsRef}
            role="region"
            tabIndex={-1}
          >
            {initialLoading ? (
              <AsyncStatePanel
                kind="loading"
                title={scopeConfig[activeScope].loading}
                tone="schedule"
              />
            ) : activeItems === undefined && activeLoadFailure !== undefined ? (
              <AsyncStatePanel
                action={
                  <button
                    aria-busy={loading}
                    className="ui-button ui-button-primary text-sm"
                    disabled={loading || loadingMore}
                    onClick={retryScope}
                    type="button"
                  >
                    다시 시도
                  </button>
                }
                description="인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요."
                kind="error"
                title="일정 목록을 불러오지 못했어요."
                tone="schedule"
              />
            ) : (activeItems ?? []).length === 0 ? (
              <AsyncStatePanel
                description={
                  filtered
                    ? "검색어 또는 일정 종류를 바꿔 보세요."
                    : teacher && activeScope === "upcoming"
                      ? "새 일정이 생기면 위에서 바로 등록할 수 있어요."
                      : "새 일정이 등록되면 날짜순으로 이곳에 정리해 드려요."
                }
                icon={CalendarDays}
                kind="empty"
                title={filtered ? "조건에 맞는 일정이 없어요." : scopeConfig[activeScope].empty}
                tone="schedule"
              />
            ) : (
              <div className="min-w-0">
                <DateGroupedList
                  listRef={listScrollRef}
                  items={activeItems ?? []}
                  label="일정 목록"
                  dateFor={(item) => item.due_date}
                  today={serverToday ?? bootstrap.server_today}
                  renderItem={(schedule) => (
                    <li className="min-w-0" key={schedule.id}>
                      <ScheduleAgendaCard
                        item={schedule}
                        term={scheduleSearchTerm}
                        state={itemListOriginState("schedules", location.key)}
                        selected={desktop && selectedId === schedule.id}
                        onClick={(event) => {
                          if (selectContentInPlace(event)) {
                            setSelectedId(schedule.id);
                            document
                              .querySelector("[data-schedule-calendar-pair]")
                              ?.scrollIntoView({ block: "start" });
                          } else rememberCurrentPosition(schedule.id);
                        }}
                        linkRef={(element) => {
                          if (element === null) scheduleLinkRefs.current.delete(schedule.id);
                          else scheduleLinkRefs.current.set(schedule.id, element);
                        }}
                      />
                    </li>
                  )}
                />
                {cursorByScope[activeScope] === null ? null : (
                  <ContentMore
                    busy={loading || loadingMore}
                    onMore={() =>
                      void loadScope(activeScope, cursorByScope[activeScope] ?? undefined)
                    }
                    label="일정 더 보기"
                  />
                )}
              </div>
            )}
          </div>

          {serverToday === undefined ? null : (
            <p className="mt-5 text-right text-xs font-medium text-app-muted">
              기준일 <time dateTime={serverToday}>{formatScheduleDate(serverToday)}</time>
            </p>
          )}
        </section>
      </ContentFrameBody>
    </AppShell>
  );
}
