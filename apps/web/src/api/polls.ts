import { apiFetch, entityEtag, parseResponse, withCsrfRecovery } from "./auth";

export type PollScope = "closed" | "open";
export type PollStatus = "closed" | "open";
export type PollBallotVisibility = "private" | "teacher_visible";
export type PollResultsPolicy = "after_close" | "after_vote" | "teacher_only";

export interface PollOptionItem {
  id: string;
  label: string;
  position: number;
  vote_count: number | null;
}

export interface PollItem {
  ballot_visibility: PollBallotVisibility;
  closed_at: string | null;
  closes_at: string;
  created_at: string;
  description: string | null;
  has_voted: boolean;
  id: string;
  my_option_id: string | null;
  options: PollOptionItem[];
  results_policy: PollResultsPolicy;
  results_visible: boolean;
  row_version: string;
  status: PollStatus;
  title: string;
  total_vote_count: number | null;
}

export interface PollListResponse {
  items: PollItem[];
  next_cursor: string | null;
  scope: PollScope;
  server_now: string;
}

export interface PollParticipantItem {
  display_name: string;
  member_id: string;
  selected_option_id?: string;
  selected_option_label?: string;
  student_number: number | null;
}

export interface PollParticipationResponse {
  ballot_visibility: PollBallotVisibility;
  poll_id: string;
  total_students: number;
  unvoted_count: number;
  unvoted_students: PollParticipantItem[];
  voted_count: number;
  voted_students: PollParticipantItem[];
}

export interface CreatePollRequest {
  ballot_visibility: PollBallotVisibility;
  closes_at: string;
  description: string | null;
  options: string[];
  results_policy: PollResultsPolicy;
  title: string;
}

export type UpdatePollRequest = Pick<
  CreatePollRequest,
  "closes_at" | "description" | "options" | "title"
>;

export interface PollEntityResponse {
  etag: string;
  item: PollItem;
}

async function parseEntity(response: Response): Promise<PollEntityResponse> {
  const item = await parseResponse<PollItem>(response);
  return { etag: entityEtag(item.row_version, response.headers.get("ETag")), item };
}

async function parseEmptyResponse(response: Response): Promise<void> {
  if (response.ok) return;
  await parseResponse<never>(response);
}

export async function listPolls(scope: PollScope, cursor?: string): Promise<PollListResponse> {
  const search = new URLSearchParams({ scope });
  if (cursor !== undefined) search.set("cursor", cursor);
  const response = await apiFetch(`/api/v1/polls?${search.toString()}`, {
    credentials: "include",
  });
  return parseResponse<PollListResponse>(response);
}

export async function getPoll(pollId: string): Promise<PollEntityResponse> {
  const response = await apiFetch(`/api/v1/polls/${encodeURIComponent(pollId)}`, {
    credentials: "include",
  });
  return parseEntity(response);
}

export async function getPollParticipation(pollId: string): Promise<PollParticipationResponse> {
  const response = await apiFetch(`/api/v1/polls/${encodeURIComponent(pollId)}/participation`, {
    credentials: "include",
  });
  return parseResponse<PollParticipationResponse>(response);
}

export async function createPoll(
  request: CreatePollRequest,
  idempotencyKey: string,
): Promise<PollEntityResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch("/api/v1/polls", {
        body,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-CSRF-Token": csrfToken,
        },
        method: "POST",
      }),
    parseEntity,
  );
}

export async function voteInPoll(
  pollId: string,
  optionId: string,
  idempotencyKey: string,
): Promise<PollEntityResponse> {
  const body = JSON.stringify({ option_id: optionId });
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/polls/${encodeURIComponent(pollId)}/votes`, {
        body,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-CSRF-Token": csrfToken,
        },
        method: "POST",
      }),
    parseEntity,
  );
}

export async function closePoll(pollId: string, etag: string): Promise<PollEntityResponse> {
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/polls/${encodeURIComponent(pollId)}/close`, {
        credentials: "include",
        headers: { "If-Match": etag, "X-CSRF-Token": csrfToken },
        method: "POST",
      }),
    parseEntity,
  );
}

/** 진행 중 투표 수정(제한형). 참여한 학생이 있으면 options는 지금과 같아야 한다(POLL_OPTIONS_LOCKED). */
export async function updatePoll(
  pollId: string,
  etag: string,
  request: UpdatePollRequest,
): Promise<PollEntityResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/polls/${encodeURIComponent(pollId)}`, {
        body,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
          "X-CSRF-Token": csrfToken,
        },
        method: "PATCH",
      }),
    parseEntity,
  );
}

export async function deletePoll(pollId: string, etag: string): Promise<void> {
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/polls/${encodeURIComponent(pollId)}`, {
        credentials: "include",
        headers: {
          "If-Match": etag,
          "X-CSRF-Token": csrfToken,
        },
        method: "DELETE",
      }),
    parseEmptyResponse,
  );
}
