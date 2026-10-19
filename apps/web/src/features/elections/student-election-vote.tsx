import { CheckCircle2, LoaderCircle, Vote } from "lucide-react";
import { useState } from "react";

import {
  castElectionVote,
  getCurrentElection,
  type ElectionCandidateItem,
  type ElectionPublicItem,
  type ElectionResults,
} from "../../api/elections";
import { ApiRequestError } from "../../api/auth";
import { isMutationOutcomeUnknown } from "../../lib/idempotent-create";
import { AsyncStatePanel } from "../layout/async-state";

/*
 * 학생이 보는 투표 화면.
 *
 * 여기서 화면이 지켜야 하는 것은 **고른 것을 남기지 않는 것**이다. 서버가 무엇을
 * 골랐는지 모르므로 다시 열어도 알 수 없고, 화면도 그 사실을 숨기지 않고 그대로
 * 말한다 — "누구를 뽑았는지는 아무도 알 수 없어요". 그래야 학생이 믿고 찍는다.
 *
 * 득표 수도 보여주지 않는다. 진행 중에 보이면 뒤에 찍는 학생이 앞선 결과에 끌린다.
 */
export function StudentElectionVote({
  election,
  onVoted,
}: {
  election: ElectionPublicItem;
  onVoted: (next: ElectionPublicItem | null) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [statusCheckNeeded, setStatusCheckNeeded] = useState(false);
  const [error, setError] = useState<string>();

  async function recheckVoteStatus(): Promise<boolean> {
    setCheckingStatus(true);
    try {
      const latest = (await getCurrentElection()).item;
      if (latest?.id === election.id && latest.has_voted) {
        setError(undefined);
        setStatusCheckNeeded(false);
        onVoted(latest);
        return true;
      }
      setStatusCheckNeeded(latest === null || latest.id !== election.id);
      return false;
    } catch {
      setStatusCheckNeeded(true);
      return false;
    } finally {
      setCheckingStatus(false);
    }
  }

  if (election.has_voted) {
    return (
      <section
        className="content-card activity-summary-panel p-4 sm:p-5"
        data-election-surface="student-voted"
      >
        <div className="flex items-start gap-3">
          <CheckCircle2 aria-hidden="true" className="mt-1 size-6 shrink-0 text-role-primary" />
          <div className="min-w-0">
            <h2 className="break-words text-2xl font-extrabold tracking-[-0.03em] text-app-text">
              투표를 마쳤어요
            </h2>
            <p className="mt-2 text-sm font-semibold text-app-muted">
              {election.title} · 지금까지 {election.participant_count}명이 투표했어요.
            </p>
            {/* 이 문장이 이 기능의 약속이다. 지킬 수 없는 말을 적지 않는다. */}
            <p className="mt-4 rounded-2xl bg-app-surface-muted px-4 py-3 text-sm font-bold text-app-text">
              누구를 뽑았는지는 아무도 알 수 없어요. 선생님도, 나중에 이 화면을 다시 열어도 나오지
              않아요.
            </p>
          </div>
        </div>
      </section>
    );
  }

  async function submit(): Promise<void> {
    if (selected === undefined) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await castElectionVote(election.id, selected);
      onVoted(result.item);
    } catch (requestError) {
      const message =
        requestError instanceof ApiRequestError
          ? requestError.message
          : "투표를 보내지 못했어요. 잠시 뒤 다시 시도해 주세요.";
      setError(message);
      if (
        isMutationOutcomeUnknown(requestError) ||
        (requestError instanceof ApiRequestError && requestError.status === 409)
      ) {
        /* 결과 미상 상태에서 화면에 마지막 선택을 남기지 않는다. */
        setSelected(undefined);
        await recheckVoteStatus();
      }
    } finally {
      setSubmitting(false);
    }
  }

  const interactionBlocked = submitting || checkingStatus || statusCheckNeeded;

  return (
    <section
      className="content-card activity-summary-panel p-4 sm:p-5"
      data-election-surface="student-vote"
    >
      <p className="text-sm font-bold text-role-primary">비밀 투표</p>
      <h2 className="mt-2 break-words text-xl font-extrabold text-app-text">{election.title}</h2>
      <p className="mt-3 text-sm font-semibold text-app-muted">
        한 사람이 한 번만 투표할 수 있어요. 누구를 뽑았는지는 기록에 남지 않아요.
      </p>

      <div aria-label="후보" className="mt-6 grid gap-2" role="radiogroup">
        {election.candidates.map((candidate: ElectionCandidateItem) => (
          <label
            className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl border px-4 text-base font-extrabold transition-colors focus-within:ring-2 focus-within:ring-role-primary focus-within:ring-offset-2 focus-within:ring-offset-app-surface ${
              selected === candidate.id
                ? "border-role-border bg-role-soft text-role-primary"
                : "border-app-border bg-app-surface text-app-text hover:bg-app-surface-muted"
            }`}
            key={candidate.id}
          >
            <input
              checked={selected === candidate.id}
              className="sr-only"
              disabled={interactionBlocked}
              name="election-candidate"
              onChange={() => setSelected(candidate.id)}
              type="radio"
              value={candidate.id}
            />
            <span className="min-w-0 break-words">
              {candidate.student_number === null ? null : (
                <span className="mr-2 text-sm font-bold text-app-muted">
                  {candidate.student_number}번
                </span>
              )}
              {candidate.display_name}
            </span>
          </label>
        ))}
      </div>

      {error === undefined ? null : (
        <p
          className="mt-4 rounded-2xl border border-danger-border bg-danger-surface px-4 py-3 text-sm font-bold text-danger-text"
          role="alert"
        >
          {error}
        </p>
      )}

      {statusCheckNeeded ? (
        <div className="mt-3 rounded-2xl border border-warning-border bg-warning-surface px-4 py-4 text-warning-text">
          <p className="text-sm font-bold">
            투표가 완료됐는지 아직 확인하지 못했어요. 다시 보내기 전에 현재 상태를 먼저 확인해
            주세요.
          </p>
          <button
            className="ui-button ui-button-secondary mt-3 min-h-11 text-sm"
            disabled={checkingStatus}
            onClick={() => void recheckVoteStatus()}
            type="button"
          >
            {checkingStatus ? (
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            ) : null}
            {checkingStatus ? "투표 상태 확인 중" : "투표 상태 다시 확인"}
          </button>
        </div>
      ) : null}

      <button
        className="ui-button ui-button-primary mt-6 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-extrabold"
        disabled={selected === undefined || interactionBlocked}
        onClick={() => void submit()}
        type="button"
      >
        {submitting ? (
          <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
        ) : (
          <Vote aria-hidden="true" className="size-5" />
        )}
        투표하기
      </button>
      <p className="mt-3 text-center text-xs font-semibold text-app-muted">
        한 번 보내면 바꿀 수 없어요.
      </p>
    </section>
  );
}

export function StudentElectionEmpty(): React.JSX.Element {
  return (
    <AsyncStatePanel
      description="선생님이 선거를 시작하면 여기에서 투표할 수 있어요."
      icon={Vote}
      kind="empty"
      title="지금 진행 중인 선거가 없어요."
    />
  );
}

/*
 * 학생이 보는 발표 결과.
 *
 * 무엇을 보일지는 **서버가 정한다** — 교사가 "당선자만 공개"를 골랐으면 득표 수가
 * 아예 안 온다(`tallies === null`). 화면은 온 것만 그린다. 공개 범위 판단을 화면에
 * 두면 두 곳이 서로 어긋날 수 있고, 어긋나는 쪽이 하필 학생 화면이면 약속이 깨진다.
 */
export function StudentElectionResult({
  results,
}: {
  results: ElectionResults;
}): React.JSX.Element {
  const tallies = results.tallies ?? [];
  return (
    <section
      className="content-card activity-summary-panel p-4 sm:p-5"
      data-election-surface="student-result"
    >
      <p className="text-sm font-bold text-role-primary">투표 결과</p>
      <h2 className="mt-2 break-words text-xl font-extrabold text-app-text">{results.title}</h2>

      {results.winner === null ? (
        <p className="mt-4 text-sm font-semibold text-app-muted">
          아직 당선자가 정해지지 않았어요.
        </p>
      ) : (
        <p className="mt-4 rounded-2xl bg-role-soft px-4 py-3 text-lg font-extrabold text-role-primary">
          당선: {results.winner.display_name}
          {results.tie_break_applied ? " (동점 처리 절차를 거쳤어요)" : ""}
        </p>
      )}

      {tallies.length === 0 ? null : (
        <ul aria-label="후보별 득표" className="mt-5 grid gap-2">
          {tallies.map((tally) => (
            <li
              className="flex min-h-12 items-center justify-between rounded-2xl bg-app-surface-muted px-4 py-2"
              key={tally.candidate_id}
            >
              <span className="min-w-0 break-words font-bold text-app-text">
                {tally.display_name}
              </span>
              <span className="shrink-0 font-extrabold text-role-primary">
                {tally.vote_count}표
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-5 text-sm font-semibold text-app-muted">
        {results.participant_count}명이 투표했어요. 누가 누구를 뽑았는지는 여전히 아무도 알 수
        없어요.
      </p>
    </section>
  );
}
