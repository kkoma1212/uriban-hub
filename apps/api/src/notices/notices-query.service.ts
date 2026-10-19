import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type RawBuilder } from "kysely";

import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import type { AppEnvironment } from "../config/environment.js";
import { noticeDatabaseEngine, noticeMariaDbRowCodec } from "./notices.database.js";
import { readMariaDbNoticeConfirmations } from "./notices-confirmations.mariadb.js";
import { normalizeSearchTerm, toIlikePattern } from "../common/validation/search-term.js";
import { ContentAudiencesService } from "../content-audiences/content-audiences.service.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { NoticesAccessService } from "./notices-access.service.js";
import {
  decodeNoticeConfirmationsCursor,
  decodeNoticeListCursor,
  encodeNoticeConfirmationsCursor,
  encodeNoticeListCursor,
  type NoticeConfirmationsCursor,
} from "./notices.cursor.js";
import { NoticeNotFoundException, NoticeRoleInsufficientException } from "./notices.errors.js";
import type {
  GetNoticeQuery,
  ListNoticeConfirmationsQuery,
  ListNoticeConfirmationsResult,
  ListNoticesQuery,
  ListNoticesResult,
  NoticeConfirmationFilter,
  NoticeItem,
} from "./notices.types.js";
import { noticeConfirmationState, noticeItemView } from "./notices.view.js";

const PAGE_SIZE = 20;

function confirmationStatePredicate(
  state: NoticeConfirmationFilter,
  contentRevision: string,
): RawBuilder<boolean> {
  if (state === "unread") return sql<boolean>`notice_read.id IS NULL`;
  if (state === "confirmed") {
    return sql<boolean>`notice_read.confirmed_revision = ${contentRevision}::bigint`;
  }
  return sql<boolean>`notice_read.confirmed_revision < ${contentRevision}::bigint`;
}

function confirmationsCursorPredicate(
  cursor: NoticeConfirmationsCursor,
  displayName: RawBuilder<string>,
): RawBuilder<boolean> {
  if (cursor.studentNumber === null) {
    return sql<boolean>`(
      member.student_number IS NULL
      AND (
        ${displayName} > ${cursor.displayName}
        OR (${displayName} = ${cursor.displayName} AND member.id > ${cursor.memberId}::bigint)
      )
    )`;
  }
  return sql<boolean>`(
    member.student_number > ${cursor.studentNumber}
    OR member.student_number IS NULL
    OR (
      member.student_number = ${cursor.studentNumber}
      AND (
        ${displayName} > ${cursor.displayName}
        OR (${displayName} = ${cursor.displayName} AND member.id > ${cursor.memberId}::bigint)
      )
    )
  )`;
}

@Injectable()
export class NoticesQueryService {
  private readonly dialect: "postgres" | "mariadb";
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly access: NoticesAccessService,
    private readonly audiences: ContentAudiencesService,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    this.dialect = noticeDatabaseEngine(config);
    if (this.dialect === "mariadb") this.database = database.withPlugin(noticeMariaDbRowCodec);
  }

  async list(query: ListNoticesQuery): Promise<ListNoticesResult> {
    const serverToday = await readDatabaseKstToday(this.database, this.dialect);
    const context = await this.access.getCollectionContext(query.actorUserId);
    const search = normalizeSearchTerm(query.search);
    const cursor =
      query.cursor === undefined
        ? undefined
        : decodeNoticeListCursor(query.cursor, query.importance, search);

    let builder = this.database
      .selectFrom("notices as notice")
      .leftJoin("notice_reads as notice_read", (join) =>
        join
          .onRef("notice_read.notice_id", "=", "notice.id")
          .on("notice_read.member_id", "=", context.memberId),
      )
      .select([
        "notice.audience_mode",
        "notice.category",
        "notice.content",
        "notice.content_revision",
        "notice.id",
        "notice.is_important",
        "notice.published_at",
        "notice.row_version",
        "notice.title",
        "notice_read.confirmed_revision",
        (this.dialect === "mariadb"
          ? sql<string>`DATE_FORMAT(notice.published_at,'%Y-%m-%dT%H:%i:%s.%fZ')`
          : sql<string>`to_char(
          notice.published_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )`
        ).as("cursor_published_at"),
      ])
      .where("notice.class_id", "=", context.classId)
      .where("notice.deleted_at", "is", null)
      .where(
        "notice.published_at",
        "<=",
        this.dialect === "mariadb" ? sql<Date>`UTC_TIMESTAMP(6)` : sql<Date>`CURRENT_TIMESTAMP`,
      );

    if (context.role === "student") {
      builder = builder.where(sql<boolean>`(
        notice.audience_mode = 'legacy_class'
        OR EXISTS (
          SELECT 1
          FROM notice_recipients AS audience_recipient
          WHERE audience_recipient.notice_id = notice.id
            AND audience_recipient.class_id = notice.class_id
            AND audience_recipient.member_id = ${this.dialect === "mariadb" ? sql`${context.memberId}` : sql`${context.memberId}::bigint`}
        )
      )`);
    }
    if (query.importance !== "all") {
      builder = builder.where("notice.is_important", "=", query.importance === "important");
    }
    if (search !== undefined) {
      /*
       * 제목과 본문 둘 다에서 찾는다. ESCAPE 를 반드시 함께 준다 — 없으면 사용자가
       * 넣은 `%` 한 글자가 전부를 걸어 버린다.
       */
      const pattern = toIlikePattern(search);
      builder = builder.where(
        this.dialect === "mariadb"
          ? sql<boolean>`(
        LOWER(notice.title) LIKE LOWER(${pattern}) ESCAPE ${"\\"}
        OR LOWER(notice.content) LIKE LOWER(${pattern}) ESCAPE ${"\\"}
      )`
          : sql<boolean>`(
        notice.title ILIKE ${pattern} ESCAPE '\\'
        OR notice.content ILIKE ${pattern} ESCAPE '\\'
      )`,
      );
    }
    if (cursor !== undefined) {
      builder = builder.where(
        this.dialect === "mariadb"
          ? sql<boolean>`(
        (${cursor.isImportant} = TRUE AND notice.is_important = FALSE)
        OR (notice.is_important = ${cursor.isImportant} AND (
          notice.published_at < ${cursor.publishedAt.replace("T", " ").slice(0, -1)}
          OR (notice.published_at = ${cursor.publishedAt.replace("T", " ").slice(0, -1)} AND notice.id < ${cursor.id})
        ))
      )`
          : sql<boolean>`(
        (${cursor.isImportant}::boolean = TRUE AND notice.is_important = FALSE)
        OR (
          notice.is_important = ${cursor.isImportant}::boolean
          AND (
            notice.published_at < ${cursor.publishedAt}::timestamptz
            OR (
              notice.published_at = ${cursor.publishedAt}::timestamptz
              AND notice.id < ${cursor.id}::bigint
            )
          )
        )
      )`,
      );
    }

    const rows = await builder
      .orderBy("notice.is_important", "desc")
      .orderBy("notice.published_at", "desc")
      .orderBy("notice.id", "desc")
      .limit(PAGE_SIZE + 1)
      .execute();
    const pageRows = rows.slice(0, PAGE_SIZE);
    const items = pageRows.map((row): NoticeItem => {
      const state =
        context.role === "student"
          ? noticeConfirmationState(row.confirmed_revision, row.content_revision)
          : undefined;
      return noticeItemView(row, state);
    });
    const last = pageRows.at(-1);
    const nextCursor =
      rows.length > PAGE_SIZE && last !== undefined
        ? encodeNoticeListCursor({
            id: last.id,
            importance: query.importance,
            isImportant: last.is_important,
            publishedAt: last.cursor_published_at,
            ...(search === undefined ? {} : { search }),
          })
        : null;
    return {
      items,
      next_cursor: nextCursor,
      selected_audience_enabled: this.audiences.selectedAudienceEnabled(),
      server_today: serverToday,
    };
  }

  async get(query: GetNoticeQuery): Promise<NoticeItem> {
    const { context, notice } = await this.access.getResourceContext(
      query.actorUserId,
      query.noticeId,
    );
    if (context.role === "teacher") return noticeItemView(notice);

    const read = await this.database
      .selectFrom("notice_reads")
      .select("confirmed_revision")
      .where("notice_id", "=", notice.id)
      .where("member_id", "=", context.memberId)
      .executeTakeFirst();
    return noticeItemView(
      notice,
      noticeConfirmationState(read?.confirmed_revision ?? null, notice.content_revision),
    );
  }

  async listConfirmations(
    query: ListNoticeConfirmationsQuery,
  ): Promise<ListNoticeConfirmationsResult> {
    const { context, notice } = await this.access.getResourceContext(
      query.actorUserId,
      query.noticeId,
    );
    if (context.role !== "teacher") {
      throw new NoticeRoleInsufficientException("이 반의 선생님만 공지 확인 현황을 볼 수 있어요.");
    }
    const cursor =
      query.cursor === undefined
        ? undefined
        : decodeNoticeConfirmationsCursor(query.cursor, notice.id, query.state);
    if (this.dialect === "mariadb") {
      return readMariaDbNoticeConfirmations(this.database, {
        classId: context.classId,
        noticeId: notice.id,
        state: query.state,
        ...(cursor === undefined ? {} : { cursor }),
      });
    }
    const displayName = sql<string>`COALESCE(member.display_name_in_class, account.display_name)`;

    return this.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (transaction) => {
        const serverToday = await readDatabaseKstToday(transaction);
        const snapshotNotice = await transaction
          .selectFrom("notices")
          .select(["audience_mode", "content_revision", "id"])
          .where("id", "=", notice.id)
          .where("class_id", "=", context.classId)
          .where("deleted_at", "is", null)
          .where("published_at", "<=", sql<Date>`CURRENT_TIMESTAMP`)
          .executeTakeFirst();
        if (snapshotNotice === undefined) throw new NoticeNotFoundException();

        // 집계와 목록이 같은 기준을 쓰도록 한 곳에 둔다. 예전에는 이 조건이
        // WHERE로만 걸려 대상 밖 학생이 세 집계 어디에도 안 잡혔고, 화면 분모가
        // confirmed+unread+modified라 그 학생이 통째로 사라졌다(P1-07).
        const audienceMemberPredicate = sql<boolean>`(
          ${snapshotNotice.audience_mode}::text = 'legacy_class'
          OR audience_recipient.member_id IS NOT NULL
        )`;

        const countsRow = await transaction
          .selectFrom("class_members as member")
          .innerJoin("users as account", "account.id", "member.user_id")
          .leftJoin("notice_recipients as audience_recipient", (join) =>
            join
              .onRef("audience_recipient.member_id", "=", "member.id")
              .onRef("audience_recipient.class_id", "=", "member.class_id")
              .on("audience_recipient.notice_id", "=", snapshotNotice.id),
          )
          .leftJoin("notice_reads as notice_read", (join) =>
            join
              .onRef("notice_read.member_id", "=", "member.id")
              .on("notice_read.notice_id", "=", snapshotNotice.id),
          )
          .select([
            sql<string>`COUNT(*) FILTER (
              WHERE ${audienceMemberPredicate}
                AND notice_read.confirmed_revision = ${snapshotNotice.content_revision}::bigint
            )`.as("confirmed"),
            sql<string>`COUNT(*) FILTER (
              WHERE ${audienceMemberPredicate}
                AND notice_read.confirmed_revision < ${snapshotNotice.content_revision}::bigint
            )`.as("modified_unconfirmed"),
            // 첫 확인보다 마지막 확인이 늦으면 수정 뒤 새 내용을 다시 확인한 학생이다.
            sql<string>`COUNT(*) FILTER (
              WHERE ${audienceMemberPredicate}
                AND notice_read.confirmed_revision = ${snapshotNotice.content_revision}::bigint
                AND notice_read.confirmed_at > notice_read.first_confirmed_at
            )`.as("reconfirmed"),
            sql<string>`COUNT(*) FILTER (
              WHERE ${audienceMemberPredicate} AND notice_read.id IS NULL
            )`.as("unread"),
            // 대상 밖에 있는 승인 학생 수. 발행 후 합류한 학생이 여기 잡힌다 —
            // 이 수를 빼놓으면 분모에서도 사라져 교사 화면이 "전원 확인 완료"로
            // 보인다. 대상 자체를 바꾸지는 않는다(AC 2항 스냅샷 불변).
            sql<string>`COUNT(*) FILTER (
              WHERE NOT ${audienceMemberPredicate}
            )`.as("excluded_member_count"),
          ])
          .where("member.class_id", "=", context.classId)
          .where("member.role", "=", "student")
          .where("member.status", "=", "approved")
          .where("account.is_active", "=", true)
          .where("account.deleted_at", "is", null)
          .executeTakeFirstOrThrow();
        const latestReminder = await transaction
          .selectFrom("in_app_reminder_batches")
          .select(sql<Date | null>`MAX(created_at)`.as("requested_at"))
          .where("class_id", "=", context.classId)
          .where("notice_id", "=", snapshotNotice.id)
          .where("content_revision", "=", snapshotNotice.content_revision)
          .executeTakeFirstOrThrow();

        let itemsBuilder = transaction
          .selectFrom("class_members as member")
          .innerJoin("users as account", "account.id", "member.user_id")
          .leftJoin("notice_recipients as audience_recipient", (join) =>
            join
              .onRef("audience_recipient.member_id", "=", "member.id")
              .onRef("audience_recipient.class_id", "=", "member.class_id")
              .on("audience_recipient.notice_id", "=", snapshotNotice.id),
          )
          .leftJoin("notice_reads as notice_read", (join) =>
            join
              .onRef("notice_read.member_id", "=", "member.id")
              .on("notice_read.notice_id", "=", snapshotNotice.id),
          )
          .select(["member.id", "member.student_number", displayName.as("display_name")])
          .where("member.class_id", "=", context.classId)
          .where("member.role", "=", "student")
          .where("member.status", "=", "approved")
          .where("account.is_active", "=", true)
          .where("account.deleted_at", "is", null)
          .where(audienceMemberPredicate)
          .where(confirmationStatePredicate(query.state, snapshotNotice.content_revision));
        if (cursor !== undefined) {
          itemsBuilder = itemsBuilder.where(confirmationsCursorPredicate(cursor, displayName));
        }
        const rows = await itemsBuilder
          .orderBy(sql`member.student_number ASC NULLS LAST`)
          .orderBy(displayName, "asc")
          .orderBy("member.id", "asc")
          .limit(PAGE_SIZE + 1)
          .execute();
        const pageRows = rows.slice(0, PAGE_SIZE);
        const items = pageRows.map((row) => ({
          confirmation_state: query.state,
          display_name: row.display_name,
          member_id: row.id,
          student_number: row.student_number,
        }));
        const last = pageRows.at(-1);
        const nextCursor =
          rows.length > PAGE_SIZE && last !== undefined
            ? encodeNoticeConfirmationsCursor({
                displayName: last.display_name,
                memberId: last.id,
                noticeId: snapshotNotice.id,
                state: query.state,
                studentNumber: last.student_number,
              })
            : null;

        return {
          content_revision: snapshotNotice.content_revision,
          counts: {
            confirmed: Number(countsRow.confirmed),
            excluded_member_count: Number(countsRow.excluded_member_count),
            modified_unconfirmed: Number(countsRow.modified_unconfirmed),
            reconfirmed: Number(countsRow.reconfirmed),
            unread: Number(countsRow.unread),
          },
          items,
          last_reminder_requested_at: latestReminder.requested_at?.toISOString() ?? null,
          next_cursor: nextCursor,
          server_today: serverToday,
        };
      });
  }
}
