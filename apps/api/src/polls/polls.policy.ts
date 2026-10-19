import type {
  PollBallotVisibility,
  PollItem,
  PollResultsPolicy,
  PollStatus,
} from "./polls.types.js";

type MaybeLegacyPollItem = Omit<PollItem, "ballot_visibility" | "closed_at" | "results_policy"> &
  Partial<Pick<PollItem, "ballot_visibility" | "closed_at" | "results_policy">>;

export function withPollPolicyDefaults(
  item: MaybeLegacyPollItem,
  ballotVisibility: PollBallotVisibility,
  resultsPolicy: PollResultsPolicy,
): PollItem {
  const normalized: PollItem = {
    ...item,
    closed_at: item.closed_at ?? null,
    ballot_visibility: item.ballot_visibility ?? ballotVisibility,
    results_policy: item.results_policy ?? resultsPolicy,
  };
  // Old idempotency responses can contain live counts. Apply the privacy rule
  // after restoring legacy defaults, including when replaying a stored response.
  if (normalized.ballot_visibility !== "private" || normalized.status !== "open") {
    return normalized;
  }
  return {
    ...normalized,
    options: normalized.options.map((option) => ({ ...option, vote_count: null })),
    results_visible: false,
    total_vote_count: null,
  };
}

export function shouldShowPollResults(input: {
  actorRole: "student" | "teacher";
  ballotVisibility: PollBallotVisibility;
  hasVoted: boolean;
  resultsPolicy: PollResultsPolicy;
  status: PollStatus;
}): boolean {
  if (input.ballotVisibility === "private" && input.status === "open") return false;
  if (input.actorRole === "teacher") return true;
  if (input.resultsPolicy === "teacher_only") return false;
  if (input.resultsPolicy === "after_close") return input.status === "closed";
  return input.hasVoted || input.status === "closed";
}
