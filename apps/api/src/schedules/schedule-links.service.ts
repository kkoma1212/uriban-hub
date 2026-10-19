import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DB } from "@classhub/db";
import { sql, type Kysely, type Transaction } from "kysely";

import { addCalendarDays } from "../common/date/kst-date.js";
import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  scheduleDateSql,
  scheduleIdSql,
  scheduleJson,
  schedulesDatabase,
} from "./mariadb/schedules-dialect.js";
import { SchedulesAccessService } from "./schedules-access.service.js";
import { MAX_SCHEDULE_LINKS } from "./schedules.dto.js";
import {
  ScheduleLinkTargetNotFoundException,
  ScheduleRoleInsufficientException,
} from "./schedules.errors.js";
import type {
  GetScheduleLinksQuery,
  ScheduleLinksResult,
  UpdateScheduleLinksCommand,
} from "./schedules.types.js";

type Engine = "postgres" | "mariadb";

interface Viewer {
  classId: string;
  /** 학생이면 그 학생에게 공개된 항목만 읽는다. 교사는 undefined. */
  studentMemberId: string | undefined;
  serverToday: string;
}

/** DB 감사 허용 키(schedule_id·title…) 안에서만 남긴다. 무엇이 바뀌었는지는 작업명이 말한다. */
interface LinkAuditJson {
  [key: string]: string;
  schedule_id: string;
  title: string;
}

@Injectable()
export class ScheduleLinksService {
  private readonly database: ClassHubDatabase;
  private readonly engine: Engine;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    private readonly access: SchedulesAccessService,
    @Optional() @Inject(ConfigService) environment?: ConfigService<AppEnvironment, true>,
  ) {
    ({ database: this.database, engine: this.engine } = schedulesDatabase(database, environment));
  }

  async get(query: GetScheduleLinksQuery): Promise<ScheduleLinksResult> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const { context, schedule } = await this.access.getResourceContext(
      query.actorUserId,
      query.scheduleId,
      serverToday,
    );
    return this.readLinks(this.database, schedule.id, {
      classId: context.classId,
      serverToday,
      studentMemberId: context.role === "student" ? context.memberId : undefined,
    });
  }

  /** 연결 전체를 요청한 목록으로 바꾼다. 같은 요청을 다시 보내도 결과가 같다. */
  async replace(command: UpdateScheduleLinksCommand): Promise<ScheduleLinksResult> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const preliminary = await this.access.getResourceContext(
      command.actorUserId,
      command.scheduleId,
      serverToday,
    );
    if (preliminary.context.role !== "teacher") {
      throw new ScheduleRoleInsufficientException("이 반의 선생님만 일정 연결을 바꿀 수 있어요.");
    }
    return this.database.transaction().execute(async (transaction) => {
      const actor = await this.access.lockActorContext(
        transaction,
        preliminary.context,
        command.actorUserId,
      );
      // 일정 행을 잠가 같은 일정의 연결 변경을 한 번에 하나씩 처리한다.
      const schedule = await this.access.lockSchedule(
        transaction,
        actor.classId,
        command.scheduleId,
        serverToday,
      );
      await this.assertTargetsExist(transaction, actor.classId, command);

      const [currentNotices, currentSupplies] = await Promise.all([
        transaction
          .selectFrom("schedule_notice_links")
          .select("notice_id")
          .where("schedule_id", "=", schedule.id)
          .execute(),
        transaction
          .selectFrom("schedule_supply_links")
          .select("supply_id")
          .where("schedule_id", "=", schedule.id)
          .execute(),
      ]);
      const beforeNotices = currentNotices.map((row) => String(row.notice_id));
      const beforeSupplies = currentSupplies.map((row) => String(row.supply_id));
      const noticeChange = difference(beforeNotices, command.noticeIds);
      const supplyChange = difference(beforeSupplies, command.supplyIds);

      if (noticeChange.removed.length > 0) {
        await transaction
          .deleteFrom("schedule_notice_links")
          .where("schedule_id", "=", schedule.id)
          .where("notice_id", "in", noticeChange.removed)
          .execute();
      }
      if (noticeChange.added.length > 0) {
        await transaction
          .insertInto("schedule_notice_links")
          .values(
            noticeChange.added.map((noticeId) => ({
              class_id: actor.classId,
              notice_id: noticeId,
              schedule_id: schedule.id,
            })),
          )
          .execute();
      }
      if (supplyChange.removed.length > 0) {
        await transaction
          .deleteFrom("schedule_supply_links")
          .where("schedule_id", "=", schedule.id)
          .where("supply_id", "in", supplyChange.removed)
          .execute();
      }
      if (supplyChange.added.length > 0) {
        await transaction
          .insertInto("schedule_supply_links")
          .values(
            supplyChange.added.map((supplyId) => ({
              class_id: actor.classId,
              schedule_id: schedule.id,
              supply_id: supplyId,
            })),
          )
          .execute();
      }

      const changed =
        noticeChange.added.length +
          noticeChange.removed.length +
          supplyChange.added.length +
          supplyChange.removed.length >
        0;
      if (changed) {
        const snapshot: LinkAuditJson = { schedule_id: schedule.id, title: schedule.title };
        await transaction
          .insertInto("audit_logs")
          .values({
            action: "schedule.links_updated",
            actor_display_name_snapshot: actor.displayName,
            actor_member_id: actor.memberId,
            actor_role_snapshot: "teacher",
            actor_user_id: command.actorUserId,
            after_json: scheduleJson(snapshot, this.engine),
            before_json: scheduleJson(snapshot, this.engine),
            class_id: actor.classId,
            reason: null,
            request_id: command.requestId,
            target_id: schedule.id,
            target_snapshot: null,
            target_type: "schedule",
          })
          .execute();
      }
      return this.readLinks(transaction, schedule.id, {
        classId: actor.classId,
        serverToday,
        studentMemberId: undefined,
      });
    });
  }

  /** 같은 반에 있고 지워지지 않은 항목만 연결할 수 있다(다른 반은 DB 외래키가 한 번 더 막음). */
  private async assertTargetsExist(
    transaction: Transaction<DB>,
    classId: string,
    command: UpdateScheduleLinksCommand,
  ): Promise<void> {
    const [notices, supplies] = await Promise.all([
      command.noticeIds.length === 0
        ? []
        : transaction
            .selectFrom("notices")
            .select("id")
            .where("class_id", "=", classId)
            .where("id", "in", command.noticeIds)
            .where("deleted_at", "is", null)
            .execute(),
      command.supplyIds.length === 0
        ? []
        : transaction
            .selectFrom("supplies")
            .select("id")
            .where("class_id", "=", classId)
            .where("id", "in", command.supplyIds)
            .where("deleted_at", "is", null)
            .execute(),
    ]);
    if (
      notices.length !== command.noticeIds.length ||
      supplies.length !== command.supplyIds.length
    ) {
      throw new ScheduleLinkTargetNotFoundException();
    }
  }

  private async readLinks(
    database: Kysely<DB> | Transaction<DB>,
    scheduleId: string,
    viewer: Viewer,
  ): Promise<ScheduleLinksResult> {
    const student = viewer.studentMemberId;
    const memberId = student === undefined ? undefined : scheduleIdSql(student, this.engine);
    const now =
      this.engine === "mariadb" ? sql<Date>`UTC_TIMESTAMP(6)` : sql<Date>`CURRENT_TIMESTAMP`;
    const neededOn =
      this.engine === "mariadb"
        ? sql<string>`DATE_FORMAT(supply.needed_on, '%Y-%m-%d')`
        : sql<string>`to_char(supply.needed_on, 'YYYY-MM-DD')`;

    let noticeQuery = database
      .selectFrom("schedule_notice_links as link")
      .innerJoin("notices as notice", (join) =>
        join
          .onRef("notice.id", "=", "link.notice_id")
          .onRef("notice.class_id", "=", "link.class_id"),
      )
      .select(["notice.id", "notice.title", "notice.is_important"])
      .where("link.schedule_id", "=", scheduleId)
      .where("link.class_id", "=", viewer.classId)
      .where("notice.deleted_at", "is", null);
    let supplyQuery = database
      .selectFrom("schedule_supply_links as link")
      .innerJoin("supplies as supply", (join) =>
        join
          .onRef("supply.id", "=", "link.supply_id")
          .onRef("supply.class_id", "=", "link.class_id"),
      )
      .select(["supply.id", "supply.title", "supply.category", neededOn.as("needed_on")])
      .where("link.schedule_id", "=", scheduleId)
      .where("link.class_id", "=", viewer.classId)
      .where("supply.deleted_at", "is", null);
    if (memberId !== undefined) {
      // 학생에게는 공지·준비물 화면과 같은 공개 규칙(게시 시각·대상·지난 준비물 90일)을 적용한다.
      noticeQuery = noticeQuery.where("notice.published_at", "<=", now).where(sql<boolean>`(
        notice.audience_mode = 'legacy_class'
        OR EXISTS (
          SELECT 1 FROM notice_recipients AS recipient
          WHERE recipient.notice_id = notice.id AND recipient.class_id = notice.class_id
            AND recipient.member_id = ${memberId}
        )
      )`);
      supplyQuery = supplyQuery.where(
        "supply.needed_on",
        ">=",
        scheduleDateSql(addCalendarDays(viewer.serverToday, -90), this.engine),
      ).where(sql<boolean>`(
          supply.audience_mode = 'legacy_class'
          OR EXISTS (
            SELECT 1 FROM supply_recipients AS recipient
            WHERE recipient.supply_id = supply.id AND recipient.class_id = supply.class_id
              AND recipient.member_id = ${memberId}
          )
        )`);
    }
    const [notices, supplies] = await Promise.all([
      noticeQuery.orderBy("link.id", "asc").limit(MAX_SCHEDULE_LINKS).execute(),
      supplyQuery.orderBy("link.id", "asc").limit(MAX_SCHEDULE_LINKS).execute(),
    ]);
    return {
      notices: notices.map((row) => ({
        id: String(row.id),
        is_important: Boolean(row.is_important),
        title: row.title,
      })),
      supplies: supplies.map((row) => ({
        category: row.category,
        id: String(row.id),
        needed_on: row.needed_on,
        title: row.title,
      })),
    };
  }
}

function difference(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const previous = new Set(before);
  const next = new Set(after);
  return {
    added: after.filter((id) => !previous.has(id)),
    removed: before.filter((id) => !next.has(id)),
  };
}
