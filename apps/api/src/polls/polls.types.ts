export type PollListScope = "closed" | "open";
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

export interface PollListResult {
  items: PollItem[];
  next_cursor: string | null;
  scope: PollListScope;
  server_now: string;
}

export interface PollParticipantItem {
  display_name: string;
  member_id: string;
  selected_option_id?: string;
  selected_option_label?: string;
  student_number: number | null;
}

export interface PollParticipationResult {
  ballot_visibility: PollBallotVisibility;
  poll_id: string;
  total_students: number;
  unvoted_count: number;
  unvoted_students: PollParticipantItem[];
  voted_count: number;
  voted_students: PollParticipantItem[];
}

export interface ListPollsQuery {
  actorUserId: string;
  cursor?: string;
  scope: PollListScope;
}

export interface GetPollQuery {
  actorUserId: string;
  pollId: string;
}

export type GetPollParticipationQuery = GetPollQuery;

export interface CreatePollCommand {
  actorUserId: string;
  ballotVisibility: PollBallotVisibility;
  closesAt: string;
  description: string | null;
  idempotencyKey: string | string[] | undefined;
  options: string[];
  requestId: string;
  resultsPolicy: PollResultsPolicy;
  title: string;
}

export interface VoteInPollCommand {
  actorUserId: string;
  idempotencyKey: string | string[] | undefined;
  optionId: string;
  pollId: string;
}

export interface DeletePollCommand {
  actorUserId: string;
  ifMatch: string | string[] | undefined;
  pollId: string;
  requestId: string;
}

export type ClosePollCommand = DeletePollCommand;

/** 진행 중 투표 수정: 고칠 수 있는 네 가지를 통째로 보낸다(공개 설정은 받지 않는다). */
export interface UpdatePollCommand extends DeletePollCommand {
  closesAt: string;
  description: string | null;
  options: string[];
  title: string;
}
