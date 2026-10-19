import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DB } from "@classhub/db";
import { sql, type Kysely, type Transaction } from "kysely";

import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbCount,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  ClassChatClassSuspendedException,
  ClassChatConflictException,
  ClassChatNotFoundException,
  ClassChatRateLimitedException,
  ClassChatRoleInsufficientException,
  ClassChatSendBlockedException,
} from "./class-chat.errors.js";
import type {
  ClassChatAuthor,
  ClassChatBlockedReason,
  ClassChatMessage,
  ClassChatMuteDuration,
  ClassChatReport,
  ClassChatRole,
  ClassChatState,
} from "./class-chat.types.js";

type Engine = "postgres" | "mariadb";
type Executor = Kysely<DB> | Transaction<DB>;

interface Actor {
  classId: string;
  memberId: string;
  role: ClassChatRole;
}

/** 처음 열 때·after 없이 부를 때 보여 주는 최근 메시지 수 */
const RECENT_LIMIT = 100;
/** after로 이어 받을 때 한 번에 돌려주는 최대 수 */
const AFTER_LIMIT = 200;
/*
 * 학생 보내기 제한(설계 planning/class-chat-20260928). 여러 명이 함께 쓰는 방이라 1:1 도움 대화(1분 20개)보다
 * 낮게 두어 도배를 막는다. 담임에게는 걸지 않는다.
 */
const STUDENT_MESSAGES_PER_MINUTE = 10;
const STUDENT_MESSAGES_PER_DAY = 300;
/** 학생 보내기가 저절로 잠기는 밤 시간(한국 시각). 담임은 보낼 수 있다. */
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 7;

const codec = () =>
  createMariaDbRowCodec({
    id: mariaDbId,
    class_id: mariaDbId,
    member_id: mariaDbId,
    author_member_id: mariaDbId,
    reporter_member_id: mariaDbId,
    message_id: mariaDbId,
    student_number: mariaDbNullable(mariaDbCount),
    reporter_student_number: mariaDbNullable(mariaDbCount),
    created_at: mariaDbDateTime,
    message_created_at: mariaDbDateTime,
    hidden_at: mariaDbNullable(mariaDbDateTime),
    muted_until: mariaDbDateTime,
    is_open: mariaDbBoolean,
    sent: mariaDbCount,
    open_reports: mariaDbCount,
  });

function kstHour(now: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: "Asia/Seoul",
    }).format(now),
  );
}

/** 한국 시각으로 오늘 자정(다음 날 0시)의 UTC 시각 */
function endOfKstDay(now: Date): Date {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1) - 9 * 60 * 60 * 1000,
  );
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

@Injectable()
export class ClassChatService {
  private readonly database: ClassHubDatabase;
  private readonly engine: Engine;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) environment?: ConfigService<AppEnvironment, true>,
    /** 검사에서 밤 잠금 시각만 고정할 때 쓴다(멈춤 끝 시각은 DB와 같은 실제 시각으로 잰다). */
    @Optional() @Inject("CLASS_CHAT_CLOCK") private readonly clock?: () => Date,
  ) {
    const engine = environment?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Unsupported database engine");
    this.engine = engine;
    this.database = engine === "mariadb" ? database.withPlugin(codec()) : database;
  }

  async state(actorUserId: string, after?: string): Promise<ClassChatState> {
    const actor = await this.actor(actorUserId);
    return this.stateFor(actor, after);
  }

  async send(actorUserId: string, body: string): Promise<ClassChatState> {
    const actor = await this.actor(actorUserId);
    if (actor.role === "teacher") {
      await this.insertMessage(this.database, actor, body);
      return this.stateFor(actor);
    }
    /*
     * 확인과 저장이 따로라 같은 학생이 동시에 보낸 25개가 모두 같은 이전 개수를 보고 저장됐다
     * (2026-10-05 Codex 총검수 F01). 그 학생의 구성원 행만 잠근 한 트랜잭션 안에서 소속·방·음소거·
     * 개수를 다시 보고 저장한다. 다른 학생·담임은 기다리지 않는다.
     */
    await this.database.transaction().execute(async (transaction) => {
      const member = await transaction
        .selectFrom("class_members")
        .select("id")
        .where("id", "=", actor.memberId)
        .where("class_id", "=", actor.classId)
        .where("status", "=", "approved")
        .forUpdate()
        .executeTakeFirst();
      if (member === undefined) throw new ClassChatNotFoundException();
      const blocked = await this.blockedReason(actor, undefined, undefined, transaction);
      if (blocked === "closed")
        throw new ClassChatSendBlockedException("선생님이 대화방을 열면 보낼 수 있어요.");
      if (blocked === "night")
        throw new ClassChatSendBlockedException("밤 10시부터 아침 7시까지는 보낼 수 없어요.");
      if (blocked === "muted")
        throw new ClassChatSendBlockedException("선생님이 잠시 말하기를 멈춰 두었어요.");
      await this.assertStudentRate(actor, transaction);
      await this.insertMessage(transaction, actor, body);
    });
    return this.stateFor(actor);
  }

  private async insertMessage(db: Executor, actor: Actor, body: string): Promise<void> {
    await db
      .insertInto("class_chat_messages")
      .values({ author_member_id: actor.memberId, body, class_id: actor.classId })
      .execute();
  }

  async hide(actorUserId: string, messageId: string): Promise<ClassChatState> {
    const actor = await this.teacher(actorUserId);
    const result = await this.database
      .updateTable("class_chat_messages")
      .set({ hidden_at: this.now(), hidden_by_member_id: actor.memberId })
      .where("id", "=", messageId)
      .where("class_id", "=", actor.classId)
      .where("hidden_at", "is", null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      const exists = await this.database
        .selectFrom("class_chat_messages")
        .select("id")
        .where("id", "=", messageId)
        .where("class_id", "=", actor.classId)
        .executeTakeFirst();
      if (exists === undefined) throw new ClassChatNotFoundException();
    }
    return this.stateFor(actor);
  }

  async report(actorUserId: string, messageId: string, reason: string): Promise<void> {
    const actor = await this.actor(actorUserId);
    const message = await this.database
      .selectFrom("class_chat_messages")
      .select("id")
      .where("id", "=", messageId)
      .where("class_id", "=", actor.classId)
      .executeTakeFirst();
    if (message === undefined) throw new ClassChatNotFoundException();
    try {
      await this.database
        .insertInto("class_chat_reports")
        .values({
          class_id: actor.classId,
          message_id: messageId,
          reason,
          reporter_member_id: actor.memberId,
        })
        .execute();
    } catch (error) {
      if (isDuplicateKey(error)) throw new ClassChatConflictException("이미 신고한 메시지예요.");
      throw error;
    }
  }

  async reports(actorUserId: string): Promise<ClassChatReport[]> {
    const actor = await this.teacher(actorUserId);
    const rows = await this.database
      .selectFrom("class_chat_reports as report")
      .innerJoin("class_chat_messages as message", "message.id", "report.message_id")
      .innerJoin("class_members as author", "author.id", "message.author_member_id")
      .innerJoin("users as author_account", "author_account.id", "author.user_id")
      .innerJoin("class_members as reporter", "reporter.id", "report.reporter_member_id")
      .innerJoin("users as reporter_account", "reporter_account.id", "reporter.user_id")
      .select([
        "report.id",
        "report.reason",
        "report.created_at",
        "message.id as message_id",
        "message.body",
        "message.hidden_at",
        "message.created_at as message_created_at",
        "author.id as author_member_id",
        "author.role as author_role",
        "author.student_number",
        sql<string>`COALESCE(author.display_name_in_class, author_account.display_name)`.as(
          "author_name",
        ),
        "reporter.id as reporter_member_id",
        "reporter.role as reporter_role",
        "reporter.student_number as reporter_student_number",
        sql<string>`COALESCE(reporter.display_name_in_class, reporter_account.display_name)`.as(
          "reporter_name",
        ),
      ])
      .where("report.class_id", "=", actor.classId)
      .where("report.resolved_at", "is", null)
      .orderBy("report.id", "desc")
      .limit(100)
      .execute();
    return rows.map((row) => ({
      id: String(row.id),
      reason: row.reason,
      created_at: toIso(row.created_at),
      reporter: {
        member_id: String(row.reporter_member_id),
        name: row.reporter_name,
        role: row.reporter_role === "teacher" ? "teacher" : "student",
        student_number: row.reporter_student_number ?? null,
      },
      message: {
        id: String(row.message_id),
        author: {
          member_id: String(row.author_member_id),
          name: row.author_name,
          role: row.author_role === "teacher" ? "teacher" : "student",
          student_number: row.student_number ?? null,
        },
        body: row.body,
        hidden: row.hidden_at !== null,
        created_at: toIso(row.message_created_at),
        mine: String(row.author_member_id) === actor.memberId,
      },
    }));
  }

  async resolveReport(actorUserId: string, reportId: string): Promise<void> {
    const actor = await this.teacher(actorUserId);
    const result = await this.database
      .updateTable("class_chat_reports")
      .set({ resolved_at: this.now(), resolved_by_member_id: actor.memberId })
      .where("id", "=", reportId)
      .where("class_id", "=", actor.classId)
      .where("resolved_at", "is", null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0)
      throw new ClassChatNotFoundException("신고를 찾을 수 없어요.");
  }

  async setRoom(actorUserId: string, isOpen: boolean): Promise<ClassChatState> {
    const actor = await this.teacher(actorUserId);
    const updated = await this.database
      .updateTable("class_chat_rooms")
      .set({ is_open: isOpen, updated_at: this.now(), updated_by_member_id: actor.memberId })
      .where("class_id", "=", actor.classId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      try {
        await this.database
          .insertInto("class_chat_rooms")
          .values({
            class_id: actor.classId,
            is_open: isOpen,
            updated_by_member_id: actor.memberId,
          })
          .execute();
      } catch (error) {
        // 동시에 두 번 눌러 다른 요청이 먼저 만들었다면 그 줄을 고친다.
        if (!isDuplicateKey(error)) throw error;
        await this.database
          .updateTable("class_chat_rooms")
          .set({ is_open: isOpen, updated_at: this.now(), updated_by_member_id: actor.memberId })
          .where("class_id", "=", actor.classId)
          .execute();
      }
    }
    return this.stateFor(actor);
  }

  async mute(
    actorUserId: string,
    memberId: string,
    duration: ClassChatMuteDuration,
  ): Promise<void> {
    const actor = await this.teacher(actorUserId);
    await this.assertStudentMember(actor, memberId);
    const now = new Date();
    const until =
      duration === "10m"
        ? new Date(now.getTime() + 10 * 60 * 1000)
        : duration === "1h"
          ? new Date(now.getTime() + 60 * 60 * 1000)
          : endOfKstDay(now);
    const values = { created_by_member_id: actor.memberId, muted_until: until };
    const updated = await this.database
      .updateTable("class_chat_mutes")
      .set({ ...values, created_at: this.now() })
      .where("class_id", "=", actor.classId)
      .where("member_id", "=", memberId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      try {
        await this.database
          .insertInto("class_chat_mutes")
          .values({ ...values, class_id: actor.classId, member_id: memberId })
          .execute();
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        await this.database
          .updateTable("class_chat_mutes")
          .set(values)
          .where("class_id", "=", actor.classId)
          .where("member_id", "=", memberId)
          .execute();
      }
    }
  }

  async unmute(actorUserId: string, memberId: string): Promise<void> {
    const actor = await this.teacher(actorUserId);
    await this.assertStudentMember(actor, memberId);
    await this.database
      .deleteFrom("class_chat_mutes")
      .where("class_id", "=", actor.classId)
      .where("member_id", "=", memberId)
      .execute();
  }

  private async stateFor(actor: Actor, after?: string): Promise<ClassChatState> {
    const room = await this.database
      .selectFrom("class_chat_rooms")
      .select("is_open")
      .where("class_id", "=", actor.classId)
      .executeTakeFirst();
    const mute = await this.activeMute(actor);
    const blocked =
      actor.role === "student"
        ? await this.blockedReason(actor, room?.is_open ?? false, mute)
        : null;
    const base = this.database
      .selectFrom("class_chat_messages as message")
      .innerJoin("class_members as author", "author.id", "message.author_member_id")
      .innerJoin("users as account", "account.id", "author.user_id")
      .select([
        "message.id",
        "message.body",
        "message.created_at",
        "message.hidden_at",
        "author.id as author_member_id",
        "author.role as author_role",
        "author.student_number",
        sql<string>`COALESCE(author.display_name_in_class, account.display_name)`.as("author_name"),
      ])
      .where("message.class_id", "=", actor.classId);
    const rows =
      after === undefined
        ? (
            await base
              .orderBy("message.id", "desc")
              .limit(RECENT_LIMIT + 1)
              .execute()
          ).reverse()
        : await base
            .where("message.id", ">", after)
            .orderBy("message.id", "asc")
            .limit(AFTER_LIMIT)
            .execute();
    const hasMoreBefore = after === undefined && rows.length > RECENT_LIMIT;
    const visible = hasMoreBefore ? rows.slice(1) : rows;
    let openReportCount: number | null = null;
    if (actor.role === "teacher") {
      const count = await this.database
        .selectFrom("class_chat_reports")
        .select((eb) => eb.fn.countAll().as("open_reports"))
        .where("class_id", "=", actor.classId)
        .where("resolved_at", "is", null)
        .executeTakeFirstOrThrow();
      openReportCount = Number(count.open_reports);
    }
    return {
      room: { is_open: room?.is_open ?? false },
      me: {
        member_id: actor.memberId,
        role: actor.role,
        can_send: blocked === null,
        blocked_reason: blocked,
        muted_until: mute === null ? null : toIso(mute),
      },
      messages: visible.map((row) => this.message(actor, row)),
      has_more_before: hasMoreBefore,
      open_report_count: openReportCount,
    };
  }

  private message(
    actor: Actor,
    row: {
      id: unknown;
      body: string;
      created_at: Date | string;
      hidden_at: Date | string | null;
      author_member_id: unknown;
      author_role: string;
      student_number: number | null;
      author_name: string;
    },
  ): ClassChatMessage {
    const hidden = row.hidden_at !== null;
    const author: ClassChatAuthor = {
      member_id: String(row.author_member_id),
      name: row.author_name,
      role: row.author_role === "teacher" ? "teacher" : "student",
      student_number: row.student_number ?? null,
    };
    return {
      id: String(row.id),
      author,
      // 담임이 가린 말은 학생에게 내용을 보내지 않는다(화면에서 숨기는 것만으로는 부족).
      body: hidden && actor.role !== "teacher" ? null : row.body,
      hidden,
      created_at: toIso(row.created_at),
      mine: author.member_id === actor.memberId,
    };
  }

  private async activeMute(actor: Actor, db: Executor = this.database): Promise<Date | null> {
    const row = await db
      .selectFrom("class_chat_mutes")
      .select("muted_until")
      .where("class_id", "=", actor.classId)
      .where("member_id", "=", actor.memberId)
      .where("muted_until", ">", this.now())
      .executeTakeFirst();
    return row === undefined ? null : new Date(row.muted_until);
  }

  private async blockedReason(
    actor: Actor,
    isOpen?: boolean,
    mute?: Date | null,
    db: Executor = this.database,
  ): Promise<ClassChatBlockedReason | null> {
    if (actor.role === "teacher") return null;
    const open =
      isOpen ??
      (
        await db
          .selectFrom("class_chat_rooms")
          .select("is_open")
          .where("class_id", "=", actor.classId)
          .executeTakeFirst()
      )?.is_open ??
      false;
    if (!open) return "closed";
    const hour = kstHour(this.clock?.() ?? new Date());
    if (hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR) return "night";
    if ((mute === undefined ? await this.activeMute(actor, db) : mute) !== null) return "muted";
    return null;
  }

  private async assertStudentRate(actor: Actor, db: Executor): Promise<void> {
    const sentSince = async (seconds: number) =>
      Number(
        (
          await db
            .selectFrom("class_chat_messages")
            .select((eb) => eb.fn.countAll().as("sent"))
            .where("author_member_id", "=", actor.memberId)
            .where("class_id", "=", actor.classId)
            .where("created_at", ">=", this.secondsAgo(seconds))
            .executeTakeFirstOrThrow()
        ).sent,
      );
    if ((await sentSince(60)) >= STUDENT_MESSAGES_PER_MINUTE)
      throw new ClassChatRateLimitedException(
        "조금 천천히 보내 주세요. 1분 뒤에 다시 보낼 수 있어요.",
      );
    if ((await sentSince(24 * 60 * 60)) >= STUDENT_MESSAGES_PER_DAY)
      throw new ClassChatRateLimitedException("오늘은 더 보낼 수 없어요. 내일 다시 보내 주세요.");
  }

  private async assertStudentMember(actor: Actor, memberId: string): Promise<void> {
    const member = await this.database
      .selectFrom("class_members")
      .select("id")
      .where("id", "=", memberId)
      .where("class_id", "=", actor.classId)
      .where("role", "=", "student")
      .where("status", "=", "approved")
      .executeTakeFirst();
    if (member === undefined)
      throw new ClassChatNotFoundException("이 반의 학생을 찾을 수 없어요.");
  }

  private async teacher(actorUserId: string): Promise<Actor> {
    const actor = await this.actor(actorUserId);
    if (actor.role !== "teacher") throw new ClassChatRoleInsufficientException();
    return actor;
  }

  /** 반의 승인된 구성원만. 담임은 활성 교사 계정이어야 한다(도움 대화와 같은 규칙). */
  private async actor(actorUserId: string): Promise<Actor> {
    const current = await this.database
      .selectFrom("class_members as member")
      .innerJoin("classes as class", "class.id", "member.class_id")
      .leftJoin("teacher_profiles as profile", "profile.user_id", "member.user_id")
      .select([
        "class.id as class_id",
        "class.status as class_status",
        "member.id as member_id",
        "member.role",
        "profile.status as profile_status",
        "profile.temporary_password_must_change",
      ])
      .where("member.user_id", "=", actorUserId)
      .where("member.status", "=", "approved")
      .executeTakeFirst();
    if (current === undefined || current.class_status === "archived")
      throw new ClassChatNotFoundException();
    if (current.class_status === "suspended") throw new ClassChatClassSuspendedException();
    if (current.class_status !== "active") throw new ClassChatNotFoundException();
    if (current.role === "student")
      return {
        classId: String(current.class_id),
        memberId: String(current.member_id),
        role: "student",
      };
    if (
      current.role !== "teacher" ||
      current.profile_status !== "active" ||
      Boolean(current.temporary_password_must_change)
    )
      throw new ClassChatRoleInsufficientException();
    return {
      classId: String(current.class_id),
      memberId: String(current.member_id),
      role: "teacher",
    };
  }

  private now() {
    return this.engine === "mariadb" ? sql<Date>`UTC_TIMESTAMP(6)` : sql<Date>`clock_timestamp()`;
  }

  private secondsAgo(seconds: number) {
    return this.engine === "mariadb"
      ? sql<Date>`UTC_TIMESTAMP(6) - INTERVAL ${sql.lit(seconds)} SECOND`
      : sql<Date>`clock_timestamp() - ${sql.lit(seconds)} * INTERVAL '1 second'`;
  }
}

function isDuplicateKey(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  return code === "23505" || code === "ER_DUP_ENTRY" || errno === 1062;
}
