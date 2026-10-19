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
  /** 개표 전에 정해져 있어야 하고 그 뒤 바꿀 수 없다 — DB 트리거가 막는다. */
  tie_break: ElectionTieBreak;
  title: string;
}

export interface ElectionItem extends ElectionSummary {
  candidates: ElectionCandidateItem[];
  /*
   * 투표를 마친 사람 "수"만 내려보낸다. 누가 했는지는 내려보내지 않는다 —
   * 참여자 목록과 득표 수를 함께 쥐면 소수 인원에서는 선택이 드러날 수 있다.
   */
  participant_count: number;
}

export interface ElectionListResult {
  items: ElectionSummary[];
}

/*
 * 학생이 보는 모양. 득표 수는 담지 않는다 — 진행 중에 보이면 나중에 찍는 학생이
 * 앞선 결과에 끌린다. 결과 공개는 개표·발표 단계에서 따로 다룬다.
 */
export interface ElectionPublicItem {
  candidates: ElectionCandidateItem[];
  /** 내가 투표를 마쳤는지. 무엇을 골랐는지는 서버도 모른다. */
  has_voted: boolean;
  id: string;
  participant_count: number;
  status: ElectionStatus;
  title: string;
}

export interface ElectionCurrentResult {
  item: ElectionPublicItem | null;
}

export interface GetCurrentElectionQuery {
  actorUserId: string;
}

export interface OpenElectionCommand {
  actorUserId: string;
  electionId: string;
  ifMatch: string | string[] | undefined;
  requestId: string;
}

export interface CastElectionVoteCommand {
  actorUserId: string;
  candidateId: string;
  electionId: string;
}

export interface ElectionTallyItem {
  candidate_id: string;
  display_name: string;
  student_number: number | null;
  vote_count: number;
}

export interface ElectionResults {
  /** 최다 득표가 갈리지 않은 후보들. 하나면 그대로 당선이다. */
  leading_candidate_ids: string[];
  participant_count: number;
  results_visibility: ElectionResultsVisibility;
  status: ElectionStatus;
  /*
   * 득표 수는 발표 전이거나 "당선자만 공개"인 경우 학생에게 내려보내지 않는다.
   * 교사에게는 개표를 위해 항상 보인다.
   */
  tallies: ElectionTallyItem[] | null;
  tie_break: ElectionTieBreak;
  tie_break_applied: boolean;
  title: string;
  winner: ElectionCandidateItem | null;
}

export interface GetElectionResultsQuery {
  actorUserId: string;
  electionId: string;
}

export interface CloseElectionCommand {
  actorUserId: string;
  electionId: string;
  ifMatch: string | string[] | undefined;
  requestId: string;
}

export interface PublishElectionCommand {
  actorUserId: string;
  electionId: string;
  ifMatch: string | string[] | undefined;
  requestId: string;
  /** 동점일 때만 필요하다. 동점자 중 하나여야 한다. */
  winnerCandidateId: string | undefined;
}

export interface ListElectionsQuery {
  actorUserId: string;
}

export interface GetElectionQuery {
  actorUserId: string;
  electionId: string;
}

export interface CreateElectionCommand {
  actorUserId: string;
  idempotencyKey: string | string[] | undefined;
  requestId: string;
  resultsVisibility: ElectionResultsVisibility;
  tieBreak: ElectionTieBreak;
  title: string;
}

export interface RegisterElectionCandidateCommand {
  actorUserId: string;
  electionId: string;
  ifMatch: string | string[] | undefined;
  memberId: string;
  requestId: string;
}
