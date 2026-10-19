import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DB } from "@classhub/db";
import { sql, type Kysely, type Transaction } from "kysely";

import {
  createMariaDbRowCodec,
  mariaDbCount,
  mariaDbDateOnly,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";
import { addCalendarDays } from "../common/date/kst-date.js";
import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { PushOutbox } from "../push-subscriptions/push-outbox.js";
import {
  HelpRequestClassSuspendedException,
  HelpRequestNotFoundException,
  HelpRequestRateLimitedException,
  HelpRequestRoleInsufficientException,
  HelpRequestStateConflictException,
} from "./help-requests.errors.js";
import type {
  CloseHelpRequestCommand,
  CreateHelpRequestCommand,
  HelpRequestItem,
  HelpRequestKind,
  HelpRequestListResult,
  HelpRequestMessage,
  HelpRequestStatus,
  HelpRequestThread,
  ListHelpRequestsQuery,
  ResolveHelpRequestCommand,
  SendHelpMessageCommand,
  StartGeneralHelpCommand,
} from "./help-requests.types.js";

type Engine = "postgres" | "mariadb";

interface Actor {
  userId: string;
  classId: string;
  memberId: string;
  role: "student" | "teacher";
}

interface ReadFilter {
  helpRequestId?: string;
  status: "open" | "all";
  target?: ListHelpRequestsQuery["target"];
}

/** 목록은 처리 중 요청을 훑는 용도라 한 번에 이만큼만 돌려준다(오래된 기록은 잘린다). */
const LIST_LIMIT = 100;
/** 대화 화면은 최근 메시지부터 이만큼만 보여 준다. */
const THREAD_LIMIT = 200;
/*
 * 학생 보내기 제한. 2026-09-27 기본값(1분 5개·하루 50개)이 짧은 메시지를 여러 번 보내는 대화에서
 * 자주 걸린다는 피드백으로 2026-09-28 사용자 요청에 따라 1분 20개·하루 200개로 완화. 자유 대화가 선생님께 쏟아지는
 * 민원 창구가 되지 않게 막는 최소 장치다. 선생님 메시지에는 걸지 않는다.
 */
const STUDENT_MESSAGES_PER_MINUTE = 20;
const STUDENT_MESSAGES_PER_DAY = 200;

const helpRequestsLogger = new Logger("HelpRequests");

const codec = () =>
  createMariaDbRowCodec({
    id: mariaDbId,
    class_id: mariaDbId,
    member_id: mariaDbId,
    target_id: mariaDbNullable(mariaDbId),
    student_number: mariaDbNullable(mariaDbCount),
    created_at: mariaDbDateTime,
    closed_at: mariaDbNullable(mariaDbDateTime),
    last_activity_at: mariaDbDateTime,
    sent: mariaDbCount,
  });

@Injectable()
export class HelpRequestsService {
  private readonly database: ClassHubDatabase;
  private readonly engine: Engine;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) environment?: ConfigService<AppEnvironment, true>,
    // 웹 푸시가 켜져 있을 때만 주입된다.
    @Optional() private readonly pushOutbox?: PushOutbox,
  ) {
    const engine = environment?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Unsupported database engine");
    this.engine = engine;
    this.database = engine === "mariadb" ? database.withPlugin(codec()) : database;
  }

  async list(query: ListHelpRequestsQuery): Promise<HelpRequestListResult> {
    const actor = await this.actor(query.actorUserId);
    return {
      items: await this.read(this.database, actor, {
        status: query.status,
        ...(query.target === undefined ? {} : { target: query.target }),
      }),
    };
  }

  async create(command: CreateHelpRequestCommand): Promise<HelpRequestItem> {
    const actor = await this.actor(command.actorUserId);
    if (actor.role !== "student") {
      throw new HelpRequestRoleInsufficientException("도움 요청은 학생만 보낼 수 있어요.");
    }
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    return this.database.transaction().execute(async (transaction) => {
      await this.lockMutationActor(transaction, actor);
      await this.assertVisibleTarget(transaction, actor, command.target, serverToday);
      const column = command.target.kind === "notice" ? "notice_id" : "supply_id";
      const openRequest = () =>
        transaction
          .selectFrom("help_requests")
          .select("id")
          .where("member_id", "=", actor.memberId)
          .where(column, "=", command.target.id)
          .where("status", "=", "open")
          .executeTakeFirst();
      const duplicate = new HelpRequestStateConflictException(
        "이 안내에 선생님이 아직 확인하지 않은 요청이 있어요. 처리된 뒤에 다시 보낼 수 있어요.",
      );
      if ((await openRequest()) !== undefined) throw duplicate;
      try {
        await transaction
          .insertInto("help_requests")
          .values({
            class_id: actor.classId,
            kind: command.kind,
            member_id: actor.memberId,
            message: command.message,
            [column]: command.target.id,
          })
          .execute();
      } catch (error) {
        // 동시에 두 번 누른 경우 DB 고유 제약이 막는다. 그 경우만 중복으로 안내한다.
        if ((await openRequest().catch(() => undefined)) !== undefined) throw duplicate;
        throw error;
      }
      const created = await openRequest();
      if (created === undefined) throw new Error("Help request write could not be verified.");
      return this.readOne(transaction, actor, created.id);
    });
  }

  async withdraw(command: CloseHelpRequestCommand): Promise<HelpRequestItem> {
    const actor = await this.actor(command.actorUserId);
    if (actor.role !== "student") {
      throw new HelpRequestRoleInsufficientException("요청을 보낸 학생만 철회할 수 있어요.");
    }
    return this.close(actor, command.helpRequestId, "withdrawn", null);
  }

  async resolve(command: ResolveHelpRequestCommand): Promise<HelpRequestItem> {
    const actor = await this.actor(command.actorUserId);
    if (actor.role !== "teacher") {
      throw new HelpRequestRoleInsufficientException("이 반의 선생님만 처리할 수 있어요.");
    }
    return this.close(actor, command.helpRequestId, "resolved", command.reply);
  }

  /** 대화 한 건과 주고받은 말. 학생은 자기 대화만, 담임은 반 전체 대화를 연다. */
  async thread(actorUserId: string, helpRequestId: string): Promise<HelpRequestThread> {
    const actor = await this.actor(actorUserId);
    if (!isPositiveId(helpRequestId)) throw new HelpRequestNotFoundException();
    return this.readThread(this.database, actor, helpRequestId);
  }

  /**
   * 대화에 말을 더한다. 닫힌(resolved) 대화는 다시 열린다. 학생이 철회한 대화에는 보낼 수 없다.
   * 말은 고치거나 지우지 않는다(DB 권한도 SELECT·INSERT뿐).
   */
  async send(command: SendHelpMessageCommand): Promise<HelpRequestThread> {
    const actor = await this.actor(command.actorUserId);
    if (!isPositiveId(command.helpRequestId)) throw new HelpRequestNotFoundException();
    const thread = await this.database.transaction().execute(async (transaction) => {
      // 학생별 순서 잠금 다음 요청 행을 잠근다. 종료·철회가 먼저 끝났다면 최신 상태로 판단하고,
      // 전송이 먼저면 메시지와 재개가 끝날 때까지 종료·철회가 기다리게 한다.
      await this.lockMutationActor(transaction, actor);
      let requestLock = transaction
        .selectFrom("help_requests")
        .select("id")
        .where("id", "=", command.helpRequestId)
        .where("class_id", "=", actor.classId)
        .forUpdate();
      if (actor.role === "student")
        requestLock = requestLock.where("member_id", "=", actor.memberId);
      await requestLock.executeTakeFirst();
      // 보이지 않는 대화(다른 학생·다른 반·지워진 안내)는 존재 여부도 알리지 않는다.
      const request = await this.readOne(transaction, actor, command.helpRequestId);
      if (request.status === "withdrawn") {
        throw new HelpRequestStateConflictException("철회한 요청에는 메시지를 보낼 수 없어요.");
      }
      if (actor.role === "student") {
        await this.assertStudentRate(transaction, actor);
      }
      if (request.status === "resolved") await this.reopen(transaction, actor, request.id);
      await this.insertMessage(transaction, actor, request.id, command.body);
      return this.readThread(transaction, actor, request.id);
    });
    await this.notifyOtherSide(actor, thread.request);
    return thread;
  }

  /** 학생이 글과 무관하게 선생님께 묻는다. 열린 대화가 있으면 거기에 이어 쓴다(학생마다 1개). */
  async startGeneral(command: StartGeneralHelpCommand): Promise<HelpRequestThread> {
    const actor = await this.actor(command.actorUserId);
    if (actor.role !== "student") {
      throw new HelpRequestRoleInsufficientException("선생님께 묻기는 학생만 시작할 수 있어요.");
    }
    const thread = await this.database.transaction().execute(async (transaction) => {
      await this.lockMutationActor(transaction, actor);
      await this.assertStudentRate(transaction, actor);
      const openGeneral = () =>
        transaction
          .selectFrom("help_requests")
          .select("id")
          .where("member_id", "=", actor.memberId)
          .where("kind", "=", "general")
          .where("status", "=", "open")
          .forUpdate()
          .executeTakeFirst();
      let existing = await openGeneral();
      if (existing === undefined) {
        try {
          await transaction
            .insertInto("help_requests")
            .values({ class_id: actor.classId, kind: "general", member_id: actor.memberId })
            .execute();
        } catch (error) {
          // 동시에 두 번 누르면 DB 고유 제약(학생마다 열린 대화 1개)이 막는다. 그때는 그 대화에 잇는다.
          if ((await openGeneral().catch(() => undefined)) === undefined) throw error;
        }
        existing = await openGeneral();
        if (existing === undefined)
          throw new Error("Help conversation write could not be verified.");
      }
      const id = String(existing.id);
      await this.insertMessage(transaction, actor, id, command.body);
      return this.readThread(transaction, actor, id);
    });
    await this.notifyOtherSide(actor, thread.request);
    return thread;
  }

  /** 처리 중(open)일 때만 닫는다. 이미 닫힌 요청을 다시 닫으면 409로 알린다. */
  private async close(
    actor: Actor,
    helpRequestId: string,
    status: Exclude<HelpRequestStatus, "open">,
    reply: string | null,
  ): Promise<HelpRequestItem> {
    if (!isPositiveId(helpRequestId)) throw new HelpRequestNotFoundException();
    return this.database.transaction().execute(async (transaction) => {
      await this.lockMutationActor(transaction, actor);
      let update = transaction
        .updateTable("help_requests")
        .set({ closed_at: this.now(), reply, status })
        .where("id", "=", helpRequestId)
        .where("class_id", "=", actor.classId)
        .where("status", "=", "open");
      if (actor.role === "student") update = update.where("member_id", "=", actor.memberId);
      const result = await update.executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        // 다른 학생의 요청은 존재 여부도 알려 주지 않는다.
        const existing = await this.read(transaction, actor, { helpRequestId, status: "all" });
        if (existing.length === 0) throw new HelpRequestNotFoundException();
        throw new HelpRequestStateConflictException("이미 처리됐거나 철회된 요청이에요.");
      }
      return this.readOne(transaction, actor, helpRequestId);
    });
  }

  private async readThread(
    database: Kysely<DB> | Transaction<DB>,
    actor: Actor,
    helpRequestId: string,
  ): Promise<HelpRequestThread> {
    const request = await this.readOne(database, actor, helpRequestId);
    const db = this.engine === "mariadb" ? database.withPlugin(codec()) : database;
    const rows = await db
      .selectFrom("help_request_messages as message")
      .innerJoin("class_members as author", (join) =>
        join
          .onRef("author.id", "=", "message.author_member_id")
          .onRef("author.class_id", "=", "message.class_id"),
      )
      .select(["message.id", "message.body", "message.created_at", "author.role"])
      .where("message.help_request_id", "=", helpRequestId)
      .where("message.class_id", "=", actor.classId)
      .orderBy("message.id", "desc")
      .limit(THREAD_LIMIT)
      .execute();
    const messages: HelpRequestMessage[] = rows.reverse().map((row) => ({
      author: row.role === "teacher" ? "teacher" : "student",
      body: row.body,
      created_at: new Date(row.created_at).toISOString(),
      id: String(row.id),
    }));
    return { messages, request };
  }

  /** 닫힌 대화를 다시 연다. 같은 안내(또는 선생님께 묻기)에 이미 열린 대화가 있으면 409. */
  private async reopen(transaction: Transaction<DB>, actor: Actor, helpRequestId: string) {
    try {
      await transaction
        .updateTable("help_requests")
        .set({ closed_at: null, status: "open" })
        .where("id", "=", helpRequestId)
        .where("class_id", "=", actor.classId)
        .where("status", "=", "resolved")
        .execute();
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      throw new HelpRequestStateConflictException(
        "같은 안내에 이미 열린 대화가 있어요. 그 대화에 이어서 보내 주세요.",
      );
    }
  }

  private async insertMessage(
    transaction: Transaction<DB>,
    actor: Actor,
    helpRequestId: string,
    body: string,
  ): Promise<void> {
    await transaction
      .insertInto("help_request_messages")
      .values({
        author_member_id: actor.memberId,
        body,
        class_id: actor.classId,
        help_request_id: helpRequestId,
      })
      .execute();
  }

  /**
   * 트랜잭션 밖에서 찾은 소속은 식별에만 쓴다. 관리자·반 종료와 같은 순서로 권한 행을 잠가
   * 추방·비활성화·담임 회수가 먼저 커밋되면 쓰기를 거부하고, 전송이 먼저면 완료까지 기다리게 한다.
   * 사용자·반·담임 권한은 공유 잠금으로 유지하며 갱신하지 않는다. 구성원 행만 배타 잠가
   * 같은 학생의 동시 전송이 이전 개수를 함께 읽어 제한을 넘지 않게 한다.
   */
  private async lockMutationActor(transaction: Transaction<DB>, actor: Actor): Promise<void> {
    const sharedLock = this.engine === "mariadb" ? sql`LOCK IN SHARE MODE` : sql`FOR SHARE`;
    const account = await transaction
      .selectFrom("users")
      .select(["is_active", "deleted_at"])
      .where("id", "=", actor.userId)
      .modifyEnd(sharedLock)
      .executeTakeFirst();
    if (!account?.is_active || account.deleted_at !== null)
      throw new HelpRequestNotFoundException();
    const targetClass = await transaction
      .selectFrom("classes")
      .select("status")
      .where("id", "=", actor.classId)
      .modifyEnd(sharedLock)
      .executeTakeFirst();
    if (targetClass?.status === "suspended") throw new HelpRequestClassSuspendedException();
    if (targetClass?.status !== "active") throw new HelpRequestNotFoundException();
    const member = await transaction
      .selectFrom("class_members")
      .select(["role", "status"])
      .where("id", "=", actor.memberId)
      .where("class_id", "=", actor.classId)
      .where("user_id", "=", actor.userId)
      .forUpdate()
      .executeTakeFirst();
    if (member?.status !== "approved" || member.role !== actor.role)
      throw new HelpRequestNotFoundException();
    if (actor.role === "teacher") {
      const profile = await transaction
        .selectFrom("teacher_profiles")
        .select(["status", "temporary_password_must_change"])
        .where("user_id", "=", actor.userId)
        .modifyEnd(sharedLock)
        .executeTakeFirst();
      if (profile?.status !== "active" || Boolean(profile.temporary_password_must_change))
        throw new HelpRequestRoleInsufficientException("이 반의 선생님만 처리할 수 있어요.");
    }
  }

  private async assertStudentRate(transaction: Transaction<DB>, actor: Actor): Promise<void> {
    const db = this.engine === "mariadb" ? transaction.withPlugin(codec()) : transaction;
    const sentSince = async (seconds: number) =>
      Number(
        (
          await db
            .selectFrom("help_request_messages")
            .select((eb) => eb.fn.countAll().as("sent"))
            .where("author_member_id", "=", actor.memberId)
            .where("class_id", "=", actor.classId)
            .where("created_at", ">=", this.secondsAgo(seconds))
            .executeTakeFirstOrThrow()
        ).sent,
      );
    if ((await sentSince(60)) >= STUDENT_MESSAGES_PER_MINUTE) {
      throw new HelpRequestRateLimitedException(
        "조금 천천히 보내 주세요. 1분 뒤에 다시 보낼 수 있어요.",
      );
    }
    if ((await sentSince(24 * 60 * 60)) >= STUDENT_MESSAGES_PER_DAY) {
      throw new HelpRequestRateLimitedException("오늘은 더 보낼 수 없어요. 내일 다시 보내 주세요.");
    }
  }

  /**
   * 선생님이 답장하면 학생에게 알린다(수업·밤 시간은 대기열이 보류). 알림에는 메시지 내용이나
   * 이름을 넣지 않는다 — 푸시 서비스(외부)로 학생 사정이 나가지 않게 하려는 것이다.
   * 학생이 보낸 메시지는 선생님께 알리지 않는다(2026-09-27 사용자 결정: 밤·주말 알림 부담 없이
   * 홈의 도움 요청 칸·목록으로 확인 — 교권 보호).
   */
  private async notifyOtherSide(actor: Actor, request: HelpRequestItem): Promise<void> {
    if (!this.pushOutbox || actor.role !== "teacher") return;
    try {
      const recipients = await this.database
        .selectFrom("help_requests as request")
        .innerJoin("class_members as member", (join) =>
          join
            .onRef("member.id", "=", "request.member_id")
            .onRef("member.class_id", "=", "request.class_id"),
        )
        .select("member.user_id")
        .where("request.id", "=", request.id)
        .where("request.class_id", "=", actor.classId)
        .where("member.status", "=", "approved")
        .execute();
      await this.pushOutbox.enqueue(
        recipients.flatMap(({ user_id: userId }) =>
          userId === null
            ? []
            : [
                {
                  body: "선생님이 답장을 보냈어요.",
                  classId: actor.classId,
                  kind: "help_message" as const,
                  path: `/help-requests/${request.id}`,
                  tag: `help:${request.id}`,
                  title: "선생님 답장",
                  userId: String(userId),
                },
              ],
        ),
      );
    } catch {
      // 알림 대기열 실패가 이미 저장된 메시지를 실패로 만들지 않게 한다.
      helpRequestsLogger.warn({ failure_code: "push_enqueue_failed" });
    }
  }

  private async readOne(
    database: Kysely<DB> | Transaction<DB>,
    actor: Actor,
    helpRequestId: string,
  ): Promise<HelpRequestItem> {
    const [item] = await this.read(database, actor, { helpRequestId, status: "all" });
    if (item === undefined) throw new HelpRequestNotFoundException();
    return item;
  }

  private async read(
    database: Kysely<DB> | Transaction<DB>,
    actor: Actor,
    filter: ReadFilter,
  ): Promise<HelpRequestItem[]> {
    const db = this.engine === "mariadb" ? database.withPlugin(codec()) : database;
    let query = db
      .selectFrom("help_requests as request")
      .innerJoin("class_members as member", (join) =>
        join
          .onRef("member.id", "=", "request.member_id")
          .onRef("member.class_id", "=", "request.class_id"),
      )
      .innerJoin("users as account", "account.id", "member.user_id")
      .leftJoin("notices as notice", (join) =>
        join
          .onRef("notice.id", "=", "request.notice_id")
          .onRef("notice.class_id", "=", "request.class_id"),
      )
      .leftJoin("supplies as supply", (join) =>
        join
          .onRef("supply.id", "=", "request.supply_id")
          .onRef("supply.class_id", "=", "request.class_id"),
      )
      .select([
        "request.id",
        "request.kind",
        "request.message",
        "request.status",
        "request.reply",
        "request.created_at",
        "request.closed_at",
        "request.member_id",
        "member.display_name_in_class",
        "account.display_name as account_display_name",
        "member.student_number",
        sql<string | null>`COALESCE(request.notice_id, request.supply_id)`.as("target_id"),
        sql<"notice" | "supply" | null>`CASE
          WHEN request.notice_id IS NOT NULL THEN 'notice'
          WHEN request.supply_id IS NOT NULL THEN 'supply'
          ELSE NULL END`.as("target_kind"),
        sql<string | null>`COALESCE(notice.title, supply.title)`.as("target_title"),
        sql<Date>`COALESCE((SELECT MAX(latest.created_at) FROM help_request_messages AS latest
          WHERE latest.help_request_id = request.id), request.created_at)`.as("last_activity_at"),
      ])
      .where("request.class_id", "=", actor.classId)
      // 지워진 안내에 딸린 요청은 더 처리할 수 없으므로 보여 주지 않는다. 글과 무관한 대화는 늘 보인다.
      .where(
        sql<boolean>`((request.notice_id IS NOT NULL AND notice.deleted_at IS NULL)
          OR (request.supply_id IS NOT NULL AND supply.deleted_at IS NULL)
          OR (request.notice_id IS NULL AND request.supply_id IS NULL))`,
      );
    if (actor.role === "student") query = query.where("request.member_id", "=", actor.memberId);
    if (filter.status === "open") query = query.where("request.status", "=", "open");
    if (filter.helpRequestId !== undefined)
      query = query.where("request.id", "=", filter.helpRequestId);
    if (filter.target !== undefined)
      query = query.where(
        filter.target.kind === "notice" ? "request.notice_id" : "request.supply_id",
        "=",
        filter.target.id,
      );
    // 최근에 말이 오간 대화가 위로 온다(대화가 없으면 요청 시각).
    const rows = await query
      .orderBy("last_activity_at", "desc")
      .orderBy("request.id", "desc")
      .limit(LIST_LIMIT)
      .execute();
    return rows.map((row) => ({
      closed_at: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
      created_at: new Date(row.created_at).toISOString(),
      id: String(row.id),
      kind: row.kind as HelpRequestKind,
      last_activity_at: new Date(row.last_activity_at).toISOString(),
      message: row.message,
      reply: row.reply,
      status: row.status as HelpRequestStatus,
      student:
        actor.role === "teacher"
          ? {
              display_name: row.display_name_in_class ?? row.account_display_name,
              member_id: String(row.member_id),
              student_number: row.student_number === null ? null : Number(row.student_number),
            }
          : null,
      target:
        row.target_id === null || row.target_kind === null
          ? null
          : { id: String(row.target_id), kind: row.target_kind, title: row.target_title ?? "" },
    }));
  }

  /** 학생은 공지·준비물 화면에서 자기에게 보이는 안내에만 요청할 수 있다(같은 공개 규칙). */
  private async assertVisibleTarget(
    transaction: Transaction<DB>,
    actor: Actor,
    target: CreateHelpRequestCommand["target"],
    serverToday: string,
  ): Promise<void> {
    const memberId =
      this.engine === "mariadb"
        ? sql<string>`CAST(${mariaDbId(actor.memberId)} AS SIGNED)`
        : sql<string>`${actor.memberId}::bigint`;
    const visible =
      target.kind === "notice"
        ? await transaction
            .selectFrom("notices as notice")
            .select("notice.id")
            .where("notice.id", "=", target.id)
            .where("notice.class_id", "=", actor.classId)
            .where("notice.deleted_at", "is", null)
            .where("notice.published_at", "<=", this.now())
            .where(
              sql<boolean>`(notice.audience_mode = 'legacy_class' OR EXISTS (
                SELECT 1 FROM notice_recipients AS recipient
                WHERE recipient.notice_id = notice.id AND recipient.class_id = notice.class_id
                  AND recipient.member_id = ${memberId}))`,
            )
            .executeTakeFirst()
        : await transaction
            .selectFrom("supplies as supply")
            .select("supply.id")
            .where("supply.id", "=", target.id)
            .where("supply.class_id", "=", actor.classId)
            .where("supply.deleted_at", "is", null)
            .where("supply.needed_on", ">=", this.date(addCalendarDays(serverToday, -90)))
            .where(
              sql<boolean>`(supply.audience_mode = 'legacy_class' OR EXISTS (
                SELECT 1 FROM supply_recipients AS recipient
                WHERE recipient.supply_id = supply.id AND recipient.class_id = supply.class_id
                  AND recipient.member_id = ${memberId}))`,
            )
            .executeTakeFirst();
    if (visible === undefined) throw new HelpRequestNotFoundException();
  }

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
    if (current === undefined || current.class_status === "archived") {
      throw new HelpRequestNotFoundException();
    }
    if (current.class_status === "suspended") throw new HelpRequestClassSuspendedException();
    if (current.class_status !== "active") throw new HelpRequestNotFoundException();
    if (current.role === "student") {
      return {
        classId: String(current.class_id),
        memberId: String(current.member_id),
        role: "student",
        userId: actorUserId,
      };
    }
    if (
      current.role !== "teacher" ||
      current.profile_status !== "active" ||
      Boolean(current.temporary_password_must_change)
    ) {
      throw new HelpRequestRoleInsufficientException("이 반의 선생님만 처리할 수 있어요.");
    }
    return {
      classId: String(current.class_id),
      memberId: String(current.member_id),
      role: "teacher",
      userId: actorUserId,
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

  private date(value: string) {
    return this.engine === "mariadb"
      ? sql<Date>`CAST(${mariaDbDateOnly(value)} AS DATE)`
      : sql<Date>`${value}::date`;
  }
}

/** MariaDB ER_DUP_ENTRY(1062) · PostgreSQL unique_violation(23505). */
function isDuplicateKey(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown } | null;
  return (
    candidate?.errno === 1062 || candidate?.code === "ER_DUP_ENTRY" || candidate?.code === "23505"
  );
}

function isPositiveId(value: string): boolean {
  return /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}
