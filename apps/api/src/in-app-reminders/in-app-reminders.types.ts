import type { DB } from "@classhub/db";
import type { Transaction } from "kysely";

export type InAppReminderType = "notice" | "supply";

export interface InAppReminderResult {
  batch_id: string;
  cooldown_suppressed_count: number;
  created_at: string;
  created_count: number;
  current_unresolved_count: number;
  next_available_at: string | null;
}

export interface LockedInAppReminderContext {
  actorDisplayName: string;
  actorMemberId: string;
  classId: string;
  contentRevision: string;
  resourceId: string;
}

export interface CreateInAppReminderCommand {
  actorUserId: string;
  contentRevision: string;
  idempotencyKey: string | string[] | undefined;
  /** Lock the actor's users row, then class/member/resource in this transaction; recheck access. */
  lockContext: (transaction: Transaction<DB>) => Promise<LockedInAppReminderContext>;
  requestId: string;
  resourceId: string;
  reminderType: InAppReminderType;
}

export interface ResolveInAppRemindersCommand {
  classId: string;
  contentRevision: string;
  memberId: string;
  resourceId: string;
  reminderType: InAppReminderType;
}
