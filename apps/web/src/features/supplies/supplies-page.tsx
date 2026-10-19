import {
  Backpack,
  CheckCircle2,
  LoaderCircle,
  Package,
  PencilLine,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import {
  createSupply,
  listSupplies,
  type SupplyCategory,
  type SupplyCheckState,
  type SupplyItem,
  type SupplyListResponse,
  type SupplyScope,
  type SupplyWriteRequest,
} from "../../api/supplies";
import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import { isContentAudienceRequest } from "../../api/content-audiences";
import { useIdempotentContentCreate } from "../../lib/use-idempotent-content-create";
import { AppShell } from "../layout/app-shell";
import { AsyncStatePanel, StaleDataAlert } from "../layout/async-state";
import { SupplyDetailPage } from "./supply-detail-page";
import {
  CompactContentProgress,
  ContentMore,
  ContentPostCard,
  DateGroupedList,
  ListSearch,
  StudentContentState,
  isDueSoon,
  selectContentInPlace,
  useContentDesktop,
  useContentListPosition,
  readContentList,
} from "../updates/content-list-view";
import { contentPageCursor, type ContentPageSnapshot } from "../layout/content-pagination";
import { ContentFrameHeader, ContentFilters, ContentSplit } from "../layout/content-frame";
import {
  itemListHistoryEntry,
  itemListOwner,
  restorableItemListView,
  itemListOriginState,
  rememberItemListPosition,
} from "../layout/item-list-history";
import { categoryCreatedNotice, checkStateLabel, formatSupplyDate } from "./supply-format";
import { SupplyForm } from "./supply-form";

const SCOPE_ORDER: SupplyScope[] = ["upcoming", "today", "this_week", "past"];
type SupplyLoadFailure = "append" | "refresh";

function scopeValues<T>(value: T): Record<SupplyScope, T> {
  return { upcoming: value, today: value, this_week: value, past: value };
}

function isRelativeScope(scope: SupplyScope): boolean {
  return scope === "today" || scope === "this_week";
}

const scopeConfig: Record<
  SupplyScope,
  { empty: string; label: string; summary: string; tabLabel: string }
> = {
  upcoming: {
    empty: "다가오는 준비물·숙제가 없어요.",
    label: "다가오는 준비물·숙제",
    summary: "오늘부터 챙길 준비물과 해야 할 숙제를 날짜순으로 확인해요.",
    tabLabel: "다가오는",
  },
  today: {
    empty: "오늘 필요한 준비물·숙제가 없어요.",
    label: "오늘 준비물·숙제",
    summary: "한국 시간 기준, 오늘 챙길 준비물과 오늘 마감인 숙제를 확인해요.",
    tabLabel: "오늘",
  },
  this_week: {
    empty: "이번 주 준비물·숙제가 없어요.",
    label: "이번 주 준비물·숙제",
    summary: "월요일부터 일요일까지, 지난 날짜도 포함해 날짜순으로 확인해요.",
    tabLabel: "이번 주",
  },
  past: {
    empty: "최근 90일 동안 지난 준비물·숙제가 없어요.",
    label: "지난 준비물·숙제",
    summary: "최근 90일의 준비물과 숙제를 최신 날짜부터 확인해요.",
    tabLabel: "지난 항목",
  },
};

interface SuppliesLocationState {
  notice?: string;
}

function locationNotice(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const notice = (value as SuppliesLocationState).notice;
  return typeof notice === "string" ? notice : undefined;
}

function scopeFromSearch(searchParams: URLSearchParams): SupplyScope {
  return SCOPE_ORDER.find((scope) => scope === searchParams.get("scope")) ?? "upcoming";
}

/** 기본은 함께 표시하고, 교사와 학생 모두 필요할 때 종류를 좁힌다. */
const CATEGORY_ORDER: SupplyCategory[] = ["general", "homework"];

const categoryConfig: Record<SupplyCategory, { icon: typeof Package; label: string }> = {
  general: { icon: Package, label: "준비물" },
  homework: { icon: PencilLine, label: "숙제" },
};

function categoryFromSearch(searchParams: URLSearchParams): SupplyCategory | undefined {
  const value = searchParams.get("category");
  return value === "general" || value === "homework" ? value : undefined;
}

const CHECK_STATE_ORDER: SupplyCheckState[] = ["unchecked", "modified_unconfirmed", "checked"];

function checkStateFromSearch(searchParams: URLSearchParams): SupplyCheckState | undefined {
  return CHECK_STATE_ORDER.find((state) => state === searchParams.get("check_state"));
}

function checkFilterLabel(state: SupplyCheckState, category: SupplyCategory | undefined): string {
  if (state === "modified_unconfirmed") return "재확인 필요";
  if (category !== undefined) return checkStateLabel(state, category);
  return state === "checked" ? "챙김·완료" : "미챙김·미완료";
}

function isSupplyWriteRequest(value: unknown): value is SupplyWriteRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<SupplyWriteRequest>;
  /*
   * 종류가 없어도 통과시킨다. 이 판정은 브라우저에 남아 있던 임시저장 초안을 되살릴
   * 때 쓰이는데, 종류가 생기기 전에 저장된 초안에는 그 칸이 없다. 여기서 걸러 버리면
   * 결과를 모른 채 남아 있던 등록 요청이 조용히 사라지고, 그걸 되살려 중복 등록을
   * 막는 장치가 바로 그 초안이다. 종류가 없으면 서버가 일반 준비물로 받는다.
   */
  return (
    (request.audience === undefined || isContentAudienceRequest(request.audience)) &&
    (request.category === undefined ||
      request.category === "general" ||
      request.category === "homework") &&
    (request.description === null || typeof request.description === "string") &&
    typeof request.needed_on === "string" &&
    typeof request.title === "string"
  );
}

export function SuppliesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeScope = scopeFromSearch(searchParams);
  const activeCategory = categoryFromSearch(searchParams);
  const desktop = useContentDesktop();
  const [selectedId, setSelectedId] = useState<string>();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const activeCheckState =
    bootstrap?.current_membership?.role === "teacher"
      ? undefined
      : checkStateFromSearch(searchParams);
  const [focusedScope, setFocusedScope] = useState<SupplyScope>(activeScope);
  const [itemsByScope, setItemsByScope] = useState<Record<SupplyScope, SupplyItem[] | undefined>>(
    scopeValues(undefined),
  );
  const [cursorByScope, setCursorByScope] = useState<Record<SupplyScope, string | null>>(
    scopeValues(null),
  );
  const [dateRangesByScope, setDateRangesByScope] = useState<
    Partial<Record<SupplyScope, SupplyListResponse["date_range"]>>
  >({});
  const [serverToday, setServerToday] = useState<string>();
  const [selectedAudienceEnabled, setSelectedAudienceEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [bootstrapLoadAttempt, setBootstrapLoadAttempt] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const focusResultsRef = useRef(false);
  const [error, setError] = useState<string>();
  const [loadFailuresByScope, setLoadFailuresByScope] = useState<
    Partial<Record<SupplyScope, SupplyLoadFailure>>
  >({});
  const [notice, setNotice] = useState<string | undefined>(() => locationNotice(location.state));
  const activeScopeRef = useRef(activeScope);
  activeScopeRef.current = activeScope;
  const activeCategoryRef = useRef(activeCategory);
  activeCategoryRef.current = activeCategory;
  const activeCheckStateRef = useRef(activeCheckState);
  activeCheckStateRef.current = activeCheckState;
  const filters = JSON.stringify([activeCategory ?? null, activeCheckState ?? null]);
  const previousFiltersRef = useRef(filters);
  const itemsByScopeRef = useRef(itemsByScope);
  const tabRefs = useRef<Record<SupplyScope, HTMLButtonElement | null>>(scopeValues(null));
  const createButtonRef = useRef<HTMLButtonElement>(null);
  /*
   * 등록을 마쳤다고 알릴 때 종류를 말하려면 방금 무엇을 보냈는지 알아야 한다.
   * 완료 시점에는 폼이 이미 닫혀 있어 화면 상태로는 알 수 없으므로 보낼 때 적어 둔다.
   */
  const submittedCategoryRef = useRef<SupplyCategory>("general");
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const listScrollRef = useRef<HTMLUListElement>(null);
  const supplyLinkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const loadGenerationRef = useRef<Record<SupplyScope, number>>(scopeValues(0));
  const supplySearchRef = useRef<string | undefined>(undefined);
  const [supplySearchTerm, setSupplySearchTerm] = useState<string>();
  const previousScopeRef = useRef(activeScope);
  const restoredLocationKeyRef = useRef<string | undefined>(undefined);
  const { page: contentPage, received: receivedPage } = useContentListPosition();
  const currentPage = contentPage(activeScope, itemsByScope[activeScope]);
  const pageSnapshotRef = useRef(currentPage.snapshot);
  pageSnapshotRef.current = currentPage.snapshot;
  const restorePageRef = useRef<ContentPageSnapshot | undefined>(undefined);
  const failedRequestsRef = useRef<
    Partial<
      Record<SupplyScope, { cursor: string | undefined; restore: ContentPageSnapshot | undefined }>
    >
  >({});
  const viewCriteria = JSON.stringify([
    activeScope,
    activeCategory ?? null,
    activeCheckState ?? null,
  ]);

  const loadScope = useCallback(
    async (scope: SupplyScope, cursor?: string, restore?: ContentPageSnapshot): Promise<void> => {
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
        /* 검색어도 ref 로 읽는다 — load 를 다시 만들면 열려 있던 요청 세대가 꼬인다. */
        const category = activeCategoryRef.current;
        const search = supplySearchRef.current;
        const checkState = activeCheckStateRef.current;
        const loaded = await readContentList(
          (next) => listSupplies(scope, next, category, search, checkState),
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
        setSelectedAudienceEnabled(result.selected_audience_enabled === true);
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
        const criteria = JSON.stringify([
          activeScope,
          activeCategory ?? null,
          result.current_membership.role === "student"
            ? (checkStateFromSearch(searchParams) ?? null)
            : null,
        ]);
        const view = restorableItemListView("supplies", location.key, result, criteria);
        restorePageRef.current = view?.page;
        if (view !== undefined) {
          supplySearchRef.current = view.search;
          setSupplySearchTerm(view.search);
          setFiltersExpanded(view.filtersExpanded ?? false);
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
          requestError instanceof Error
            ? requestError.message
            : "준비물 화면을 준비하지 못했습니다.",
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

  const supplyCreate = useIdempotentContentCreate<SupplyWriteRequest>({
    actionLabel: "준비물·숙제 등록 요청",
    create: createSupply,
    isRequest: isSupplyWriteRequest,
    membershipId: bootstrap?.current_membership?.id,
    onCreated: (supplyId) => {
      void navigate(`/supplies/${supplyId}`, {
        state: {
          notice: categoryCreatedNotice(submittedCategoryRef.current),
        },
      });
    },
    onUnauthorized: () => void navigate("/login", { replace: true }),
    readServerToday: async () => (await listSupplies(activeScope)).server_today,
    resource: "supplies",
    serverToday,
  });

  useEffect(() => {
    if (
      bootstrap?.current_membership?.role !== "teacher" ||
      (searchParams.get("new") !== "1" && searchParams.get("create") !== "1")
    ) {
      return;
    }

    setFormOpen(true);
    supplyCreate.clearResolvedError();
    setNotice(undefined);

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("new");
    nextSearchParams.delete("create");
    setSearchParams(nextSearchParams, { replace: true });
  }, [bootstrap, searchParams, setSearchParams]);

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

  // 종류·확인 상태 변경은 아래 로딩 효과 전에 모든 기간의 이전 조건을 비운다.
  useEffect(() => {
    if (previousFiltersRef.current === filters) return;
    previousFiltersRef.current = filters;
    invalidateResults();
    setFormOpen(false);
    setNotice(undefined);
    setError(undefined);
  }, [filters, invalidateResults]);

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
  }, [activeCategory, activeCheckState, activeScope, bootstrap, loadScope]);

  useEffect(() => {
    if (
      bootstrap === undefined ||
      (!isRelativeScope(activeScope) && activeCheckState === undefined)
    )
      return;
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
  }, [activeCheckState, activeScope, bootstrap, loadScope]);

  useLayoutEffect(() => {
    if (!focusResultsRef.current) return;
    focusResultsRef.current = false;
    listTitleRef.current?.focus({ preventScroll: true });
    listTitleRef.current?.scrollIntoView?.({ block: "start" });
  }, [filtersExpanded]);

  useLayoutEffect(() => {
    const activeItems = itemsByScope[activeScope];
    if (activeItems === undefined || restoredLocationKeyRef.current === location.key) return;
    const historyEntry = itemListHistoryEntry("supplies", location.key);
    if (historyEntry === undefined) return;
    if (
      historyEntry.view !== undefined &&
      (bootstrap === undefined ||
        restorableItemListView("supplies", location.key, bootstrap, viewCriteria) === undefined)
    )
      return;
    restoredLocationKeyRef.current = location.key;
    const listScroll = listScrollRef.current?.closest<HTMLElement>(".content-split-main");
    if (listScroll) listScroll.scrollTop = historyEntry.view?.listScrollTop ?? 0;
    window.scrollTo({ behavior: "auto", left: 0, top: historyEntry.scrollY });
    const focusTarget = supplyLinkRefs.current.get(historyEntry.itemId) ?? listTitleRef.current;
    focusTarget?.focus({ preventScroll: true });
  }, [activeScope, itemsByScope, location.key, bootstrap, viewCriteria]);

  function rememberCurrentPosition(supplyId: string): void {
    rememberItemListPosition("supplies", location.key, supplyId, window.scrollY, {
      owner: itemListOwner(bootstrap!),
      criteria: viewCriteria,
      page: currentPage.snapshot,
      listScrollTop:
        listScrollRef.current?.closest<HTMLElement>(".content-split-main")?.scrollTop ?? 0,
      search: supplySearchRef.current,
      filtersExpanded,
    });
  }

  function retryScope(scope: SupplyScope): void {
    const failed = failedRequestsRef.current[scope];
    void loadScope(scope, failed?.cursor, failed?.restore);
  }

  function switchScope(scope: SupplyScope): void {
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

  function switchCategory(category: SupplyCategory | undefined): void {
    if (category === activeCategory) return;
    const nextSearchParams = new URLSearchParams(searchParams);
    if (category === undefined) nextSearchParams.delete("category");
    else nextSearchParams.set("category", category);
    setSearchParams(nextSearchParams);
  }

  function searchSupplies(term: string | undefined): void {
    supplySearchRef.current = term;
    setSupplySearchTerm(term);
    invalidateResults();
    void loadScope(activeScope);
  }

  function switchCheckState(state: SupplyCheckState | undefined): void {
    if (state === activeCheckState) return;
    const nextSearchParams = new URLSearchParams(searchParams);
    if (state === undefined) nextSearchParams.delete("check_state");
    else nextSearchParams.set("check_state", state);
    setSearchParams(nextSearchParams);
  }

  function clearFilters(): void {
    if (activeCategory === undefined && activeCheckState === undefined) searchSupplies(undefined);
    else {
      supplySearchRef.current = undefined;
      setSupplySearchTerm(undefined);
      const nextSearchParams = new URLSearchParams(searchParams);
      nextSearchParams.delete("category");
      nextSearchParams.delete("check_state");
      setSearchParams(nextSearchParams);
    }
  }

  function showResults(): void {
    focusResultsRef.current = false;
    listTitleRef.current?.focus({ preventScroll: true });
    listTitleRef.current?.scrollIntoView?.({ block: "start" });
  }

  function moveTabFocus(event: React.KeyboardEvent<HTMLButtonElement>, current: SupplyScope): void {
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
      <AppShell contentFrame width="wide">
        <ContentFrameHeader title="준비물·숙제" />
        <div
          aria-live={loading ? "polite" : "assertive"}
          className="mt-6 text-center"
          role={loading ? "status" : "alert"}
        >
          {loading ? (
            <LoaderCircle
              aria-hidden="true"
              className="mx-auto animate-spin text-role-primary"
              size={32}
            />
          ) : (
            <Backpack aria-hidden="true" className="mx-auto text-rose-500" size={32} />
          )}
          <p className="mt-4 font-bold">{loading ? "준비물 화면을 준비하고 있어요." : error}</p>
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
      </AppShell>
    );
  }

  const teacher = bootstrap.current_membership?.role === "teacher";
  const activeItems = itemsByScope[activeScope];
  const selectedSupply =
    selectedId === ""
      ? undefined
      : (activeItems?.find((item) => item.id === selectedId) ?? activeItems?.[0]);
  const dateRange = dateRangesByScope[activeScope];
  const filtered =
    activeCategory !== undefined ||
    activeCheckState !== undefined ||
    supplySearchTerm !== undefined;
  const activeLoadFailure = loadFailuresByScope[activeScope];
  const initialListLoading = (loading || loadingMore) && activeItems === undefined;

  return (
    <AppShell contentFrame navigationRole={teacher ? "teacher" : "student"} width="wide">
      <ContentFrameHeader
        actions={
          <>
            <ListSearch
              label="준비물·숙제 검색"
              searchTerm={supplySearchTerm}
              onSearch={searchSupplies}
              placeholder="제목·내용 검색"
            />
            {teacher ? (
              <button
                aria-label="준비물·숙제 작성"
                aria-controls="supply-create-panel"
                aria-expanded={formOpen}
                className="content-write"
                data-content-hero-action
                disabled={supplyCreate.busy}
                onClick={() => {
                  setFormOpen((current) => !current);
                  supplyCreate.clearResolvedError();
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
        title="준비물·숙제"
      />

      {supplyCreate.error === undefined ? null : (
        <div
          className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700"
          role="alert"
        >
          <p>{supplyCreate.error}</p>
        </div>
      )}

      {teacher && formOpen ? (
        <section
          className="mt-5 rounded-card border border-role-border border-t-4 border-t-role-primary bg-app-surface-raised p-5 shadow-sm sm:p-7"
          id="supply-create-panel"
        >
          <p className="text-sm font-bold text-role-primary">새 준비물·숙제</p>
          <h2 className="mt-1 break-keep text-xl font-extrabold text-app-text">
            학생들이 잊지 않도록 알려 주세요
          </h2>
          <div className="mt-6 max-w-2xl">
            <SupplyForm
              busy={supplyCreate.busy}
              initialValue={supplyCreate.pendingRequest}
              locked={supplyCreate.outcomeUnknown}
              onCancel={cancelCreate}
              onSubmit={(request) => {
                setNotice(undefined);
                submittedCategoryRef.current = request.category ?? "general";
                void supplyCreate.submit(request);
              }}
              selectedAudienceEnabled={selectedAudienceEnabled}
              showPublishSummary
              submitLabel={supplyCreate.outcomeUnknown ? "결과 다시 확인" : "등록하기"}
            />
          </div>
        </section>
      ) : null}

      {notice === undefined ? null : (
        <p
          aria-live="polite"
          className="mt-5 flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-700"
          role="status"
        >
          <CheckCircle2 aria-hidden="true" size={18} />
          {notice}
        </p>
      )}

      <section className="mt-5 min-w-0" data-feature-surface="supplies-list">
        <ContentFilters label="준비물 종류">
          <button
            aria-label="준비물 목록 새로고침"
            className="ui-icon-button"
            disabled={loading || loadingMore}
            onClick={() => void loadScope(activeScope)}
            type="button"
          >
            <RefreshCw aria-hidden className={loading ? "animate-spin" : ""} size={18} />
          </button>
          <button
            aria-pressed={activeCategory === undefined}
            className="content-filter"
            onClick={() => switchCategory(undefined)}
            type="button"
          >
            전체
          </button>
          {CATEGORY_ORDER.map((category) => (
            <button
              aria-pressed={activeCategory === category}
              className="content-filter"
              key={category}
              onClick={() => switchCategory(category)}
              type="button"
            >
              {categoryConfig[category].label}
            </button>
          ))}
        </ContentFilters>
        <ContentFilters aria-label="준비물 기간" role="tablist">
          {SCOPE_ORDER.map((scope) => (
            <button
              aria-label={scopeConfig[scope].label}
              aria-controls={"supply-panel-" + scope}
              aria-selected={activeScope === scope}
              className="content-filter"
              id={"supply-tab-" + scope}
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
              {scopeConfig[scope].tabLabel}
            </button>
          ))}
        </ContentFilters>
        {!teacher ? (
          <label
            className="mt-2 flex items-center gap-3 text-sm font-bold text-app-text"
            htmlFor="supply-check-state"
          >
            내 확인 상태
            <select
              className="ui-input min-h-11 min-w-0 flex-1 text-sm"
              id="supply-check-state"
              onChange={(event) =>
                switchCheckState(CHECK_STATE_ORDER.find((state) => state === event.target.value))
              }
              value={activeCheckState ?? ""}
            >
              <option value="">전체 상태</option>
              {CHECK_STATE_ORDER.map((state) => (
                <option key={state} value={state}>
                  {checkFilterLabel(state, activeCategory)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="my-2 flex flex-wrap items-center justify-between gap-2">
          <h2
            className="sr-only focus:not-sr-only focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2"
            id="supply-results-heading"
            ref={listTitleRef}
            tabIndex={-1}
          >
            조회 결과
          </h2>
          {dateRange === undefined ? null : (
            <p className="text-xs text-app-muted" data-supply-date-range="true">
              조회 기간{" "}
              <time dateTime={dateRange.start_date}>{formatSupplyDate(dateRange.start_date)}</time>
              {dateRange.start_date === dateRange.end_date ? null : (
                <>
                  {" "}
                  ~{" "}
                  <time dateTime={dateRange.end_date}>{formatSupplyDate(dateRange.end_date)}</time>
                </>
              )}
            </p>
          )}
          {filtered ? (
            <div className="flex gap-2">
              <button
                className="ui-button ui-button-tertiary text-xs"
                onClick={showResults}
                type="button"
              >
                결과 보기
              </button>
              <button
                className="ui-button ui-button-tertiary text-xs"
                onClick={clearFilters}
                type="button"
              >
                검색·필터 초기화
              </button>
            </div>
          ) : null}
        </div>
        {SCOPE_ORDER.map((scope) => (
          <div
            aria-busy={activeScope === scope && (loading || loadingMore)}
            aria-labelledby={`supply-tab-${scope}`}
            hidden={activeScope !== scope}
            id={`supply-panel-${scope}`}
            key={scope}
            className="mt-3 min-w-0"
            role="tabpanel"
            tabIndex={0}
          >
            {activeScope !== scope ? null : (
              <>
                {activeLoadFailure !== undefined && activeItems !== undefined ? (
                  <StaleDataAlert
                    busy={loading || loadingMore}
                    description={
                      activeLoadFailure === "append"
                        ? "지금까지 불러온 목록은 유지했습니다. 이어지는 항목을 다시 불러올 수 있어요."
                        : "이전에 불러온 준비물을 계속 표시하고 있어 최신 정보와 다를 수 있어요."
                    }
                    onRetry={() => retryScope(scope)}
                    title={
                      activeLoadFailure === "append"
                        ? "준비물 더 보기를 완료하지 못했어요."
                        : "최신 준비물을 확인하지 못했어요."
                    }
                  />
                ) : null}

                {initialListLoading ? (
                  <AsyncStatePanel
                    kind="loading"
                    title="준비물 목록을 불러오고 있어요."
                    tone="supplies"
                  />
                ) : activeItems === undefined && activeLoadFailure !== undefined ? (
                  <AsyncStatePanel
                    action={
                      <button
                        aria-busy={loading}
                        className="ui-button ui-button-primary text-sm"
                        disabled={loading || loadingMore}
                        onClick={() => retryScope(scope)}
                        type="button"
                      >
                        다시 시도
                      </button>
                    }
                    description="인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요."
                    kind="error"
                    title="준비물 목록을 불러오지 못했어요."
                    tone="supplies"
                  />
                ) : (activeItems ?? []).length === 0 ? (
                  /* "찾은 게 없어요"와 "아직 아무것도 없어요"는 다른 상태다. */
                  !filtered ? (
                    <AsyncStatePanel
                      description={
                        teacher && scope === "upcoming"
                          ? "필요한 준비물이 생기면 위에서 바로 등록할 수 있어요."
                          : "새로운 준비물이 등록되면 이곳에서 확인할 수 있어요."
                      }
                      icon={Backpack}
                      kind="empty"
                      title={scopeConfig[scope].empty}
                      tone="supplies"
                    />
                  ) : (
                    <AsyncStatePanel
                      description="검색어나 조회 조건을 바꿔 보세요. 초기화하면 선택한 기간의 전체 목록이 나와요."
                      icon={Backpack}
                      kind="empty"
                      title={
                        supplySearchTerm === undefined
                          ? "선택한 조건에 맞는 준비물·숙제가 없어요."
                          : "검색 결과가 없어요."
                      }
                      tone="supplies"
                    />
                  )
                ) : (
                  <ContentSplit
                    asideLabel="선택한 준비물·숙제 상세"
                    aside={
                      !desktop || selectedSupply === undefined ? undefined : (
                        <SupplyDetailPage
                          key={selectedSupply.id}
                          embeddedId={selectedSupply.id}
                          onClose={() => {
                            setSelectedId("");
                            void loadScope(activeScope, undefined, currentPage.snapshot);
                          }}
                        />
                      )
                    }
                  >
                    <DateGroupedList
                      listRef={listScrollRef}
                      items={activeItems ?? []}
                      label="준비물·숙제 목록"
                      dateFor={(item) => item.needed_on}
                      today={serverToday ?? bootstrap.server_today}
                      renderItem={(supply) => (
                        <li className="min-w-0" key={supply.id}>
                          <ContentPostCard
                            to={"/supplies/" + supply.id}
                            state={itemListOriginState("supplies", location.key)}
                            onClick={(event) => {
                              if (selectContentInPlace(event)) setSelectedId(supply.id);
                              else rememberCurrentPosition(supply.id);
                            }}
                            linkRef={(element) => {
                              if (element === null) supplyLinkRefs.current.delete(supply.id);
                              else supplyLinkRefs.current.set(supply.id, element);
                            }}
                            selected={desktop && selectedSupply?.id === supply.id}
                            title={supply.title}
                            body={supply.description}
                            term={supplySearchTerm}
                            kind={supply.category === "homework" ? "숙제" : "준비물"}
                            date={supply.needed_on}
                            dateLabel={
                              (supply.category === "homework" ? "마감 " : "필요한 날 ") +
                              formatSupplyDate(supply.needed_on)
                            }
                            dueSoon={
                              supply.category === "homework" &&
                              isDueSoon(supply.needed_on, serverToday ?? bootstrap.server_today)
                            }
                            footer={
                              teacher ? (
                                <CompactContentProgress
                                  refreshKey={loadGenerationRef.current[activeScope]}
                                  id={supply.id}
                                  kind="supply"
                                  revision={supply.content_revision}
                                  doneLabel={supply.category === "homework" ? "완료" : "챙김"}
                                />
                              ) : (
                                <StudentContentState
                                  state={supply.check_state}
                                  doneLabel={
                                    supply.category === "homework" ? "다 했어요" : "챙겼어요"
                                  }
                                  openLabel={
                                    supply.category === "homework"
                                      ? "아직 안 했어요"
                                      : "아직 안 챙겼어요"
                                  }
                                />
                              )
                            }
                          />
                        </li>
                      )}
                    />
                    {cursorByScope[scope] === null ? null : (
                      <ContentMore
                        busy={loading || loadingMore}
                        onMore={() => void loadScope(scope, cursorByScope[scope] ?? undefined)}
                        label="준비물·숙제 더 보기"
                      />
                    )}
                  </ContentSplit>
                )}
                {serverToday === undefined ? null : (
                  <p className="mt-5 text-right text-xs font-medium text-app-muted">
                    기준일 <time dateTime={serverToday}>{formatSupplyDate(serverToday)}</time>
                  </p>
                )}
              </>
            )}
          </div>
        ))}
      </section>
    </AppShell>
  );
}
