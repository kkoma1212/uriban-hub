import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type RawBuilder } from "kysely";

import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import { normalizeSearchTerm, toIlikePattern } from "../common/validation/search-term.js";
import { addCalendarDays, databaseDate, startOfKstWeek } from "../common/date/kst-date.js";
import { ContentAudiencesService } from "../content-audiences/content-audiences.service.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { SuppliesAccessService } from "./supplies-access.service.js";
import {
  decodeSupplyChecksCursor,
  decodeSupplyListCursor,
  encodeSupplyChecksCursor,
  encodeSupplyListCursor,
  type SupplyChecksCursor,
} from "./supplies.cursor.js";
import { SupplyNotFoundException, SupplyRoleInsufficientException } from "./supplies.errors.js";
import type {
  GetSupplyQuery,
  ListSuppliesQuery,
  ListSuppliesResult,
  ListSupplyChecksQuery,
  ListSupplyChecksResult,
  SupplyCheckFilter,
  SupplyItem,
} from "./supplies.types.js";
import { supplyCheckState, supplyItemView } from "./supplies.view.js";
import type { AppEnvironment } from "../config/environment.js";
import { supplyDatabase } from "./mariadb/supplies-database.js";
import {
  supplyDate,
  supplyBigint,
  supplySearchPattern,
  type SupplyDatabaseEngine,
} from "./mariadb/supplies-sql.js";
import { listSupplyChecksMariaDb } from "./mariadb/supplies-checks-query.js";

const PAGE_SIZE = 20;

function checkStatePredicate(
  state: SupplyCheckFilter,
  contentRevision: string,
): RawBuilder<boolean> {
  if (state === "unchecked") {
    return sql<boolean>`(supply_check.id IS NULL OR supply_check.is_checked = FALSE)`;
  }
  if (state === "checked") {
    return sql<boolean>`(
      supply_check.is_checked = TRUE
      AND supply_check.confirmed_revision = ${contentRevision}::bigint
    )`;
  }
  return sql<boolean>`(
    supply_check.is_checked = TRUE
    AND supply_check.confirmed_revision < ${contentRevision}::bigint
  )`;
}

function checksCursorPredicate(
  cursor: SupplyChecksCursor,
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
export class SuppliesQueryService {
  private readonly database: ClassHubDatabase;
  private readonly engine: SupplyDatabaseEngine;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    private readonly access: SuppliesAccessService,
    private readonly audiences: ContentAudiencesService,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    ({ database: this.database, engine: this.engine } = supplyDatabase(database, config));
  }

  async list(query: ListSuppliesQuery): Promise<ListSuppliesResult> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const context = await this.access.getCollectionContext(query.actorUserId);
    if (query.checkState !== undefined && context.role !== "student") {
      throw new SupplyRoleInsufficientException();
    }
    const oldestPast = addCalendarDays(serverToday, -90);
    const dateRange =
      query.scope === "today"
        ? { start_date: serverToday, end_date: serverToday }
        : query.scope === "this_week"
          ? {
              start_date: startOfKstWeek(serverToday),
              end_date: addCalendarDays(startOfKstWeek(serverToday), 6),
            }
          : undefined;
    const search = normalizeSearchTerm(query.search);
    const cursor =
      query.cursor === undefined
        ? undefined
        : decodeSupplyListCursor(
            query.cursor,
            query.scope,
            search,
            dateRange,
            query.category,
            query.checkState,
          );

    let builder = this.database
      .selectFrom("supplies as supply")
      .leftJoin("supply_checks as supply_check", (join) =>
        join
          .onRef("supply_check.supply_id", "=", "supply.id")
          .on("supply_check.member_id", "=", context.memberId),
      )
      .select([
        "supply.audience_mode",
        "supply.category",
        "supply.content_revision",
        "supply.description",
        "supply.id",
        "supply.needed_on",
        "supply.row_version",
        "supply.title",
        "supply_check.confirmed_revision",
        "supply_check.is_checked",
      ])
      .where("supply.class_id", "=", context.classId)
      .where("supply.deleted_at", "is", null);

    /*
     * 종류는 걸러내기만 하고 정렬은 건드리지 않는다 — 커서가 (needed_on, id) 위에
     * 서 있으므로 걸러도 페이지 이어붙이기가 그대로 성립한다. 걸러내기를 화면에서
     * 하면 한 페이지가 통째로 비어 "더 없음"으로 보일 수 있어 서버에서 한다.
     */
    if (query.category !== undefined) {
      builder = builder.where("supply.category", "=", query.category);
    }
    if (search !== undefined) {
      /* 제목과 내용 둘 다에서 찾는다. ESCAPE 없이 두면 사용자가 넣은 `%`가 전부를 건다. */
      const pattern =
        this.engine === "mariadb" ? supplySearchPattern(search) : toIlikePattern(search);
      builder = builder.where(
        this.engine === "mariadb"
          ? sql<boolean>`(
        LOWER(supply.title) COLLATE utf8mb4_nopad_bin LIKE LOWER(${pattern}) ESCAPE '!'
        OR LOWER(supply.description) COLLATE utf8mb4_nopad_bin LIKE LOWER(${pattern}) ESCAPE '!'
      )`
          : sql<boolean>`(
        supply.title ILIKE ${pattern} ESCAPE '\\'
        OR supply.description ILIKE ${pattern} ESCAPE '\\'
      )`,
      );
    }
    if (context.role === "student") {
      // supplyCheckState와 같은 판정으로 전체 결과를 거른 뒤 페이지를 나눈다.
      if (query.checkState === "unchecked") {
        builder = builder.where(sql<boolean>`(
          supply_check.is_checked IS NULL OR supply_check.is_checked = FALSE
          OR supply_check.confirmed_revision IS NULL
        )`);
      } else if (query.checkState === "checked") {
        builder = builder.where(sql<boolean>`(
          supply_check.is_checked = TRUE
          AND supply_check.confirmed_revision = supply.content_revision
        )`);
      } else if (query.checkState === "modified_unconfirmed") {
        builder = builder.where(sql<boolean>`(
          supply_check.is_checked = TRUE
          AND supply_check.confirmed_revision <> supply.content_revision
        )`);
      }
      builder = builder.where(sql<boolean>`(
        supply.audience_mode = 'legacy_class'
        OR EXISTS (
          SELECT 1
          FROM supply_recipients AS audience_recipient
          WHERE audience_recipient.supply_id = supply.id
            AND audience_recipient.class_id = supply.class_id
            AND audience_recipient.member_id = ${supplyBigint(context.memberId, this.engine)}
        )
      )`);
    }
    if (query.scope !== "past") {
      builder = builder.where(
        "supply.needed_on",
        ">=",
        supplyDate(dateRange?.start_date ?? serverToday, this.engine),
      );
      if (dateRange !== undefined)
        builder = builder.where(
          "supply.needed_on",
          "<=",
          supplyDate(dateRange.end_date, this.engine),
        );
      if (cursor !== undefined) {
        builder = builder.where(sql<boolean>`(
          supply.needed_on > ${supplyDate(cursor.neededOn, this.engine)}
          OR (supply.needed_on = ${supplyDate(cursor.neededOn, this.engine)} AND supply.id > ${supplyBigint(cursor.id, this.engine)})
        )`);
      }
      builder = builder.orderBy("supply.needed_on", "asc").orderBy("supply.id", "asc");
    } else {
      builder = builder
        .where("supply.needed_on", ">=", supplyDate(oldestPast, this.engine))
        .where("supply.needed_on", "<", supplyDate(serverToday, this.engine));
      if (cursor !== undefined) {
        builder = builder.where(sql<boolean>`(
          supply.needed_on < ${supplyDate(cursor.neededOn, this.engine)}
          OR (supply.needed_on = ${supplyDate(cursor.neededOn, this.engine)} AND supply.id < ${supplyBigint(cursor.id, this.engine)})
        )`);
      }
      builder = builder.orderBy("supply.needed_on", "desc").orderBy("supply.id", "desc");
    }

    const rows = await builder.limit(PAGE_SIZE + 1).execute();
    const pageRows = rows.slice(0, PAGE_SIZE);
    const items = pageRows.map((row): SupplyItem => {
      const state =
        context.role === "student"
          ? supplyCheckState(row.is_checked, row.confirmed_revision, row.content_revision)
          : undefined;
      return supplyItemView(row, state);
    });
    const last = pageRows.at(-1);
    const nextCursor =
      rows.length > PAGE_SIZE && last !== undefined
        ? encodeSupplyListCursor({
            id: last.id,
            neededOn: databaseDate(last.needed_on),
            scope: query.scope,
            ...(search === undefined ? {} : { search }),
            ...(dateRange === undefined ? {} : { dateRange }),
            ...(query.category === undefined ? {} : { category: query.category }),
            ...(query.checkState === undefined ? {} : { checkState: query.checkState }),
          })
        : null;

    return {
      items,
      next_cursor: nextCursor,
      selected_audience_enabled: this.audiences.selectedAudienceEnabled(),
      server_today: serverToday,
      ...(dateRange === undefined ? {} : { date_range: dateRange }),
    };
  }

  async get(query: GetSupplyQuery): Promise<SupplyItem> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const { context, supply } = await this.access.getResourceContext(
      query.actorUserId,
      query.supplyId,
      serverToday,
    );
    if (context.role === "teacher") return supplyItemView(supply);

    const check = await this.database
      .selectFrom("supply_checks")
      .select(["confirmed_revision", "is_checked"])
      .where("supply_id", "=", supply.id)
      .where("member_id", "=", context.memberId)
      .executeTakeFirst();
    return supplyItemView(
      supply,
      supplyCheckState(
        check?.is_checked ?? null,
        check?.confirmed_revision ?? null,
        supply.content_revision,
      ),
    );
  }

  async listChecks(query: ListSupplyChecksQuery): Promise<ListSupplyChecksResult> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const { context, supply } = await this.access.getResourceContext(
      query.actorUserId,
      query.supplyId,
      serverToday,
    );
    if (context.role !== "teacher") {
      throw new SupplyRoleInsufficientException(
        "이 반의 선생님만 준비물 확인 현황을 볼 수 있어요.",
      );
    }
    const cursor =
      query.cursor === undefined
        ? undefined
        : decodeSupplyChecksCursor(query.cursor, supply.id, query.state);
    if (this.engine === "mariadb")
      return listSupplyChecksMariaDb(this.database, {
        classId: context.classId,
        supplyId: supply.id,
        state: query.state,
        cursor,
        serverToday,
      });
    const displayName = sql<string>`COALESCE(member.display_name_in_class, account.display_name)`;

    return this.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (transaction) => {
        const snapshotSupply = await transaction
          .selectFrom("supplies")
          .select(["audience_mode", "content_revision", "id", "updated_at"])
          .where("id", "=", supply.id)
          .where("class_id", "=", context.classId)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
        if (snapshotSupply === undefined) throw new SupplyNotFoundException();

        // 집계와 목록이 같은 기준을 쓰도록 한 곳에 둔다(P1-07 — 공지 쪽과 동일).
        const audienceMemberPredicate = sql<boolean>`(
          ${snapshotSupply.audience_mode}::text = 'legacy_class'
          OR audience_recipient.member_id IS NOT NULL
        )`;

        const countsRow = await transaction
          .selectFrom("class_members as member")
          .innerJoin("users as account", "account.id", "member.user_id")
          .leftJoin("supply_recipients as audience_recipient", (join) =>
            join
              .onRef("audience_recipient.member_id", "=", "member.id")
              .onRef("audience_recipient.class_id", "=", "member.class_id")
              .on("audience_recipient.supply_id", "=", snapshotSupply.id),
          )
          .leftJoin("supply_checks as supply_check", (join) =>
            join
              .onRef("supply_check.member_id", "=", "member.id")
              .on("supply_check.supply_id", "=", snapshotSupply.id),
          )
          .select([
            sql<string>`COUNT(*) FILTER (
              WHERE ${audienceMemberPredicate}
              AND supply_check.is_checked = TRUE
              AND supply_check.confirmed_revision = ${snapshotSupply.content_revision}::bigint
            )`.as("checked"),
            sql<string>`COUNT(*) FILTER (
              WHERE ${audienceMemberPredicate}
              AND supply_check.is_checked = TRUE
              AND supply_check.confirmed_revision < ${snapshotSupply.content_revision}::bigint
            )`.as("modified_unconfirmed"),
            // 준비물은 내용 수정 때만 updated_at 이 바뀐다. 마지막 수정 전부터 체크 기록이 있던
            // 학생이 현재 내용을 챙겼으면 재확인이다(MariaDB 쿼리와 같은 기준).
            sql<string>`COUNT(*) FILTER (
              WHERE ${audienceMemberPredicate}
              AND supply_check.is_checked = TRUE
              AND supply_check.confirmed_revision = ${snapshotSupply.content_revision}::bigint
              AND supply_check.created_at < ${snapshotSupply.updated_at}
            )`.as("reconfirmed"),
            sql<string>`COUNT(*) FILTER (
              WHERE ${audienceMemberPredicate}
              AND (supply_check.id IS NULL OR supply_check.is_checked = FALSE)
            )`.as("unchecked"),
            // 공지 쪽과 같은 이유. 대상 밖 학생이 세 집계에서 모두 빠지면
            // 화면 분모에서도 사라져 "전원 챙김 완료"로 보인다(P1-07).
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
          .where("supply_id", "=", snapshotSupply.id)
          .where("content_revision", "=", snapshotSupply.content_revision)
          .executeTakeFirstOrThrow();

        let itemsBuilder = transaction
          .selectFrom("class_members as member")
          .innerJoin("users as account", "account.id", "member.user_id")
          .leftJoin("supply_recipients as audience_recipient", (join) =>
            join
              .onRef("audience_recipient.member_id", "=", "member.id")
              .onRef("audience_recipient.class_id", "=", "member.class_id")
              .on("audience_recipient.supply_id", "=", snapshotSupply.id),
          )
          .leftJoin("supply_checks as supply_check", (join) =>
            join
              .onRef("supply_check.member_id", "=", "member.id")
              .on("supply_check.supply_id", "=", snapshotSupply.id),
          )
          .select(["member.id", "member.student_number", displayName.as("display_name")])
          .where("member.class_id", "=", context.classId)
          .where("member.role", "=", "student")
          .where("member.status", "=", "approved")
          .where("account.is_active", "=", true)
          .where("account.deleted_at", "is", null)
          .where(audienceMemberPredicate)
          .where(checkStatePredicate(query.state, snapshotSupply.content_revision));
        if (cursor !== undefined) {
          itemsBuilder = itemsBuilder.where(checksCursorPredicate(cursor, displayName));
        }
        const rows = await itemsBuilder
          .orderBy(sql`member.student_number ASC NULLS LAST`)
          .orderBy(displayName, "asc")
          .orderBy("member.id", "asc")
          .limit(PAGE_SIZE + 1)
          .execute();
        const pageRows = rows.slice(0, PAGE_SIZE);
        const items = pageRows.map((row) => ({
          check_state: query.state,
          display_name: row.display_name,
          member_id: row.id,
          student_number: row.student_number,
        }));
        const last = pageRows.at(-1);
        const nextCursor =
          rows.length > PAGE_SIZE && last !== undefined
            ? encodeSupplyChecksCursor({
                displayName: last.display_name,
                memberId: last.id,
                state: query.state,
                studentNumber: last.student_number,
                supplyId: snapshotSupply.id,
              })
            : null;

        return {
          content_revision: snapshotSupply.content_revision,
          counts: {
            checked: Number(countsRow.checked),
            excluded_member_count: Number(countsRow.excluded_member_count),
            modified_unconfirmed: Number(countsRow.modified_unconfirmed),
            reconfirmed: Number(countsRow.reconfirmed),
            unchecked: Number(countsRow.unchecked),
          },
          items,
          last_reminder_requested_at: latestReminder.requested_at?.toISOString() ?? null,
          next_cursor: nextCursor,
          server_today: serverToday,
        };
      });
  }
}
