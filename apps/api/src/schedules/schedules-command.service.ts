import {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  IdempotencyService,
  MariaDbIdempotencyService,
} from "@classhub/db";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import { databaseDate } from "../common/date/kst-date.js";
import { parseRequiredIfMatch, ResourceVersionChangedException } from "../common/http/if-match.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AppEnvironment } from "../config/environment.js";
import { mariaDbInsertId } from "../common/database/mariadb-values.js";
import { PushOutbox } from "../push-subscriptions/push-outbox.js";
import {
  schedulesDatabase,
  scheduleDateSql,
  scheduleJson,
  schedulesPersistenceFailure,
} from "./mariadb/schedules-dialect.js";
import { type ScheduleResourceRow, SchedulesAccessService } from "./schedules-access.service.js";
import {
  mapScheduleIdempotencyError,
  ScheduleRoleInsufficientException,
} from "./schedules.errors.js";
import type {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ScheduleItem,
  UpdateScheduleCommand,
} from "./schedules.types.js";
import { scheduleItemView } from "./schedules.view.js";

const CREATE_ROUTE = "/schedules";
const scheduleSelection = [
  "class_id",
  "description",
  "due_date",
  "id",
  "row_version",
  "schedule_type",
  "subject",
  "title",
] as const;

interface ScheduleItemJson {
  [key: string]: null | number | string;
  d_day_label: string | null;
  days_until: number;
  description: string | null;
  due_date: string;
  id: string;
  row_version: string;
  schedule_type: string;
  subject: string | null;
  title: string;
}

interface ScheduleAuditJson {
  [key: string]: null | string;
  deleted_at: null;
  due_date: string;
  schedule_id: string;
  schedule_type: string;
  subject: string | null;
  title: string;
}

function auditSnapshot(schedule: ScheduleResourceRow): ScheduleAuditJson {
  return {
    deleted_at: null,
    due_date: databaseDate(schedule.due_date),
    schedule_id: schedule.id,
    schedule_type: schedule.schedule_type,
    subject: schedule.subject,
    title: schedule.title,
  };
}

const schedulesLogger = new Logger("SchedulesCommand");

@Injectable()
export class SchedulesCommandService {
  private readonly idempotency: Pick<IdempotencyService, "execute">;
  private readonly database: ClassHubDatabase;
  private readonly engine: "postgres" | "mariadb";

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    private readonly access: SchedulesAccessService,
    @Optional() @Inject(ConfigService) environment?: ConfigService<AppEnvironment, true>,
    // 웹 푸시가 켜져 있을 때만 주입된다.
    @Optional() private readonly pushOutbox?: PushOutbox,
  ) {
    ({ database: this.database, engine: this.engine } = schedulesDatabase(database, environment));
    this.idempotency =
      this.engine === "mariadb"
        ? new MariaDbIdempotencyService(this.database)
        : new IdempotencyService(this.database);
  }

  async create(command: CreateScheduleCommand): Promise<ScheduleItem> {
    const preliminary = await this.access.getCollectionContext(command.actorUserId);
    if (preliminary.role !== "teacher") {
      throw new ScheduleRoleInsufficientException("이 반의 선생님만 일정을 등록할 수 있어요.");
    }

    try {
      const result = await this.idempotency.execute<ScheduleItemJson>(
        {
          actorUserId: command.actorUserId,
          idempotencyKey: command.idempotencyKey as string,
          requestHash: createIdempotencyRequestHash({
            body: {
              description: command.description,
              due_date: command.dueDate,
              schedule_type: command.scheduleType,
              subject: command.subject,
              title: command.title,
            },
            effectiveClassId: preliminary.classId,
          }),
          routeKey: createIdempotencyRouteKey(CREATE_ROUTE, preliminary.classId),
        },
        async (transaction) => {
          const serverToday = await readDatabaseKstToday(transaction, this.engine);
          const actor = await this.access.lockActorContext(
            transaction,
            preliminary,
            command.actorUserId,
          );
          const insert = transaction.insertInto("schedules").values({
            class_id: actor.classId,
            created_by_member_id: actor.memberId,
            description: command.description,
            due_date: scheduleDateSql(command.dueDate, this.engine),
            schedule_type: command.scheduleType,
            subject: command.subject,
            title: command.title,
          });
          let created;
          if (this.engine === "mariadb") {
            const inserted = await insert.executeTakeFirstOrThrow();
            if (inserted.numInsertedOrUpdatedRows !== 1n || inserted.insertId === undefined)
              throw schedulesPersistenceFailure();
            created = await transaction
              .selectFrom("schedules")
              .select(scheduleSelection)
              .where("id", "=", mariaDbInsertId(inserted.insertId))
              .where("class_id", "=", actor.classId)
              .where("deleted_at", "is", null)
              .executeTakeFirstOrThrow();
          } else created = await insert.returning(scheduleSelection).executeTakeFirstOrThrow();
          const body = scheduleItemView(created, serverToday) as ScheduleItemJson;

          await transaction
            .insertInto("audit_logs")
            .values({
              action: "schedule.created",
              actor_display_name_snapshot: actor.displayName,
              actor_member_id: actor.memberId,
              actor_role_snapshot: "teacher",
              actor_user_id: command.actorUserId,
              after_json: scheduleJson(auditSnapshot(created), this.engine),
              before_json: null,
              class_id: actor.classId,
              reason: null,
              request_id: command.requestId,
              target_id: created.id,
              target_snapshot: null,
              target_type: "schedule",
            })
            .execute();

          return { body, statusCode: 201 };
        },
      );
      return result.body as ScheduleItem;
    } catch (error) {
      mapScheduleIdempotencyError(error);
    }
  }

  async update(command: UpdateScheduleCommand): Promise<ScheduleItem> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const preliminaryResource = await this.access.getResourceContext(
      command.actorUserId,
      command.scheduleId,
      serverToday,
    );
    if (preliminaryResource.context.role !== "teacher") {
      throw new ScheduleRoleInsufficientException("이 반의 선생님만 일정을 수정할 수 있어요.");
    }

    // 커밋된 뒤에만 푸시 대기열에 넣는다(롤백된 수정을 알리지 않는다).
    let pushChange:
      { classId: string; scheduleId: string; title: string; subject: string | null } | undefined;
    const item = await this.database.transaction().execute(async (transaction) => {
      const actor = await this.access.lockActorContext(
        transaction,
        preliminaryResource.context,
        command.actorUserId,
      );
      const schedule = await this.access.lockSchedule(
        transaction,
        actor.classId,
        command.scheduleId,
        serverToday,
      );
      const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);
      if (schedule.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(schedule.row_version);
      }

      const currentDueDate = databaseDate(schedule.due_date);
      const nextTitle = command.title ?? schedule.title;
      const nextSubject = command.subject === undefined ? schedule.subject : command.subject;
      const nextScheduleType = command.scheduleType ?? schedule.schedule_type;
      const nextDueDate = command.dueDate ?? currentDueDate;
      const nextDescription =
        command.description === undefined ? schedule.description : command.description;
      const titleChanged = nextTitle !== schedule.title;
      const subjectChanged = nextSubject !== schedule.subject;
      const scheduleTypeChanged = nextScheduleType !== schedule.schedule_type;
      const dueDateChanged = nextDueDate !== currentDueDate;
      const descriptionChanged = nextDescription !== schedule.description;
      if (
        !titleChanged &&
        !subjectChanged &&
        !scheduleTypeChanged &&
        !dueDateChanged &&
        !descriptionChanged
      ) {
        return scheduleItemView(schedule, serverToday);
      }

      const now = new Date();
      const update = transaction
        .updateTable("schedules")
        .set({
          ...(descriptionChanged ? { description: nextDescription } : {}),
          ...(dueDateChanged ? { due_date: scheduleDateSql(nextDueDate, this.engine) } : {}),
          row_version: sql`row_version + 1`,
          ...(scheduleTypeChanged ? { schedule_type: nextScheduleType } : {}),
          ...(subjectChanged ? { subject: nextSubject } : {}),
          ...(titleChanged ? { title: nextTitle } : {}),
          updated_at: now,
          updated_by_member_id: actor.memberId,
        })
        .where("id", "=", schedule.id)
        .where("class_id", "=", actor.classId)
        .where("deleted_at", "is", null)
        .where("row_version", "=", expectedRowVersion);
      let updated;
      if (this.engine === "mariadb") {
        const changed = await update.executeTakeFirstOrThrow();
        if (changed.numUpdatedRows !== 1n)
          throw new ResourceVersionChangedException(schedule.row_version);
        updated = await transaction
          .selectFrom("schedules")
          .select(scheduleSelection)
          .where("id", "=", schedule.id)
          .where("class_id", "=", actor.classId)
          .where("deleted_at", "is", null)
          .where("row_version", "=", (BigInt(expectedRowVersion) + 1n).toString())
          .executeTakeFirst();
      } else updated = await update.returning(scheduleSelection).executeTakeFirst();
      if (updated === undefined) {
        throw new ResourceVersionChangedException(schedule.row_version);
      }

      await transaction
        .insertInto("audit_logs")
        .values({
          action: "schedule.updated",
          actor_display_name_snapshot: actor.displayName,
          actor_member_id: actor.memberId,
          actor_role_snapshot: "teacher",
          actor_user_id: command.actorUserId,
          after_json: scheduleJson(auditSnapshot(updated), this.engine),
          before_json: scheduleJson(auditSnapshot(schedule), this.engine),
          class_id: actor.classId,
          reason: null,
          request_id: command.requestId,
          target_id: schedule.id,
          target_snapshot: null,
          target_type: "schedule",
        })
        .execute();

      // 지난 일정의 수정은 학생이 챙길 일이 아니므로 알리지 않는다.
      if (nextDueDate >= serverToday) {
        pushChange = {
          classId: actor.classId,
          scheduleId: schedule.id,
          subject: nextSubject,
          title: nextTitle,
        };
      }
      return scheduleItemView(updated, serverToday);
    });
    if (pushChange && this.pushOutbox) {
      try {
        await this.pushOutbox.enqueueScheduleChange(pushChange);
      } catch {
        // 푸시 대기열 실패가 이미 저장된 일정 수정을 실패로 만들지 않게 한다.
        schedulesLogger.warn({ failure_code: "push_enqueue_failed" });
      }
    }
    return item;
  }

  async delete(command: DeleteScheduleCommand): Promise<void> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const preliminaryResource = await this.access.getResourceContext(
      command.actorUserId,
      command.scheduleId,
      serverToday,
    );
    if (preliminaryResource.context.role !== "teacher") {
      throw new ScheduleRoleInsufficientException("이 반의 선생님만 일정을 삭제할 수 있어요.");
    }

    await this.database.transaction().execute(async (transaction) => {
      const actor = await this.access.lockActorContext(
        transaction,
        preliminaryResource.context,
        command.actorUserId,
      );
      const schedule = await this.access.lockSchedule(
        transaction,
        actor.classId,
        command.scheduleId,
        serverToday,
      );
      const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);
      if (schedule.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(schedule.row_version);
      }

      const now = new Date();
      const deletion = transaction
        .updateTable("schedules")
        .set({
          delete_reason: command.reason,
          deleted_at: now,
          deleted_by_member_id: actor.memberId,
          row_version: sql`row_version + 1`,
          updated_at: now,
        })
        .where("id", "=", schedule.id)
        .where("class_id", "=", actor.classId)
        .where("deleted_at", "is", null)
        .where("row_version", "=", expectedRowVersion);
      const deleted =
        this.engine === "mariadb"
          ? (await deletion.executeTakeFirstOrThrow()).numUpdatedRows === 1n
          : (await deletion.returning("id").executeTakeFirst()) !== undefined;
      if (!deleted) {
        throw new ResourceVersionChangedException(schedule.row_version);
      }

      await transaction
        .insertInto("audit_logs")
        .values({
          action: "schedule.deleted",
          actor_display_name_snapshot: actor.displayName,
          actor_member_id: actor.memberId,
          actor_role_snapshot: "teacher",
          actor_user_id: command.actorUserId,
          after_json: null,
          before_json: null,
          class_id: actor.classId,
          reason: command.reason,
          request_id: command.requestId,
          target_id: schedule.id,
          target_snapshot: scheduleJson(auditSnapshot(schedule), this.engine),
          target_type: "schedule",
        })
        .execute();
    });
  }
}
