import {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  IdempotencyService,
  MariaDbIdempotencyService,
} from "@classhub/db";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import { mariaDbDateBinding, mariaDbInsertId } from "../common/database/mariadb-values.js";
import type { AppEnvironment } from "../config/environment.js";
import { parseRequiredIfMatch, ResourceVersionChangedException } from "../common/http/if-match.js";
import { ContentAudiencesService } from "../content-audiences/content-audiences.service.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { PushOutbox } from "../push-subscriptions/push-outbox.js";
import { InAppRemindersService } from "../in-app-reminders/in-app-reminders.service.js";
import type { InAppReminderResult } from "../in-app-reminders/in-app-reminders.types.js";
import { NoticesAccessService } from "./notices-access.service.js";
import {
  noticeDatabaseEngine,
  noticeJson,
  noticeMariaDbRowCodec,
  noticeProjection,
} from "./notices.database.js";
import {
  mapNoticeIdempotencyError,
  NoticeContentRevisionChangedException,
  NoticeRoleInsufficientException,
} from "./notices.errors.js";
import type {
  ConfirmNoticeCommand,
  CreateNoticeCommand,
  CreateNoticeReminderCommand,
  DeleteNoticeCommand,
  NoticeConfirmationResult,
  NoticeItem,
  UpdateNoticeCommand,
} from "./notices.types.js";
import { noticeItemView } from "./notices.view.js";

const CREATE_ROUTE = "/notices";

interface NoticeItemJson {
  [key: string]: boolean | string;
  audience_mode: string;
  category: string;
  content: string;
  content_revision: string;
  id: string;
  is_important: boolean;
  published_at: string;
  row_version: string;
  title: string;
}

const noticesPushLogger = new Logger("NoticesCommand");

@Injectable()
export class NoticesCommandService {
  private readonly idempotency: IdempotencyService | MariaDbIdempotencyService;
  private readonly dialect: "postgres" | "mariadb";

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly access: NoticesAccessService,
    private readonly audiences: ContentAudiencesService,
    private readonly reminders: InAppRemindersService,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
    // 웹 푸시가 켜져 있을 때만 주입된다.
    @Optional() private readonly pushOutbox?: PushOutbox,
  ) {
    this.dialect = noticeDatabaseEngine(config);
    if (this.dialect === "mariadb") this.database = database.withPlugin(noticeMariaDbRowCodec);
    this.idempotency =
      this.dialect === "mariadb"
        ? new MariaDbIdempotencyService(this.database)
        : new IdempotencyService(this.database);
  }

  async createReminder(command: CreateNoticeReminderCommand): Promise<InAppReminderResult> {
    const preliminaryResource = await this.access.getResourceContext(
      command.actorUserId,
      command.noticeId,
    );
    if (preliminaryResource.context.role !== "teacher") {
      throw new NoticeRoleInsufficientException("이 반의 선생님만 공지 재알림을 요청할 수 있어요.");
    }

    try {
      return await this.reminders.create({
        actorUserId: command.actorUserId,
        contentRevision: command.contentRevision,
        idempotencyKey: command.idempotencyKey,
        lockContext: async (transaction) => {
          const actor = await this.access.lockActorContext(
            transaction,
            preliminaryResource.context,
            command.actorUserId,
            "teacher",
          );
          const notice = await this.access.lockNotice(transaction, actor.classId, command.noticeId);
          return {
            actorDisplayName: actor.displayName,
            actorMemberId: actor.memberId,
            classId: actor.classId,
            contentRevision: notice.content_revision,
            resourceId: notice.id,
          };
        },
        reminderType: "notice",
        requestId: command.requestId,
        resourceId: command.noticeId,
      });
    } catch (error) {
      mapNoticeIdempotencyError(error);
    }
  }

  async create(command: CreateNoticeCommand): Promise<NoticeItem> {
    const preliminary = await this.access.getCollectionContext(command.actorUserId);
    if (preliminary.role !== "teacher") {
      throw new NoticeRoleInsufficientException("이 반의 선생님만 공지를 등록할 수 있어요.");
    }

    try {
      const result = await this.idempotency.execute<NoticeItemJson>(
        {
          actorUserId: command.actorUserId,
          idempotencyKey: command.idempotencyKey as string,
          requestHash: createIdempotencyRequestHash({
            body: {
              audience: {
                member_ids: command.audience.memberIds,
                mode: command.audience.mode,
              },
              category: command.category,
              content: command.content,
              is_important: command.isImportant,
              title: command.title,
            },
            effectiveClassId: preliminary.classId,
          }),
          routeKey: createIdempotencyRouteKey(CREATE_ROUTE, preliminary.classId),
        },
        async (transaction) => {
          const clock =
            this.dialect === "mariadb"
              ? (
                  await sql<{ notice_clock: string }>`
            SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS notice_clock
          `.execute(transaction)
                ).rows[0]?.notice_clock
              : undefined;
          if (this.dialect === "mariadb" && clock === undefined)
            throw new Error("Invalid notice clock.");
          const actor = await this.access.lockActorContext(
            transaction,
            preliminary,
            command.actorUserId,
            "teacher",
          );
          const recipientIds = await this.audiences.resolveRecipientIds(
            transaction,
            actor.classId,
            command.audience,
          );
          const insertion = transaction.insertInto("notices").values({
            audience_mode: command.audience.storedMode,
            category: command.category,
            class_id: actor.classId,
            content: command.content,
            created_by_member_id: actor.memberId,
            is_important: command.isImportant,
            title: command.title,
            ...(clock === undefined
              ? {}
              : {
                  created_at: mariaDbDateBinding(clock),
                  published_at: mariaDbDateBinding(clock),
                  updated_at: mariaDbDateBinding(clock),
                }),
          });
          let created;
          if (this.dialect === "mariadb") {
            const inserted = await insertion.executeTakeFirstOrThrow();
            if (inserted.numInsertedOrUpdatedRows !== 1n)
              throw new Error("Invalid notice insert result.");
            created = await transaction
              .selectFrom("notices")
              .select(noticeProjection)
              .where("id", "=", mariaDbInsertId(inserted.insertId))
              .where("class_id", "=", actor.classId)
              .executeTakeFirstOrThrow();
          } else created = await insertion.returning(noticeProjection).executeTakeFirstOrThrow();
          if (recipientIds.length > 0) {
            await transaction
              .insertInto("notice_recipients")
              .values(
                recipientIds.map((memberId) => ({
                  class_id: actor.classId,
                  member_id: memberId,
                  notice_id: created.id,
                  ...(clock === undefined ? {} : { created_at: mariaDbDateBinding(clock) }),
                })),
              )
              .execute();
          }
          const body = noticeItemView(created) as NoticeItemJson;

          await transaction
            .insertInto("audit_logs")
            .values({
              action: "notice.created",
              actor_display_name_snapshot: actor.displayName,
              actor_member_id: actor.memberId,
              actor_role_snapshot: "teacher",
              actor_user_id: command.actorUserId,
              after_json: noticeJson(
                {
                  audience_mode: created.audience_mode,
                  category: created.category,
                  content_revision: created.content_revision,
                  deleted_at: null,
                  is_important: created.is_important,
                  notice_id: created.id,
                  published_at: body.published_at,
                  recipient_count: recipientIds.length,
                  title: created.title,
                },
                this.dialect,
              ),
              before_json: null,
              class_id: actor.classId,
              ...(clock === undefined ? {} : { created_at: mariaDbDateBinding(clock) }),
              reason: null,
              request_id: command.requestId,
              target_id: created.id,
              target_snapshot: null,
              target_type: "notice",
            })
            .execute();

          return { body, statusCode: 201 };
        },
      );
      return result.body as NoticeItem;
    } catch (error) {
      mapNoticeIdempotencyError(error);
    }
  }

  async update(command: UpdateNoticeCommand): Promise<NoticeItem> {
    const preliminaryResource = await this.access.getResourceContext(
      command.actorUserId,
      command.noticeId,
    );
    if (preliminaryResource.context.role !== "teacher") {
      throw new NoticeRoleInsufficientException("이 반의 선생님만 공지를 수정할 수 있어요.");
    }

    // 커밋된 뒤에만 수정본 재확인 푸시를 대기열에 넣는다.
    let revised: { classId: string; title: string } | undefined;
    const item = await this.database.transaction().execute(async (transaction) => {
      const actor = await this.access.lockActorContext(
        transaction,
        preliminaryResource.context,
        command.actorUserId,
        "teacher",
      );
      const notice = await this.access.lockNotice(transaction, actor.classId, command.noticeId);
      const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);
      if (notice.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(notice.row_version);
      }

      const nextTitle = command.title ?? notice.title;
      const nextContent = command.content ?? notice.content;
      const nextIsImportant = command.isImportant ?? notice.is_important;
      const nextCategory = command.category ?? notice.category;
      const titleChanged = nextTitle !== notice.title;
      const contentChanged = nextContent !== notice.content;
      const importanceChanged = nextIsImportant !== notice.is_important;
      const categoryChanged = nextCategory !== notice.category;
      const contentRevisionChanged = titleChanged || contentChanged;
      if (!contentRevisionChanged && !importanceChanged && !categoryChanged) {
        return noticeItemView(notice);
      }

      const now = new Date();
      const mutation = transaction
        .updateTable("notices")
        .set({
          ...(categoryChanged ? { category: nextCategory } : {}),
          ...(contentChanged ? { content: nextContent } : {}),
          ...(contentRevisionChanged ? { content_revision: sql`content_revision + 1` } : {}),
          ...(importanceChanged ? { is_important: nextIsImportant } : {}),
          row_version: sql`row_version + 1`,
          ...(titleChanged ? { title: nextTitle } : {}),
          updated_at: this.dialect === "mariadb" ? mariaDbDateBinding(now) : now,
          updated_by_member_id: actor.memberId,
        })
        .where("id", "=", notice.id)
        .where("class_id", "=", actor.classId)
        .where("deleted_at", "is", null)
        .where("row_version", "=", expectedRowVersion);
      let updated;
      if (this.dialect === "mariadb") {
        const result = await mutation.executeTakeFirst();
        if (result.numUpdatedRows !== 0n && result.numUpdatedRows !== 1n)
          throw new Error("Invalid notice update result.");
        updated =
          result.numUpdatedRows === 0n
            ? undefined
            : await transaction
                .selectFrom("notices")
                .select(noticeProjection)
                .where("id", "=", notice.id)
                .where("class_id", "=", actor.classId)
                .where("deleted_at", "is", null)
                .executeTakeFirstOrThrow();
      } else updated = await mutation.returning(noticeProjection).executeTakeFirst();
      if (updated === undefined) {
        throw new ResourceVersionChangedException(notice.row_version);
      }

      const before: Record<string, boolean | string> = {};
      const after: Record<string, boolean | string> = {};
      if (contentRevisionChanged) {
        before.content_revision = notice.content_revision;
        after.content_revision = updated.content_revision;
      }
      if (titleChanged) {
        before.title = notice.title;
        after.title = updated.title;
      }
      if (importanceChanged) {
        before.is_important = notice.is_important;
        after.is_important = updated.is_important;
      }
      if (categoryChanged) {
        before.category = notice.category;
        after.category = updated.category;
      }
      await transaction
        .insertInto("audit_logs")
        .values({
          action: "notice.updated",
          actor_display_name_snapshot: actor.displayName,
          actor_member_id: actor.memberId,
          actor_role_snapshot: "teacher",
          actor_user_id: command.actorUserId,
          after_json: noticeJson(after, this.dialect),
          before_json: noticeJson(before, this.dialect),
          class_id: actor.classId,
          reason: null,
          request_id: command.requestId,
          target_id: notice.id,
          target_snapshot: null,
          target_type: "notice",
        })
        .execute();

      if (contentRevisionChanged) revised = { classId: actor.classId, title: updated.title };
      return noticeItemView(updated);
    });
    if (revised && this.pushOutbox) {
      try {
        await this.pushOutbox.enqueueRevisionReconfirm({
          classId: revised.classId,
          kind: "notice",
          resourceId: item.id,
          revision: item.content_revision,
          title: revised.title,
        });
      } catch {
        // 푸시 대기열 실패가 이미 저장된 공지 수정을 실패로 만들지 않게 한다.
        noticesPushLogger.warn({ failure_code: "push_enqueue_failed" });
      }
    }
    return item;
  }

  async delete(command: DeleteNoticeCommand): Promise<void> {
    const preliminaryResource = await this.access.getResourceContext(
      command.actorUserId,
      command.noticeId,
    );
    if (preliminaryResource.context.role !== "teacher") {
      throw new NoticeRoleInsufficientException("이 반의 선생님만 공지를 삭제할 수 있어요.");
    }

    await this.database.transaction().execute(async (transaction) => {
      const actor = await this.access.lockActorContext(
        transaction,
        preliminaryResource.context,
        command.actorUserId,
        "teacher",
      );
      const notice = await this.access.lockNotice(transaction, actor.classId, command.noticeId);
      const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);
      if (notice.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(notice.row_version);
      }

      const now = new Date();
      const mutation = transaction
        .updateTable("notices")
        .set({
          delete_reason: command.reason,
          deleted_at: this.dialect === "mariadb" ? mariaDbDateBinding(now) : now,
          deleted_by_member_id: actor.memberId,
          row_version: sql`row_version + 1`,
          updated_at: this.dialect === "mariadb" ? mariaDbDateBinding(now) : now,
        })
        .where("id", "=", notice.id)
        .where("class_id", "=", actor.classId)
        .where("deleted_at", "is", null)
        .where("row_version", "=", expectedRowVersion);
      let deleted;
      if (this.dialect === "mariadb") {
        const result = await mutation.executeTakeFirst();
        if (result.numUpdatedRows !== 0n && result.numUpdatedRows !== 1n)
          throw new Error("Invalid notice delete result.");
        deleted = result.numUpdatedRows === 1n ? { id: notice.id } : undefined;
      } else deleted = await mutation.returning("id").executeTakeFirst();
      if (deleted === undefined) {
        throw new ResourceVersionChangedException(notice.row_version);
      }

      await transaction
        .insertInto("audit_logs")
        .values({
          action: "notice.deleted",
          actor_display_name_snapshot: actor.displayName,
          actor_member_id: actor.memberId,
          actor_role_snapshot: "teacher",
          actor_user_id: command.actorUserId,
          after_json: null,
          before_json: null,
          class_id: actor.classId,
          reason: command.reason,
          request_id: command.requestId,
          target_id: notice.id,
          target_snapshot: noticeJson(
            {
              audience_mode: notice.audience_mode,
              category: notice.category,
              content_revision: notice.content_revision,
              deleted_at: null,
              is_important: notice.is_important,
              notice_id: notice.id,
              published_at: notice.published_at.toISOString(),
              title: notice.title,
            },
            this.dialect,
          ),
          target_type: "notice",
        })
        .execute();
    });
  }

  async confirm(
    command: ConfirmNoticeCommand,
    now = new Date(),
  ): Promise<NoticeConfirmationResult> {
    const preliminaryResource = await this.access.getResourceContext(
      command.actorUserId,
      command.noticeId,
    );
    if (preliminaryResource.context.role !== "student") {
      throw new NoticeRoleInsufficientException("학생만 공지를 확인할 수 있습니다.");
    }

    return this.database.transaction().execute(async (transaction) => {
      const actor = await this.access.lockActorContext(
        transaction,
        preliminaryResource.context,
        command.actorUserId,
        "student",
      );
      const notice = await this.access.lockNotice(
        transaction,
        actor.classId,
        command.noticeId,
        actor.memberId,
      );
      const existing = await transaction
        .selectFrom("notice_reads")
        .select(["confirmed_revision", "id"])
        .where("notice_id", "=", notice.id)
        .where("member_id", "=", actor.memberId)
        .forUpdate()
        .executeTakeFirst();

      if (notice.content_revision !== command.contentRevision) {
        throw new NoticeContentRevisionChangedException(notice.content_revision);
      }
      if (existing?.confirmed_revision !== notice.content_revision) {
        const timestamp = this.dialect === "mariadb" ? mariaDbDateBinding(now) : now;
        if (existing === undefined) {
          await transaction
            .insertInto("notice_reads")
            .values({
              class_id: actor.classId,
              confirmed_at: timestamp,
              confirmed_revision: notice.content_revision,
              first_confirmed_at: timestamp,
              member_id: actor.memberId,
              notice_id: notice.id,
            })
            .execute();
        } else {
          await transaction
            .updateTable("notice_reads")
            .set({
              confirmed_at: timestamp,
              confirmed_revision: notice.content_revision,
            })
            .where("id", "=", existing.id)
            .execute();
        }
      }

      await this.reminders.resolve(transaction, {
        classId: actor.classId,
        contentRevision: notice.content_revision,
        memberId: actor.memberId,
        reminderType: "notice",
        resourceId: notice.id,
      });

      return {
        confirmation_state: "confirmed",
        content_revision: notice.content_revision,
        notice_id: notice.id,
      };
    });
  }
}
