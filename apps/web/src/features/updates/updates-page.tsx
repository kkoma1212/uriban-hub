import { ListFilter, LoaderCircle, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";

import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import { listUpdates, type UpdateItem, type UpdatesFilter } from "../../api/updates";
import { AppShell } from "../layout/app-shell";
import {
  ContentFrameBody,
  ContentFrameHeader,
  ContentFilters,
  ContentSplit,
} from "../layout/content-frame";
import { NoticeDetailPage } from "../notices/notice-detail-page";
import { SupplyDetailPage } from "../supplies/supply-detail-page";
import {
  CompactContentProgress,
  ContentMore,
  ContentPostCard,
  DateGroupedList,
  ListSearch,
  StudentContentState,
  isDueSoon,
  groupContentItems,
  selectContentInPlace,
  useContentDesktop,
  useContentListPosition,
  readContentList,
} from "./content-list-view";
import { contentPageCursor, type ContentPageSnapshot } from "../layout/content-pagination";
import {
  itemListHistoryEntry,
  itemListOriginState,
  itemListOwner,
  rememberItemListPosition,
  restorableItemListView,
} from "../layout/item-list-history";
import { AsyncStatePanel, StaleDataAlert } from "../layout/async-state";
import { formatNoticeDateTime } from "../notices/notice-format";
import { formatSupplyDate } from "../supplies/supply-format";
import { UpdateCreatePanel, type UpdateCreateKind } from "./update-create-panel";

import "./updates-list.css";

type UpdatesLoadFailure = "append" | "refresh";

const FILTERS: Array<{
  filter: UpdatesFilter;
  label: string;
}> = [
  { filter: "all", label: "전체" },
  { filter: "notices", label: "공지" },
  { filter: "homework", label: "숙제" },
  { filter: "materials", label: "준비물" },
  { filter: "performance", label: "수행평가" },
  { filter: "important", label: "중요" },
];

/*
 * 「투표」 칸은 없앴다(2026-08-18 Hex 결정 — 투표는 투표 화면 한 곳). 서버도 투표를
 * 안 실어 보내므로 `filter=polls` 는 이제 400이다. 옛 즐겨찾기가 그 주소로 들어와도
 * 오류 대신 「전체」가 보이도록 여기서 걸러 낸다.
 */
function filterFromSearch(searchParams: URLSearchParams): UpdatesFilter {
  const value = searchParams.get("filter");
  return value === "important" ||
    value === "performance" ||
    value === "supplies" ||
    value === "homework" ||
    value === "notices" ||
    value === "materials" ||
    value === "unresolved"
    ? value
    : "all";
}

function filterPath(filter: UpdatesFilter): string {
  return filter === "all" ? "/updates" : `/updates?filter=${filter}`;
}

function isPastUpdate(item: UpdateItem, today: string): boolean {
  return item.kind === "supply" && item.needed_on !== null && item.needed_on < today;
}

function itemPath(item: UpdateItem): string {
  return item.kind === "notice" ? `/notices/${item.id}` : `/supplies/${item.id}`;
}

export function UpdatesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const desktopPreview = useContentDesktop();
  const activeFilter = filterFromSearch(searchParams);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [items, setItems] = useState<UpdateItem[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unresolvedCount, setUnresolvedCount] = useState<number>();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [serverToday, setServerToday] = useState<string>();
  const [selectedAudienceEnabled, setSelectedAudienceEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [bootstrapLoadAttempt, setBootstrapLoadAttempt] = useState(0);
  const [loadFailure, setLoadFailure] = useState<UpdatesLoadFailure>();
  const [fatalError, setFatalError] = useState<string>();
  const [formOpen, setFormOpen] = useState(false);
  const [initialCreateKind, setInitialCreateKind] = useState<UpdateCreateKind>();
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const restoreCreateFocusRef = useRef(false);
  const itemsRef = useRef<UpdateItem[] | undefined>(undefined);
  const loadGenerationRef = useRef(0);
  const [progressRefreshKey, setProgressRefreshKey] = useState(0);
  const updatesSearchRef = useRef<string | undefined>(undefined);
  const [updatesSearchTerm, setUpdatesSearchTerm] = useState<string>();
  const [searchReset, setSearchReset] = useState(0);
  const [selectedUpdateKey, setSelectedUpdateKey] = useState<string>();
  const { page: contentPage, received: receivedPage } = useContentListPosition();
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const currentPage = contentPage(activeFilter, items);
  const listScrollRef = useRef<HTMLUListElement>(null);
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const restorePageRef = useRef<ContentPageSnapshot | undefined>(undefined);
  const restoredLocationRef = useRef<string | undefined>(undefined);
  const failedRequestRef = useRef<
    { cursor: string | undefined; restore: ContentPageSnapshot | undefined } | undefined
  >(undefined);

  useLayoutEffect(() => {
    if (!formOpen && restoreCreateFocusRef.current) {
      restoreCreateFocusRef.current = false;
      createButtonRef.current?.focus();
    }
  }, [formOpen]);

  const load = useCallback(
    async (
      filter: UpdatesFilter,
      cursor?: string,
      restore?: ContentPageSnapshot,
    ): Promise<void> => {
      const generation = ++loadGenerationRef.current;
      const appending = cursor !== undefined && restore === undefined;
      const changingPage = cursor !== undefined || restore !== undefined;
      if (changingPage) setLoadingMore(true);
      else setLoading(true);
      try {
        /* 검색어는 ref 로 읽는다 — load 를 다시 만들면 열려 있던 요청 세대가 꼬인다. */
        const search = updatesSearchRef.current;
        const loaded = await readContentList(
          (next) => listUpdates(filter, next, search),
          cursor,
          restore,
        );
        const { result } = loaded;
        if (generation !== loadGenerationRef.current) return;
        receivedPage(
          filter,
          itemsRef.current?.length ?? 0,
          result.items.length,
          appending,
          loaded.cursor,
          loaded.restore,
        );
        const nextItems = appending ? [...(itemsRef.current ?? []), ...result.items] : result.items;
        itemsRef.current = nextItems;
        setItems(nextItems);
        setNextCursor(result.next_cursor);
        setSelectedAudienceEnabled(result.selected_audience_enabled === true);
        setUnresolvedCount(
          typeof result.unresolved_count === "number" &&
            Number.isSafeInteger(result.unresolved_count) &&
            result.unresolved_count >= 0
            ? result.unresolved_count
            : undefined,
        );
        setServerToday(result.server_today);
        // 더 보기는 새 카드만 읽는다. 기존 카드의 확인 현황을 다시 비우지 않는다.
        if (!appending) setProgressRefreshKey((current) => current + 1);
        setLoadFailure(undefined);
        failedRequestRef.current = undefined;
      } catch (requestError) {
        if (generation !== loadGenerationRef.current) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setUnresolvedCount(undefined);
        failedRequestRef.current = { cursor, restore };
        setLoadFailure(changingPage ? "append" : "refresh");
      } finally {
        if (generation === loadGenerationRef.current) {
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
        const view = restorableItemListView("updates", location.key, result, activeFilter);
        if (view !== undefined) {
          restorePageRef.current = view.page;
          updatesSearchRef.current = view.search;
          setUpdatesSearchTerm(view.search);
          setSelectedUpdateKey(itemListHistoryEntry("updates", location.key)?.itemId);
        }
        setUnresolvedCount(undefined);
        setBootstrap(result);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setFatalError(
          requestError instanceof Error ? requestError.message : "소식 화면을 준비하지 못했습니다.",
        );
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bootstrapLoadAttempt, navigate]);

  useEffect(() => {
    if (bootstrap === undefined) return;
    itemsRef.current = undefined;
    setItems(undefined);
    setNextCursor(null);
    setLoadFailure(undefined);
    const restore = restorePageRef.current;
    restorePageRef.current = undefined;
    void load(activeFilter, contentPageCursor(restore), restore);
  }, [activeFilter, bootstrap, load]);

  useLayoutEffect(() => {
    if (items === undefined || restoredLocationRef.current === location.key) return;
    const entry = itemListHistoryEntry("updates", location.key);
    if (
      entry === undefined ||
      bootstrap === undefined ||
      restorableItemListView("updates", location.key, bootstrap, activeFilter) === undefined
    )
      return;
    restoredLocationRef.current = location.key;
    const listScroll = listScrollRef.current?.closest<HTMLElement>(".content-split-main");
    if (listScroll) listScroll.scrollTop = entry.view?.listScrollTop ?? 0;
    window.scrollTo({ top: entry.scrollY, left: 0, behavior: "auto" });
    (linkRefs.current.get(entry.itemId) ?? listTitleRef.current)?.focus({ preventScroll: true });
  }, [items, location.key, bootstrap, activeFilter]);

  useEffect(() => {
    if (bootstrap?.current_membership?.role !== "teacher") return;
    const createIntent = searchParams.get("create");
    const legacyCreateIntent = searchParams.get("new");
    if (
      createIntent !== "1" &&
      createIntent !== "notice" &&
      createIntent !== "supply" &&
      createIntent !== "homework" &&
      legacyCreateIntent !== "1"
    ) {
      return;
    }

    setInitialCreateKind(
      createIntent === "notice" || createIntent === "supply" || createIntent === "homework"
        ? createIntent
        : undefined,
    );
    setFormOpen(true);

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("create");
    nextSearchParams.delete("new");
    setSearchParams(nextSearchParams, { replace: true });
  }, [bootstrap, searchParams, setSearchParams]);

  useEffect(
    () => () => {
      loadGenerationRef.current += 1;
    },
    [],
  );

  function retryBootstrap(): void {
    setFatalError(undefined);
    setLoading(true);
    setBootstrapLoadAttempt((attempt) => attempt + 1);
  }

  if (bootstrap === undefined) {
    return (
      <AppShell alignedFrame contentFrame width="wide">
        <ContentFrameHeader title="우리반 소식" />
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
              <ListFilter aria-hidden="true" className="mx-auto text-rose-500" size={32} />
            )}
            <p className="mt-4 font-bold">{loading ? "소식을 불러오고 있어요." : fatalError}</p>
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

  const teacherMembership =
    bootstrap.current_membership?.role === "teacher" ? bootstrap.current_membership : undefined;
  const teacher = teacherMembership !== undefined;
  const initialLoading = (loading || loadingMore) && items === undefined;
  const firstDateGroup = groupContentItems(
    items ?? [],
    (item) => item.published_at,
    serverToday ?? bootstrap.server_today,
  )[0];
  const selectedItem =
    selectedUpdateKey === ""
      ? undefined
      : ((items ?? []).find((item) => `${item.kind}:${item.id}` === selectedUpdateKey) ??
        items?.[0]);

  function rememberCurrentPosition(item: UpdateItem): void {
    rememberItemListPosition("updates", location.key, `${item.kind}:${item.id}`, window.scrollY, {
      owner: itemListOwner(bootstrap!),
      criteria: activeFilter,
      page: currentPage.snapshot,
      search: updatesSearchRef.current,
      listScrollTop:
        listScrollRef.current?.closest<HTMLElement>(".content-split-main")?.scrollTop ?? 0,
    });
  }

  function retryList(): void {
    const failed = failedRequestRef.current;
    void load(activeFilter, failed?.cursor, failed?.restore);
  }

  function clearFilters(): void {
    updatesSearchRef.current = undefined;
    setUpdatesSearchTerm(undefined);
    // 초기화 직전 입력의 검색 타이머도 취소한다.
    setSearchReset((value) => value + 1);
    if (activeFilter === "all") void load("all");
    else void navigate(filterPath("all"));
    listTitleRef.current?.focus({ preventScroll: true });
  }

  function closeCreate(): void {
    restoreCreateFocusRef.current = true;
    setFormOpen(false);
    setInitialCreateKind(undefined);
  }

  return (
    <AppShell
      alignedFrame={!formOpen}
      contentFrame
      hideMobileNavigation={formOpen}
      navigationRole={teacher ? "teacher" : "student"}
      width="wide"
    >
      <ContentFrameHeader
        title={formOpen ? "소식 쓰기" : "소식"}
        className={formOpen ? "hidden" : ""}
        hidden={formOpen}
        actions={
          formOpen ? undefined : (
            <>
              <ListSearch
                key={searchReset}
                label="공지·준비물·숙제 검색"
                searchTerm={updatesSearchTerm}
                onSearch={(term) => {
                  updatesSearchRef.current = term;
                  setUpdatesSearchTerm(term);
                  void load(activeFilter);
                }}
                placeholder="제목·내용 검색"
              />
              <button
                aria-label="소식 새로고침"
                className="ui-icon-button"
                disabled={loading || loadingMore}
                onClick={() => void load(activeFilter)}
                type="button"
              >
                <RefreshCw aria-hidden className={loading ? "animate-spin" : ""} size={18} />
              </button>
              {teacher ? (
                <button
                  aria-label="쓰기 (소식 작성)"
                  aria-controls="update-create-panel"
                  aria-expanded={formOpen}
                  className="content-write"
                  onClick={() => {
                    setInitialCreateKind(undefined);
                    setFormOpen(true);
                  }}
                  ref={createButtonRef}
                  type="button"
                >
                  <Plus aria-hidden size={18} />
                  쓰기
                </button>
              ) : null}
              <div
                className="relative"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setMoreOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setMoreOpen(false);
                    moreButtonRef.current?.focus();
                  }
                }}
              >
                <button
                  aria-label="소식 더보기"
                  aria-controls="updates-more-options"
                  aria-expanded={moreOpen}
                  className="ui-icon-button"
                  ref={moreButtonRef}
                  onClick={() => setMoreOpen(!moreOpen)}
                  type="button"
                >
                  <MoreHorizontal aria-hidden size={20} />
                </button>
                {moreOpen ? (
                  <div
                    className="absolute right-0 top-12 z-30 flex w-48 flex-col rounded-2xl border border-app-border bg-app-surface p-2 shadow-card"
                    id="updates-more-options"
                    onClick={() => setMoreOpen(false)}
                  >
                    <Link
                      className="ui-button ui-button-tertiary justify-start text-sm"
                      to={filterPath("supplies")}
                    >
                      준비물·숙제 함께 보기
                    </Link>
                    {!teacher &&
                    (unresolvedCount !== undefined || activeFilter === "unresolved") ? (
                      <Link
                        className="ui-button ui-button-tertiary justify-start text-sm"
                        to="/updates/catch-up"
                      >
                        놓친 안내 따라잡기
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          )
        }
      >
        {formOpen ? null : (
          <ContentFilters label="소식 필터" role="navigation">
            {FILTERS.map(({ filter, label }) => (
              <Link
                aria-current={activeFilter === filter ? "page" : undefined}
                className="content-filter"
                key={filter}
                to={filterPath(filter)}
              >
                {label}
              </Link>
            ))}
            {activeFilter === "supplies" ? (
              <Link className="content-filter" aria-current="page" to={filterPath("supplies")}>
                준비물·숙제
              </Link>
            ) : null}
            {!teacher && (unresolvedCount !== undefined || activeFilter === "unresolved") ? (
              <Link
                className="content-filter"
                aria-current={activeFilter === "unresolved" ? "page" : undefined}
                to={filterPath("unresolved")}
              >
                안 한 것
                {unresolvedCount === undefined ? null : (
                  <span className="updates-unresolved-count ml-1 font-extrabold tabular-nums text-danger">
                    {unresolvedCount}
                  </span>
                )}
              </Link>
            ) : null}
            {teacher && !desktopPreview ? (
              <Link className="content-filter" to="/updates/followups">
                학생별 미해결
              </Link>
            ) : !teacher && unresolvedCount === undefined && activeFilter !== "unresolved" ? (
              <Link className="content-filter" to="/updates/catch-up">
                놓친 안내 따라잡기
              </Link>
            ) : null}
          </ContentFilters>
        )}
      </ContentFrameHeader>
      {teacher && teacherMembership !== undefined && formOpen ? (
        <UpdateCreatePanel
          initialKind={initialCreateKind}
          membershipId={teacherMembership.id}
          onClose={closeCreate}
          selectedAudienceEnabled={selectedAudienceEnabled}
          serverToday={serverToday}
        />
      ) : null}
      <ContentFrameBody
        as="section"
        aria-busy={loading || loadingMore}
        aria-labelledby="updates-list-title"
        hidden={formOpen}
      >
        <h2
          className="sr-only focus:not-sr-only focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2"
          id="updates-list-title"
          ref={listTitleRef}
          tabIndex={-1}
        >
          {activeFilter === "supplies"
            ? "준비물·숙제"
            : activeFilter === "unresolved"
              ? "안 한 것"
              : FILTERS.find(({ filter }) => filter === activeFilter)?.label}{" "}
          소식
        </h2>
        {loadFailure !== undefined && items !== undefined ? (
          <StaleDataAlert
            busy={loading || loadingMore}
            description={
              loadFailure === "append"
                ? "현재까지 불러온 소식은 유지했습니다. 이어지는 소식을 다시 불러올 수 있어요."
                : "이전에 불러온 목록을 표시하고 있어 최신 내용과 다를 수 있어요."
            }
            onRetry={retryList}
            title={
              loadFailure === "append"
                ? "소식 더 보기를 완료하지 못했어요."
                : "최신 소식을 확인하지 못했어요."
            }
          />
        ) : null}
        {initialLoading ? (
          <AsyncStatePanel kind="loading" title="소식을 불러오고 있어요." />
        ) : items === undefined && loadFailure !== undefined ? (
          <AsyncStatePanel
            action={
              <button
                className="ui-button ui-button-primary text-sm"
                disabled={loading || loadingMore}
                onClick={retryList}
                type="button"
              >
                다시 시도
              </button>
            }
            description="인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요."
            kind="error"
            title="소식을 불러오지 못했어요."
          />
        ) : (items ?? []).length === 0 ? (
          <AsyncStatePanel
            action={
              updatesSearchTerm !== undefined || activeFilter !== "all" ? (
                <button
                  className="ui-button ui-button-primary text-sm"
                  onClick={clearFilters}
                  type="button"
                >
                  검색·필터 초기화
                </button>
              ) : undefined
            }
            description={
              updatesSearchTerm === undefined && activeFilter === "all"
                ? "공지·준비물·숙제가 생기면 여기에 보여요."
                : "검색어나 종류를 바꿔 보세요. 초기화하면 전체 소식이 나와요."
            }
            icon={ListFilter}
            kind="empty"
            title={
              updatesSearchTerm !== undefined
                ? "검색 결과가 없어요."
                : activeFilter === "all"
                  ? "표시할 소식이 없어요."
                  : "선택한 종류의 소식이 없어요."
            }
          />
        ) : (
          <ContentSplit
            className="updates-master-detail"
            data-updates-master-detail="pair"
            asideLabel="선택한 소식 상세"
            aside={
              !desktopPreview || selectedItem === undefined ? undefined : selectedItem.kind ===
                "notice" ? (
                <NoticeDetailPage
                  key={selectedItem.kind + ":" + selectedItem.id}
                  embeddedId={selectedItem.id}
                  onClose={() => {
                    setSelectedUpdateKey("");
                    void load(activeFilter, undefined, currentPage.snapshot);
                  }}
                />
              ) : (
                <SupplyDetailPage
                  key={selectedItem.id}
                  embeddedId={selectedItem.id}
                  onClose={() => {
                    setSelectedUpdateKey("");
                    void load(activeFilter, undefined, currentPage.snapshot);
                  }}
                />
              )
            }
          >
            {desktopPreview ? (
              <div className="updates-pane-header">
                <span className="text-[13px] font-bold text-app-muted">
                  {firstDateGroup?.[0] ?? "소식 목록"}
                  {firstDateGroup ? (
                    <span className="ml-1 tabular-nums">{firstDateGroup[1].length}</span>
                  ) : null}
                </span>
                {teacher ? (
                  <Link className="content-filter" to="/updates/followups">
                    학생별 미해결
                  </Link>
                ) : null}
              </div>
            ) : null}
            <div className="updates-list-content">
              <DateGroupedList
                items={items ?? []}
                label="소식 목록"
                firstGroupInHeader={desktopPreview}
                moveLast={(item) => isPastUpdate(item, serverToday ?? bootstrap.server_today)}
                dateFor={(item) => item.published_at}
                today={serverToday ?? bootstrap.server_today}
                listRef={listScrollRef}
                renderItem={(item) => (
                  <li className="min-w-0" key={item.kind + ":" + item.id}>
                    <ContentPostCard
                      to={itemPath(item)}
                      state={itemListOriginState("updates", location.key)}
                      selected={
                        desktopPreview &&
                        selectedItem?.id === item.id &&
                        selectedItem?.kind === item.kind
                      }
                      onClick={(event) => {
                        if (selectContentInPlace(event))
                          setSelectedUpdateKey(item.kind + ":" + item.id);
                        else rememberCurrentPosition(item);
                      }}
                      linkRef={(element) => {
                        const key = item.kind + ":" + item.id;
                        if (element === null) linkRefs.current.delete(key);
                        else linkRefs.current.set(key, element);
                      }}
                      title={item.title}
                      body={item.content}
                      term={updatesSearchTerm}
                      kind={
                        item.kind === "notice"
                          ? item.category === "performance"
                            ? "수행평가"
                            : "공지"
                          : item.category === "homework"
                            ? "숙제"
                            : "준비물"
                      }
                      important={item.is_important}
                      past={isPastUpdate(item, serverToday ?? bootstrap.server_today)}
                      date={item.needed_on ?? item.published_at}
                      dateLabel={
                        item.needed_on === null
                          ? formatNoticeDateTime(item.published_at)
                          : (item.category === "homework" ? "마감 " : "필요한 날 ") +
                            formatSupplyDate(item.needed_on)
                      }
                      dueSoon={
                        item.needed_on !== null &&
                        item.category === "homework" &&
                        isDueSoon(item.needed_on, serverToday ?? bootstrap.server_today)
                      }
                      footer={
                        teacher ? (
                          <CompactContentProgress
                            refreshKey={progressRefreshKey}
                            id={item.id}
                            kind={item.kind}
                            revision={item.content_revision}
                            doneLabel={
                              item.kind === "notice"
                                ? "확인"
                                : item.category === "homework"
                                  ? "완료"
                                  : "챙김"
                            }
                          />
                        ) : (
                          <StudentContentState
                            state={item.confirmation_state ?? item.check_state}
                            doneLabel={
                              item.kind === "notice"
                                ? "확인했어요"
                                : item.category === "homework"
                                  ? "다 했어요"
                                  : "챙겼어요"
                            }
                          />
                        )
                      }
                    />
                  </li>
                )}
              />
              {nextCursor === null ? null : (
                <ContentMore
                  busy={loading || loadingMore}
                  onMore={() => void load(activeFilter, nextCursor)}
                />
              )}
            </div>
          </ContentSplit>
        )}
      </ContentFrameBody>
    </AppShell>
  );
}
