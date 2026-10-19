import { ChevronDown, LoaderCircle, Vote } from "lucide-react";
import { useRef, useState } from "react";

import { ApiRequestError, type MemberListItem } from "../../api/auth";
import {
  closeElection,
  createElection,
  getElectionResults,
  openElection,
  publishElection,
  registerElectionCandidate,
  type ElectionEntityResponse,
  type ElectionResults,
  type ElectionResultsVisibility,
  type ElectionSummary,
  type ElectionTieBreak,
} from "../../api/elections";
import { ContentSplit } from "../layout/content-frame";
import "../activities/activity-layout.css";
import { ConfirmDialog } from "../layout/confirm-dialog";

const TIE_BREAK_LABEL: Record<ElectionTieBreak, string> = {
  elder: "동점이면 나이가 많은 학생",
  revote: "동점이면 다시 투표",
  teacher_decides: "동점이면 선생님이 결정",
};

const STATUS_LABEL = {
  closed: "마감",
  draft: "준비 중",
  open: "투표 중",
  published: "발표됨",
} as const;

const ELECTION_STEPS = [
  { label: "후보 등록", status: "draft" },
  { label: "투표", status: "open" },
  { label: "마감", status: "closed" },
  { label: "결과 공개", status: "published" },
] as const;

type ElectionTransitionConfirmation =
  { kind: "close" } | { kind: "open" } | { kind: "publish"; winnerCandidateId: string | undefined };

interface ElectionTransitionCopy {
  confirmLabel: string;
  confirmTone: "danger" | "primary";
  description: string;
  title: string;
}

function electionTransitionCopy(
  confirmation: ElectionTransitionConfirmation,
  detail: ElectionEntityResponse,
  results: ElectionResults | undefined,
): ElectionTransitionCopy {
  if (confirmation.kind === "open") {
    return {
      confirmLabel: "투표 시작",
      confirmTone: "primary",
      description: `등록한 후보 ${String(detail.item.candidates.length)}명이 학생 화면에 공개됩니다. 시작하면 후보를 추가할 수 없고 준비 중 단계로 되돌릴 수 없습니다.`,
      title: `‘${detail.item.title}’ 투표를 시작할까요?`,
    };
  }
  if (confirmation.kind === "close") {
    return {
      confirmLabel: "투표 마감하고 개표",
      confirmTone: "danger",
      description: `현재 ${String(detail.item.participant_count)}명이 투표했습니다. 마감하면 학생은 더 이상 참여할 수 없고 투표 중 단계로 되돌릴 수 없습니다.`,
      title: `‘${detail.item.title}’ 투표를 마감할까요?`,
    };
  }

  const winnerId = confirmation.winnerCandidateId ?? results?.winner?.id;
  const winner = detail.item.candidates.find((candidate) => candidate.id === winnerId);
  const winnerLabel =
    winner === undefined
      ? "개표 결과의 당선자"
      : `${winner.student_number === null ? "" : `${String(winner.student_number)}번 `}${winner.display_name}`;
  return {
    confirmLabel: "결과 발표하기",
    confirmTone: "primary",
    description: `당선 결과(${winnerLabel})를 학생 화면에 공개합니다. 발표한 뒤에는 이 화면에서 취소하거나 마감 상태로 되돌릴 수 없습니다.`,
    title: `‘${detail.item.title}’ 결과를 발표할까요?`,
  };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/*
 * 교사가 선거를 운영하는 화면.
 *
 * 화면이 지켜야 하는 것 하나: **득표 수는 개표할 때만 보인다.** 진행 중에 교사가
 * 중간 집계를 보면 그 정보가 교실로 새어 나가고, 아직 안 찍은 학생이 그 영향을
 * 받는다. 그래서 결과는 마감한 뒤에만 불러온다.
 */
export function TeacherElectionPanel({
  createOpen,
  elections,
  members,
  onChanged,
  onCloseCreate,
}: {
  /** 만들기 칸은 상단 "만들기"로 들어왔을 때만 편다 — 기본 화면은 목록이다. */
  createOpen: boolean;
  elections: ElectionSummary[];
  members: MemberListItem[];
  onChanged: () => void;
  onCloseCreate: () => void;
}): React.JSX.Element {
  const [title, setTitle] = useState("");
  const [tieBreak, setTieBreak] = useState<ElectionTieBreak>("revote");
  const [visibility, setVisibility] = useState<ElectionResultsVisibility>("with_counts");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [detail, setDetail] = useState<ElectionEntityResponse>();
  const [results, setResults] = useState<ElectionResults>();

  async function guard(run: () => Promise<void>, fallback: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (requestError) {
      setError(errorText(requestError, fallback));
    } finally {
      setBusy(false);
    }
  }

  /*
   * 같은 줄을 다시 누르면 접는다. 다른 줄을 누르면 그 줄을 연다 —
   * 목록을 벗어나지 않고 상세를 보기 위해서다(2026-08-12 Hex 요청).
   */
  function toggleDetail(electionId: string): void {
    if (detail?.item.id === electionId) {
      setDetail(undefined);
      setResults(undefined);
      return;
    }
    void guard(async () => {
      const { getElection } = await import("../../api/elections");
      const loaded = await getElection(electionId);
      setDetail(loaded);
      setResults(
        loaded.item.status === "draft" || loaded.item.status === "open"
          ? undefined
          : await getElectionResults(electionId),
      );
    }, "선거를 열지 못했어요.");
  }

  return (
    <div className="grid gap-5" data-election-surface="teacher-panel">
      {!createOpen ? null : (
        <section className="rounded-shell border border-role-border bg-app-surface-raised p-5 shadow-card sm:p-6">
          <h2 className="text-lg font-extrabold text-app-text">새 선거 만들기</h2>
          <p className="mt-2 text-sm font-semibold text-app-muted">
            동점 처리 방식은 만들 때 정해지고 나중에 바꿀 수 없어요. 결과를 보고 규칙을 고르면
            공정하지 않기 때문이에요.
          </p>
          <div className="mt-4 grid gap-3">
            <label className="grid gap-1 text-sm font-bold text-app-text">
              선거 이름
              <input
                className="min-h-14 rounded-2xl border border-app-border bg-app-surface px-4 text-base font-semibold text-app-text"
                maxLength={80}
                onChange={(event) => setTitle(event.target.value)}
                value={title}
              />
            </label>
            <label className="grid gap-1 text-sm font-bold text-app-text">
              동점 처리 방식
              <select
                className="min-h-14 rounded-2xl border border-app-border bg-app-surface px-4 text-base font-semibold text-app-text"
                onChange={(event) => setTieBreak(event.target.value as ElectionTieBreak)}
                value={tieBreak}
              >
                {Object.entries(TIE_BREAK_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm font-bold text-app-text">
              결과 공개 범위
              <select
                className="min-h-14 rounded-2xl border border-app-border bg-app-surface px-4 text-base font-semibold text-app-text"
                onChange={(event) => setVisibility(event.target.value as ElectionResultsVisibility)}
                value={visibility}
              >
                <option value="with_counts">득표 수까지 학생에게 공개</option>
                <option value="winner_only">당선자만 학생에게 공개</option>
              </select>
            </label>
            <button
              className="ui-button ui-button-primary min-h-14 rounded-2xl text-base font-extrabold"
              disabled={busy || title.trim().length === 0}
              onClick={() =>
                void guard(async () => {
                  await createElection(
                    { results_visibility: visibility, tie_break: tieBreak, title: title.trim() },
                    crypto.randomUUID(),
                  );
                  setTitle("");
                  onChanged();
                  /* 만들고 나면 목록으로 돌아간다 — 방금 만든 선거가 거기 있다. */
                  onCloseCreate();
                }, "선거를 만들지 못했어요.")
              }
              type="button"
            >
              {/*
               * ⚠️ 상단의 "폼을 여는" 단추와 **이름이 같으면 안 된다**(2026-08-20 Hex 결정).
               * 전에는 둘 다 「선거 만들기」였다. 눈으로는 구분되지만 화면을 읽어주는
               * 도구에는 같은 이름 둘로 들리고, 검수 도구도 앞의 것을 눌러 폼이 영영
               * 제출되지 않았다. 이 단추는 "지금 적은 내용으로 만든다"는 뜻이다.
               */}
              이 내용으로 만들기
            </button>
            <button
              className="ui-button ui-button-tertiary min-h-14 rounded-2xl text-base font-bold"
              disabled={busy}
              onClick={onCloseCreate}
              type="button"
            >
              그만두기
            </button>
          </div>
        </section>
      )}

      {error === undefined ? null : (
        <p
          className="rounded-2xl border border-danger-border bg-danger-surface px-4 py-3 text-sm font-bold text-danger-text"
          role="alert"
        >
          {error}
        </p>
      )}

      <ContentSplit
        className="activity-overview"
        asideOnMobile
        asideLabel="선택한 선거"
        aside={
          detail === undefined ? (
            <section className="content-card activity-summary-panel p-5">
              <p className="text-sm text-app-muted">선거를 고르면 진행 상황을 볼 수 있어요.</p>
            </section>
          ) : (
            <section className="content-card activity-summary-panel" data-election-detail-panel>
              <h2 className="px-4 pt-4 text-lg font-extrabold break-words">{detail.item.title}</h2>
              <p className="px-4 pt-2 text-sm text-app-muted">
                참여 {detail.item.participant_count}명
              </p>
              <TeacherElectionDetail
                busy={busy}
                detail={detail}
                guard={guard}
                members={members}
                onChanged={onChanged}
                results={results}
                setDetail={setDetail}
                setResults={setResults}
              />
            </section>
          )
        }
      >
        <section className="min-w-0">
          <h2 className="text-lg font-extrabold text-app-text">진행 중인 선거</h2>
          {elections.length === 0 ? (
            <p className="mt-3 text-sm font-semibold text-app-muted">
              아직 만든 선거가 없어요. 위 “만들기”로 시작해 보세요.
            </p>
          ) : (
            <ul className="mt-4 grid gap-2">
              {elections.map((election) => {
                const expanded = detail?.item.id === election.id;
                return (
                  <li
                    className={`content-card min-w-0 ${expanded ? "ring-2 ring-role-primary" : ""}`}
                    key={election.id}
                  >
                    <button
                      aria-expanded={expanded}
                      className="flex min-h-14 w-full items-center justify-between gap-3 bg-app-surface px-4 py-3 text-left transition-colors hover:bg-app-surface-muted"
                      data-election-row={election.id}
                      onClick={() => toggleDetail(election.id)}
                      type="button"
                    >
                      <span className="min-w-0 line-clamp-2 break-words font-extrabold text-app-text">
                        {election.title}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="rounded-full bg-app-surface-muted px-3 py-1 text-xs font-bold text-app-muted">
                          {STATUS_LABEL[election.status]}
                        </span>
                        <ChevronDown
                          aria-hidden="true"
                          className={`text-app-muted transition-transform ${
                            expanded ? "rotate-180" : ""
                          }`}
                          size={18}
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </ContentSplit>
    </div>
  );
}

/*
 * 선택한 선거 한 건의 상세. 목록 크기를 바꾸지 않고 별도 칸 안에서 표시한다.
 */
function TeacherElectionDetail({
  busy,
  detail,
  guard,
  members,
  onChanged,
  results,
  setDetail,
  setResults,
}: {
  busy: boolean;
  detail: ElectionEntityResponse;
  guard: (run: () => Promise<void>, fallback: string) => Promise<void>;
  members: MemberListItem[];
  onChanged: () => void;
  results: ElectionResults | undefined;
  setDetail: (value: ElectionEntityResponse) => void;
  setResults: (value: ElectionResults) => void;
}): React.JSX.Element {
  const currentStepIndex = ELECTION_STEPS.findIndex((step) => step.status === detail.item.status);
  const [confirmation, setConfirmation] = useState<ElectionTransitionConfirmation>();
  const confirmationTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmationCopy =
    confirmation === undefined ? undefined : electionTransitionCopy(confirmation, detail, results);

  function requestConfirmation(
    next: ElectionTransitionConfirmation,
    trigger: HTMLButtonElement,
  ): void {
    confirmationTriggerRef.current = trigger;
    setConfirmation(next);
  }

  function confirmTransition(): void {
    if (confirmation === undefined || busy) return;
    const pending = confirmation;
    setConfirmation(undefined);
    if (pending.kind === "open") {
      void guard(async () => {
        setDetail(await openElection(detail.item.id, detail.etag));
        onChanged();
      }, "투표를 시작하지 못했어요.");
      return;
    }
    if (pending.kind === "close") {
      void guard(async () => {
        const closed = await closeElection(detail.item.id, detail.etag);
        setDetail(closed);
        setResults(await getElectionResults(closed.item.id));
        onChanged();
      }, "마감하지 못했어요.");
      return;
    }
    void guard(async () => {
      const published = await publishElection(
        detail.item.id,
        detail.etag,
        pending.winnerCandidateId,
      );
      setResults(published);
      const { getElection } = await import("../../api/elections");
      setDetail(await getElection(detail.item.id));
      onChanged();
    }, "발표하지 못했어요.");
  }

  return (
    <div
      className="border-t border-app-border bg-app-surface-raised px-4 py-4 sm:px-5"
      data-election-surface="teacher-detail"
    >
      <ol
        aria-label="선거 단계"
        className="grid grid-cols-4 gap-1 rounded-2xl border border-app-border bg-app-surface-muted p-2"
      >
        {ELECTION_STEPS.map((step, index) => {
          const current = index === currentStepIndex;
          const done = index < currentStepIndex;
          return (
            <li
              aria-current={current ? "step" : undefined}
              className={`rounded-xl px-2 py-2 text-center text-xs font-extrabold sm:text-sm ${
                current
                  ? "bg-role-primary text-app-canvas shadow-sm"
                  : done
                    ? "bg-role-soft text-role-primary"
                    : "text-app-muted"
              }`}
              key={step.status}
            >
              <span className="block text-[10px] opacity-75">{index + 1}단계</span>
              <span className="mt-0.5 block break-keep">{step.label}</span>
            </li>
          );
        })}
      </ol>

      <p className="mt-4 text-sm font-semibold text-app-muted">
        {STATUS_LABEL[detail.item.status]} · {TIE_BREAK_LABEL[detail.item.tie_break]} ·{" "}
        {detail.item.participant_count}명 투표함
      </p>

      {/*
            등록된 후보가 보이지 않으면 교사가 지금 몇 명을 세웠는지 알 수 없다.
            버튼이 비활성화되는 것만으로는 부족하다 — 목록으로 보여준다.
          */}
      <div className="mt-4" data-election-candidates>
        <p className="text-sm font-bold text-app-text">
          등록된 후보 {detail.item.candidates.length}명
        </p>
        {detail.item.candidates.length === 0 ? (
          <p className="mt-1 text-sm font-semibold text-app-muted">아직 없어요.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {detail.item.candidates.map((candidate) => (
              <li
                className="rounded-full bg-role-soft px-3 py-1 text-sm font-bold text-role-primary"
                key={candidate.id}
              >
                {candidate.display_name}
              </li>
            ))}
          </ul>
        )}
      </div>

      {detail.item.status !== "draft" ? null : (
        <div className="mt-4 grid gap-2">
          <p className="text-sm font-bold text-app-text">후보 등록</p>
          {members.length === 0 ? (
            <p className="text-sm font-semibold text-app-muted">승인된 학생이 없어요.</p>
          ) : (
            members.map((member) => (
              <button
                className="min-h-14 rounded-2xl border border-app-border bg-app-surface px-4 text-left text-base font-bold text-app-text hover:bg-app-surface-muted"
                disabled={
                  busy || detail.item.candidates.some((c) => c.display_name === member.display_name)
                }
                key={member.id}
                onClick={() =>
                  void guard(async () => {
                    const updated = await registerElectionCandidate(
                      detail.item.id,
                      member.id,
                      detail.etag,
                    );
                    setDetail(updated);
                    onChanged();
                  }, "후보를 등록하지 못했어요.")
                }
                type="button"
              >
                {member.display_name} 후보로 등록
              </button>
            ))
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        {detail.item.status !== "draft" ? null : (
          <button
            className="ui-button ui-button-primary min-h-14 rounded-2xl px-5 text-base font-extrabold"
            disabled={busy || detail.item.candidates.length < 2}
            onClick={(event) => requestConfirmation({ kind: "open" }, event.currentTarget)}
            type="button"
          >
            투표 시작
          </button>
        )}
        {detail.item.status !== "open" ? null : (
          <button
            className="ui-button ui-button-secondary min-h-14 rounded-2xl px-5 text-base font-extrabold"
            disabled={busy}
            onClick={(event) => requestConfirmation({ kind: "close" }, event.currentTarget)}
            type="button"
          >
            투표 마감하고 개표
          </button>
        )}
      </div>

      {detail.item.candidates.length < 2 && detail.item.status === "draft" ? (
        <p className="mt-3 text-sm font-semibold text-app-muted">
          후보를 두 명 이상 등록해야 투표를 시작할 수 있어요.
        </p>
      ) : null}

      {results === undefined ? null : (
        <ElectionResultsBlock
          busy={busy}
          detail={detail}
          onPublish={(winnerCandidateId, trigger) =>
            requestConfirmation({ kind: "publish", winnerCandidateId }, trigger)
          }
          results={results}
        />
      )}
      {confirmationCopy === undefined ? null : (
        <ConfirmDialog
          confirmLabel={confirmationCopy.confirmLabel}
          confirmTone={confirmationCopy.confirmTone}
          description={confirmationCopy.description}
          onCancel={() => setConfirmation(undefined)}
          onConfirm={confirmTransition}
          open
          returnFocusTo={confirmationTriggerRef.current}
          title={confirmationCopy.title}
        />
      )}
    </div>
  );
}

function ElectionResultsBlock({
  busy,
  detail,
  onPublish,
  results,
}: {
  busy: boolean;
  detail: ElectionEntityResponse;
  onPublish: (winnerCandidateId: string | undefined, trigger: HTMLButtonElement) => void;
  results: ElectionResults;
}): React.JSX.Element {
  const tied = results.leading_candidate_ids.length > 1;
  return (
    <div className="mt-6 border-t border-app-border pt-5" data-election-surface="teacher-results">
      <h3 className="text-lg font-extrabold text-app-text">개표 결과</h3>
      <ul className="mt-3 grid gap-2">
        {(results.tallies ?? []).map((tally) => (
          <li
            className="flex min-h-12 items-center justify-between rounded-2xl bg-app-surface-muted px-4 py-2"
            key={tally.candidate_id}
          >
            <span className="min-w-0 break-words font-bold text-app-text">
              {tally.display_name}
            </span>
            <span className="shrink-0 font-extrabold text-role-primary">{tally.vote_count}표</span>
          </li>
        ))}
      </ul>

      {results.winner === null ? null : (
        <p className="mt-4 rounded-2xl bg-role-soft px-4 py-3 text-base font-extrabold text-role-primary">
          당선: {results.winner.display_name}
          {results.tie_break_applied ? " (동점 처리 절차를 거쳤어요)" : ""}
        </p>
      )}

      {detail.item.status !== "closed" ? null : tied && detail.item.tie_break === "revote" ? (
        <p className="mt-4 rounded-2xl border border-warning-border bg-warning-surface px-4 py-3 text-sm font-bold text-warning-text">
          동점이라 재투표가 필요해요. 새 선거를 만들어 다시 투표해 주세요.
        </p>
      ) : tied ? (
        <div className="mt-4 grid gap-2">
          <p className="text-sm font-bold text-app-text">
            {detail.item.tie_break === "elder"
              ? "동점입니다. 동점자 중 나이가 많은 학생을 골라 주세요."
              : "동점입니다. 당선자를 골라 주세요."}
          </p>
          {results.leading_candidate_ids.map((candidateId) => {
            const candidate = detail.item.candidates.find((item) => item.id === candidateId);
            return (
              <button
                className="min-h-14 rounded-2xl border border-role-border bg-app-surface px-4 text-base font-extrabold text-app-text hover:bg-app-surface-muted"
                disabled={busy}
                key={candidateId}
                onClick={(event) => onPublish(candidateId, event.currentTarget)}
                type="button"
              >
                {candidate?.display_name ?? candidateId} 당선으로 발표
              </button>
            );
          })}
        </div>
      ) : (
        <button
          className="ui-button ui-button-primary mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-extrabold"
          disabled={busy}
          onClick={(event) => onPublish(undefined, event.currentTarget)}
          type="button"
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
          ) : (
            <Vote aria-hidden="true" className="size-5" />
          )}
          결과 발표하기
        </button>
      )}
    </div>
  );
}
