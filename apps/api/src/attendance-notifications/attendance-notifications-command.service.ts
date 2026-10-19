import { createIdempotencyRequestHash, createIdempotencyRouteKey, type DB } from "@classhub/db";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppEnvironment } from "../config/environment.js";
import { mariaDbInsertId } from "../common/database/mariadb-values.js";
import {
  attendanceDatabaseEngine,
  attendanceDate,
  attendanceJson,
  attendanceMariaDbRowCodec,
  type AttendanceDatabaseEngine,
} from "./attendance-notifications.database.js";
import { sql, type Transaction } from "kysely";

import { parseRequiredIfMatch, ResourceVersionChangedException } from "../common/http/if-match.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  AttendanceNotificationsAccessService,
  type AttendancePreliminaryResource,
  type LockedAttendanceActor,
  type LockedAttendanceRow,
} from "./attendance-notifications-access.service.js";
import { assertFreshAttendanceDate } from "./attendance-notifications-clock.js";
import {
  AttendanceNotificationAlreadyAcknowledgedException,
  AttendanceNotificationStateConflictException,
  mapAttendanceIdempotencyError,
  parseRequiredServerToday,
} from "./attendance-notifications-command.errors.js";
import type {
  AttendanceMutationItem,
  AttendanceStateCommand,
  CreateAttendanceCommand,
  CreateAttendanceResult,
  UpdateAttendanceCommand,
} from "./attendance-notifications-command.types.js";
import { attendanceMutationItem } from "./attendance-notifications-command.view.js";
import { AttendanceNotificationsIdempotencyService } from "./attendance-notifications-idempotency.service.js";
import { AttendanceRoleInsufficientException } from "./attendance-notifications.errors.js";

const CREATE_ROUTE = "/attendance-notifications";
const RETURNING_FIELDS = [
  "acknowledged_at",
  "expected_time",
  "id",
  "notification_type",
  "row_version",
  "status",
  "submitted_at",
  "updated_at",
] as const;

function snapshot(row: LockedAttendanceRow | AttendanceMutationItem, notificationDate: string) {
  return {
    attendance_notification_id: row.id,
    notification_date: notificationDate,
    notification_type: row.notification_type,
    status: row.status,
  };
}

function normalizedExpectedTime(value: string | null): string | null {
  return value === null ? null : value.slice(0, 5);
}

@Injectable()
export class AttendanceNotificationsCommandService {
  private readonly engine: AttendanceDatabaseEngine;
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly access: AttendanceNotificationsAccessService,
    private readonly idempotency: AttendanceNotificationsIdempotencyService,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    this.engine = attendanceDatabaseEngine(config);
    if (this.engine === "mariadb") this.database = database.withPlugin(attendanceMariaDbRowCodec);
  }

  async create(command: CreateAttendanceCommand): Promise<CreateAttendanceResult> {
    const serverToday = parseRequiredServerToday(command.serverToday);
    const preliminary = await this.access.getCollectionContext(command.actorUserId);
    if (preliminary.role !== "student") {
      throw new AttendanceRoleInsufficientException("학생만 출결 연락을 제출할 수 있습니다.");
    }

    try {
      const result = await this.idempotency.execute({
        actorUserId: command.actorUserId,
        beforeCommit: async (transaction) => {
          await assertFreshAttendanceDate(transaction, serverToday, this.engine);
        },
        beforeLookup: async (transaction) => {
          await this.access.lockCreateContext(
            transaction,
            preliminary,
            command.actorUserId,
            serverToday,
          );
        },
        idempotencyKey: command.idempotencyKey,
        operation: async (transaction) => {
          const locked = await this.access.lockCreateContext(
            transaction,
            preliminary,
            command.actorUserId,
            serverToday,
          );
          if (locked.existing !== undefined && locked.existing.status !== "canceled") {
            throw new AttendanceNotificationStateConflictException(
              "오늘 제출한 출결 연락이 이미 있습니다.",
            );
          }

          let row;
          if (locked.existing === undefined) {
            const insertion = transaction.insertInto("attendance_notifications").values({
              class_id: locked.actor.classId,
              expected_time: command.expectedTime,
              member_id: locked.actor.memberId,
              notification_date: attendanceDate(serverToday, this.engine),
              notification_type: command.notificationType,
              status: "pending",
              submitted_at: locked.clock.databaseNow,
              updated_at: locked.clock.databaseNow,
            });
            row =
              this.engine === "mariadb"
                ? await this.readMutation(
                    transaction,
                    mariaDbInsertId((await insertion.executeTakeFirstOrThrow()).insertId),
                    locked.actor.classId,
                  )
                : await insertion.returning(RETURNING_FIELDS).executeTakeFirstOrThrow();
          } else {
            const reactivation = transaction
              .updateTable("attendance_notifications")
              .set({
                acknowledged_at: null,
                acknowledged_by_member_id: null,
                expected_time: command.expectedTime,
                notification_type: command.notificationType,
                row_version: sql`row_version + 1`,
                status: "pending",
                submitted_at: locked.clock.databaseNow,
                updated_at: locked.clock.databaseNow,
              })
              .where("id", "=", locked.existing.id)
              .where("class_id", "=", locked.actor.classId)
              .where("member_id", "=", locked.actor.memberId)
              .where("notification_date", "=", attendanceDate(serverToday, this.engine))
              .where("status", "=", "canceled")
              .where("row_version", "=", locked.existing.row_version);
            if (this.engine === "mariadb") {
              if ((await reactivation.executeTakeFirstOrThrow()).numUpdatedRows !== 1n)
                throw new ResourceVersionChangedException(locked.existing.row_version);
              row = await this.readMutation(transaction, locked.existing.id, locked.actor.classId);
            } else row = await reactivation.returning(RETURNING_FIELDS).executeTakeFirstOrThrow();
          }
          const body = attendanceMutationItem(row);
          await this.insertAudit(
            transaction,
            locked.actor,
            command.actorUserId,
            command.requestId,
            "attendance_notification.created",
            row.id,
            null,
            snapshot(body, serverToday),
          );
          return { body, statusCode: locked.existing === undefined ? 201 : 200 };
        },
        requestHash: createIdempotencyRequestHash({
          body: {
            expected_time: command.expectedTime,
            notification_date: serverToday,
            notification_type: command.notificationType,
          },
          effectiveClassId: preliminary.classId,
        }),
        routeKey: createIdempotencyRouteKey(CREATE_ROUTE, preliminary.classId),
      });
      return { item: result.body, statusCode: result.statusCode };
    } catch (error) {
      mapAttendanceIdempotencyError(error);
    }
  }

  async update(command: UpdateAttendanceCommand): Promise<AttendanceMutationItem> {
    const serverToday = parseRequiredServerToday(command.serverToday);
    const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);
    const preliminary = await this.studentResource(command.actorUserId, command.attendanceId);

    return this.database.transaction().execute(async (transaction) => {
      const locked = await this.access.lockResourceContext(
        transaction,
        preliminary,
        command.actorUserId,
        serverToday,
      );
      this.assertStudentPending(locked.notification);
      if (locked.notification.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(locked.notification.row_version);
      }

      const typeChanged = locked.notification.notification_type !== command.notificationType;
      const expectedTimeChanged =
        normalizedExpectedTime(locked.notification.expected_time) !== command.expectedTime;
      if (!typeChanged && !expectedTimeChanged) {
        await assertFreshAttendanceDate(transaction, serverToday, this.engine);
        return attendanceMutationItem(locked.notification);
      }

      const updatedQuery = transaction
        .updateTable("attendance_notifications")
        .set({
          expected_time: command.expectedTime,
          notification_type: command.notificationType,
          row_version: sql`row_version + 1`,
          updated_at: locked.clock.databaseNow,
        })
        .where("id", "=", locked.notification.id)
        .where("class_id", "=", locked.actor.classId)
        .where("member_id", "=", locked.actor.memberId)
        .where("notification_date", "=", attendanceDate(serverToday, this.engine))
        .where("status", "=", "pending")
        .where("row_version", "=", expectedRowVersion);
      const updated =
        this.engine === "mariadb"
          ? (await updatedQuery.executeTakeFirstOrThrow()).numUpdatedRows === 1n
            ? await this.readMutation(transaction, locked.notification.id, locked.actor.classId)
            : undefined
          : await updatedQuery.returning(RETURNING_FIELDS).executeTakeFirst();
      if (updated === undefined) {
        throw new ResourceVersionChangedException(locked.notification.row_version);
      }
      const body = attendanceMutationItem(updated);
      await this.insertAudit(
        transaction,
        locked.actor,
        command.actorUserId,
        command.requestId,
        "attendance_notification.updated",
        updated.id,
        snapshot(locked.notification, serverToday),
        snapshot(body, serverToday),
      );
      await assertFreshAttendanceDate(transaction, serverToday, this.engine);
      return body;
    });
  }

  async cancel(command: AttendanceStateCommand): Promise<AttendanceMutationItem> {
    const serverToday = parseRequiredServerToday(command.serverToday);
    const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);
    const preliminary = await this.studentResource(command.actorUserId, command.attendanceId);

    return this.database.transaction().execute(async (transaction) => {
      const locked = await this.access.lockResourceContext(
        transaction,
        preliminary,
        command.actorUserId,
        serverToday,
      );
      this.assertStudentPending(locked.notification);
      if (locked.notification.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(locked.notification.row_version);
      }
      const canceledQuery = transaction
        .updateTable("attendance_notifications")
        .set({
          row_version: sql`row_version + 1`,
          status: "canceled",
          updated_at: locked.clock.databaseNow,
        })
        .where("id", "=", locked.notification.id)
        .where("class_id", "=", locked.actor.classId)
        .where("member_id", "=", locked.actor.memberId)
        .where("notification_date", "=", attendanceDate(serverToday, this.engine))
        .where("status", "=", "pending")
        .where("row_version", "=", expectedRowVersion);
      const canceled =
        this.engine === "mariadb"
          ? (await canceledQuery.executeTakeFirstOrThrow()).numUpdatedRows === 1n
            ? await this.readMutation(transaction, locked.notification.id, locked.actor.classId)
            : undefined
          : await canceledQuery.returning(RETURNING_FIELDS).executeTakeFirst();
      if (canceled === undefined) {
        throw new ResourceVersionChangedException(locked.notification.row_version);
      }
      const body = attendanceMutationItem(canceled);
      await this.insertAudit(
        transaction,
        locked.actor,
        command.actorUserId,
        command.requestId,
        "attendance_notification.canceled",
        canceled.id,
        snapshot(locked.notification, serverToday),
        snapshot(body, serverToday),
      );
      await assertFreshAttendanceDate(transaction, serverToday, this.engine);
      return body;
    });
  }

  async acknowledge(command: AttendanceStateCommand): Promise<AttendanceMutationItem> {
    const serverToday = parseRequiredServerToday(command.serverToday);
    const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);
    const preliminary = await this.teacherResource(command.actorUserId, command.attendanceId);

    return this.database.transaction().execute(async (transaction) => {
      const locked = await this.access.lockResourceContext(
        transaction,
        preliminary,
        command.actorUserId,
        serverToday,
      );
      if (locked.notification.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(locked.notification.row_version);
      }
      if (locked.notification.status !== "pending") {
        throw new AttendanceNotificationStateConflictException(
          locked.notification.status === "acknowledged"
            ? "이미 확인한 출결 연락입니다."
            : "취소된 출결 연락은 확인할 수 없습니다.",
        );
      }
      const acknowledgedQuery = transaction
        .updateTable("attendance_notifications")
        .set({
          acknowledged_at: locked.clock.databaseNow,
          acknowledged_by_member_id: locked.actor.memberId,
          row_version: sql`row_version + 1`,
          status: "acknowledged",
          updated_at: locked.clock.databaseNow,
        })
        .where("id", "=", locked.notification.id)
        .where("class_id", "=", locked.actor.classId)
        .where("member_id", "=", preliminary.targetMemberId)
        .where("notification_date", "=", attendanceDate(serverToday, this.engine))
        .where("status", "=", "pending")
        .where("row_version", "=", expectedRowVersion);
      const acknowledged =
        this.engine === "mariadb"
          ? (await acknowledgedQuery.executeTakeFirstOrThrow()).numUpdatedRows === 1n
            ? await this.readMutation(transaction, locked.notification.id, locked.actor.classId)
            : undefined
          : await acknowledgedQuery.returning(RETURNING_FIELDS).executeTakeFirst();
      if (acknowledged === undefined) {
        throw new ResourceVersionChangedException(locked.notification.row_version);
      }
      const body = attendanceMutationItem(acknowledged);
      await this.insertAudit(
        transaction,
        locked.actor,
        command.actorUserId,
        command.requestId,
        "attendance_notification.acknowledged",
        acknowledged.id,
        snapshot(locked.notification, serverToday),
        snapshot(body, serverToday),
      );
      await assertFreshAttendanceDate(transaction, serverToday, this.engine);
      return body;
    });
  }

  private async readMutation(transaction: Transaction<DB>, id: string, classId: string) {
    return transaction
      .selectFrom("attendance_notifications")
      .select(RETURNING_FIELDS)
      .where("id", "=", id)
      .where("class_id", "=", classId)
      .executeTakeFirstOrThrow();
  }

  private async studentResource(
    actorUserId: string,
    attendanceId: string,
  ): Promise<AttendancePreliminaryResource> {
    const preliminary = await this.access.getResourceContext(actorUserId, attendanceId);
    if (preliminary.context.role !== "student") {
      throw new AttendanceRoleInsufficientException(
        "학생만 본인의 출결 연락을 변경할 수 있습니다.",
      );
    }
    return preliminary;
  }

  private async teacherResource(
    actorUserId: string,
    attendanceId: string,
  ): Promise<AttendancePreliminaryResource> {
    const preliminary = await this.access.getResourceContext(actorUserId, attendanceId);
    if (preliminary.context.role !== "teacher") {
      throw new AttendanceRoleInsufficientException(
        "이 반의 선생님만 출결 연락을 확인할 수 있어요.",
      );
    }
    return preliminary;
  }

  private assertStudentPending(notification: LockedAttendanceRow): void {
    if (notification.status === "acknowledged") {
      throw new AttendanceNotificationAlreadyAcknowledgedException();
    }
    if (notification.status !== "pending") {
      throw new AttendanceNotificationStateConflictException("취소된 출결 연락입니다.");
    }
  }

  private async insertAudit(
    transaction: Transaction<DB>,
    actor: LockedAttendanceActor,
    actorUserId: string,
    requestId: string,
    action:
      | "attendance_notification.acknowledged"
      | "attendance_notification.canceled"
      | "attendance_notification.created"
      | "attendance_notification.updated",
    targetId: string,
    before: null | ReturnType<typeof snapshot>,
    after: null | ReturnType<typeof snapshot>,
  ): Promise<void> {
    await transaction
      .insertInto("audit_logs")
      .values({
        action,
        actor_display_name_snapshot: actor.displayName,
        actor_member_id: actor.memberId,
        actor_role_snapshot: actor.role,
        actor_user_id: actorUserId,
        after_json: attendanceJson(after, this.engine),
        before_json: attendanceJson(before, this.engine),
        class_id: actor.classId,
        reason: null,
        request_id: requestId,
        target_id: targetId,
        target_snapshot: null,
        target_type: "attendance_notification",
      })
      .execute();
  }
}
