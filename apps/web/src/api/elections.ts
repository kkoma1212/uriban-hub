import { apiFetch, entityEtag, parseResponse, withCsrfRecovery } from "./auth";

export type ElectionStatus = "closed" | "draft" | "open" | "published";
export type ElectionTieBreak = "elder" | "revote" | "teacher_decides";
export type ElectionResultsVisibility = "winner_only" | "with_counts";

export interface ElectionCandidateItem {
  display_name: string;
  id: string;
  student_number: number | null;
}

export interface ElectionSummary {
  closed_at: string | null;
  created_at: string;
  id: string;
  opened_at: string | null;
  published_at: string | null;
  results_visibility: ElectionResultsVisibility;
  row_version: string;
  status: ElectionStatus;
  tie_break: ElectionTieBreak;
  title: string;
}

export interface ElectionItem extends ElectionSummary {
  candidates: ElectionCandidateItem[];
  participant_count: number;
}

/*
 * 학생이 보는 모양. 득표 수가 없다 — 진행 중에 보이면 뒤에 찍는 학생이 앞선
 * 결과에 끌린다. 무엇을 골랐는지는 서버도 모르므로 어차피 내려올 수 없다.
 */
export interface ElectionPublicItem {
  candidates: ElectionCandidateItem[];
  has_voted: boolean;
  id: string;
  participant_count: number;
  status: ElectionStatus;
  title: string;
}

export interface ElectionTallyItem {
  candidate_id: string;
  display_name: string;
  student_number: number | null;
  vote_count: number;
}

export interface ElectionResults {
  leading_candidate_ids: string[];
  participant_count: number;
  results_visibility: ElectionResultsVisibility;
  status: ElectionStatus;
  /** "당선자만 공개"인 선거에서는 학생에게 null 로 온다. */
  tallies: ElectionTallyItem[] | null;
  tie_break: ElectionTieBreak;
  tie_break_applied: boolean;
  title: string;
  winner: ElectionCandidateItem | null;
}

export interface ElectionEntityResponse {
  etag: string;
  item: ElectionItem;
}

export interface CreateElectionRequest {
  results_visibility: ElectionResultsVisibility;
  tie_break: ElectionTieBreak;
  title: string;
}

async function parseElection(response: Response): Promise<ElectionEntityResponse> {
  const item = await parseResponse<ElectionItem>(response);
  return { etag: entityEtag(item.row_version, response.headers.get("ETag")), item };
}

export async function listElections(): Promise<{ items: ElectionSummary[] }> {
  const response = await apiFetch("/api/v1/elections", { credentials: "include" });
  return parseResponse<{ items: ElectionSummary[] }>(response);
}

/** 학생도 부를 수 있는 유일한 선거 경로다. 진행 중인 선거만 내려온다. */
export async function getCurrentElection(): Promise<{ item: ElectionPublicItem | null }> {
  const response = await apiFetch("/api/v1/elections/current", { credentials: "include" });
  return parseResponse<{ item: ElectionPublicItem | null }>(response);
}

export async function getElection(electionId: string): Promise<ElectionEntityResponse> {
  const response = await apiFetch(`/api/v1/elections/${encodeURIComponent(electionId)}`, {
    credentials: "include",
  });
  return parseElection(response);
}

export async function createElection(
  request: CreateElectionRequest,
  idempotencyKey: string,
): Promise<ElectionEntityResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch("/api/v1/elections", {
        body,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-CSRF-Token": csrfToken,
        },
        method: "POST",
      }),
    parseElection,
  );
}

export async function registerElectionCandidate(
  electionId: string,
  memberId: string,
  etag: string,
): Promise<ElectionEntityResponse> {
  const body = JSON.stringify({ member_id: memberId });
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/elections/${encodeURIComponent(electionId)}/candidates`, {
        body,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
          "X-CSRF-Token": csrfToken,
        },
        method: "POST",
      }),
    parseElection,
  );
}

export async function openElection(
  electionId: string,
  etag: string,
): Promise<ElectionEntityResponse> {
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/elections/${encodeURIComponent(electionId)}/open`, {
        credentials: "include",
        headers: { "If-Match": etag, "X-CSRF-Token": csrfToken },
        method: "POST",
      }),
    parseElection,
  );
}

export async function closeElection(
  electionId: string,
  etag: string,
): Promise<ElectionEntityResponse> {
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/elections/${encodeURIComponent(electionId)}/close`, {
        credentials: "include",
        headers: { "If-Match": etag, "X-CSRF-Token": csrfToken },
        method: "POST",
      }),
    parseElection,
  );
}

/*
 * 멱등성 키를 보내지 않는다. 서버가 받지도 않는다 — 그 저장소가 요청 본문의
 * 해시를 사용자 식별자와 같은 행에 남기는데, 후보가 몇 명뿐이라 해시를 맞춰 보면
 * 선택이 복원되기 때문이다. 중복 투표는 서버의 기본키가 막는다.
 */
export async function castElectionVote(
  electionId: string,
  candidateId: string,
): Promise<{ item: ElectionPublicItem | null }> {
  const body = JSON.stringify({ candidate_id: candidateId });
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/elections/${encodeURIComponent(electionId)}/vote`, {
        body,
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        method: "POST",
      }),
    (response) => parseResponse<{ item: ElectionPublicItem | null }>(response),
  );
}

export async function getElectionResults(electionId: string): Promise<ElectionResults> {
  const response = await apiFetch(`/api/v1/elections/${encodeURIComponent(electionId)}/results`, {
    credentials: "include",
  });
  return parseResponse<ElectionResults>(response);
}

export async function publishElection(
  electionId: string,
  etag: string,
  winnerCandidateId?: string,
): Promise<ElectionResults> {
  const body = JSON.stringify(
    winnerCandidateId === undefined ? {} : { winner_candidate_id: winnerCandidateId },
  );
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/elections/${encodeURIComponent(electionId)}/publish`, {
        body,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
          "X-CSRF-Token": csrfToken,
        },
        method: "POST",
      }),
    (response) => parseResponse<ElectionResults>(response),
  );
}
