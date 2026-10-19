import {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  IdempotencyService,
  MariaDbIdempotencyService,
  matchesDatabaseConstraint,
  type DB,
  type JsonObject,
} from "@classhub/db";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type Kysely, type Transaction } from "kysely";

import { UnauthenticatedException } from "../auth/auth.errors.js";
import type { AppEnvironment } from "../config/environment.js";
import { mariaDbInsertId } from "../common/database/mariadb-values.js";
import { parseRequiredIfMatch, ResourceVersionChangedException } from "../common/http/if-match.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { applyPollEdit } from "./poll-edit.js";
import { decodePollListCursor, encodePollListCursor } from "./polls.cursor.js";
import {
  isMariaDbPollDuplicate,
  pollCursorTime,
  pollDatabaseEngine,
  pollDate,
  pollId,
  pollJson,
  pollMariaDbRowCodec,
  pollProjection,
  type PollDatabaseEngine,
} from "./polls.database.js";
import {
  mapPollIdempotencyError,
  PollAlreadyVotedException,
  PollClassSuspendedException,
  PollClosedException,
  PollDeadlineInvalidException,
  PollEditUnavailableException,
  PollNotFoundException,
  PollOptionsDuplicateException,
  PollRoleInsufficientException,
} from "./polls.errors.js";
import { withPollPolicyDefaults } from "./polls.policy.js";
import type {
  ClosePollCommand,
  CreatePollCommand,
  DeletePollCommand,
  GetPollParticipationQuery,
  GetPollQuery,
  ListPollsQuery,
  PollItem,
  PollListResult,
  PollOptionItem,
  PollParticipantItem,
  PollParticipationResult,
  UpdatePollCommand,
  VoteInPollCommand,
} from "./polls.types.js";

import {
  pollAuditSnapshot,
  viewsForPollRows,
  viewForPollRow,
  type PollActorContext,
  type PollRow,
} from "./polls.view.js";

const CREATE_ROUTE = "/polls";
const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;
const MINIMUM_CLOSE_DELAY_MS = 5 * 60 * 1_000;
const MAXIMUM_CLOSE_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;
const LIST_LIMIT = 50;

type PollItemJson = PollItem & JsonObject;
type DatabaseExecutor = Kysely<DB>;

interface RawPollActor {
  class_id: string;
  class_status: string;
  deleted_at: Date | null;
  display_name: string;
  is_active: boolean;
  member_id: string;
  profile_status: string | null;
  role: string;
  temporary_password_must_change: boolean | null;
}

// 목록 조회에서만 커서용 원본 정밀도 타임스탬프를 함께 읽는다.
interface PollListRow extends PollRow {
  cursor_closes_at: string;
}

function isPositiveId(value: string): boolean {
  if (!/^[1-9][0-9]*$/u.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_DATABASE_ID;
  } catch {
    return false;
  }
}

function normalizeOptionLabel(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function assertUniqueOptions(options: string[]): void {
  const normalized = options.map(normalizeOptionLabel);
  if (new Set(normalized).size !== normalized.length) {
    throw new PollOptionsDuplicateException();
  }
}

function isDatabaseConstraint(error: unknown, constraint: string): boolean {
  return matchesDatabaseConstraint(error, {
    kind: "unique_violation",
    objectName: constraint,
  });
}

@Injectable()
export class PollsService {
  private readonly idempotency: IdempotencyService | MariaDbIdempotencyService;
  private readonly engine: PollDatabaseEngine;
  private readonly pollEditInstalled: boolean;

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    this.engine = pollDatabaseEngine(config);
    this.pollEditInstalled = config?.get("POLL_EDIT_DATABASE_INSTALLED", { infer: true }) === true;
    if (this.engine === "mariadb") this.database = database.withPlugin(pollMariaDbRowCodec);
    this.idempotency =
      this.engine === "mariadb"
        ? new MariaDbIdempotencyService(this.database)
        : new IdempotencyService(this.database);
  }

  async list(query: ListPollsQuery): Promise<PollListResult> {
    const [actor, now] = await Promise.all([
      this.getActorContext(query.actorUserId),
      this.readDatabaseNow(this.database),
    ]);
    const cursor =
      query.cursor === undefined ? undefined : decodePollListCursor(query.cursor, query.scope);
    let builder = this.database
      .selectFrom("polls")
      .select([
        "class_id",
        "ballot_visibility",
        "closed_at",
        "closes_at",
        "created_at",
        "description",
        "id",
        "option_count",
        "results_policy",
        "row_version",
        "title",
        // closes_at은 DB에서 마이크로초까지 보관하는데 JS Date는 밀리초까지만 담는다.
        // 커서 비교를 잘라진 값으로 하면 같은 밀리초의 투표를 건너뛰므로 원본 정밀도를
        // 문자열로 따로 읽는다.
        (this.engine === "mariadb"
          ? sql<string>`DATE_FORMAT(COALESCE(closed_at, closes_at), '%Y-%m-%dT%H:%i:%s.%fZ')`
          : sql<string>`to_char(
          COALESCE(closed_at, closes_at) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )`
        ).as("cursor_closes_at"),
      ])
      .where("class_id", "=", actor.classId);

    builder =
      query.scope === "open"
        ? builder
            .where("closed_at", "is", null)
            .where("closes_at", ">", pollDate(now, this.engine))
            .orderBy("closes_at", "asc")
            .orderBy("id", "asc")
        : builder
            .where((eb) =>
              eb.or([
                eb("closed_at", "is not", null),
                eb("closes_at", "<=", pollDate(now, this.engine)),
              ]),
            )
            .orderBy(sql`COALESCE(closed_at, closes_at)`, "desc")
            .orderBy("id", "desc");

    // 비교 방향은 위 정렬 방향과 반드시 같아야 한다. 한쪽만 바꾸면 항목을 건너뛰거나
    // 중복해서 보낸다.
    if (cursor !== undefined) {
      builder =
        query.scope === "open"
          ? builder.where(sql<boolean>`(
              closes_at > ${pollCursorTime(cursor.closesAt, this.engine)}
              OR (closes_at = ${pollCursorTime(cursor.closesAt, this.engine)} AND id > ${pollId(cursor.id, this.engine)})
            )`)
          : builder.where(sql<boolean>`(
              COALESCE(closed_at, closes_at) < ${pollCursorTime(cursor.closesAt, this.engine)}
              OR (COALESCE(closed_at, closes_at) = ${pollCursorTime(cursor.closesAt, this.engine)} AND id < ${pollId(cursor.id, this.engine)})
            )`);
    }

    const rows = (await builder.limit(LIST_LIMIT + 1).execute()) as PollListRow[];
    const pageRows = rows.slice(0, LIST_LIMIT);
    const items = await viewsForPollRows(this.database, pageRows, actor, now, this.engine);
    const last = pageRows.at(-1);
    const nextCursor =
      rows.length > LIST_LIMIT && last !== undefined
        ? encodePollListCursor({
            closesAt: last.cursor_closes_at,
            id: last.id,
            scope: query.scope,
          })
        : null;
    return { items, next_cursor: nextCursor, scope: query.scope, server_now: now.toISOString() };
  }

  async get(query: GetPollQuery): Promise<PollItem> {
    const [actor, now] = await Promise.all([
      this.getActorContext(query.actorUserId),
      this.readDatabaseNow(this.database),
    ]);
    const poll = await this.readPoll(this.database, actor.classId, query.pollId);
    return viewForPollRow(this.database, poll, actor, now, this.engine);
  }

  async participation(query: GetPollParticipationQuery): Promise<PollParticipationResult> {
    const actor = await this.getActorContext(query.actorUserId);
    if (actor.role !== "teacher") {
      throw new PollRoleInsufficientException("이 반의 선생님만 투표 참여 현황을 볼 수 있어요.");
    }
    const poll = await this.readPoll(this.database, actor.classId, query.pollId);
    const baseQuery = this.database
      .selectFrom("class_members as member")
      .innerJoin("users as user", "user.id", "member.user_id")
      .leftJoin("poll_votes as vote", (join) =>
        join.onRef("vote.member_id", "=", "member.id").on("vote.poll_id", "=", poll.id),
      )
      .where("member.class_id", "=", actor.classId)
      .where("member.role", "=", "student")
      .where("member.status", "=", "approved")
      .where("user.is_active", "=", true)
      .where("user.deleted_at", "is", null)
      .$if(this.engine === "mariadb", (query) =>
        query.orderBy(sql`member.student_number IS NULL`, "asc"),
      )
      .orderBy("member.student_number", "asc")
      .orderBy("member.id", "asc");

    const rows =
      poll.ballot_visibility === "teacher_visible"
        ? await baseQuery
            .leftJoin("poll_options as selected_option", "selected_option.id", "vote.option_id")
            .select([
              "member.display_name_in_class",
              "member.id as member_id",
              "member.student_number",
              "selected_option.id as selected_option_id",
              "selected_option.label as selected_option_label",
              "user.display_name",
              "vote.id as vote_id",
            ])
            .execute()
        : await baseQuery
            .select([
              "member.display_name_in_class",
              "member.id as member_id",
              "member.student_number",
              "user.display_name",
              "vote.id as vote_id",
            ])
            .execute();

    const votedStudents: PollParticipantItem[] = [];
    const unvotedStudents: PollParticipantItem[] = [];
    for (const row of rows) {
      const item: PollParticipantItem = {
        display_name: row.display_name_in_class ?? row.display_name,
        member_id: row.member_id,
        student_number: row.student_number,
      };
      if (row.vote_id === null) unvotedStudents.push(item);
      else {
        if (
          poll.ballot_visibility === "teacher_visible" &&
          "selected_option_id" in row &&
          typeof row.selected_option_id === "string" &&
          "selected_option_label" in row &&
          typeof row.selected_option_label === "string"
        ) {
          item.selected_option_id = row.selected_option_id;
          item.selected_option_label = row.selected_option_label;
        }
        votedStudents.push(item);
      }
    }
    return {
      ballot_visibility: poll.ballot_visibility,
      poll_id: poll.id,
      total_students: rows.length,
      unvoted_count: unvotedStudents.length,
      unvoted_students: unvotedStudents,
      voted_count: votedStudents.length,
      voted_students: votedStudents,
    };
  }

  async create(command: CreatePollCommand): Promise<PollItem> {
    if (this.engine === "mariadb") command = { ...command, options: [...command.options] };
    assertUniqueOptions(command.options);
    const preliminary = await this.getActorContext(command.actorUserId);
    if (preliminary.role !== "teacher") {
      throw new PollRoleInsufficientException("이 반의 선생님만 투표를 만들 수 있어요.");
    }

    try {
      const result = await this.idempotency.execute<PollItemJson>(
        {
          actorUserId: command.actorUserId,
          idempotencyKey: command.idempotencyKey as string,
          requestHash: createIdempotencyRequestHash({
            body: {
              ...(command.ballotVisibility === "private"
                ? {}
                : { ballot_visibility: command.ballotVisibility }),
              closes_at: command.closesAt,
              description: command.description,
              options: command.options,
              ...(command.resultsPolicy === "after_vote"
                ? {}
                : { results_policy: command.resultsPolicy }),
              title: command.title,
            },
            effectiveClassId: preliminary.classId,
          }),
          routeKey: createIdempotencyRouteKey(CREATE_ROUTE, preliminary.classId),
        },
        async (transaction) => {
          const actor = await this.lockActorContext(transaction, preliminary, command.actorUserId);
          const now = await this.readDatabaseNow(transaction);
          const closesAt = new Date(command.closesAt);
          const closeDelay = closesAt.getTime() - now.getTime();
          if (
            Number.isNaN(closesAt.getTime()) ||
            closeDelay < MINIMUM_CLOSE_DELAY_MS ||
            closeDelay > MAXIMUM_CLOSE_DELAY_MS
          ) {
            throw new PollDeadlineInvalidException();
          }

          const insertPoll = transaction.insertInto("polls").values({
            ballot_visibility: command.ballotVisibility,
            class_id: actor.classId,
            closes_at: pollDate(closesAt, this.engine),
            created_at: pollDate(now, this.engine),
            created_by_member_id: actor.memberId,
            description: command.description,
            option_count: command.options.length,
            results_policy: command.resultsPolicy,
            title: command.title,
          });
          const created =
            this.engine === "mariadb"
              ? await this.readPoll(
                  transaction,
                  actor.classId,
                  mariaDbInsertId((await insertPoll.executeTakeFirstOrThrow()).insertId),
                )
              : ((await insertPoll.returning(pollProjection).executeTakeFirstOrThrow()) as PollRow);
          const insertOptions = transaction.insertInto("poll_options").values(
            command.options.map((label, index) => ({
              label,
              poll_id: created.id,
              position: index + 1,
            })),
          );
          let createdOptions;
          if (this.engine === "mariadb") {
            try {
              await insertOptions.execute();
            } catch (error) {
              // Auto IDs and fixed distinct positions leave only normalized label identity.
              if (isMariaDbPollDuplicate(error)) throw new PollOptionsDuplicateException();
              throw error;
            }
            createdOptions = await transaction
              .selectFrom("poll_options")
              .select(["id", "label", "position"])
              .where("poll_id", "=", created.id)
              .orderBy("position", "asc")
              .execute();
            if (createdOptions.length !== command.options.length)
              throw new Error("MariaDB poll options could not be verified.");
          } else {
            createdOptions = await insertOptions.returning(["id", "label", "position"]).execute();
          }

          await transaction
            .insertInto("audit_logs")
            .values({
              action: "poll.created",
              actor_display_name_snapshot: actor.displayName,
              actor_member_id: actor.memberId,
              actor_role_snapshot: "teacher",
              actor_user_id: command.actorUserId,
              after_json: pollJson(pollAuditSnapshot(created, 0, null), this.engine),
              before_json: null,
              class_id: actor.classId,
              reason: null,
              request_id: command.requestId,
              target_id: created.id,
              target_snapshot: null,
              target_type: "poll",
            })
            .execute();

          const body: PollItem = {
            ballot_visibility: created.ballot_visibility,
            closed_at: null,
            closes_at: created.closes_at.toISOString(),
            created_at: created.created_at.toISOString(),
            description: created.description,
            has_voted: false,
            id: created.id,
            my_option_id: null,
            options: createdOptions.map((option): PollOptionItem => ({
              id: option.id,
              label: option.label,
              position: option.position,
              vote_count: 0,
            })),
            results_policy: created.results_policy,
            results_visible: true,
            row_version: created.row_version,
            status: "open",
            title: created.title,
            total_vote_count: 0,
          };
          return { body: body as PollItemJson, statusCode: 201 };
        },
      );
      return withPollPolicyDefaults(
        result.body as unknown as PollItem,
        command.ballotVisibility,
        command.resultsPolicy,
      );
    } catch (error) {
      if (
        this.engine === "postgres" &&
        isDatabaseConstraint(error, "poll_options_poll_label_unique")
      ) {
        throw new PollOptionsDuplicateException();
      }
      mapPollIdempotencyError(error);
    }
  }

  async vote(command: VoteInPollCommand): Promise<PollItem> {
    if (this.engine === "mariadb") command = { ...command };
    const preliminary = await this.getActorContext(command.actorUserId);
    if (preliminary.role !== "student") {
      throw new PollRoleInsufficientException("학생만 투표에 참여할 수 있습니다.");
    }
    if (!isPositiveId(command.pollId) || !isPositiveId(command.optionId)) {
      throw new PollNotFoundException();
    }

    try {
      const result = await this.idempotency.execute<PollItemJson>(
        {
          actorUserId: command.actorUserId,
          idempotencyKey: command.idempotencyKey as string,
          requestHash: createIdempotencyRequestHash({
            body: { option_id: command.optionId, poll_id: command.pollId },
            effectiveClassId: preliminary.classId,
          }),
          routeKey: createIdempotencyRouteKey(
            `/polls/${command.pollId}/votes`,
            preliminary.classId,
          ),
        },
        async (transaction) => {
          const actor = await this.lockActorContext(transaction, preliminary, command.actorUserId);
          if (actor.role !== "student") {
            throw new PollRoleInsufficientException("학생만 투표에 참여할 수 있습니다.");
          }
          await this.lockPollMutation(transaction, command.pollId, actor.classId);
          const poll = await this.readPoll(transaction, actor.classId, command.pollId);
          const now = await this.readDatabaseNow(transaction);
          if (poll.closed_at !== null || poll.closes_at.getTime() <= now.getTime()) {
            throw new PollClosedException();
          }

          const option = await transaction
            .selectFrom("poll_options")
            .select("id")
            .where("id", "=", command.optionId)
            .where("poll_id", "=", poll.id)
            .executeTakeFirst();
          if (option === undefined) throw new PollNotFoundException();

          const existing = await transaction
            .selectFrom("poll_votes")
            .select("id")
            .where("poll_id", "=", poll.id)
            .where("member_id", "=", actor.memberId)
            .executeTakeFirst();
          if (existing !== undefined) throw new PollAlreadyVotedException();

          try {
            await transaction
              .insertInto("poll_votes")
              .values({
                class_id: actor.classId,
                member_id: actor.memberId,
                option_id: option.id,
                poll_id: poll.id,
              })
              .execute();
          } catch (error) {
            if (this.engine === "mariadb" && isMariaDbPollDuplicate(error))
              throw new PollAlreadyVotedException();
            throw error;
          }
          const body = await viewForPollRow(transaction, poll, actor, now, this.engine);
          return { body: body as PollItemJson, statusCode: 201 };
        },
      );
      return withPollPolicyDefaults(result.body as unknown as PollItem, "private", "after_vote");
    } catch (error) {
      if (
        this.engine === "postgres" &&
        isDatabaseConstraint(error, "poll_votes_poll_member_unique")
      ) {
        throw new PollAlreadyVotedException();
      }
      mapPollIdempotencyError(error);
    }
  }

  async close(command: ClosePollCommand): Promise<PollItem> {
    const preliminary = await this.getActorContext(command.actorUserId);
    if (preliminary.role !== "teacher") {
      throw new PollRoleInsufficientException("이 반의 선생님만 투표를 종료할 수 있어요.");
    }
    if (!isPositiveId(command.pollId)) throw new PollNotFoundException();
    const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);

    return this.database.transaction().execute(async (transaction) => {
      const actor = await this.lockActorContext(transaction, preliminary, command.actorUserId);
      if (actor.role !== "teacher") {
        throw new PollRoleInsufficientException("이 반의 선생님만 투표를 종료할 수 있어요.");
      }
      // Votes, deletion and closure share this lock: no vote can commit past closure.
      await this.lockPollMutation(transaction, command.pollId, actor.classId);
      const poll = await this.readPoll(transaction, actor.classId, command.pollId);
      if (poll.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(poll.row_version);
      }
      const now = await this.readDatabaseNow(transaction);
      if (poll.closed_at !== null || poll.closes_at.getTime() <= now.getTime()) {
        return viewForPollRow(transaction, poll, actor, now, this.engine);
      }
      const databaseClock =
        this.engine === "mariadb" ? sql<Date>`UTC_TIMESTAMP(6)` : sql<Date>`clock_timestamp()`;
      const update = await transaction
        .updateTable("polls")
        .set({
          closed_at: sql<Date>`LEAST(closes_at, GREATEST(created_at, ${databaseClock}))`,
          row_version: sql<string>`row_version + 1`,
        })
        .where("id", "=", poll.id)
        .where("class_id", "=", actor.classId)
        .where("row_version", "=", expectedRowVersion)
        .where("closed_at", "is", null)
        .executeTakeFirstOrThrow();
      if (update.numUpdatedRows !== 1n) throw new ResourceVersionChangedException(poll.row_version);
      const closed = await this.readPoll(transaction, actor.classId, poll.id);
      const result = await viewForPollRow(transaction, closed, actor, now, this.engine);
      const snapshot = pollAuditSnapshot(poll, result.total_vote_count ?? 0, null);
      await transaction
        .insertInto("audit_logs")
        .values({
          action: "poll.closed",
          actor_display_name_snapshot: actor.displayName,
          actor_member_id: actor.memberId,
          actor_role_snapshot: "teacher",
          actor_user_id: command.actorUserId,
          // Existing allowlisted closes_at records the effective end before and after.
          after_json: pollJson({ ...snapshot, closes_at: result.closed_at }, this.engine),
          before_json: pollJson(snapshot, this.engine),
          class_id: actor.classId,
          reason: "teacher_explicit_close",
          request_id: command.requestId,
          target_id: poll.id,
          target_snapshot: null,
          target_type: "poll",
        })
        .execute();
      return result;
    });
  }

  /** 진행 중 투표 수정(제한형). 검증·쓰기·감사는 poll-edit.ts, 여기서는 권한과 잠금만 잡는다. */
  async update(command: UpdatePollCommand): Promise<PollItem> {
    if (!this.pollEditInstalled) throw new PollEditUnavailableException();
    if (this.engine === "mariadb") command = { ...command, options: [...command.options] };
    assertUniqueOptions(command.options);
    const denied = "이 반의 선생님만 투표를 고칠 수 있어요.";
    const preliminary = await this.getActorContext(command.actorUserId);
    if (preliminary.role !== "teacher") throw new PollRoleInsufficientException(denied);
    if (!isPositiveId(command.pollId)) throw new PollNotFoundException();
    const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);
    return this.database.transaction().execute(async (transaction) => {
      const actor = await this.lockActorContext(transaction, preliminary, command.actorUserId);
      if (actor.role !== "teacher") throw new PollRoleInsufficientException(denied);
      // 투표·마감·삭제와 같은 잠금: 표 수를 센 뒤 선택지를 바꾸는 사이에 표가 끼어들 수 없다.
      await this.lockPollMutation(transaction, command.pollId, actor.classId);
      const poll = await this.readPoll(transaction, actor.classId, command.pollId);
      const now = await this.readDatabaseNow(transaction);
      const limits = {
        maximumCloseDelayMs: MAXIMUM_CLOSE_DELAY_MS,
        minimumCloseDelayMs: MINIMUM_CLOSE_DELAY_MS,
      };
      const edit = { actor, command, engine: this.engine, expectedRowVersion, limits, now, poll };
      const edited = (await applyPollEdit(transaction, edit))
        ? await this.readPoll(transaction, actor.classId, poll.id)
        : poll;
      return viewForPollRow(transaction, edited, actor, now, this.engine);
    });
  }

  async delete(command: DeletePollCommand): Promise<void> {
    const preliminary = await this.getActorContext(command.actorUserId);
    if (preliminary.role !== "teacher") {
      throw new PollRoleInsufficientException("이 반의 선생님만 투표를 삭제할 수 있어요.");
    }
    if (!isPositiveId(command.pollId)) throw new PollNotFoundException();
    const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);

    await this.database.transaction().execute(async (transaction) => {
      const actor = await this.lockActorContext(transaction, preliminary, command.actorUserId);
      await this.lockPollMutation(transaction, command.pollId, actor.classId);
      const poll = await this.readPoll(transaction, actor.classId, command.pollId);
      if (poll.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(poll.row_version);
      }
      const voteCountRow = await transaction
        .selectFrom("poll_votes")
        .select((expression) => expression.fn.count<number>("id").as("vote_count"))
        .where("poll_id", "=", poll.id)
        .executeTakeFirstOrThrow();
      const voteCount = Number(voteCountRow.vote_count);
      const now = await this.readDatabaseNow(transaction);

      await transaction.deleteFrom("poll_votes").where("poll_id", "=", poll.id).execute();
      await transaction.deleteFrom("poll_options").where("poll_id", "=", poll.id).execute();
      const deletion = transaction
        .deleteFrom("polls")
        .where("id", "=", poll.id)
        .where("class_id", "=", actor.classId);
      if (this.engine === "mariadb") {
        if ((await deletion.executeTakeFirstOrThrow()).numDeletedRows !== 1n)
          throw new PollNotFoundException();
      } else if ((await deletion.returning("id").executeTakeFirst()) === undefined)
        throw new PollNotFoundException();

      await transaction
        .insertInto("audit_logs")
        .values({
          action: "poll.deleted",
          actor_display_name_snapshot: actor.displayName,
          actor_member_id: actor.memberId,
          actor_role_snapshot: "teacher",
          actor_user_id: command.actorUserId,
          after_json: pollJson(pollAuditSnapshot(poll, voteCount, now.toISOString()), this.engine),
          before_json: pollJson(pollAuditSnapshot(poll, voteCount, null), this.engine),
          class_id: actor.classId,
          reason: "teacher_explicit_delete",
          request_id: command.requestId,
          target_id: poll.id,
          target_snapshot: null,
          target_type: "poll",
        })
        .execute();
    });
  }

  private async getActorContext(actorUserId: string): Promise<PollActorContext> {
    const raw = await this.database
      .selectFrom("class_members as member")
      .innerJoin("classes as class", "class.id", "member.class_id")
      .innerJoin("users as user", "user.id", "member.user_id")
      .leftJoin("teacher_profiles as profile", "profile.user_id", "member.user_id")
      .select([
        "class.id as class_id",
        "class.status as class_status",
        "member.id as member_id",
        "member.role",
        "profile.status as profile_status",
        "profile.temporary_password_must_change",
        "user.deleted_at",
        "user.display_name",
        "user.is_active",
      ])
      .where("member.user_id", "=", actorUserId)
      .where("member.status", "=", "approved")
      .executeTakeFirst();
    return this.assertActorContext(raw as RawPollActor | undefined);
  }

  private assertActorContext(raw: RawPollActor | undefined): PollActorContext {
    if (
      raw === undefined ||
      !raw.is_active ||
      raw.deleted_at !== null ||
      raw.class_status === "archived"
    ) {
      throw new PollNotFoundException();
    }
    if (raw.class_status === "suspended") throw new PollClassSuspendedException();
    if (raw.class_status !== "active") throw new PollNotFoundException();
    if (raw.role !== "student" && raw.role !== "teacher") {
      throw new PollRoleInsufficientException();
    }
    if (
      raw.role === "teacher" &&
      (raw.profile_status !== "active" || raw.temporary_password_must_change !== false)
    ) {
      throw new PollRoleInsufficientException("이 반의 선생님만 투표를 관리할 수 있어요.");
    }
    return {
      classId: raw.class_id,
      displayName: raw.display_name,
      memberId: raw.member_id,
      role: raw.role,
    };
  }

  private async lockActorContext(
    transaction: Transaction<DB>,
    preliminary: PollActorContext,
    actorUserId: string,
  ): Promise<PollActorContext> {
    const account = await transaction
      .selectFrom("users")
      .select(["deleted_at", "display_name", "is_active"])
      .where("id", "=", actorUserId)
      .forUpdate()
      .executeTakeFirst();
    if (account === undefined || !account.is_active || account.deleted_at !== null) {
      throw new UnauthenticatedException();
    }
    const targetClass = await transaction
      .selectFrom("classes")
      .select(["id", "status"])
      .where("id", "=", preliminary.classId)
      .forUpdate()
      .executeTakeFirst();
    if (targetClass === undefined || targetClass.status === "archived") {
      throw new PollNotFoundException();
    }
    if (targetClass.status === "suspended") throw new PollClassSuspendedException();
    if (targetClass.status !== "active") throw new PollNotFoundException();

    const member = await transaction
      .selectFrom("class_members")
      .select(["id", "role", "status", "user_id"])
      .where("id", "=", preliminary.memberId)
      .where("class_id", "=", targetClass.id)
      .where("user_id", "=", actorUserId)
      .forUpdate()
      .executeTakeFirst();
    if (
      member === undefined ||
      member.status !== "approved" ||
      (member.role !== "student" && member.role !== "teacher")
    ) {
      throw new PollNotFoundException();
    }
    if (member.role === "teacher") {
      const profile = await transaction
        .selectFrom("teacher_profiles")
        .select(["status", "temporary_password_must_change"])
        .where("user_id", "=", actorUserId)
        .$if(this.engine === "mariadb", (query) => query.forUpdate())
        .executeTakeFirst();
      if (
        profile === undefined ||
        profile.status !== "active" ||
        profile.temporary_password_must_change
      ) {
        throw new PollRoleInsufficientException("이 반의 선생님만 투표를 관리할 수 있어요.");
      }
    }
    return {
      classId: targetClass.id,
      displayName: account.display_name,
      memberId: member.id,
      role: member.role,
    };
  }

  private async readPoll(
    executor: DatabaseExecutor,
    classId: string,
    pollId: string,
  ): Promise<PollRow> {
    if (!isPositiveId(pollId)) throw new PollNotFoundException();
    const poll = await executor
      .selectFrom("polls")
      .select([
        "ballot_visibility",
        "class_id",
        "closed_at",
        "closes_at",
        "created_at",
        "description",
        "id",
        "option_count",
        "results_policy",
        "row_version",
        "title",
      ])
      .where("id", "=", pollId)
      .where("class_id", "=", classId)
      .executeTakeFirst();
    if (poll === undefined) throw new PollNotFoundException();
    return poll as PollRow;
  }

  private async readDatabaseNow(executor: DatabaseExecutor): Promise<Date> {
    const clock = await (
      this.engine === "mariadb"
        ? sql<{ now: Date }>`SELECT UTC_TIMESTAMP(6) AS now`
        : sql<{ now: Date }>`SELECT clock_timestamp() AS now`
    ).execute(executor);
    const now = clock.rows[0]?.now;
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("Database clock did not return a valid Date.");
    }
    return now;
  }

  private async lockPollMutation(
    transaction: Transaction<DB>,
    pollId: string,
    classId: string,
  ): Promise<void> {
    if (this.engine === "mariadb") {
      // Existing users/class/member locks precede this row; absent or foreign polls remain 404.
      await transaction
        .selectFrom("polls")
        .select("id")
        .where("id", "=", pollId)
        .where("class_id", "=", classId)
        .forUpdate()
        .execute();
      return;
    }
    await sql`SELECT pg_advisory_xact_lock(${pollId}::bigint)`.execute(transaction);
  }
}
