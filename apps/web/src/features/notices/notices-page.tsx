import { BellRing, CheckCircle2, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import { isContentAudienceRequest } from "../../api/content-audiences";
import {
  createNotice,
  listNotices,
  type NoticeItem,
  type NoticeWriteRequest,
} from "../../api/notices";
import { useIdempotentContentCreate } from "../../lib/use-idempotent-content-create";
import { AppShell } from "../layout/app-shell";
import { AsyncStatePanel, StaleDataAlert } from "../layout/async-state";
import { NoticeDetailPage } from "./notice-detail-page";
import {
  CompactContentProgress,
  ContentMore,
  ContentPostCard,
  DateGroupedList,
  ListSearch,
  StudentContentState,
  selectContentInPlace,
  useContentDesktop,
  useContentListPosition,
  readContentList,
} from "../updates/content-list-view";
import type { ContentPageSnapshot } from "../layout/content-pagination";
import { itemListOwner } from "../layout/item-list-history";
import { ContentFrameHeader, ContentSplit } from "../layout/content-frame";
import { formatNoticeDate, formatNoticeDateTime, NOTICE_CREATED_MESSAGE } from "./notice-format";
import { noticeListHistoryEntry, rememberNoticeListPosition } from "./notice-list-history";
import { NoticeForm } from "./notice-form";

interface NoticesLocationState {
  notice?: string;
}

type NoticeLoadFailure = "append" | "refresh";

function locationNotice(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const notice = (value as NoticesLocationState).notice;
  return typeof notice === "string" ? notice : undefined;
}

function isNoticeWriteRequest(value: unknown): value is NoticeWriteRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<NoticeWriteRequest>;
  return (
    (request.audience === undefined || isContentAudienceRequest(request.audience)) &&
    (request.category === undefined ||
      request.category === "general" ||
      request.category === "performance") &&
    typeof request.content === "string" &&
    typeof request.is_important === "boolean" &&
    typeof request.title === "string"
  );
}

export function NoticesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const desktop = useContentDesktop();
  const [selectedId, setSelectedId] = useState<string>();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [items, setItems] = useState<NoticeItem[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [serverToday, setServerToday] = useState<string>();
  const [selectedAudienceEnabled, setSelectedAudienceEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [bootstrapLoadAttempt, setBootstrapLoadAttempt] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [loadFailure, setLoadFailure] = useState<NoticeLoadFailure>();
  const [notice, setNotice] = useState<string | undefined>(() => locationNotice(location.state));
  const itemsRef = useRef<NoticeItem[] | undefined>(undefined);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const listScrollRef = useRef<HTMLUListElement>(null);
  const restorePageRef = useRef<ContentPageSnapshot | undefined>(undefined);
  const failedRequestRef = useRef<
    { cursor: string | undefined; restore: ContentPageSnapshot | undefined } | undefined
  >(undefined);
  const { page, received } = useContentListPosition();
  const currentPage = page("all", items);
  const loadGenerationRef = useRef(0);
  const searchRef = useRef<string | undefined>(undefined);
  const [searchTerm, setSearchTerm] = useState<string>();
  const noticeLinkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const restoredLocationKeyRef = useRef<string | undefined>(undefined);

  const load = useCallback(
    async (cursor?: string, restore?: ContentPageSnapshot): Promise<void> => {
      const generation = ++loadGenerationRef.current;
      const appending = cursor !== undefined && restore === undefined;
      if (appending) setLoadingMore(true);
      else setLoading(true);
      if (itemsRef.current === undefined) setLoadFailure(undefined);
      try {
        /* 검색어는 ref 로 읽는다 — load 를 다시 만들면 열려 있던 요청 세대가 꼬인다. */
        const search = searchRef.current;
        const loaded = await readContentList(
          (next) => listNotices("all", next, search),
          cursor,
          restore,
        );
        const { result } = loaded;
        if (generation !== loadGenerationRef.current) return;
        received(
          "all",
          itemsRef.current?.length ?? 0,
          result.items.length,
          appending,
          loaded.cursor,
          loaded.restore,
        );
        failedRequestRef.current = undefined;
        const nextItems = appending ? [...(itemsRef.current ?? []), ...result.items] : result.items;
        itemsRef.current = nextItems;
        setItems(nextItems);
        setNextCursor(result.next_cursor);
        setSelectedAudienceEnabled(result.selected_audience_enabled === true);
        setServerToday(result.server_today);
        setLoadFailure(undefined);
      } catch (requestError) {
        if (generation !== loadGenerationRef.current) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        failedRequestRef.current = { cursor, restore };
        setLoadFailure(appending ? "append" : "refresh");
      } finally {
        if (generation === loadGenerationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [navigate, received],
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
        const entry = noticeListHistoryEntry(location.key);
        if (entry?.view?.owner === itemListOwner(result)) {
          restorePageRef.current = entry.view.page;
          searchRef.current = entry.view.search;
          setSearchTerm(entry.view.search);
          setSelectedId(entry.noticeId);
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
          requestError instanceof Error ? requestError.message : "공지 화면을 준비하지 못했습니다.",
        );
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bootstrapLoadAttempt, navigate]);

  useEffect(() => {
    if (bootstrap !== undefined && itemsRef.current === undefined) {
      const restore = restorePageRef.current;
      restorePageRef.current = undefined;
      void load(undefined, restore);
    }
  }, [bootstrap, load]);

  const noticeCreate = useIdempotentContentCreate<NoticeWriteRequest>({
    actionLabel: "공지 작성 요청",
    create: createNotice,
    isRequest: isNoticeWriteRequest,
    membershipId: bootstrap?.current_membership?.id,
    onCreated: (noticeId) => {
      rememberCurrentPosition(noticeId);
      void navigate(`/notices/${noticeId}`, {
        state: {
          notice: NOTICE_CREATED_MESSAGE,
          noticeListEntryKey: location.key,
        },
      });
    },
    onUnauthorized: () => void navigate("/login", { replace: true }),
    readServerToday: async () => (await listNotices("all")).server_today,
    resource: "notices",
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
    noticeCreate.clearResolvedError();
    setNotice(undefined);

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("new");
    nextSearchParams.delete("create");
    setSearchParams(nextSearchParams, { replace: true });
  }, [bootstrap, searchParams, setSearchParams]);

  useEffect(
    () => () => {
      loadGenerationRef.current += 1;
    },
    [],
  );

  useLayoutEffect(() => {
    if (items === undefined || restoredLocationKeyRef.current === location.key) return;
    const historyEntry = noticeListHistoryEntry(location.key);
    if (
      historyEntry === undefined ||
      (historyEntry.view !== undefined &&
        (bootstrap === undefined || historyEntry.view.owner !== itemListOwner(bootstrap)))
    )
      return;
    restoredLocationKeyRef.current = location.key;
    const listScroll = listScrollRef.current?.closest<HTMLElement>(".content-split-main");
    if (listScroll) listScroll.scrollTop = historyEntry.view?.listScrollTop ?? 0;
    window.scrollTo({ behavior: "auto", left: 0, top: historyEntry.scrollY });
    const focusTarget = noticeLinkRefs.current.get(historyEntry.noticeId) ?? listTitleRef.current;
    focusTarget?.focus({ preventScroll: true });
  }, [items, location.key, bootstrap]);

  function rememberCurrentPosition(noticeId: string): void {
    rememberNoticeListPosition(
      location.key,
      noticeId,
      window.scrollY,
      bootstrap === undefined
        ? undefined
        : {
            owner: itemListOwner(bootstrap),
            criteria: "all",
            page: currentPage.snapshot,
            search: searchRef.current,
            listScrollTop:
              listScrollRef.current?.closest<HTMLElement>(".content-split-main")?.scrollTop ?? 0,
          },
    );
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
        <ContentFrameHeader title="공지" />

        <section className="mt-5 rounded-card border border-app-border bg-app-surface p-5 shadow-sm sm:p-7">
          <div
            aria-live={loading ? "polite" : "assertive"}
            className="grid min-h-52 place-items-center text-center"
            role={loading ? "status" : "alert"}
          >
            <div>
              {loading ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="mx-auto animate-spin text-home-important"
                  size={32}
                />
              ) : (
                <BellRing aria-hidden="true" className="mx-auto text-rose-500" size={32} />
              )}
              <p className="mt-4 font-bold">
                {loading ? "로그인과 반 정보를 확인하고 있어요." : error}
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
          </div>
        </section>
      </AppShell>
    );
  }

  const teacher = bootstrap.current_membership?.role === "teacher";
  const selectedNotice =
    selectedId === "" ? undefined : (items?.find((item) => item.id === selectedId) ?? items?.[0]);
  const initialLoading = loading && items === undefined;

  return (
    <AppShell contentFrame navigationRole={teacher ? "teacher" : "student"} width="wide">
      <ContentFrameHeader
        actions={
          <>
            <ListSearch
              label="공지 검색"
              searchTerm={searchTerm}
              onSearch={(term) => {
                searchRef.current = term;
                setSearchTerm(term);
                void load();
              }}
              placeholder="공지 제목·내용에서 찾기"
            />
            <button
              aria-label="공지 목록 새로고침"
              className="ui-icon-button"
              disabled={loading || loadingMore}
              onClick={() => void load()}
              type="button"
            >
              <RefreshCw aria-hidden className={loading ? "animate-spin" : ""} size={18} />
            </button>
            {teacher ? (
              <button
                aria-label="공지 작성"
                aria-controls="notice-create-panel"
                aria-expanded={formOpen}
                className="content-write"
                data-content-hero-action
                disabled={noticeCreate.busy}
                onClick={() => {
                  setFormOpen((current) => !current);
                  noticeCreate.clearResolvedError();
                  setNotice(undefined);
                }}
                ref={createButtonRef}
                type="button"
              >
                <Plus aria-hidden="true" size={18} /> 쓰기
              </button>
            ) : null}
          </>
        }
        title="공지"
      />

      {noticeCreate.error === undefined ? null : (
        <div
          className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700"
          role="alert"
        >
          <p>{noticeCreate.error}</p>
        </div>
      )}

      {teacher && formOpen ? (
        <section
          className="feature-surface-notice mt-5 rounded-card border border-role-border border-t-4 border-t-role-primary p-5 shadow-sm sm:p-7"
          id="notice-create-panel"
        >
          <p className="text-sm font-bold text-role-primary">새 공지</p>
          <h2 className="mt-1 break-keep text-xl font-extrabold text-app-text">
            학생들에게 정확하게 알려 주세요
          </h2>
          <div className="mt-6 max-w-2xl">
            <NoticeForm
              /*
               * ⚠️ 기준일(`serverToday`)이 아직 안 왔으면 **누를 수 없게 둔다**
               * (2026-08-20 Hex 결정). 그전에 누르면 제품이 "네트워크 연결을 확인한 뒤
               * 다시 시도해 주세요"를 띄우는데, 네트워크는 멀쩡하고 **화면이 아직 준비가
               * 안 된 것**이라 읽는 사람을 헷갈리게 한다. 기준일은 목록 응답에 실려 오고
               * 「공지 작성」 단추는 그전에 이미 보이므로, 빠르게 누르면 실제로 겪는다.
               * (같은 뿌리로 검수도 넉 달간 세 번 흔들렸다 — T-HUB-27.)
               */
              busy={noticeCreate.busy || serverToday === undefined}
              initialValue={
                noticeCreate.pendingRequest ?? {
                  audience: { mode: "all" },
                  category: "general",
                  content: "",
                  is_important: false,
                  title: "",
                }
              }
              locked={noticeCreate.outcomeUnknown}
              onCancel={cancelCreate}
              onSubmit={(request) => {
                setNotice(undefined);
                void noticeCreate.submit(request);
              }}
              selectedAudienceEnabled={selectedAudienceEnabled}
              showPublishSummary
              submitLabel={noticeCreate.outcomeUnknown ? "결과 다시 확인" : "등록하기"}
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
          <CheckCircle2 aria-hidden="true" size={18} /> {notice}
        </p>
      )}

      <section
        aria-busy={loading || loadingMore}
        aria-labelledby="notice-list-title"
        className="mt-4 min-w-0"
        data-feature-surface="notices-list"
      >
        <h2
          className="sr-only focus:not-sr-only focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2"
          id="notice-list-title"
          ref={listTitleRef}
          tabIndex={-1}
        >
          공지 목록
        </h2>

        {loadFailure !== undefined && items !== undefined ? (
          <StaleDataAlert
            busy={loading || loadingMore}
            description={
              loadFailure === "append"
                ? "현재까지 불러온 공지는 그대로 두었어요. 이어지는 공지를 다시 불러올 수 있어요."
                : "이전에 불러온 공지를 계속 표시하고 있어 최신 정보와 다를 수 있어요."
            }
            onRetry={() =>
              void load(failedRequestRef.current?.cursor, failedRequestRef.current?.restore)
            }
            title={
              loadFailure === "append"
                ? "공지 더 보기를 완료하지 못했어요."
                : "최신 공지를 확인하지 못했어요."
            }
          />
        ) : null}

        {initialLoading ? (
          <AsyncStatePanel
            kind="loading"
            title="공지 목록을 불러오고 있어요."
            tone={teacher ? "neutral" : "important"}
          />
        ) : items === undefined && loadFailure !== undefined ? (
          <AsyncStatePanel
            action={
              <button
                aria-busy={loading}
                className="ui-button ui-button-primary text-sm"
                disabled={loading}
                onClick={() =>
                  void load(failedRequestRef.current?.cursor, failedRequestRef.current?.restore)
                }
                type="button"
              >
                다시 시도
              </button>
            }
            description="인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요."
            kind="error"
            title="공지 목록을 불러오지 못했어요."
            tone={teacher ? "neutral" : "important"}
          />
        ) : (items ?? []).length === 0 ? (
          /*
           * "찾은 게 없어요"와 "아직 아무것도 없어요"는 다른 상태다. 섞어 놓으면
           * 검색 중인 사람이 "공지가 다 사라졌나?" 하고 놀란다.
           */
          searchTerm === undefined ? (
            <AsyncStatePanel
              description={
                teacher
                  ? "알려야 할 내용이 생기면 위에서 등록해 주세요."
                  : "새 공지가 등록되면 이곳에서 확인할 수 있어요."
              }
              icon={BellRing}
              kind="empty"
              title="아직 공지가 없어요."
              tone={teacher ? "neutral" : "important"}
            />
          ) : (
            <AsyncStatePanel
              description="다른 낱말로 찾아보거나, 검색어를 지우면 전체 목록이 다시 나와요."
              icon={BellRing}
              kind="empty"
              title={`'${searchTerm}'로 찾은 공지가 없어요.`}
              tone="neutral"
            />
          )
        ) : (
          <ContentSplit
            asideLabel="선택한 공지 상세"
            aside={
              !desktop || selectedNotice === undefined ? undefined : (
                <NoticeDetailPage
                  key={selectedNotice?.id}
                  embeddedId={selectedNotice?.id}
                  onClose={() => {
                    setSelectedId("");
                    void load(undefined, currentPage.snapshot);
                  }}
                />
              )
            }
          >
            <DateGroupedList
              items={items ?? []}
              listRef={listScrollRef}
              label="공지 목록"
              dateFor={(item) => item.published_at}
              today={serverToday ?? bootstrap.server_today}
              renderItem={(item) => (
                <li className="min-w-0" key={item.id}>
                  <ContentPostCard
                    title={item.title}
                    body={item.content}
                    term={searchTerm}
                    kind={item.category === "performance" ? "수행평가" : "공지"}
                    important={item.is_important}
                    date={item.published_at}
                    dateLabel={formatNoticeDateTime(item.published_at)}
                    selected={desktop && selectedNotice?.id === item.id}
                    to={"/notices/" + item.id}
                    state={{ noticeListEntryKey: location.key }}
                    onClick={(event) => {
                      if (selectContentInPlace(event)) setSelectedId(item.id);
                      else rememberCurrentPosition(item.id);
                    }}
                    linkRef={(element) => {
                      if (element === null) noticeLinkRefs.current.delete(item.id);
                      else noticeLinkRefs.current.set(item.id, element);
                    }}
                    footer={
                      teacher ? (
                        <CompactContentProgress
                          refreshKey={loadGenerationRef.current}
                          id={item.id}
                          kind="notice"
                          revision={item.content_revision}
                          doneLabel="확인"
                        />
                      ) : (
                        <StudentContentState
                          state={item.confirmation_state}
                          doneLabel="확인했어요"
                        />
                      )
                    }
                  />
                </li>
              )}
            />
            {nextCursor === null ? null : (
              <ContentMore
                busy={loadingMore}
                onMore={() => void load(nextCursor)}
                label="지난 공지 더 보기"
              />
            )}
          </ContentSplit>
        )}

        {serverToday === undefined ? null : (
          <p className="mt-5 text-right text-xs font-medium text-app-muted">
            기준일 <time dateTime={serverToday}>{formatNoticeDate(serverToday)}</time>
          </p>
        )}
      </section>
    </AppShell>
  );
}
