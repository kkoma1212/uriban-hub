import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type RawBuilder } from "kysely";

import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import { normalizeSearchTerm, toIlikePattern } from "../common/validation/search-term.js";
import { addCalendarDays } from "../common/date/kst-date.js";
import type { AppEnvironment } from "../config/environment.js";
import {
  ContentAudiencesService,
  type ContentAudienceMode,
} from "../content-audiences/content-audiences.service.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  NoticesAccessService,
  type NoticeAccessContext,
} from "../notices/notices-access.service.js";
import type { NoticeConfirmationState } from "../notices/notices.types.js";
import type { SupplyCheckState } from "../supplies/supplies.types.js";
import { decodeUpdatesCursor, encodeUpdatesCursor } from "./updates.cursor.js";
import { StudentUpdatesFilterRequiredException } from "./updates.errors.js";
import { readMariaDbUpdates } from "./mariadb/updates-query.js";
import type {
  ListUpdatesQuery,
  ListUpdatesResult,
  UpdateItem,
  UpdateItemCategory,
  UpdateItemKind,
  UpdatesFeedRow,
  UpdatesFilter,
} from "./updates.types.js";

const PAGE_SIZE = 20;

function noticeFilterPredicate(filter: UpdatesFilter): RawBuilder<unknown> {
  if (filter === "supplies" || filter === "materials" || filter === "homework") return sql`FALSE`;
  if (filter === "notices") return sql`notice.category = 'general'`;
  if (filter === "unresolved")
    return sql`notice_read.confirmed_revision IS DISTINCT FROM notice.content_revision`;
  if (filter === "important") return sql`notice.is_important = TRUE`;
  if (filter === "performance") return sql`notice.category = 'performance'`;
  return sql`TRUE`;
}

function supplyFilterPredicate(filter: UpdatesFilter): RawBuilder<unknown> {
  if (filter === "homework") return sql`supply.category = 'homework'`;
  if (filter === "materials") return sql`supply.category = 'general'`;
  if (filter === "unresolved")
    return sql`NOT COALESCE(supply_check.is_checked = TRUE
      AND supply_check.confirmed_revision = supply.content_revision, FALSE)`;
  return filter === "all" || filter === "supplies" ? sql`TRUE` : sql`FALSE`;
}

function updateItem(row: UpdatesFeedRow): UpdateItem {
  const common = {
    audience_mode: row.audience_mode as ContentAudienceMode,
    category: row.category as UpdateItemCategory,
    content: row.content,
    content_revision: row.content_revision,
    id: row.id,
    is_important: row.is_important,
    kind: row.item_kind as UpdateItemKind,
    needed_on: row.needed_on,
    published_at: row.published_at,
    row_version: row.row_version,
    title: row.title,
  };

  if (row.item_kind === "notice" && row.confirmation_state !== null) {
    return {
      ...common,
      confirmation_state: row.confirmation_state as NoticeConfirmationState,
    };
  }
  if (row.item_kind === "supply" && row.check_state !== null) {
    return { ...common, check_state: row.check_state as SupplyCheckState };
  }
  return common;
}

@Injectable()
export class UpdatesService {
  private readonly engine: "postgres" | "mariadb";

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly access: NoticesAccessService,
    private readonly audiences: ContentAudiencesService,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    const engine = config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Unsupported database engine");
    this.engine = engine;
  }

  async list(query: ListUpdatesQuery): Promise<ListUpdatesResult> {
    const context = await this.access.getCollectionContext(query.actorUserId);
    return this.listForContext(context, query, { recentSuppliesOnly: true });
  }

  /**
   * 권한 확인이 끝난 반(context)의 통합 목록. 현재 반은 list(), 지난 반은 PastClassesService가
   * 자기 권한 규칙으로 context를 만든 뒤 호출한다 — 학생 공개 대상 규칙은 여기서 똑같이 적용된다.
   */
  async listForContext(
    context: NoticeAccessContext,
    query: Omit<ListUpdatesQuery, "actorUserId">,
    { recentSuppliesOnly }: { recentSuppliesOnly: boolean },
  ): Promise<ListUpdatesResult> {
    if (query.filter === "unresolved" && context.role !== "student")
      throw new StudentUpdatesFilterRequiredException();
    const search = normalizeSearchTerm(query.search);
    const cursor =
      query.cursor === undefined
        ? undefined
        : decodeUpdatesCursor(query.cursor, query.filter, search);
    if (this.engine === "mariadb") {
      const result = await readMariaDbUpdates(
        this.database,
        context,
        query.filter,
        search,
        cursor,
        PAGE_SIZE + 1,
        recentSuppliesOnly,
      );
      return this.response(
        result.rows,
        result.serverToday,
        query.filter,
        search,
        result.unresolvedCount,
      );
    }
    /*
     * 각 갈래의 WHERE 에 같은 조건을 붙인다 — ESCAPE 없이 두면 `%` 한 글자가 전부를 건다.
     */
    const noticeSearch =
      search === undefined
        ? sql``
        : sql`AND (notice.title ILIKE ${toIlikePattern(search)} ESCAPE '\\'
              OR notice.content ILIKE ${toIlikePattern(search)} ESCAPE '\\')`;
    const supplySearch =
      search === undefined
        ? sql``
        : sql`AND (supply.title ILIKE ${toIlikePattern(search)} ESCAPE '\\'
              OR supply.description ILIKE ${toIlikePattern(search)} ESCAPE '\\')`;

    return this.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (transaction) => {
        const serverToday = await readDatabaseKstToday(transaction);
        const oldestVisibleSupplyDate = addCalendarDays(serverToday, -90);
        const studentNoticeAudience =
          context.role === "student"
            ? sql`
                AND (
                  notice.audience_mode = 'legacy_class'
                  OR EXISTS (
                    SELECT 1
                    FROM notice_recipients AS audience_recipient
                    WHERE audience_recipient.notice_id = notice.id
                      AND audience_recipient.class_id = notice.class_id
                      AND audience_recipient.member_id = ${context.memberId}::bigint
                  )
                )
              `
            : sql``;
        const studentSupplyAudience =
          context.role === "student"
            ? sql`
                AND (
                  supply.audience_mode = 'legacy_class'
                  OR EXISTS (
                    SELECT 1
                    FROM supply_recipients AS audience_recipient
                    WHERE audience_recipient.supply_id = supply.id
                      AND audience_recipient.class_id = supply.class_id
                      AND audience_recipient.member_id = ${context.memberId}::bigint
                  )
                )
              `
            : sql``;
        const cursorPredicate =
          cursor === undefined
            ? sql``
            : sql`
                WHERE (
                  feed.source_published_at < ${cursor.publishedAt}::timestamptz
                  OR (
                    feed.source_published_at = ${cursor.publishedAt}::timestamptz
                    AND feed.item_kind > ${cursor.itemKind}
                  )
                  OR (
                    feed.source_published_at = ${cursor.publishedAt}::timestamptz
                    AND feed.item_kind = ${cursor.itemKind}
                    AND feed.id < ${cursor.id}::bigint
                  )
                )
              `;
        const result = await sql<UpdatesFeedRow>`
          WITH feed AS (
            SELECT
              notice.audience_mode::text AS audience_mode,
              notice.category::text AS category,
              NULL::text AS check_state,
              CASE
                WHEN ${context.role}::text <> 'student' THEN NULL::text
                WHEN notice_read.id IS NULL THEN 'unread'::text
                WHEN notice_read.confirmed_revision = notice.content_revision
                  THEN 'confirmed'::text
                ELSE 'modified_unconfirmed'::text
              END AS confirmation_state,
              notice.content::text AS content,
              notice.content_revision,
              notice.id,
              notice.is_important,
              'notice'::text AS item_kind,
              NULL::text AS needed_on,
              notice.published_at AS source_published_at,
              notice.row_version,
              notice.title
            FROM notices AS notice
            LEFT JOIN notice_reads AS notice_read
              ON notice_read.notice_id = notice.id
              AND notice_read.member_id = ${context.memberId}::bigint
            WHERE notice.class_id = ${context.classId}::bigint
              AND notice.deleted_at IS NULL
              AND notice.published_at <= CURRENT_TIMESTAMP
              AND ${noticeFilterPredicate(query.filter)}
              ${noticeSearch}
              ${studentNoticeAudience}

            UNION ALL

            SELECT
              supply.audience_mode::text AS audience_mode,
              -- 자리표시자 'supply' 를 두면 숙제가 통합 알림에서 준비물과 구별되지
              -- 않는다. 공지가 자기 category 를 그대로 내려보내는 것과 같은 방식.
              supply.category::text AS category,
              CASE
                WHEN ${context.role}::text <> 'student' THEN NULL::text
                WHEN supply_check.is_checked = TRUE
                  AND supply_check.confirmed_revision = supply.content_revision
                  THEN 'checked'::text
                WHEN supply_check.is_checked = TRUE
                  AND supply_check.confirmed_revision < supply.content_revision
                  THEN 'modified_unconfirmed'::text
                ELSE 'unchecked'::text
              END AS check_state,
              NULL::text AS confirmation_state,
              supply.description::text AS content,
              supply.content_revision,
              supply.id,
              FALSE AS is_important,
              'supply'::text AS item_kind,
              to_char(supply.needed_on, 'YYYY-MM-DD') AS needed_on,
              supply.created_at AS source_published_at,
              supply.row_version,
              supply.title
            FROM supplies AS supply
            LEFT JOIN supply_checks AS supply_check
              ON supply_check.supply_id = supply.id
              AND supply_check.member_id = ${context.memberId}::bigint
            WHERE supply.class_id = ${context.classId}::bigint
              AND supply.deleted_at IS NULL
              ${recentSuppliesOnly ? sql`AND supply.needed_on >= ${oldestVisibleSupplyDate}::date` : sql``}
              AND ${supplyFilterPredicate(query.filter)}
              ${supplySearch}
              ${studentSupplyAudience}
          )
          SELECT
            feed.audience_mode,
            feed.category,
            feed.check_state,
            feed.confirmation_state,
            feed.content,
            feed.content_revision::text AS content_revision,
            feed.id::text AS id,
            feed.is_important,
            feed.item_kind,
            feed.needed_on,
            to_char(
              feed.source_published_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS published_at,
            feed.row_version::text AS row_version,
            feed.title
          FROM feed
          ${cursorPredicate}
          ORDER BY
            feed.source_published_at DESC,
            feed.item_kind ASC,
            feed.id DESC
          LIMIT ${PAGE_SIZE + 1}
        `.execute(transaction);
        let unresolvedCount: number | null = null;
        if (context.role === "student") {
          // 같은 MVCC 스냅샷에서 검색/필터/커서와 무관하게 본인 대상만 센다.
          const count = await sql<{ unresolved_count: string }>`
            SELECT (
              (SELECT COUNT(*) FROM notices AS notice
                WHERE notice.class_id = ${context.classId}::bigint
                  AND notice.deleted_at IS NULL
                  AND notice.published_at <= CURRENT_TIMESTAMP
                  ${studentNoticeAudience}
                  AND NOT EXISTS (
                    SELECT 1 FROM notice_reads AS confirmed
                    WHERE confirmed.notice_id = notice.id
                      AND confirmed.member_id = ${context.memberId}::bigint
                      AND confirmed.confirmed_revision = notice.content_revision
                  ))
              + (SELECT COUNT(*) FROM supplies AS supply
                WHERE supply.class_id = ${context.classId}::bigint
                  AND supply.deleted_at IS NULL
                  ${recentSuppliesOnly ? sql`AND supply.needed_on >= ${oldestVisibleSupplyDate}::date` : sql``}
                  ${studentSupplyAudience}
                  AND NOT EXISTS (
                    SELECT 1 FROM supply_checks AS confirmed
                    WHERE confirmed.supply_id = supply.id
                      AND confirmed.member_id = ${context.memberId}::bigint
                      AND confirmed.is_checked = TRUE
                      AND confirmed.confirmed_revision = supply.content_revision
                  ))
            )::text AS unresolved_count
          `.execute(transaction);
          unresolvedCount = Number(count.rows[0]?.unresolved_count);
          if (!Number.isSafeInteger(unresolvedCount) || unresolvedCount < 0)
            throw new Error("Invalid unresolved content count.");
        }
        return this.response(result.rows, serverToday, query.filter, search, unresolvedCount);
      });
  }

  private response(
    rows: UpdatesFeedRow[],
    serverToday: string,
    filter: UpdatesFilter,
    search: string | undefined,
    unresolvedCount: number | null,
  ): ListUpdatesResult {
    const pageRows = rows.slice(0, PAGE_SIZE);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(updateItem),
      next_cursor:
        rows.length > PAGE_SIZE && last !== undefined
          ? encodeUpdatesCursor({
              filter,
              id: last.id,
              itemKind: last.item_kind as UpdateItemKind,
              publishedAt: last.published_at,
              ...(search === undefined ? {} : { search }),
            })
          : null,
      selected_audience_enabled: this.audiences.selectedAudienceEnabled(),
      unresolved_count: unresolvedCount,
      server_today: serverToday,
    };
  }
}
