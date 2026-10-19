import { matchesDatabaseConstraint, type DB } from "@classhub/db";
import { sql, type Kysely } from "kysely";
import { ResourceVersionChangedException } from "../common/http/if-match.js";
import {
  isMariaDbPollDuplicate,
  pollDate,
  pollJson,
  type PollDatabaseEngine,
} from "./polls.database.js";
import {
  PollClosedException,
  PollDeadlineInvalidException,
  PollOptionsDuplicateException,
  PollOptionsLockedException,
} from "./polls.errors.js";
import type { UpdatePollCommand } from "./polls.types.js";
import { pollAuditSnapshot, type PollActorContext, type PollRow } from "./polls.view.js";

export interface PollEditInput {
  actor: PollActorContext;
  command: UpdatePollCommand;
  engine: PollDatabaseEngine;
  expectedRowVersion: string;
  /** 만들 때와 같은 마감 범위(서비스의 상수를 그대로 넘긴다). */
  limits: { maximumCloseDelayMs: number; minimumCloseDelayMs: number };
  now: Date;
  poll: PollRow;
}

/**
 * 진행 중 투표 수정(2026-10-04 사용자 결정, 제한형). 호출하는 쪽이 투표·마감·삭제와 같은 잠금
 * (lockPollMutation)을 먼저 잡는다 — 그래서 아래에서 센 표 수와 선택지 교체 사이에 표가 끼어들 수 없다.
 * 제목·설명·마감은 언제든, 선택지는 0표일 때만 바꾼다. 공개 설정은 받지도 바꾸지도 않는다.
 * 바뀐 것이 없으면 아무것도 쓰지 않고 false를 돌려준다.
 */
export async function applyPollEdit(
  transaction: Kysely<DB>,
  { actor, command, engine, expectedRowVersion, limits, now, poll }: PollEditInput,
): Promise<boolean> {
  if (poll.row_version !== expectedRowVersion) {
    throw new ResourceVersionChangedException(poll.row_version);
  }
  if (poll.closed_at !== null || poll.closes_at.getTime() <= now.getTime()) {
    throw new PollClosedException();
  }
  const closesAt = new Date(command.closesAt);
  // 마감은 지금부터 최소 5분 뒤, 투표를 만든 때부터 최대 30일(DB 검사 polls_closes_at_check와 같은 끝).
  if (
    Number.isNaN(closesAt.getTime()) ||
    closesAt.getTime() - now.getTime() < limits.minimumCloseDelayMs ||
    closesAt.getTime() > poll.created_at.getTime() + limits.maximumCloseDelayMs
  ) {
    throw new PollDeadlineInvalidException();
  }

  const currentOptions = await transaction
    .selectFrom("poll_options")
    .select("label")
    .where("poll_id", "=", poll.id)
    .orderBy("position", "asc")
    .execute();
  const optionsChanged =
    currentOptions.length !== command.options.length ||
    currentOptions.some((option, index) => option.label !== command.options[index]);
  const voteCount = Number(
    (
      await transaction
        .selectFrom("poll_votes")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("poll_id", "=", poll.id)
        .executeTakeFirstOrThrow()
    ).count,
  );
  if (optionsChanged && voteCount > 0) throw new PollOptionsLockedException();
  const changed =
    optionsChanged ||
    command.title !== poll.title ||
    command.description !== poll.description ||
    closesAt.getTime() !== poll.closes_at.getTime();
  if (!changed) return false;

  const update = await transaction
    .updateTable("polls")
    .set({
      closes_at: pollDate(closesAt, engine),
      description: command.description,
      option_count: command.options.length,
      row_version: sql<string>`row_version + 1`,
      title: command.title,
    })
    .where("id", "=", poll.id)
    .where("class_id", "=", actor.classId)
    .where("row_version", "=", expectedRowVersion)
    .where("closed_at", "is", null)
    .executeTakeFirstOrThrow();
  if (update.numUpdatedRows !== 1n) throw new ResourceVersionChangedException(poll.row_version);

  if (optionsChanged) {
    // 0표가 확인됐으므로 표가 가리키는 선택지가 없다 — 지우고 새 순서로 다시 넣는다(만들 때와 같은 방식).
    await transaction.deleteFrom("poll_options").where("poll_id", "=", poll.id).execute();
    try {
      await transaction
        .insertInto("poll_options")
        .values(
          command.options.map((label, index) => ({ label, poll_id: poll.id, position: index + 1 })),
        )
        .execute();
    } catch (error) {
      if (
        (engine === "mariadb" && isMariaDbPollDuplicate(error)) ||
        matchesDatabaseConstraint(error, {
          kind: "unique_violation",
          objectName: "poll_options_poll_label_unique",
        })
      )
        throw new PollOptionsDuplicateException();
      throw error;
    }
  }

  const before = pollAuditSnapshot(poll, voteCount, null);
  await transaction
    .insertInto("audit_logs")
    .values({
      action: "poll.updated",
      actor_display_name_snapshot: actor.displayName,
      actor_member_id: actor.memberId,
      actor_role_snapshot: "teacher",
      actor_user_id: command.actorUserId,
      after_json: pollJson(
        {
          ...before,
          closes_at: closesAt.toISOString(),
          option_count: command.options.length,
          title: command.title,
        },
        engine,
      ),
      before_json: pollJson(before, engine),
      class_id: actor.classId,
      reason: optionsChanged ? "teacher_edit_with_options" : "teacher_edit",
      request_id: command.requestId,
      target_id: poll.id,
      target_snapshot: null,
      target_type: "poll",
    })
    .execute();
  return true;
}
