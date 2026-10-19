import { LoaderCircle, RefreshCw, UsersRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { ApiRequestError } from "../../api/auth";
import {
  createNoticeReminder,
  listNoticeConfirmations,
  type NoticeConfirmationCounts,
  type NoticeConfirmationListState,
  type NoticeConfirmationMember,
} from "../../api/notices";
import { optionalMemberProfilePhotoUrl } from "../../api/profile-photos";
import { useNavigationCapabilities } from "../../lib/navigation-capabilities";
import { Avatar } from "../profile-photos/avatar";
import { TeacherReminderAction } from "../reminders/teacher-reminder-action";
import {
  ConfirmationDot,
  ConfirmationProgress,
  DetailActionBar,
} from "../details/content-detail-frame";

const TAB_ORDER: NoticeConfirmationListState[] = ["confirmed", "modified_unconfirmed", "unread"];
const FRESHNESS_MESSAGE_ID = "notice-confirmation-freshness-message";

type ConfirmationSnapshotStatus =
  "fresh" | "loading" | "refresh_failed" | "revision_mismatch" | "unavailable";

type ConfirmationLoadReason = "normal" | "post_reminder";

const tabConfig: Record<
  NoticeConfirmationListState,
  { empty: string; label: string; shortLabel: string }
> = {
  confirmed: {
    empty: "현재 공지를 확인한 학생이 없어요.",
    label: "확인한 학생",
    shortLabel: "확인",
  },
  unread: {
    empty: "아직 확인하지 않은 학생이 없어요.",
    label: "미확인 학생",
    shortLabel: "미확인",
  },
  modified_unconfirmed: {
    empty: "수정된 내용을 다시 확인할 학생이 없어요.",
    label: "수정 후 재확인 학생",
    shortLabel: "재확인 필요",
  },
};

interface NoticeConfirmationsPanelProps {
  contentRevision: string;
  membershipId: string;
  noticeId: string;
  onReloadContent: () => Promise<void>;
  tone?: "important" | "latest";
  title: string;
}

export function NoticeConfirmationsPanel({
  contentRevision,
  membershipId,
  noticeId,
  onReloadContent,
  tone = "important",
  title,
}: NoticeConfirmationsPanelProps): React.JSX.Element {
  const navigate = useNavigate();
  const { profilePhotosEnabled } = useNavigationCapabilities();
  const [activeTab, setActiveTab] = useState<NoticeConfirmationListState>("unread");
  const [focusedTab, setFocusedTab] = useState<NoticeConfirmationListState>("unread");
  const [counts, setCounts] = useState<NoticeConfirmationCounts>();
  const [lastReminderRequestedAt, setLastReminderRequestedAt] = useState<string | null>(null);
  const [items, setItems] = useState<NoticeConfirmationMember[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [hasSnapshotResponse, setHasSnapshotResponse] = useState(false);
  const [snapshotMessage, setSnapshotMessage] = useState<string>();
  const [snapshotRevision, setSnapshotRevision] = useState<string>();
  const [snapshotStatus, setSnapshotStatus] = useState<ConfirmationSnapshotStatus>("loading");
  const [reloadingContent, setReloadingContent] = useState(false);
  const tabRefs = useRef<Record<NoticeConfirmationListState, HTMLButtonElement | null>>({
    confirmed: null,
    modified_unconfirmed: null,
    unread: null,
  });
  const loadGenerationRef = useRef(0);
  const restoreTabFocusRef = useRef<NoticeConfirmationListState | undefined>(undefined);

  useEffect(() => {
    if (loading) return;
    const target = restoreTabFocusRef.current;
    restoreTabFocusRef.current = undefined;
    if (target !== undefined && document.activeElement === document.body) {
      tabRefs.current[target]?.focus({ preventScroll: true });
    }
  }, [loading]);

  async function load(
    state: NoticeConfirmationListState,
    cursor?: string,
    selectDefault = false,
    reason: ConfirmationLoadReason = "normal",
  ): Promise<void> {
    const generation = ++loadGenerationRef.current;
    const appending = cursor !== undefined;
    if (appending) setLoadingMore(true);
    else {
      setLoading(true);
      setSnapshotStatus("loading");
      setSnapshotMessage(undefined);
    }
    setError(undefined);
    try {
      const result = await listNoticeConfirmations(noticeId, state, cursor);
      if (generation !== loadGenerationRef.current) return;
      setHasSnapshotResponse(true);
      setSnapshotRevision(result.content_revision);
      if (result.content_revision !== contentRevision) {
        setItems([]);
        setNextCursor(null);
        setSnapshotStatus("revision_mismatch");
        setSnapshotMessage("공지가 방금 바뀌어 확인 현황을 다시 불러와야 해요. 새로고침해 주세요.");
        return;
      }
      setCounts(result.counts);
      setLastReminderRequestedAt(result.last_reminder_requested_at ?? null);
      if (selectDefault && cursor === undefined) {
        const defaultState: NoticeConfirmationListState =
          result.counts.unread > 0
            ? "unread"
            : result.counts.modified_unconfirmed > 0
              ? "modified_unconfirmed"
              : "confirmed";
        setActiveTab(defaultState);
        setFocusedTab(defaultState);
        if (defaultState !== state) {
          setItems([]);
          setNextCursor(null);
          void load(defaultState);
          return;
        }
      }
      setItems((current) => (appending ? [...current, ...result.items] : result.items));
      setNextCursor(result.next_cursor);
      setSnapshotStatus("fresh");
      setSnapshotMessage(undefined);
    } catch (requestError) {
      if (generation !== loadGenerationRef.current) return;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      const message =
        requestError instanceof Error
          ? requestError.message
          : "공지 확인 현황을 불러오지 못했습니다.";
      if (appending) {
        setError(message);
      } else {
        setHasSnapshotResponse(true);
        setItems([]);
        setNextCursor(null);
        setSnapshotMessage(message);
        setSnapshotStatus(reason === "post_reminder" ? "refresh_failed" : "unavailable");
      }
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    setActiveTab("unread");
    setFocusedTab("unread");
    setCounts(undefined);
    setHasSnapshotResponse(false);
    setLastReminderRequestedAt(null);
    setItems([]);
    setNextCursor(null);
    setSnapshotMessage(undefined);
    setSnapshotRevision(undefined);
    setSnapshotStatus("loading");
    void load("unread", undefined, true);
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [contentRevision, noticeId]);

  const unresolvedCount = counts === undefined ? 0 : counts.unread + counts.modified_unconfirmed;
  const totalCount =
    counts === undefined ? 0 : counts.confirmed + counts.unread + counts.modified_unconfirmed;
  /*
   * 게시 대상은 발행 순간에 고정되므로(AC 2항) 그 뒤 승인된 학생은 위 세 집계
   * 어디에도 들어오지 않는다. 그 사실을 알리지 않으면 교사에게는 대상 전원이
   * 확인한 순간이 "전원 확인 완료"로만 보이고, 못 받은 학생은 화면에서 사라진다.
   */
  const excludedCount = counts === undefined ? 0 : counts.excluded_member_count;
  /*
   * 수정 전 내용을 확인했던 학생 중 새 내용을 다시 확인한 비율. 시범 운영에서 우리반 허브의
   * 핵심 가치(바뀐 것을 챙김)를 재는 지표라, 수정이 있었던 공지에서만 보여 준다.
   */
  const reconfirmedCount = counts?.reconfirmed ?? 0;
  const revisedAudienceCount =
    counts === undefined ? 0 : reconfirmedCount + counts.modified_unconfirmed;
  const snapshotFresh = snapshotStatus === "fresh";

  function switchTab(state: NoticeConfirmationListState): void {
    restoreTabFocusRef.current = state;
    setActiveTab(state);
    setFocusedTab(state);
    setItems([]);
    setNextCursor(null);
    void load(state);
  }

  async function reloadLatestContent(): Promise<void> {
    setReloadingContent(true);
    try {
      await onReloadContent();
    } catch (requestError) {
      setSnapshotMessage(
        requestError instanceof Error ? requestError.message : "최신 공지를 불러오지 못했습니다.",
      );
    } finally {
      setReloadingContent(false);
    }
  }

  function moveTabFocus(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: NoticeConfirmationListState,
  ): void {
    const currentIndex = TAB_ORDER.indexOf(current);
    let targetIndex: number | undefined;
    if (event.key === "ArrowLeft") {
      targetIndex = (currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    } else if (event.key === "ArrowRight") {
      targetIndex = (currentIndex + 1) % TAB_ORDER.length;
    } else if (event.key === "Home") {
      targetIndex = 0;
    } else if (event.key === "End") {
      targetIndex = TAB_ORDER.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const target = TAB_ORDER[targetIndex];
    if (target === undefined) return;
    setFocusedTab(target);
    tabRefs.current[target]?.focus();
  }

  return (
    <section
      aria-labelledby="notice-confirmation-status"
      className="flex h-full min-w-0 flex-col rounded-[1.25rem] border border-app-border bg-app-surface p-[18px] shadow-card lg:p-6"
      data-notice-surface="teacher-confirmations"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2
            className="scroll-mt-6 break-keep rounded-lg text-[15px] font-extrabold text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-4 focus-visible:ring-offset-app-canvas"
            id="notice-confirmation-status"
            tabIndex={-1}
          >
            학생 확인 현황
          </h2>
          <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
            현재 내용 기준이며 비활성 계정은 제외합니다.
          </p>
        </div>
        <button
          aria-busy={loading}
          aria-label="공지 확인 현황 새로고침"
          className="ui-icon-button ui-button-secondary"
          disabled={loading || loadingMore || snapshotStatus === "revision_mismatch"}
          onClick={() => void load(activeTab)}
          type="button"
        >
          <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} size={18} />
        </button>
      </div>

      {snapshotStatus === "loading" && counts !== undefined ? (
        <p
          className="mt-5 rounded-2xl border border-role-border bg-role-soft px-4 py-3 text-sm font-bold text-role-primary"
          id={FRESHNESS_MESSAGE_ID}
          role="status"
        >
          최신 확인 현황을 다시 확인하고 있어요. 확인이 끝날 때까지 재알림을 잠시 멈춥니다.
        </p>
      ) : snapshotStatus === "fresh" ? null : snapshotStatus === "loading" ? null : (
        <div
          className={`mt-5 rounded-2xl border px-4 py-4 text-sm ${
            snapshotStatus === "refresh_failed"
              ? "border-amber-200 bg-amber-50 text-amber-900"
              : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
          id={FRESHNESS_MESSAGE_ID}
          role="alert"
        >
          <p className="font-extrabold">
            {snapshotStatus === "revision_mismatch"
              ? "공지 내용과 확인 현황의 기준이 달라요."
              : snapshotStatus === "refresh_failed"
                ? "재알림은 등록됐지만 최신 현황을 불러오지 못했어요."
                : "확인 현황을 불러오지 못해 재알림을 사용할 수 없어요."}
          </p>
          <p className="mt-1 break-keep leading-6">
            {snapshotStatus === "refresh_failed"
              ? "아래 숫자는 이전 조회 결과입니다. 최신 현황을 확인할 때까지 새 재알림은 중단됩니다."
              : snapshotMessage}
          </p>
          {snapshotStatus === "revision_mismatch" && snapshotRevision !== undefined ? (
            <p className="mt-1 text-xs font-bold">
              상세는 {contentRevision}번째 내용 · 확인 현황은 {snapshotRevision}번째 내용
            </p>
          ) : null}
          {snapshotStatus === "refresh_failed" && snapshotMessage !== undefined ? (
            <p className="mt-1 text-xs font-semibold">{snapshotMessage}</p>
          ) : null}
          <button
            aria-busy={loading || reloadingContent}
            className="ui-button ui-button-secondary mt-3 text-sm"
            disabled={loading || reloadingContent}
            onClick={() => {
              if (snapshotStatus === "revision_mismatch") {
                void reloadLatestContent();
                return;
              }
              void load(activeTab, undefined, counts === undefined);
            }}
            type="button"
          >
            <RefreshCw
              aria-hidden="true"
              className={loading || reloadingContent ? "animate-spin" : ""}
              size={17}
            />
            {snapshotStatus === "revision_mismatch"
              ? "최신 공지와 현황 다시 불러오기"
              : "최신 확인 현황 다시 불러오기"}
          </button>
        </div>
      )}

      {counts === undefined ? null : (
        <p
          aria-label={snapshotFresh ? "현재 공지 확인 요약" : "이전 조회 공지 확인 요약"}
          className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-app-muted"
        >
          <span className={snapshotFresh ? "text-app-muted" : "text-amber-900"}>게시 대상</span>
          <strong className={snapshotFresh ? "text-app-text" : "text-amber-950"}>
            {totalCount}명
          </strong>
          {excludedCount > 0 ? (
            <span
              className="text-amber-800"
              title="이 공지가 게시된 뒤 반에 들어온 학생입니다. 이 공지를 받지 못했고, 위 인원에도 포함되지 않습니다."
            >
              · 대상 외 {excludedCount}명
            </span>
          ) : null}
          {revisedAudienceCount > 0 ? (
            <span
              className={snapshotFresh ? "text-app-muted" : "text-amber-800"}
              data-notice-reconfirm-rate="true"
              title="수정 전 내용을 확인했던 학생 중 바뀐 내용을 다시 확인한 학생 수입니다."
            >
              · 수정 후 재확인 {reconfirmedCount}/{revisedAudienceCount}명
            </span>
          ) : null}
          {snapshotFresh ? null : <span className="text-amber-800">· 이전 조회</span>}
        </p>
      )}

      {counts === undefined ? null : (
        <ConfirmationProgress
          confirmed={counts.confirmed}
          changed={counts.modified_unconfirmed}
          remaining={counts.unread}
        />
      )}
      <div aria-label="공지 확인 상태" className="mt-3 flex flex-wrap gap-1.5" role="tablist">
        {TAB_ORDER.map((state) => (
          <button
            aria-controls={`notice-confirmation-panel-${state}`}
            aria-label={`${tabConfig[state].label} ${
              counts === undefined
                ? "집계 중"
                : `${counts[state]}명${snapshotFresh ? "" : " · 이전 조회"}`
            }`}
            aria-selected={activeTab === state}
            className="content-filter inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs font-bold"
            aria-pressed={activeTab === state}
            disabled={loading || !snapshotFresh}
            id={`notice-confirmation-tab-${state}`}
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
            <span>{tabConfig[state].shortLabel}</span>
            <span aria-hidden="true" className="text-xs opacity-75 tabular-nums">
              {counts?.[state] ?? "–"}
            </span>
          </button>
        ))}
      </div>

      <p className="mt-3 text-xs leading-5 text-app-muted">
        노란색은 선생님이 글을 고친 뒤 아직 다시 확인하지 않은 학생이에요. 알약을 누르면 이름이
        보여요.
      </p>

      {TAB_ORDER.map((state) => (
        <div
          aria-busy={activeTab === state && loading}
          aria-labelledby={`notice-confirmation-tab-${state}`}
          hidden={activeTab !== state}
          id={`notice-confirmation-panel-${state}`}
          key={state}
          role="tabpanel"
          tabIndex={0}
        >
          {activeTab !== state ? null : snapshotStatus !== "fresh" ? (
            <div
              aria-live={snapshotStatus === "loading" ? "polite" : undefined}
              className="mt-5 grid min-h-36 place-items-center rounded-card bg-app-surface-muted px-5 py-8 text-center"
              role={snapshotStatus === "loading" ? "status" : undefined}
            >
              {snapshotStatus === "loading" ? (
                <>
                  <LoaderCircle
                    aria-hidden="true"
                    className="animate-spin text-role-primary"
                    size={28}
                  />
                  <span className="sr-only">공지 확인 현황을 불러오고 있어요.</span>
                </>
              ) : (
                <p className="break-keep text-sm font-bold leading-6 text-app-muted">
                  최신 현황을 다시 불러오면 학생 목록을 표시합니다.
                </p>
              )}
            </div>
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
              <span className="sr-only">공지 확인 현황을 불러오고 있어요.</span>
            </div>
          ) : items.length === 0 ? (
            <div
              className={`mt-5 rounded-card px-5 py-9 text-center ${
                tone === "important" ? "bg-home-important-soft" : "bg-role-soft"
              }`}
            >
              <UsersRound
                aria-hidden="true"
                className={`mx-auto ${
                  tone === "important" ? "text-home-important" : "text-role-primary"
                }`}
                size={32}
              />
              <p className="mt-3 break-keep font-bold text-app-text">{tabConfig[state].empty}</p>
            </div>
          ) : (
            <>
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {items.map((member) => (
                  <li
                    className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-lg bg-app-surface-muted px-3 py-1 text-sm font-semibold text-app-text"
                    key={member.member_id}
                  >
                    {profilePhotosEnabled ? (
                      <Avatar
                        name={member.display_name}
                        photoUrl={optionalMemberProfilePhotoUrl(true, member.member_id)}
                        size={20}
                      />
                    ) : null}
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
          {counts === undefined && !hasSnapshotResponse ? null : (
            <TeacherReminderAction
              compact
              contentRevision={contentRevision}
              lastRequestedAt={lastReminderRequestedAt}
              membershipId={membershipId}
              onCreate={(revision, idempotencyKey) =>
                createNoticeReminder(noticeId, revision, idempotencyKey)
              }
              onRegistered={(result, registeredRevision) => {
                if (registeredRevision === contentRevision) {
                  setLastReminderRequestedAt(result.created_at);
                  void load(activeTab, undefined, false, "post_reminder");
                }
              }}
              resourceId={noticeId}
              resourceLabel="공지"
              resourceType="notice"
              statusVerified={snapshotFresh}
              title={title}
              unresolvedCount={counts === undefined ? 0 : unresolvedCount}
            />
          )}
        </div>
      </DetailActionBar>
    </section>
  );
}
