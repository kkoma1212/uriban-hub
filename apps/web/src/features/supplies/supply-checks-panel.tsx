import { LoaderCircle, RefreshCw, UsersRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { ApiRequestError } from "../../api/auth";
import {
  createSupplyReminder,
  listSupplyChecks,
  type SupplyCategory,
  type SupplyCheckCounts,
  type SupplyCheckListState,
  type SupplyCheckMember,
} from "../../api/supplies";
import { TeacherReminderAction } from "../reminders/teacher-reminder-action";
import {
  ConfirmationDot,
  ConfirmationProgress,
  DetailActionBar,
} from "../details/content-detail-frame";

const CHECK_TAB_ORDER: SupplyCheckListState[] = ["checked", "modified_unconfirmed", "unchecked"];

/*
 * 준비물은 "챙긴" 것이고 숙제는 "다 한" 것이다(2026-08-10 Hex 결정). 집계 자체는
 * 같으므로 상태 값은 그대로 두고 교사가 읽는 말만 종류에 맞춘다.
 */
const TAB_CONFIG: Record<
  SupplyCategory,
  Record<SupplyCheckListState, { empty: string; label: string; shortLabel: string }>
> = {
  general: {
    checked: {
      empty: "현재 내용을 확인하고 챙긴 학생이 없어요.",
      label: "챙긴 학생",
      shortLabel: "챙김",
    },
    unchecked: {
      empty: "아직 챙기지 않은 학생이 없어요.",
      label: "미챙김 학생",
      shortLabel: "아직 안 챙김",
    },
    modified_unconfirmed: {
      empty: "수정된 내용을 다시 확인할 학생이 없어요.",
      label: "수정 후 재확인 학생",
      shortLabel: "재확인 필요",
    },
  },
  homework: {
    checked: {
      empty: "현재 내용을 확인하고 다 한 학생이 없어요.",
      label: "완료한 학생",
      shortLabel: "완료",
    },
    unchecked: {
      empty: "아직 하지 않은 학생이 없어요.",
      label: "미완료 학생",
      shortLabel: "아직 안 함",
    },
    modified_unconfirmed: {
      empty: "수정된 내용을 다시 확인할 학생이 없어요.",
      label: "수정 후 재확인 학생",
      shortLabel: "재확인 필요",
    },
  },
};

interface SupplyChecksPanelProps {
  category: SupplyCategory;
  contentRevision: string;
  focusOnLoad: boolean;
  membershipId: string;
  onRefreshContent: () => Promise<string | undefined>;
  reminderEligible: boolean;
  supplyId: string;
  title: string;
}

type StaleContext = "load" | "post-reminder-load" | "post-reminder-revision" | "revision";

export function SupplyChecksPanel({
  category,
  contentRevision,
  focusOnLoad,
  membershipId,
  onRefreshContent,
  reminderEligible,
  supplyId,
  title,
}: SupplyChecksPanelProps): React.JSX.Element {
  const kindName = category === "homework" ? "숙제" : "준비물";
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<SupplyCheckListState>("unchecked");
  const [focusedTab, setFocusedTab] = useState<SupplyCheckListState>("unchecked");
  const [counts, setCounts] = useState<SupplyCheckCounts>();
  const [lastReminderRequestedAt, setLastReminderRequestedAt] = useState<string | null>(null);
  const [items, setItems] = useState<SupplyCheckMember[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryingLatest, setRetryingLatest] = useState(false);
  const [snapshotFresh, setSnapshotFresh] = useState(false);
  const [staleContext, setStaleContext] = useState<StaleContext>();
  const [error, setError] = useState<string>();
  const statusHeadingRef = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef<Record<SupplyCheckListState, HTMLButtonElement | null>>({
    checked: null,
    modified_unconfirmed: null,
    unchecked: null,
  });
  const anchorFocusedRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const restoreTabFocusRef = useRef<SupplyCheckListState | undefined>(undefined);

  useEffect(() => {
    if (loading) return;
    const target = restoreTabFocusRef.current;
    restoreTabFocusRef.current = undefined;
    if (target !== undefined && document.activeElement === document.body) {
      tabRefs.current[target]?.focus({ preventScroll: true });
    }
  }, [loading]);

  function invalidateSnapshot(context: StaleContext): void {
    setCounts(undefined);
    setLastReminderRequestedAt(null);
    setItems([]);
    setNextCursor(null);
    setSnapshotFresh(false);
    setStaleContext(context);
  }

  async function load(
    state: SupplyCheckListState,
    cursor?: string,
    selectDefault = false,
    purpose: "normal" | "post-reminder" = "normal",
  ): Promise<boolean> {
    const generation = ++loadGenerationRef.current;
    const appending = cursor !== undefined;
    if (appending) setLoadingMore(true);
    else {
      setLoading(true);
      setSnapshotFresh(false);
    }
    setError(undefined);
    try {
      const result = await listSupplyChecks(supplyId, state, cursor);
      if (generation !== loadGenerationRef.current) return false;
      if (result.content_revision !== contentRevision) {
        invalidateSnapshot(purpose === "post-reminder" ? "post-reminder-revision" : "revision");
        return false;
      }
      setCounts(result.counts);
      setLastReminderRequestedAt(result.last_reminder_requested_at ?? null);
      setSnapshotFresh(true);
      setStaleContext(undefined);
      if (selectDefault && cursor === undefined) {
        const defaultState: SupplyCheckListState =
          result.counts.unchecked > 0
            ? "unchecked"
            : result.counts.modified_unconfirmed > 0
              ? "modified_unconfirmed"
              : "checked";
        setActiveTab(defaultState);
        setFocusedTab(defaultState);
        if (defaultState !== state) {
          setItems([]);
          setNextCursor(null);
          return load(defaultState, undefined, false, purpose);
        }
      }
      setItems((current) => (appending ? [...current, ...result.items] : result.items));
      setNextCursor(result.next_cursor);
      return true;
    } catch (requestError) {
      if (generation !== loadGenerationRef.current) return false;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return false;
      }
      if (appending) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "학생 목록을 더 불러오지 못했습니다.",
        );
      } else {
        invalidateSnapshot(purpose === "post-reminder" ? "post-reminder-load" : "load");
      }
      return false;
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    setActiveTab("unchecked");
    setFocusedTab("unchecked");
    setCounts(undefined);
    setLastReminderRequestedAt(null);
    setItems([]);
    setNextCursor(null);
    setSnapshotFresh(false);
    setStaleContext(undefined);
    void load("unchecked", undefined, true);
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [contentRevision, supplyId]);

  useEffect(() => {
    anchorFocusedRef.current = false;
  }, [focusOnLoad, supplyId]);

  useEffect(() => {
    if (!focusOnLoad || loading || anchorFocusedRef.current) return;
    anchorFocusedRef.current = true;
    statusHeadingRef.current?.scrollIntoView?.({ block: "start" });
    statusHeadingRef.current?.focus({ preventScroll: true });
  }, [focusOnLoad, loading, supplyId]);

  const unresolvedCount = counts === undefined ? 0 : counts.unchecked + counts.modified_unconfirmed;
  /*
   * 대상은 게시 순간에 고정되므로(AC 2항) 그 뒤 승인된 학생은 탭 집계 어디에도
   * 들어오지 않는다. 알리지 않으면 "미챙김 0명"을 보고 전원 챙겼다고 결론짓게 된다.
   */
  const excludedCount = counts === undefined ? 0 : counts.excluded_member_count;
  // 공지와 같은 시범 운영 지표. 수정 전 내용을 챙겼던 학생이 있을 때만 보여 준다.
  const reconfirmedCount = counts?.reconfirmed ?? 0;
  const revisedAudienceCount =
    counts === undefined ? 0 : reconfirmedCount + counts.modified_unconfirmed;

  async function retryLatestStatus(): Promise<void> {
    if (retryingLatest) return;
    setRetryingLatest(true);
    try {
      const latestRevision = await onRefreshContent();
      if (latestRevision === undefined) {
        invalidateSnapshot("load");
        return;
      }
      if (latestRevision === contentRevision) {
        await load(activeTab);
      }
    } catch {
      invalidateSnapshot("load");
    } finally {
      setRetryingLatest(false);
    }
  }

  function refreshAfterReminder(registeredRevision: string): void {
    if (registeredRevision !== contentRevision) return;
    void load(activeTab, undefined, false, "post-reminder");
  }

  const staleMessage =
    staleContext === "revision"
      ? `${kindName} 내용이 변경되어 표시 중인 내용과 확인 현황이 맞지 않아요. 이전 수치는 재알림에 사용하지 않습니다.`
      : staleContext === "post-reminder-revision"
        ? `앱 내 재알림 등록은 완료됐지만 그사이 ${kindName} 내용이 변경됐어요. 성공 결과는 유지했으며 이전 수치로 다시 요청하지 않습니다.`
        : staleContext === "post-reminder-load"
          ? "앱 내 재알림 등록은 완료됐지만 최신 현황을 다시 불러오지 못했어요. 성공 결과는 유지했으며 이전 수치로 다시 요청하지 않습니다."
          : staleContext === "load"
            ? "최신 확인 현황을 불러오지 못했어요. 이전 수치는 재알림에 사용하지 않습니다."
            : undefined;

  function switchTab(state: SupplyCheckListState): void {
    restoreTabFocusRef.current = state;
    setActiveTab(state);
    setFocusedTab(state);
    setItems([]);
    setNextCursor(null);
    void load(state);
  }

  function moveTabFocus(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: SupplyCheckListState,
  ): void {
    const currentIndex = CHECK_TAB_ORDER.indexOf(current);
    let targetIndex: number | undefined;
    if (event.key === "ArrowLeft") {
      targetIndex = (currentIndex - 1 + CHECK_TAB_ORDER.length) % CHECK_TAB_ORDER.length;
    } else if (event.key === "ArrowRight") {
      targetIndex = (currentIndex + 1) % CHECK_TAB_ORDER.length;
    } else if (event.key === "Home") {
      targetIndex = 0;
    } else if (event.key === "End") {
      targetIndex = CHECK_TAB_ORDER.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const target = CHECK_TAB_ORDER[targetIndex];
    if (target === undefined) return;
    setFocusedTab(target);
    tabRefs.current[target]?.focus();
  }

  return (
    <section
      aria-labelledby="supply-check-status"
      className="flex h-full min-w-0 flex-col rounded-[1.25rem] border border-app-border bg-app-surface p-[18px] shadow-card lg:p-6"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2
            className="scroll-mt-24 break-keep rounded-lg text-[15px] font-extrabold text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-4"
            id="supply-check-status"
            ref={statusHeadingRef}
            tabIndex={-1}
          >
            학생 {kindName} 현황
          </h2>
          <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
            현재 내용 기준이며 비활성 계정은 제외합니다.
            {excludedCount > 0
              ? ` 대상 외 학생 ${excludedCount}명은 이 안내를 받지 않았고 위 인원에 포함되지 않습니다.`
              : ""}
          </p>
          {revisedAudienceCount > 0 ? (
            <p
              className={`mt-1 break-keep text-sm leading-6 ${snapshotFresh ? "text-app-muted" : "text-amber-800"}`}
              data-supply-reconfirm-rate="true"
              title={
                category === "homework"
                  ? "수정 전 내용을 완료로 표시했던 학생 중 바뀐 내용을 다시 완료로 표시한 학생 수입니다."
                  : "수정 전 내용을 챙김으로 표시했던 학생 중 바뀐 내용을 다시 챙김으로 표시한 학생 수입니다."
              }
            >
              수정 후 재확인 {reconfirmedCount}/{revisedAudienceCount}명
            </p>
          ) : null}
        </div>
        <button
          aria-busy={loading}
          aria-label="확인 현황 새로고침"
          className="ui-icon-button ui-button-secondary"
          disabled={loading || loadingMore}
          onClick={() => void load(activeTab)}
          type="button"
        >
          <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} size={18} />
        </button>
      </div>

      {counts === undefined ? null : (
        <>
          <p className="mt-3 text-xs font-semibold text-app-muted">
            {counts.checked}/{counts.checked + counts.modified_unconfirmed + counts.unchecked}명{" "}
            {category === "homework" ? "완료" : "챙김"}
          </p>
          <ConfirmationProgress
            confirmed={counts.checked}
            changed={counts.modified_unconfirmed}
            remaining={counts.unchecked}
            label={category === "homework" ? "숙제 현황" : "준비물 현황"}
          />
        </>
      )}
      <div
        aria-label={`${kindName} 확인 상태`}
        className="mt-3 flex flex-wrap gap-1.5"
        role="tablist"
      >
        {CHECK_TAB_ORDER.map((state) => (
          <button
            aria-controls={`supply-check-panel-${state}`}
            aria-label={`${(TAB_CONFIG[category] ?? TAB_CONFIG.general)[state].label} ${counts === undefined ? "집계 중" : `${counts[state]}명`}`}
            aria-selected={activeTab === state}
            className="content-filter inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs font-bold"
            aria-pressed={activeTab === state}
            disabled={loading}
            id={`supply-check-tab-${state}`}
            key={state}
            onClick={() => switchTab(state)}
            onFocus={() => setFocusedTab(state)}
            onKeyDown={(event) => moveTabFocus(event, state)}
            ref={(element) => {
              tabRefs.current[state] = element;
            }}
            role="tab"
            tabIndex={focusedTab === state ? 0 : -1}
            type="button"
          >
            <ConfirmationDot state={state} />
            <span>{(TAB_CONFIG[category] ?? TAB_CONFIG.general)[state].shortLabel}</span>
            <span aria-hidden="true" className="text-xs opacity-75 tabular-nums">
              {counts?.[state] ?? "–"}
            </span>
          </button>
        ))}
      </div>

      {staleMessage === undefined ? null : (
        <aside
          className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-950"
          role="alert"
        >
          <p className="break-keep font-extrabold">{staleMessage}</p>
          <button
            aria-busy={retryingLatest}
            className="ui-button ui-button-secondary mt-3 text-sm"
            disabled={retryingLatest || loading}
            onClick={() => void retryLatestStatus()}
            type="button"
          >
            {retryingLatest ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
            ) : (
              <RefreshCw aria-hidden="true" size={17} />
            )}
            최신 내용과 현황 다시 불러오기
          </button>
        </aside>
      )}

      <p className="mt-3 text-xs leading-5 text-app-muted">
        노란색은 선생님이 글을 고친 뒤 아직 다시 확인하지 않은 학생이에요. 위 단추를 누르면 그
        상태인 학생 이름이 보여요.
      </p>

      {CHECK_TAB_ORDER.map((state) => (
        <div
          aria-busy={activeTab === state && loading}
          aria-labelledby={`supply-check-tab-${state}`}
          hidden={activeTab !== state}
          id={`supply-check-panel-${state}`}
          key={state}
          role="tabpanel"
          tabIndex={0}
        >
          {activeTab !== state ? null : staleContext !== undefined ? (
            <p className="sr-only">최신 확인 현황을 다시 불러오기를 기다리고 있어요.</p>
          ) : error !== undefined ? (
            <div
              className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"
              role="alert"
            >
              <p className="font-bold">{error}</p>
              <button
                className="ui-button ui-button-primary mt-3 text-sm"
                onClick={() => void load(state)}
                type="button"
              >
                다시 시도
              </button>
            </div>
          ) : loading ? (
            <div
              aria-live="polite"
              className="grid min-h-36 place-items-center text-role-primary"
              role="status"
            >
              <LoaderCircle aria-hidden="true" className="animate-spin" size={28} />
              <span className="sr-only">확인 현황을 불러오고 있어요.</span>
            </div>
          ) : items.length === 0 ? (
            <div
              className={`mt-5 rounded-card px-5 py-9 text-center ${
                state === "checked" ? "bg-role-soft" : "bg-amber-50"
              }`}
            >
              <UsersRound
                aria-hidden="true"
                className={`mx-auto ${
                  state === "checked" ? "text-role-primary" : "text-amber-700"
                }`}
                size={32}
              />
              <p className="mt-3 break-keep font-bold text-app-text">
                {(TAB_CONFIG[category] ?? TAB_CONFIG.general)[state].empty}
              </p>
            </div>
          ) : (
            <>
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {items.map((member) => (
                  <li
                    className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-lg bg-app-surface-muted px-3 py-1 text-sm font-semibold text-app-text"
                    key={member.member_id}
                  >
                    <span className="break-words">{member.display_name}</span>
                    <span className="sr-only">학생 번호 {member.student_number ?? "미지정"}</span>
                  </li>
                ))}
              </ul>
              {nextCursor === null ? null : (
                <button
                  aria-busy={loadingMore}
                  className="ui-button ui-button-secondary mt-4 w-full text-sm"
                  disabled={loadingMore}
                  onClick={() => void load(state, nextCursor)}
                  type="button"
                >
                  {loadingMore ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
                  ) : null}
                  학생 더 보기
                </button>
              )}
            </>
          )}
        </div>
      ))}
      <DetailActionBar>
        <div className="w-full">
          {" "}
          {reminderEligible && (counts !== undefined || staleContext !== undefined) ? (
            <TeacherReminderAction
              compact
              contentRevision={contentRevision}
              lastRequestedAt={lastReminderRequestedAt}
              membershipId={membershipId}
              onCreate={(revision, idempotencyKey) =>
                createSupplyReminder(supplyId, revision, idempotencyKey)
              }
              onRegistered={(result, registeredRevision) => {
                if (registeredRevision === contentRevision) {
                  setLastReminderRequestedAt(result.created_at);
                  refreshAfterReminder(registeredRevision);
                }
              }}
              resourceId={supplyId}
              resourceLabel={kindName}
              resourceType="supply"
              statusVerified={snapshotFresh}
              title={title}
              unresolvedCount={unresolvedCount}
            />
          ) : reminderEligible ? null : (
            <aside
              aria-label="재알림 등록 제한"
              className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-900"
            >
              <p className="font-extrabold">이 {kindName}에는 앱 내 재알림을 등록할 수 없어요.</p>
              <p className="mt-1 break-keep">
                학생의 최근 90일 이력 범위를 지난 {kindName}입니다. 학생별{" "}
                {category === "homework" ? "완료" : "챙김"} 현황은 계속 확인할 수 있어요.
              </p>
            </aside>
          )}
        </div>
      </DetailActionBar>
    </section>
  );
}
