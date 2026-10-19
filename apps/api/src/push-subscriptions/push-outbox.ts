import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import { mariaDbDateBinding } from "../common/database/mariadb-values.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { nextDeliverableAt } from "./push-quiet-hours.js";
import { WebPushSender } from "./web-push-sender.js";

/*
 * 웹 푸시 대기열. 요청 시점에 바로 보내지 않고 "보내도 되는 시각" 이후에 보낸다.
 * 같은 사람·같은 tag의 대기 알림은 최신 하나로 바꿔 알림이 쌓이지 않게 한다(묶음).
 * 발송 결과는 푸시 서비스가 받았는지까지만 기록한다 — 학생이 봤다는 뜻이 아니다.
 */

export type PushDeliveryKind = "reminder" | "schedule_changed" | "help_message";

export interface PushDeliveryRequest {
  userId: string;
  classId: string;
  kind: PushDeliveryKind;
  tag: string;
  title: string;
  body: string;
  path: string;
}

export interface ProcessDueResult {
  processed: number;
  skipped: number;
}

export const PUSH_OUTBOX_BATCH_SIZE = 50;
const DONE_RETENTION_DAYS = 30;
const OUTBOX_LOCK = "classhub-push-outbox-v1";

function clip(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

@Injectable()
export class PushOutbox {
  private readonly logger = new Logger("PushOutbox");
  private readonly mariaDb: boolean;

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly sender: WebPushSender,
    config: ConfigService<AppEnvironment, true>,
  ) {
    this.mariaDb = (config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres") === "mariadb";
  }

  private time(value: Date) {
    return this.mariaDb ? mariaDbDateBinding(value) : value;
  }

  async enqueue(requests: readonly PushDeliveryRequest[], now = new Date()): Promise<number> {
    if (requests.length === 0) return 0;
    const deliverAfter = this.time(nextDeliverableAt(now));
    await this.database.transaction().execute(async (transaction) => {
      for (const request of requests) {
        await transaction
          .deleteFrom("push_deliveries")
          .where("user_id", "=", request.userId)
          .where("tag", "=", request.tag)
          .where("status", "=", "pending")
          .execute();
        await transaction
          .insertInto("push_deliveries")
          .values({
            body: clip(request.body, 200),
            class_id: request.classId,
            deliver_after: deliverAfter,
            kind: request.kind,
            path: request.path,
            tag: clip(request.tag, 64),
            title: clip(request.title, 80),
            user_id: request.userId,
          })
          .execute();
      }
    });
    return requests.length;
  }

  /** 교사가 보낸 앱 안 재알림 묶음의 학생들에게 같은 내용을 푸시로도 보낸다. */
  async enqueueReminderBatch(batchId: string, now = new Date()): Promise<number> {
    const rows = await this.database
      .selectFrom("in_app_reminder_recipients as recipient")
      .innerJoin("in_app_reminder_batches as batch", (join) =>
        join.onRef("batch.id", "=", "recipient.batch_id"),
      )
      .innerJoin("class_members as member", (join) =>
        join
          .onRef("member.id", "=", "recipient.member_id")
          .onRef("member.class_id", "=", "recipient.class_id"),
      )
      .leftJoin("notices as notice", (join) =>
        join
          .onRef("notice.id", "=", "batch.notice_id")
          .onRef("notice.class_id", "=", "batch.class_id"),
      )
      .leftJoin("supplies as supply", (join) =>
        join
          .onRef("supply.id", "=", "batch.supply_id")
          .onRef("supply.class_id", "=", "batch.class_id"),
      )
      .select([
        "member.user_id as user_id",
        "batch.class_id as class_id",
        "batch.notice_id as notice_id",
        "batch.supply_id as supply_id",
        "notice.title as notice_title",
        "supply.title as supply_title",
      ])
      .where("recipient.batch_id", "=", batchId)
      .where("member.role", "=", "student")
      .where("member.status", "=", "approved")
      .execute();
    return this.enqueue(
      rows.flatMap((row) => {
        if (row.user_id === null) return [];
        const notice = row.notice_id !== null;
        const resourceId = notice ? row.notice_id : row.supply_id;
        if (resourceId === null) return [];
        const title = (notice ? row.notice_title : row.supply_title) ?? "";
        return [
          {
            body: title === "" ? "확인하지 않은 안내가 있습니다." : `확인해 주세요: ${title}`,
            classId: String(row.class_id),
            kind: "reminder" as const,
            path: `/${notice ? "notices" : "supplies"}/${resourceId}`,
            tag: `${notice ? "notice" : "supply"}:${resourceId}`,
            title: notice ? "공지 확인 요청" : "준비물 확인 요청",
            userId: String(row.user_id),
          },
        ];
      }),
      now,
    );
  }

  /** 일정이 바뀌면 그 반의 승인된 학생에게 알린다. 여러 번 고쳐도 마지막 내용 하나만 간다. */
  async enqueueScheduleChange(
    change: { classId: string; scheduleId: string; title: string; subject: string | null },
    now = new Date(),
  ): Promise<number> {
    const students = await this.database
      .selectFrom("class_members")
      .select("user_id")
      .where("class_id", "=", change.classId)
      .where("role", "=", "student")
      .where("status", "=", "approved")
      .execute();
    const label = change.subject ? `${change.subject} ${change.title}` : change.title;
    return this.enqueue(
      students.flatMap(({ user_id: userId }) =>
        userId === null
          ? []
          : [
              {
                body: `${label} 일정이 바뀌었습니다. 바뀐 내용을 확인해 주세요.`,
                classId: change.classId,
                kind: "schedule_changed" as const,
                path: `/schedules/${change.scheduleId}`,
                tag: `schedule:${change.scheduleId}`,
                title: "일정 변경",
                userId: String(userId),
              },
            ],
      ),
      now,
    );
  }

  /**
   * 공지·준비물 내용이 바뀌면, 이전 내용을 이미 확인한 학생에게만 다시 확인을 요청한다.
   * 아직 확인하지 않은 학생은 열 때 어차피 새 내용을 보므로 보내지 않는다.
   * 같은 자료의 재알림과 tag를 공유해, 대기 중이면 하나로 묶인다.
   */
  async enqueueRevisionReconfirm(
    change: {
      kind: "notice" | "supply";
      classId: string;
      resourceId: string;
      title: string;
      revision: string;
    },
    now = new Date(),
  ): Promise<number> {
    const notice = change.kind === "notice";
    const members = notice
      ? await this.database
          .selectFrom("notice_reads as confirmation")
          .innerJoin("class_members as member", (join) =>
            join
              .onRef("member.id", "=", "confirmation.member_id")
              .onRef("member.class_id", "=", "confirmation.class_id"),
          )
          .select("member.user_id as user_id")
          .where("confirmation.notice_id", "=", change.resourceId)
          .where("confirmation.class_id", "=", change.classId)
          .where("confirmation.confirmed_revision", "<", change.revision)
          .where("member.role", "=", "student")
          .where("member.status", "=", "approved")
          .execute()
      : await this.database
          .selectFrom("supply_checks as confirmation")
          .innerJoin("class_members as member", (join) =>
            join
              .onRef("member.id", "=", "confirmation.member_id")
              .onRef("member.class_id", "=", "confirmation.class_id"),
          )
          .select("member.user_id as user_id")
          .where("confirmation.supply_id", "=", change.resourceId)
          .where("confirmation.class_id", "=", change.classId)
          .where("confirmation.confirmed_revision", "is not", null)
          .where("confirmation.confirmed_revision", "<", change.revision)
          .where("member.role", "=", "student")
          .where("member.status", "=", "approved")
          .execute();
    return this.enqueue(
      members.flatMap(({ user_id: userId }) =>
        userId === null
          ? []
          : [
              {
                body: `바뀐 내용을 다시 확인해 주세요: ${change.title}`,
                classId: change.classId,
                kind: "reminder" as const,
                path: `/${notice ? "notices" : "supplies"}/${change.resourceId}`,
                tag: `${change.kind}:${change.resourceId}`,
                title: notice ? "공지 내용 변경" : "준비물 내용 변경",
                userId: String(userId),
              },
            ],
      ),
      now,
    );
  }

  /** 보낼 시각이 된 알림을 보낸다. 여러 프로세스가 동시에 돌아도 한 곳만 처리한다. */
  async processDue(now = new Date()): Promise<ProcessDueResult> {
    const result: ProcessDueResult = { processed: 0, skipped: 0 };
    await this.database.connection().execute(async (connection) => {
      const locked = this.mariaDb
        ? await sql<{
            acquired: number | string | null;
          }>`SELECT GET_LOCK(${OUTBOX_LOCK}, 0) AS acquired`.execute(connection)
        : await sql<{
            acquired: boolean;
          }>`SELECT pg_try_advisory_lock(hashtextextended(${OUTBOX_LOCK}, 0)) AS acquired`.execute(
            connection,
          );
      const acquired = locked.rows[0]?.acquired;
      if (!(acquired === true || Number(acquired) === 1)) return;
      try {
        const due = await connection
          .selectFrom("push_deliveries")
          .select(["id", "user_id", "class_id", "title", "body", "path", "tag"])
          .where("status", "=", "pending")
          .where("deliver_after", "<=", this.time(now))
          .orderBy("deliver_after")
          .orderBy("id")
          .limit(PUSH_OUTBOX_BATCH_SIZE)
          .execute();
        for (const delivery of due) {
          const eligible = await connection
            .selectFrom("class_members as member")
            .innerJoin("users as user", "user.id", "member.user_id")
            .select("member.id")
            .where("member.user_id", "=", delivery.user_id)
            .where("member.class_id", "=", delivery.class_id)
            .where("member.status", "=", "approved")
            .where("user.is_active", "=", true)
            .where("user.deleted_at", "is", null)
            .executeTakeFirst();
          const outcome = eligible
            ? await this.sender.sendToUser(String(delivery.user_id), {
                body: delivery.body,
                path: delivery.path,
                tag: delivery.tag,
                title: delivery.title,
              })
            : { accepted: 0, failed: 0, removed: 0 };
          if (eligible) result.processed += 1;
          else result.skipped += 1;
          await connection
            .updateTable("push_deliveries")
            .set({
              accepted_count: outcome.accepted,
              completed_at: this.time(now),
              failed_count: outcome.failed,
              removed_count: outcome.removed,
              status: "done",
            })
            .where("id", "=", delivery.id)
            .where("status", "=", "pending")
            .execute();
        }
        const cutoff = new Date(now.getTime() - DONE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        await connection
          .deleteFrom("push_deliveries")
          .where("status", "=", "done")
          .where("completed_at", "<", this.time(cutoff))
          .execute();
      } finally {
        if (this.mariaDb) await sql`SELECT RELEASE_LOCK(${OUTBOX_LOCK})`.execute(connection);
        else
          await sql`SELECT pg_advisory_unlock(hashtextextended(${OUTBOX_LOCK}, 0))`.execute(
            connection,
          );
      }
    });
    if (result.processed + result.skipped > 0)
      this.logger.log({ action: "push_outbox", ...result });
    return result;
  }
}
