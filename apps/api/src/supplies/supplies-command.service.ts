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
import { ContentAudiencesService } from "../content-audiences/content-audiences.service.js";
import { isMinorTextEdit } from "../content-edits/minor-edit.js";
import { MinorEditNotAllowedException } from "../content-edits/minor-edit.errors.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { PushOutbox } from "../push-subscriptions/push-outbox.js";
import { InAppRemindersService } from "../in-app-reminders/in-app-reminders.service.js";
import type { InAppReminderResult } from "../in-app-reminders/in-app-reminders.types.js";
import { SuppliesAccessService } from "./supplies-access.service.js";
import {
  ContentRevisionChangedException,
  mapSupplyIdempotencyError,
  SupplyRoleInsufficientException,
} from "./supplies.errors.js";
import type {
  CreateSupplyCommand,
  CreateSupplyReminderCommand,
  DeleteSupplyCommand,
  SetSupplyCheckCommand,
  SupplyCheckResult,
  SupplyItem,
  UpdateSupplyCommand,
} from "./supplies.types.js";
import { supplyItemView } from "./supplies.view.js";
import type { AppEnvironment } from "../config/environment.js";
import { mariaDbDateBinding, mariaDbInsertId } from "../common/database/mariadb-values.js";
import { supplyDatabase, supplyJson } from "./mariadb/supplies-database.js";
import { supplyDate, supplyProjection, type SupplyDatabaseEngine } from "./mariadb/supplies-sql.js";

const CREATE_ROUTE = "/supplies";

interface SupplyItemJson {
  [key: string]: null | string;
  audience_mode: string;
  category: string;
  content_revision: string;
  description: string | null;
  id: string;
  needed_on: string;
  row_version: string;
  title: string;
}

const suppliesPushLogger = new Logger("SuppliesCommand");

@Injectable()
export class SuppliesCommandService {
  private readonly idempotency: IdempotencyService | MariaDbIdempotencyService;
  private readonly database: ClassHubDatabase;
  private readonly engine: SupplyDatabaseEngine;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    private readonly access: SuppliesAccessService,
    private readonly audiences: ContentAudiencesService,
    private readonly reminders: InAppRemindersService,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
    // 웹 푸시가 켜져 있을 때만 주입된다.
    @Optional() private readonly pushOutbox?: PushOutbox,
  ) {
    ({ database: this.database, engine: this.engine } = supplyDatabase(database, config));
    this.idempotency =
      this.engine === "mariadb"
        ? new MariaDbIdempotencyService(this.database)
        : new IdempotencyService(this.database);
  }

  async createReminder(command: CreateSupplyReminderCommand): Promise<InAppReminderResult> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const preliminaryResource = await this.access.getResourceContext(
      command.actorUserId,
      command.supplyId,
      serverToday,
    );
    if (preliminaryResource.context.role !== "teacher") {
      throw new SupplyRoleInsufficientException(
        "이 반의 선생님만 준비물 재알림을 요청할 수 있어요.",
      );
    }
    this.access.assertWithinStudentHistoryWindow(preliminaryResource.supply, serverToday);

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
          const supply = await this.access.lockSupply(transaction, actor.classId, command.supplyId);
          this.access.assertWithinStudentHistoryWindow(supply, serverToday);
          return {
            actorDisplayName: actor.displayName,
            actorMemberId: actor.memberId,
            classId: actor.classId,
            contentRevision: supply.content_revision,
            resourceId: supply.id,
          };
        },
        reminderType: "supply",
        requestId: command.requestId,
        resourceId: command.supplyId,
      });
    } catch (error) {
      mapSupplyIdempotencyError(error);
    }
  }

  async create(command: CreateSupplyCommand): Promise<SupplyItem> {
    const preliminary = await this.access.getCollectionContext(command.actorUserId);
    if (preliminary.role !== "teacher") {
      throw new SupplyRoleInsufficientException("이 반의 선생님만 준비물을 등록할 수 있어요.");
    }

    try {
      const result = await this.idempotency.execute<SupplyItemJson>(
        {
          actorUserId: command.actorUserId,
          idempotencyKey: command.idempotencyKey as string,
          requestHash: createIdempotencyRequestHash({
            body: {
              audience: {
                member_ids: command.audience.memberIds,
                mode: command.audience.mode,
              },
              // 종류가 해시에 없으면 같은 키로 준비물↔숙제만 바꾼 요청이
              // 거부되지 않고 첫 응답을 그대로 replay 한다(insert 는 종류를 쓴다).
              category: command.category,
              description: command.description,
              needed_on: command.neededOn,
              title: command.title,
            },
            effectiveClassId: preliminary.classId,
          }),
          routeKey: createIdempotencyRouteKey(CREATE_ROUTE, preliminary.classId),
        },
        async (transaction) => {
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
          const insertion = transaction.insertInto("supplies").values({
            audience_mode: command.audience.storedMode,
            category: command.category,
            class_id: actor.classId,
            created_by_member_id: actor.memberId,
            description: command.description,
            needed_on: supplyDate(command.neededOn, this.engine),
            title: command.title,
          });
          let created;
          if (this.engine === "mariadb") {
            const inserted = await insertion.executeTakeFirstOrThrow();
            if (inserted.numInsertedOrUpdatedRows !== 1n)
              throw new Error("Invalid supply insert result");
            created = await transaction
              .selectFrom("supplies")
              .select(supplyProjection)
              .where("id", "=", mariaDbInsertId(inserted.insertId))
              .where("class_id", "=", actor.classId)
              .executeTakeFirstOrThrow();
          } else created = await insertion.returning(supplyProjection).executeTakeFirstOrThrow();
          if (recipientIds.length > 0) {
            await transaction
              .insertInto("supply_recipients")
              .values(
                recipientIds.map((memberId) => ({
                  class_id: actor.classId,
                  member_id: memberId,
                  supply_id: created.id,
                })),
              )
              .execute();
          }
          const body = supplyItemView(created) as SupplyItemJson;

          await transaction
            .insertInto("audit_logs")
            .values({
              action: "supply.created",
              actor_display_name_snapshot: actor.displayName,
              actor_member_id: actor.memberId,
              actor_role_snapshot: "teacher",
              actor_user_id: command.actorUserId,
              after_json: supplyJson(
                {
                  audience_mode: created.audience_mode,
                  content_revision: created.content_revision,
                  deleted_at: null,
                  needed_on: body.needed_on,
                  recipient_count: recipientIds.length,
                  supply_id: created.id,
                  title: created.title,
                },
                this.engine,
              ),
              before_json: null,
              class_id: actor.classId,
              reason: null,
              request_id: command.requestId,
              target_id: created.id,
              target_snapshot: null,
              target_type: "supply",
            })
            .execute();

          return { body, statusCode: 201 };
        },
      );
      return result.body as SupplyItem;
    } catch (error) {
      mapSupplyIdempotencyError(error);
    }
  }

  async update(command: UpdateSupplyCommand): Promise<SupplyItem> {
    const preliminaryResource = await this.access.getResourceContext(
      command.actorUserId,
      command.supplyId,
    );
    if (preliminaryResource.context.role !== "teacher") {
      throw new SupplyRoleInsufficientException("이 반의 선생님만 준비물을 수정할 수 있어요.");
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
      const supply = await this.access.lockSupply(transaction, actor.classId, command.supplyId);
      const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);
      if (supply.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(supply.row_version);
      }

      const currentNeededOn = databaseDate(supply.needed_on);
      const nextTitle = command.title ?? supply.title;
      const nextDescription =
        command.description === undefined ? supply.description : command.description;
      const nextNeededOn = command.neededOn ?? currentNeededOn;
      const nextCategory = command.category ?? supply.category;
      const titleChanged = nextTitle !== supply.title;
      const descriptionChanged = nextDescription !== supply.description;
      const neededOnChanged = nextNeededOn !== currentNeededOn;
      /*
       * 종류가 바뀌면 다른 항목과 똑같이 content_revision 이 올라가고, 확인해 둔
       * 학생은 "내용이 바뀜"으로 돌아간다. 준비물이 숙제가 되는 것은 해야 할 일이
       * 달라지는 변화라 다시 확인받는 편이 맞다 — 제목·날짜와 같은 취급이다.
       */
      const categoryChanged = nextCategory !== supply.category;
      if (!titleChanged && !descriptionChanged && !neededOnChanged && !categoryChanged) {
        return supplyItemView(supply);
      }
      // 오타 수정은 판을 올리지 않아 학생 확인이 그대로 남는다(2026-10-22 사용자 결정).
      // 날짜·종류는 할 일이 달라지는 변화라 오타 수정으로 받지 않는다.
      const minorEdit = command.minorEdit === true;
      if (minorEdit && (neededOnChanged || categoryChanged)) {
        throw new MinorEditNotAllowedException("schedule");
      }
      if (
        minorEdit &&
        !isMinorTextEdit([
          [supply.title, nextTitle],
          [supply.description ?? "", nextDescription ?? ""],
        ])
      ) {
        throw new MinorEditNotAllowedException("text");
      }

      const now = new Date();
      const mutation = transaction
        .updateTable("supplies")
        .set({
          ...(categoryChanged ? { category: nextCategory } : {}),
          ...(minorEdit ? {} : { content_revision: sql`content_revision + 1` }),
          ...(descriptionChanged ? { description: nextDescription } : {}),
          ...(neededOnChanged ? { needed_on: supplyDate(nextNeededOn, this.engine) } : {}),
          row_version: sql`row_version + 1`,
          ...(titleChanged ? { title: nextTitle } : {}),
          updated_at: this.engine === "mariadb" ? mariaDbDateBinding(now) : now,
          updated_by_member_id: actor.memberId,
        })
        .where("id", "=", supply.id)
        .where("class_id", "=", actor.classId)
        .where("deleted_at", "is", null)
        .where("row_version", "=", expectedRowVersion);
      let updated;
      if (this.engine === "mariadb") {
        const result = await mutation.executeTakeFirst();
        if (result.numUpdatedRows !== 0n && result.numUpdatedRows !== 1n)
          throw new Error("Invalid supply update result");
        updated =
          result.numUpdatedRows === 0n
            ? undefined
            : await transaction
                .selectFrom("supplies")
                .select(supplyProjection)
                .where("id", "=", supply.id)
                .where("class_id", "=", actor.classId)
                .where("deleted_at", "is", null)
                .executeTakeFirstOrThrow();
      } else updated = await mutation.returning(supplyProjection).executeTakeFirst();
      if (updated === undefined) {
        throw new ResourceVersionChangedException(supply.row_version);
      }

      const before: Record<string, string> = {
        content_revision: supply.content_revision,
      };
      const after: Record<string, string> = {
        content_revision: updated.content_revision,
      };
      if (titleChanged) {
        before.title = supply.title;
        after.title = updated.title;
      }
      if (neededOnChanged) {
        before.needed_on = currentNeededOn;
        after.needed_on = databaseDate(updated.needed_on);
      }
      /*
       * 종류 변화는 감사 JSON에 남기지 않는다. audit_logs 의 키 허용목록 CHECK 가
       * supply.% 에 대해 다섯 키만 받는데, 그 제약은 이미 세 번 통째로 재작성된
       * 130줄짜리라 네 번째 재작성이 T-HUB-02·T-HUB-10 이 덴 자리다. 지금 코드도
       * description 변경을 남기지 않으므로(제목·날짜만 남긴다) 종류를 같은 취급으로
       * 두는 편이 기존 설계와 일관된다. content_revision 이 오른 사실은 남는다.
       * 종류까지 남기려면 그 제약을 안전하게 넓히는 별도 과업이 필요하다.
       */
      await transaction
        .insertInto("audit_logs")
        .values({
          action: "supply.updated",
          actor_display_name_snapshot: actor.displayName,
          actor_member_id: actor.memberId,
          actor_role_snapshot: "teacher",
          actor_user_id: command.actorUserId,
          after_json: supplyJson(after, this.engine),
          before_json: supplyJson(before, this.engine),
          class_id: actor.classId,
          reason: null,
          request_id: command.requestId,
          target_id: supply.id,
          target_snapshot: null,
          target_type: "supply",
        })
        .execute();

      // 오타 수정은 같은 판 번호가 앞뒤에 남아 감사 기록에서 구별된다(수정 재확인 푸시도 없음).
      if (!minorEdit) revised = { classId: actor.classId, title: updated.title };
      return supplyItemView(updated);
    });
    if (revised && this.pushOutbox) {
      try {
        await this.pushOutbox.enqueueRevisionReconfirm({
          classId: revised.classId,
          kind: "supply",
          resourceId: item.id,
          revision: item.content_revision,
          title: revised.title,
        });
      } catch {
        // 푸시 대기열 실패가 이미 저장된 준비물 수정을 실패로 만들지 않게 한다.
        suppliesPushLogger.warn({ failure_code: "push_enqueue_failed" });
      }
    }
    return item;
  }

  async delete(command: DeleteSupplyCommand): Promise<void> {
    const preliminaryResource = await this.access.getResourceContext(
      command.actorUserId,
      command.supplyId,
    );
    if (preliminaryResource.context.role !== "teacher") {
      throw new SupplyRoleInsufficientException("이 반의 선생님만 준비물을 삭제할 수 있어요.");
    }
    await this.database.transaction().execute(async (transaction) => {
      const actor = await this.access.lockActorContext(
        transaction,
        preliminaryResource.context,
        command.actorUserId,
        "teacher",
      );
      const supply = await this.access.lockSupply(transaction, actor.classId, command.supplyId);
      const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);
      if (supply.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(supply.row_version);
      }

      const now = new Date();
      const mutation = transaction
        .updateTable("supplies")
        .set({
          delete_reason: command.reason,
          deleted_at: this.engine === "mariadb" ? mariaDbDateBinding(now) : now,
          deleted_by_member_id: actor.memberId,
          row_version: sql`row_version + 1`,
          updated_at: this.engine === "mariadb" ? mariaDbDateBinding(now) : now,
        })
        .where("id", "=", supply.id)
        .where("class_id", "=", actor.classId)
        .where("deleted_at", "is", null)
        .where("row_version", "=", expectedRowVersion);
      let deleted;
      if (this.engine === "mariadb") {
        const result = await mutation.executeTakeFirst();
        if (result.numUpdatedRows !== 0n && result.numUpdatedRows !== 1n)
          throw new Error("Invalid supply delete result");
        deleted = result.numUpdatedRows === 1n ? { id: supply.id } : undefined;
      } else deleted = await mutation.returning("id").executeTakeFirst();
      if (deleted === undefined) {
        throw new ResourceVersionChangedException(supply.row_version);
      }

      await transaction
        .insertInto("audit_logs")
        .values({
          action: "supply.deleted",
          actor_display_name_snapshot: actor.displayName,
          actor_member_id: actor.memberId,
          actor_role_snapshot: "teacher",
          actor_user_id: command.actorUserId,
          after_json: null,
          before_json: null,
          class_id: actor.classId,
          reason: command.reason,
          request_id: command.requestId,
          target_id: supply.id,
          target_snapshot: supplyJson(
            {
              audience_mode: supply.audience_mode,
              content_revision: supply.content_revision,
              deleted_at: null,
              needed_on: databaseDate(supply.needed_on),
              supply_id: supply.id,
              title: supply.title,
            },
            this.engine,
          ),
          target_type: "supply",
        })
        .execute();
    });
  }

  async setCheck(command: SetSupplyCheckCommand, now = new Date()): Promise<SupplyCheckResult> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const preliminaryResource = await this.access.getResourceContext(
      command.actorUserId,
      command.supplyId,
      serverToday,
    );
    if (preliminaryResource.context.role !== "student") {
      throw new SupplyRoleInsufficientException("학생만 준비물 챙김 상태를 변경할 수 있습니다.");
    }

    return this.database.transaction().execute(async (transaction) => {
      const actor = await this.access.lockActorContext(
        transaction,
        preliminaryResource.context,
        command.actorUserId,
        "student",
      );
      const supply = await this.access.lockSupply(
        transaction,
        actor.classId,
        command.supplyId,
        actor.memberId,
      );
      this.access.assertStudentHistoryWindow(actor, supply, serverToday);
      const existing = await transaction
        .selectFrom("supply_checks")
        .select(["confirmed_revision", "id", "is_checked"])
        .where("supply_id", "=", supply.id)
        .where("member_id", "=", actor.memberId)
        .forUpdate()
        .executeTakeFirst();

      if (supply.content_revision !== command.contentRevision) {
        throw new ContentRevisionChangedException(supply.content_revision);
      }
      const sameState = command.isChecked
        ? existing?.is_checked === true && existing.confirmed_revision === supply.content_revision
        : existing?.is_checked === false;
      if (!sameState) {
        const timestamp = this.engine === "mariadb" ? mariaDbDateBinding(now) : now;
        if (existing === undefined) {
          await transaction
            .insertInto("supply_checks")
            .values({
              checked_at: command.isChecked ? timestamp : null,
              class_id: actor.classId,
              confirmed_revision: command.isChecked ? supply.content_revision : null,
              is_checked: command.isChecked,
              member_id: actor.memberId,
              supply_id: supply.id,
              unchecked_at: command.isChecked ? null : timestamp,
              updated_at: timestamp,
            })
            .execute();
        } else {
          await transaction
            .updateTable("supply_checks")
            .set({
              checked_at: command.isChecked ? timestamp : null,
              confirmed_revision: command.isChecked ? supply.content_revision : null,
              is_checked: command.isChecked,
              unchecked_at: command.isChecked ? null : timestamp,
              updated_at: timestamp,
            })
            .where("id", "=", existing.id)
            .execute();
        }
      }

      if (command.isChecked) {
        await this.reminders.resolve(transaction, {
          classId: actor.classId,
          contentRevision: supply.content_revision,
          memberId: actor.memberId,
          reminderType: "supply",
          resourceId: supply.id,
        });
      }

      return {
        check_state: command.isChecked ? "checked" : "unchecked",
        content_revision: supply.content_revision,
        supply_id: supply.id,
      };
    });
  }
}
