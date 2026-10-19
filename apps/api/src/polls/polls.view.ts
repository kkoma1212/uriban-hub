import type { DB } from "@classhub/db";
import { sql, type Kysely } from "kysely";
import { shouldShowPollResults } from "./polls.policy.js";
import type { PollDatabaseEngine } from "./polls.database.js";
import type {
  PollBallotVisibility,
  PollItem,
  PollOptionItem,
  PollResultsPolicy,
  PollStatus,
} from "./polls.types.js";
type DatabaseExecutor = Kysely<DB>;

export interface PollActorContext {
  classId: string;
  displayName: string;
  memberId: string;
  role: "student" | "teacher";
}

export interface PollRow {
  ballot_visibility: PollBallotVisibility;
  class_id: string;
  closed_at: Date | null;
  closes_at: Date;
  created_at: Date;
  description: string | null;
  id: string;
  option_count: number;
  results_policy: PollResultsPolicy;
  row_version: string;
  title: string;
}

interface OptionCountRow {
  id: string;
  label: string;
  poll_id: string;
  position: number;
  vote_count: number;
}

interface PollAuditJson {
  [key: string]: null | number | string;
  closes_at: string;
  deleted_at: string | null;
  option_count: number;
  poll_id: string;
  title: string;
  vote_count: number;
}

export function pollAuditSnapshot(
  poll: PollRow,
  voteCount: number,
  deletedAt: string | null,
): PollAuditJson {
  return {
    closes_at: poll.closes_at.toISOString(),
    deleted_at: deletedAt,
    option_count: poll.option_count,
    poll_id: poll.id,
    title: poll.title,
    vote_count: voteCount,
  };
}

function pollStatus(poll: PollRow, now: Date): PollStatus {
  return poll.closed_at !== null || poll.closes_at.getTime() <= now.getTime() ? "closed" : "open";
}

export async function viewsForPollRows(
  executor: DatabaseExecutor,
  polls: PollRow[],
  actor: PollActorContext,
  now: Date,
  engine: PollDatabaseEngine,
): Promise<PollItem[]> {
  if (polls.length === 0) return [];
  const pollIds = polls.map(({ id }) => id);
  const [optionRows, ownVoteRows] = await Promise.all([
    executor
      .selectFrom("poll_options as option")
      .leftJoin("poll_votes as vote", "vote.option_id", "option.id")
      .select([
        "option.id",
        "option.label",
        "option.poll_id",
        "option.position",
        (engine === "mariadb"
          ? sql<number>`COUNT(vote.id)`
          : sql<number>`count(vote.id)::integer`
        ).as("vote_count"),
      ])
      .where("option.poll_id", "in", pollIds)
      .groupBy(["option.id", "option.label", "option.poll_id", "option.position"])
      .orderBy("option.poll_id", "asc")
      .orderBy("option.position", "asc")
      .execute(),
    actor.role === "student"
      ? executor
          .selectFrom("poll_votes")
          .select(["option_id", "poll_id"])
          .where("poll_id", "in", pollIds)
          .where("member_id", "=", actor.memberId)
          .execute()
      : Promise.resolve([]),
  ]);
  const optionsByPoll = new Map<string, OptionCountRow[]>();
  for (const row of optionRows as OptionCountRow[]) {
    const options = optionsByPoll.get(row.poll_id) ?? [];
    options.push(row);
    optionsByPoll.set(row.poll_id, options);
  }
  const ownOptionByPoll = new Map(
    ownVoteRows.map(({ option_id, poll_id }) => [poll_id, option_id]),
  );
  return polls.map((poll) =>
    materializeView(
      poll,
      optionsByPoll.get(poll.id) ?? [],
      actor,
      now,
      ownOptionByPoll.get(poll.id) ?? null,
    ),
  );
}

export async function viewForPollRow(
  executor: DatabaseExecutor,
  poll: PollRow,
  actor: PollActorContext,
  now: Date,
  engine: PollDatabaseEngine,
): Promise<PollItem> {
  return (await viewsForPollRows(executor, [poll], actor, now, engine))[0]!;
}

function materializeView(
  poll: PollRow,
  options: OptionCountRow[],
  actor: PollActorContext,
  now: Date,
  myOptionId: string | null,
): PollItem {
  const status = pollStatus(poll, now);
  const hasVoted = myOptionId !== null;
  const resultsVisible = shouldShowPollResults({
    actorRole: actor.role,
    ballotVisibility: poll.ballot_visibility,
    hasVoted,
    resultsPolicy: poll.results_policy,
    status,
  });
  const totalVoteCount = options.reduce((total, option) => total + option.vote_count, 0);
  return {
    ballot_visibility: poll.ballot_visibility,
    closed_at: poll.closed_at?.toISOString() ?? null,
    closes_at: poll.closes_at.toISOString(),
    created_at: poll.created_at.toISOString(),
    description: poll.description,
    has_voted: hasVoted,
    id: poll.id,
    my_option_id: myOptionId,
    options: options.map((option): PollOptionItem => ({
      id: option.id,
      label: option.label,
      position: option.position,
      vote_count: resultsVisible ? option.vote_count : null,
    })),
    results_policy: poll.results_policy,
    results_visible: resultsVisible,
    row_version: poll.row_version,
    status,
    title: poll.title,
    total_vote_count: resultsVisible ? totalVoteCount : null,
  };
}
