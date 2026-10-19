import { ElectionNotFoundException } from "./elections.errors.js";
import type {
  ElectionResultsVisibility,
  ElectionStatus,
  ElectionSummary,
  ElectionTieBreak,
} from "./elections.types.js";

const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;

/** 후보 수 상한. 학급 하나 규모에서 이보다 많으면 고르는 화면이 무너진다. */
export const MAX_ELECTION_CANDIDATES = 30;

export interface ElectionRow {
  class_id: string;
  closed_at: Date | null;
  created_at: Date;
  created_by_member_id: string;
  id: string;
  opened_at: Date | null;
  published_at: Date | null;
  results_visibility: string;
  row_version: string;
  status: string;
  tie_break: string;
  tie_break_applied: boolean;
  title: string;
  winner_candidate_id: string | null;
}

export interface ElectionCandidateRow {
  display_name_snapshot: string;
  id: string;
  student_number_snapshot: number | null;
}

export function isPositiveElectionId(value: string): boolean {
  if (!/^[1-9][0-9]*$/u.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_DATABASE_ID;
  } catch {
    return false;
  }
}

export function assertPositiveElectionId(value: string): void {
  if (!isPositiveElectionId(value)) throw new ElectionNotFoundException();
}

export function electionStatus(value: string): ElectionStatus {
  if (value === "draft" || value === "open" || value === "closed" || value === "published") {
    return value;
  }
  throw new Error(`Unexpected election status: ${value}`);
}

export function electionTieBreak(value: string): ElectionTieBreak {
  if (value === "revote" || value === "elder" || value === "teacher_decides") return value;
  throw new Error(`Unexpected election tie break: ${value}`);
}

export function electionResultsVisibility(value: string): ElectionResultsVisibility {
  if (value === "winner_only" || value === "with_counts") return value;
  throw new Error(`Unexpected election results visibility: ${value}`);
}

export function electionSummary(row: ElectionRow): ElectionSummary {
  return {
    closed_at: row.closed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    id: row.id,
    opened_at: row.opened_at?.toISOString() ?? null,
    published_at: row.published_at?.toISOString() ?? null,
    results_visibility: electionResultsVisibility(row.results_visibility),
    row_version: row.row_version,
    status: electionStatus(row.status),
    tie_break: electionTieBreak(row.tie_break),
    title: row.title,
  };
}
