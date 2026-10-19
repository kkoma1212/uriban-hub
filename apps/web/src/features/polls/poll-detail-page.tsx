import "../activities/activity-layout.css";
import {
  BarChart3,
  CheckCircle2,
  LoaderCircle,
  LockKeyhole,
  PencilLine,
  RefreshCw,
  Trash2,
  UsersRound,
  Vote,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import {
  closePoll,
  deletePoll,
  getPoll,
  getPollParticipation,
  voteInPoll,
  type PollEntityResponse,
  type PollOptionItem,
  type PollParticipationResponse,
} from "../../api/polls";
import { formatKstDateTimeWithYearAndShortWeekday } from "../../lib/kst-format";
import {
  ContentDetailFrame,
  DetailHeading,
  DetailActionBar,
  ConfirmationProgress,
  type EmbeddedDetailProps,
} from "../details/content-detail-frame";
import { AsyncStatePanel } from "../layout/async-state";
import { ConfirmDialog } from "../layout/confirm-dialog";
// 수정 창은 선생님이 열 때만 받는다 — 상세 화면 JS 예산(check-build-output)과 학생 화면 무게를 지킨다.
const PollEditDialog = lazy(() =>
  import("./poll-edit-dialog").then((module) => ({ default: module.PollEditDialog })),
);

interface PollDetailLocationState {
  notice?: string;
}

const PRIVATE_RESULT_INFERENCE_NOTICE =
  "참여 인원이 적거나 결과가 한쪽에 몰리거나, 탈퇴로 집계가 달라지면 선택을 짐작할 수 있어요.";

function locationNotice(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const notice = (value as PollDetailLocationState).notice;
  return typeof notice === "string" ? notice : undefined;
}

function resultPercent(voteCount: number, totalVoteCount: number): number {
  if (totalVoteCount === 0) return 0;
  return Math.round((voteCount / totalVoteCount) * 100);
}

function resultsPolicyLabel(item: PollEntityResponse["item"]): string {
  const policy = item.results_policy;
  if (item.ballot_visibility === "private") {
    return policy === "teacher_only" ? "집계 · 마감 후 선생님만" : "집계 · 마감 후 공개";
  }
  if (policy === "after_close") return "집계 · 마감 후 공개";
  if (policy === "teacher_only") return "집계 · 선생님만";
  return "집계 · 참여 후 공개";
}

function hiddenResultsCopy(item: PollEntityResponse["item"]): string {
  if (item.ballot_visibility === "private" && item.status === "open") {
    return item.results_policy === "teacher_only"
      ? "비공개 투표의 집계는 마감 후 선생님에게만 공개됩니다."
      : "비공개 투표는 선생님도 마감 후에 집계를 확인할 수 있어요.";
  }
  if (item.results_policy === "teacher_only") {
    return "이 투표의 선택지별 집계는 담임 선생님에게만 공개됩니다.";
  }
  if (item.results_policy === "after_close") {
    return "선택지별 집계는 투표가 마감된 뒤 공개됩니다.";
  }
  return "먼저 자신의 선택을 제출하면 현재 집계가 보여요.";
}

function PollResults({
  options,
  totalVoteCount,
}: {
  options: PollOptionItem[];
  totalVoteCount: number;
}): React.JSX.Element {
  const highestVoteCount = Math.max(0, ...options.map((option) => option.vote_count ?? 0));
  return (
    <div className="mt-3 grid gap-2" data-poll-results="option-bars">
      {options.map((option) => {
        const voteCount = option.vote_count ?? 0;
        const percent = resultPercent(voteCount, totalVoteCount);
        const leading = voteCount > 0 && voteCount === highestVoteCount;
        return (
          <div
            aria-label={option.label + " " + voteCount + "명, " + percent + "%"}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent}
            aria-valuetext={voteCount + "명, " + percent + "%"}
            className="relative flex min-h-[54px] min-w-0 items-center gap-3 overflow-hidden rounded-[14px] bg-app-surface-muted px-4 py-3"
            data-poll-result-row
            key={option.id}
            role="progressbar"
          >
            <span
              aria-hidden="true"
              className={
                "absolute inset-y-0 left-0 rounded-[14px] transition-[width] " +
                (leading ? "bg-role-primary/25" : "bg-role-primary/15")
              }
              style={{ width: percent + "%" }}
            />
            <span className="relative min-w-0 flex-1 break-words text-[15.5px] font-extrabold text-app-text">
              {option.label}
            </span>
            <span className="relative shrink-0 text-right text-sm font-extrabold text-app-text">
              {voteCount}명 · {percent}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ParticipationList({
  emptyCopy,
  items,
}: {
  emptyCopy: string;
  items: PollParticipationResponse["voted_students"];
}): React.JSX.Element {
  if (items.length === 0) {
    return <p className="mt-3 text-sm leading-6 text-app-muted">{emptyCopy}</p>;
  }
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {items.map((student) => (
        <li
          className="rounded-full border border-app-border bg-app-surface px-3 py-1.5 text-sm font-bold text-app-text"
          key={student.member_id}
        >
          {student.student_number === null ? "" : `${student.student_number}번 `}
          {student.display_name}
          {student.selected_option_label === undefined ? null : (
            <span className="ml-1 text-role-primary">· {student.selected_option_label}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function PollDetailPage({
  embeddedId,
  onClose,
}: EmbeddedDetailProps = {}): React.JSX.Element {
  const embedded = embeddedId !== undefined;
  const navigate = useNavigate();
  const location = useLocation();
  const { pollId: routeId } = useParams<{ pollId: string }>();
  const pollId = embeddedId ?? routeId;
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [entity, setEntity] = useState<PollEntityResponse>();
  const [participation, setParticipation] = useState<PollParticipationResponse>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [selectedOptionId, setSelectedOptionId] = useState<string>();
  const [voteDialogOpen, setVoteDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [closeStep, setCloseStep] = useState<0 | 1>(0);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string | undefined>(() => locationNotice(location.state));
  const voteAttemptRef = useRef<{ key: string; optionId: string } | undefined>(undefined);
  const voteButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const [editOpen, setEditOpen] = useState(false);
  const closePendingRef = useRef(false);
  const teacher = bootstrap?.allowed_actions.includes("MANAGE_POLLS") === true;
  const navigationRole = bootstrap?.current_membership?.role;

  const loadPoll = useCallback(
    async (nextBootstrap?: BootstrapResponse): Promise<void> => {
      if (pollId === undefined) return;
      const currentBootstrap = nextBootstrap ?? bootstrap;
      const latestEntity = await getPoll(pollId);
      setEntity(latestEntity);
      setSelectedOptionId(latestEntity.item.my_option_id ?? undefined);
      if (currentBootstrap?.allowed_actions.includes("MANAGE_POLLS") === true) {
        setParticipation(await getPollParticipation(pollId));
      } else {
        setParticipation(undefined);
      }
    },
    [bootstrap, pollId],
  );

  useEffect(() => {
    if (pollId === undefined) {
      void navigate("/polls", { replace: true });
      return;
    }
    let active = true;
    void getBootstrap()
      .then(async (result) => {
        if (!active) return;
        const permitted =
          result.destination === "HOME" &&
          result.current_membership !== null &&
          (result.allowed_actions.includes("MANAGE_POLLS") ||
            result.allowed_actions.includes("VOTE_IN_POLLS"));
        if (!permitted) {
          void navigate("/updates", { replace: true });
          return;
        }
        setBootstrap(result);
        const latestEntity = await getPoll(pollId);
        if (!active) return;
        setEntity(latestEntity);
        setSelectedOptionId(latestEntity.item.my_option_id ?? undefined);
        if (result.allowed_actions.includes("MANAGE_POLLS")) {
          const latestParticipation = await getPollParticipation(pollId);
          if (!active) return;
          setParticipation(latestParticipation);
        }
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setError(
          requestError instanceof Error ? requestError.message : "투표를 불러오지 못했어요.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [navigate, pollId]);

  async function refresh(): Promise<void> {
    if (pollId === undefined) return;
    setRefreshing(true);
    setError(undefined);
    try {
      let nextBootstrap = bootstrap;
      if (nextBootstrap === undefined) {
        nextBootstrap = await getBootstrap();
        setBootstrap(nextBootstrap);
      }
      await loadPoll(nextBootstrap);
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(
        requestError instanceof Error
          ? requestError.message
          : "최신 투표 내용을 불러오지 못했어요.",
      );
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }

  async function submitVote(): Promise<void> {
    if (pollId === undefined || selectedOptionId === undefined) return;
    setVoteDialogOpen(false);
    setSubmitting(true);
    setError(undefined);
    setNotice(undefined);
    if (voteAttemptRef.current?.optionId !== selectedOptionId) {
      voteAttemptRef.current = {
        key: window.crypto.randomUUID(),
        optionId: selectedOptionId,
      };
    }
    try {
      const voted = await voteInPoll(pollId, selectedOptionId, voteAttemptRef.current.key);
      voteAttemptRef.current = undefined;
      setEntity(voted);
      setSelectedOptionId(voted.item.my_option_id ?? undefined);
      setNotice("투표를 제출했습니다. 제출한 선택은 바꿀 수 없어요.");
    } catch (requestError) {
      if (
        requestError instanceof ApiRequestError &&
        (requestError.code === "POLL_ALREADY_VOTED" || requestError.code === "POLL_CLOSED")
      ) {
        try {
          await loadPoll();
        } catch {
          // The message below remains useful when the refresh also fails.
        }
      }
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(requestError instanceof Error ? requestError.message : "투표를 제출하지 못했어요.");
      window.setTimeout(() => voteButtonRef.current?.focus(), 0);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitClose(): Promise<void> {
    if (
      !teacher ||
      closeStep !== 1 ||
      pollId === undefined ||
      entity?.item.status !== "open" ||
      closePendingRef.current
    )
      return;
    closePendingRef.current = true;
    setCloseStep(0);
    setClosing(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setEntity(await closePoll(pollId, entity.etag));
      setNotice("투표를 마감했습니다. 지금까지의 응답과 결과는 보관됩니다.");
      try {
        setParticipation(await getPollParticipation(pollId));
      } catch {
        setParticipation(undefined);
      }
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      if (
        requestError instanceof ApiRequestError &&
        requestError.code === "RESOURCE_VERSION_CHANGED"
      ) {
        try {
          await loadPoll();
        } catch {
          /* Keep the conflict message visible. */
        }
      }
      setError(requestError instanceof Error ? requestError.message : "투표를 마감하지 못했어요.");
      window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    } finally {
      closePendingRef.current = false;
      setClosing(false);
    }
  }

  async function submitDelete(): Promise<void> {
    if (pollId === undefined || entity === undefined) return;
    setDeleteDialogOpen(false);
    setDeleting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await deletePoll(pollId, entity.etag);
      if (embedded && onClose) {
        onClose();
        return;
      }
      void navigate("/polls", {
        replace: true,
        state: { notice: "투표와 모든 응답을 영구 삭제했습니다." },
      });
    } catch (requestError) {
      if (
        requestError instanceof ApiRequestError &&
        requestError.code === "RESOURCE_VERSION_CHANGED"
      ) {
        try {
          await loadPoll();
        } catch {
          // Preserve the conflict message if the refresh also fails.
        }
      }
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(requestError instanceof Error ? requestError.message : "투표를 삭제하지 못했어요.");
      setDeleting(false);
      window.setTimeout(() => deleteButtonRef.current?.focus(), 0);
    }
  }

  if (bootstrap === undefined || entity === undefined) {
    return (
      <ContentDetailFrame
        embedded={embedded}
        {...(navigationRole === undefined ? {} : { navigationRole })}
        backTo="/polls"
        backLabel="반 활동"
        {...(embedded && onClose ? { onBack: onClose } : {})}
      >
        {" "}
        <AsyncStatePanel
          {...(loading
            ? {}
            : {
                action: (
                  <div className="flex flex-wrap justify-center gap-3">
                    <button
                      className="ui-button ui-button-primary text-sm"
                      onClick={() => void refresh()}
                      type="button"
                    >
                      <RefreshCw aria-hidden="true" size={17} /> 다시 불러오기
                    </button>
                    <button
                      className="ui-button ui-button-secondary text-sm"
                      onClick={() => void navigate("/polls")}
                      type="button"
                    >
                      목록으로
                    </button>
                  </div>
                ),
                description: error ?? "이 화면에서 다시 불러오거나 투표 목록으로 돌아가 주세요.",
              })}
          icon={Vote}
          kind={loading ? "loading" : "error"}
          title={loading ? "투표를 불러오고 있어요." : "투표를 불러오지 못했어요."}
        />
      </ContentDetailFrame>
    );
  }
  const { item } = entity;
  const selectedOption = item.options.find((option) => option.id === selectedOptionId);
  const mutationBusy = submitting || deleting || closing;
  const canVote = !teacher && item.status === "open" && !item.has_voted;
  // 진행 중 투표 수정(원장 107·108 설치 뒤 EDIT_POLLS로만 열린다, 2026-10-04 사용자 결정).
  const canEdit =
    bootstrap?.allowed_actions.includes("EDIT_POLLS") === true && item.status === "open";
  const privateResultsAudience =
    item.results_policy === "teacher_only"
      ? "선택지별 집계는 마감 후 담임 선생님만 볼 수 있어요."
      : "선택지별 집계는 마감 후 우리 반 학생과 선생님이 볼 수 있어요.";
  const resultTotal = item.total_vote_count ?? 0;
  const participationTotal =
    participation === undefined
      ? undefined
      : participation.voted_count + participation.unvoted_count;
  return (
    <ContentDetailFrame
      embedded={embedded}
      navigationRole={teacher ? "teacher" : "student"}
      backTo="/polls"
      backLabel="반 활동"
      {...(embedded && onClose ? { onBack: onClose } : {})}
      hasActionBar={canVote || (teacher && item.status === "open")}
      tools={
        <>
          <button
            className="ui-button ui-button-secondary text-sm"
            disabled={refreshing || mutationBusy}
            onClick={() => void refresh()}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={refreshing ? "animate-spin" : ""} size={17} />
            최신 내용
          </button>
          {canEdit ? (
            <button
              className="ui-button ui-button-secondary text-sm"
              disabled={mutationBusy}
              onClick={() => setEditOpen(true)}
              ref={editButtonRef}
              type="button"
            >
              <PencilLine aria-hidden="true" size={17} />
              내용 고치기
            </button>
          ) : null}
          {teacher ? (
            <button
              className="ui-button ui-button-danger text-sm"
              disabled={mutationBusy}
              onClick={() => setDeleteDialogOpen(true)}
              ref={deleteButtonRef}
              type="button"
            >
              <Trash2 aria-hidden="true" size={17} />
              투표 영구 삭제
            </button>
          ) : null}
        </>
      }
      aside={
        <section
          className={
            canVote
              ? "flex h-full min-w-0 flex-col xl:rounded-[1.25rem] xl:bg-app-surface xl:p-[18px] xl:shadow-card"
              : "flex h-full min-w-0 flex-col rounded-[1.25rem] bg-app-surface p-[18px] shadow-card"
          }
          data-poll-summary-layout={teacher ? "teacher-side-panel" : "student-side-panel"}
        >
          <section
            aria-labelledby="poll-results-heading"
            className={canVote ? "hidden min-w-0 xl:block" : "min-w-0"}
          >
            <h2
              className="flex items-center gap-2 text-[15px] font-extrabold text-app-text"
              id="poll-results-heading"
            >
              <BarChart3 aria-hidden="true" size={18} />
              투표 결과
            </h2>
            {item.results_visible ? (
              <>
                <p className="mt-1 text-sm leading-6 text-app-muted">
                  총 {resultTotal}명이 참여했어요.
                </p>
                <PollResults options={item.options} totalVoteCount={resultTotal} />
              </>
            ) : (
              <div className="mt-3 flex items-start gap-2 rounded-[14px] bg-app-surface-muted p-3">
                <LockKeyhole
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-app-muted"
                  size={16}
                />
                <p className="break-keep text-[13px] leading-5 text-app-muted">
                  {hiddenResultsCopy(item)}
                </p>
              </div>
            )}
          </section>

          {teacher ? (
            <section
              aria-labelledby="poll-participation-heading"
              className="mt-5 border-t border-app-border pt-5"
            >
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-role-soft text-role-primary">
                  <UsersRound aria-hidden="true" size={20} />
                </span>
                <div>
                  <h2
                    className="text-[15px] font-extrabold text-app-text"
                    id="poll-participation-heading"
                  >
                    참여 상태
                  </h2>
                  <p className="mt-1 break-keep text-sm leading-6 text-app-muted">
                    {item.ballot_visibility === "private"
                      ? "참여 여부만 표시하며, 학생별 선택은 직접 표시하지 않습니다. 마감 후 참여 인원이 적거나 결과가 한쪽에 몰리면 선택을 짐작할 수 있습니다."
                      : "담임 선생님만 참여 학생의 선택을 확인할 수 있습니다."}
                  </p>
                </div>
              </div>
              {participation === undefined ? (
                <AsyncStatePanel
                  action={
                    <button
                      className="ui-button ui-button-secondary text-sm"
                      onClick={() => void refresh()}
                      type="button"
                    >
                      다시 불러오기
                    </button>
                  }
                  kind="error"
                  title="참여 상태를 불러오지 못했어요."
                />
              ) : (
                <div className="mt-5">
                  <div className="grid gap-5">
                    <div>
                      <h3 className="flex items-center gap-2 text-sm font-extrabold text-app-text">
                        <CheckCircle2 aria-hidden="true" size={17} />
                        참여한 학생
                      </h3>
                      <ParticipationList
                        emptyCopy="아직 참여한 학생이 없어요."
                        items={participation.voted_students}
                      />
                    </div>
                    <div>
                      <h3 className="flex items-center gap-2 text-sm font-extrabold text-app-muted">
                        <UsersRound aria-hidden="true" size={17} />
                        아직 참여하지 않은 학생
                      </h3>
                      <ParticipationList
                        emptyCopy="모든 학생이 참여했어요."
                        items={participation.unvoted_students}
                      />
                    </div>
                  </div>
                </div>
              )}
            </section>
          ) : null}

          {canVote || (teacher && item.status === "open") ? (
            <DetailActionBar>
              {" "}
              {teacher && item.status === "open" ? (
                <div className="w-full">
                  <button
                    className="ui-button ui-button-primary min-h-[52px] w-full rounded-[14px] text-sm"
                    data-poll-close-action
                    disabled={mutationBusy || refreshing}
                    onClick={() => setCloseStep(1)}
                    ref={closeButtonRef}
                    type="button"
                  >
                    {closing ? (
                      <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
                    ) : null}
                    지금 마감하기
                  </button>
                </div>
              ) : null}
              {canVote ? (
                <button
                  className="ui-button ui-button-primary min-h-[52px] w-full rounded-[14px]"
                  disabled={selectedOptionId === undefined || mutationBusy}
                  onClick={() => setVoteDialogOpen(true)}
                  ref={voteButtonRef}
                  type="button"
                >
                  {submitting ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
                  ) : (
                    <Vote aria-hidden="true" size={18} />
                  )}
                  {submitting ? "제출하고 있어요." : "이 선택으로 제출"}
                </button>
              ) : null}
            </DetailActionBar>
          ) : null}
        </section>
      }
    >
      <article
        className="poll-choice-panel h-full min-w-0 rounded-[1.25rem] bg-app-surface p-[18px] shadow-card"
        data-poll-question-card
      >
        <DetailHeading
          title={item.title}
          kind="투표"
          meta={
            <span className="flex flex-wrap items-center gap-x-1 font-bold text-rose-700">
              <span>{item.status === "open" ? "마감 예정" : "마감됨"}</span>
              <time dateTime={item.closed_at ?? item.closes_at}>
                {formatKstDateTimeWithYearAndShortWeekday(item.closed_at ?? item.closes_at)}
              </time>
            </span>
          }
        >
          <span>{item.status === "open" ? "진행 중" : "마감"}</span>
          {item.has_voted ? <span>참여 완료</span> : null}
        </DetailHeading>
        {notice === undefined ? null : (
          <p
            className="mt-4 rounded-[14px] bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800"
            role="status"
          >
            {notice}
          </p>
        )}
        {error === undefined ? null : (
          <p
            className="mt-4 rounded-[14px] bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700"
            role="alert"
          >
            {error}
          </p>
        )}
        {item.description === null ? null : (
          <section aria-labelledby="poll-description-heading" className="mt-3">
            <h2 className="sr-only" id="poll-description-heading">
              투표 설명
            </h2>
            <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.65] text-app-text">
              {item.description}
            </p>
          </section>
        )}
        {teacher && participation !== undefined ? (
          <section className="mt-4" aria-label="투표 참여 요약">
            <p className="flex items-center justify-between gap-3 text-sm text-app-text">
              <span>참여</span>
              <strong className="font-extrabold">
                {participation.voted_count} / {participationTotal}명
              </strong>
            </p>
            <ConfirmationProgress
              confirmed={participation.voted_count}
              remaining={participation.unvoted_count}
              label="투표 참여 요약"
            />
            <p className="mt-2 flex flex-wrap justify-between gap-3 text-xs font-bold text-app-muted">
              <span>참여 {participation.voted_count}명</span>
              <span>남음 {participation.unvoted_count}명</span>
            </p>
          </section>
        ) : null}
        {canVote ? (
          <section aria-labelledby="poll-choice-heading" className="mt-4">
            <h2 className="sr-only" id="poll-choice-heading">
              한 가지를 선택해 주세요
            </h2>
            <fieldset className="grid gap-2">
              <legend className="sr-only">투표 선택지</legend>
              {item.options.map((option) => (
                <label
                  className={
                    "flex min-h-[58px] min-w-0 cursor-pointer items-center gap-3 rounded-[14px] border-2 px-4 py-3 transition " +
                    (selectedOptionId === option.id
                      ? "border-role-primary bg-role-soft"
                      : "border-transparent bg-app-surface-muted hover:border-role-border")
                  }
                  key={option.id}
                >
                  <input
                    checked={selectedOptionId === option.id}
                    className="size-[22px] shrink-0 accent-role-primary"
                    disabled={mutationBusy}
                    name="poll-option"
                    onChange={() => {
                      setSelectedOptionId(option.id);
                      setError(undefined);
                    }}
                    type="radio"
                    value={option.id}
                  />
                  <span className="min-w-0 break-words text-base font-extrabold text-app-text">
                    {option.label}
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="mt-3 break-keep text-xs leading-5 text-app-muted">
              제출한 뒤에는 선택을 바꾸거나 취소할 수 없습니다.
            </p>
          </section>
        ) : null}
        {!teacher && item.has_voted && item.my_option_id !== null ? (
          <p className="mt-4 flex items-start gap-2 rounded-[14px] bg-role-soft px-4 py-3 text-sm font-bold text-app-text">
            <CheckCircle2 aria-hidden="true" className="shrink-0 text-role-primary" size={18} />
            <span className="min-w-0 break-words">
              내 선택: {item.options.find((option) => option.id === item.my_option_id)?.label}
            </span>
          </p>
        ) : null}
        <section aria-labelledby="poll-privacy-heading" className="mt-3">
          <h2
            className="flex items-start gap-2 text-[13px] font-medium leading-5 text-app-muted"
            id="poll-privacy-heading"
          >
            <LockKeyhole aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
            <span>
              {item.ballot_visibility === "private"
                ? "누가 무엇을 골랐는지는 화면에 직접 표시되지 않아요"
                : "담임 선생님만 학생별 선택을 볼 수 있어요"}
            </span>
          </h2>
          <details className="mt-2 text-xs leading-5 text-app-muted">
            <summary className="w-fit cursor-pointer py-1 font-bold">공개 범위와 투표 안내</summary>
            <div className="mt-2 space-y-2 rounded-[14px] bg-app-surface-muted p-3">
              <p className="font-bold text-app-text">
                {item.ballot_visibility === "private" ? "선택 비공개 투표" : "기명 투표"} ·{" "}
                {resultsPolicyLabel(item)}
              </p>
              <p>
                {item.ballot_visibility === "private"
                  ? "학생 이름과 선택의 연결은 학생·선생님 화면에 표시되지 않습니다."
                  : "담임 선생님만 학생별 선택을 확인할 수 있으며 학생끼리는 서로의 선택을 볼 수 없습니다."}
              </p>
              {item.ballot_visibility === "private" ? (
                <>
                  <p>선생님은 학생별 참여 여부를 확인할 수 있어요. {privateResultsAudience}</p>
                  <p className="text-app-text">{PRIVATE_RESULT_INFERENCE_NOTICE}</p>
                </>
              ) : null}
              <p>중복 투표 방지와 탈퇴 처리를 위해 시스템은 응답을 계정과 내부적으로 연결합니다.</p>
            </div>
          </details>
        </section>
        {!teacher && item.status === "closed" && !item.has_voted ? (
          <p className="mt-4 rounded-[14px] bg-app-surface-muted px-4 py-4 text-sm font-bold text-app-muted">
            마감된 투표라 더 이상 참여할 수 없습니다.
          </p>
        ) : null}
      </article>
      <ConfirmDialog
        confirmLabel="제출하기"
        confirmTone="primary"
        description={
          <>
            <strong className="text-app-text">{selectedOption?.label ?? "선택한 항목"}</strong>
            으로 제출합니다. 제출 후에는 선택을 바꾸거나 취소할 수 없습니다.
            <p className="mt-3">
              {item.ballot_visibility === "private"
                ? `${privateResultsAudience} ${PRIVATE_RESULT_INFERENCE_NOTICE}`
                : "담임 선생님은 내 이름과 선택을 함께 확인할 수 있어요."}
            </p>
          </>
        }
        onCancel={() => setVoteDialogOpen(false)}
        onConfirm={() => void submitVote()}
        open={voteDialogOpen}
        returnFocusTo={voteButtonRef.current}
        title="이 선택으로 제출할까요?"
      />
      <ConfirmDialog
        cancelLabel="취소"
        confirmLabel="마감하기"
        confirmTone="primary"
        description="마감하면 학생은 더 이상 참여할 수 없고 다시 열 수 없습니다. 지금까지의 응답과 결과는 보관됩니다."
        onCancel={() => setCloseStep(0)}
        onConfirm={() => void submitClose()}
        open={closeStep !== 0 && teacher && item.status === "open"}
        returnFocusTo={closeButtonRef.current}
        title="투표를 마감할까요?"
      />
      {editOpen && canEdit && pollId !== undefined ? (
        <Suspense fallback={null}>
          <PollEditDialog
            entity={entity}
            onClose={() => setEditOpen(false)}
            onSaved={(saved) => {
              setEntity(saved);
              setEditOpen(false);
              setError(undefined);
              setNotice("투표 내용을 고쳤어요.");
            }}
            optionsLocked={(participation?.voted_count ?? 0) > 0}
            pollId={pollId}
            returnFocusTo={editButtonRef.current}
          />
        </Suspense>
      ) : null}
      <ConfirmDialog
        confirmLabel="영구 삭제"
        description="투표·선택지·모든 응답이 즉시 영구 삭제되며 복구할 수 없습니다."
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={() => void submitDelete()}
        open={deleteDialogOpen}
        returnFocusTo={deleteButtonRef.current}
        title="투표를 영구 삭제할까요?"
      />
    </ContentDetailFrame>
  );
}
