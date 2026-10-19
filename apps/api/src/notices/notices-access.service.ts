import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DB } from "@classhub/db";
import { sql, type Transaction } from "kysely";

import { UnauthenticatedException } from "../auth/auth.errors.js";
import type { AppEnvironment } from "../config/environment.js";
import { noticeDatabaseEngine, noticeMariaDbRowCodec } from "./notices.database.js";
import type { ContentAudienceMode } from "../content-audiences/content-audiences.service.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  NoticeClassSuspendedException,
  NoticeNotFoundException,
  NoticeRoleInsufficientException,
} from "./notices.errors.js";

export type NoticeActorRole = "student" | "teacher";

export interface NoticeAccessContext {
  classId: string;
  memberId: string;
  role: NoticeActorRole;
}

export interface NoticeResourceRow {
  audience_mode: ContentAudienceMode;
  category: "general" | "performance";
  class_id: string;
  content: string;
  content_revision: string;
  id: string;
  is_important: boolean;
  published_at: Date;
  row_version: string;
  title: string;
}

export interface LockedNoticeActor extends NoticeAccessContext {
  displayName: string;
}

interface RawCurrentContext {
  class_id: string;
  class_status: string;
  member_id: string;
  profile_status: string | null;
  role: string;
  temporary_password_must_change: boolean | null;
}

const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;

function isPositiveId(value: string): boolean {
  if (!/^[1-9][0-9]*$/u.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_DATABASE_ID;
  } catch {
    return false;
  }
}

@Injectable()
export class NoticesAccessService {
  private readonly dialect: "postgres" | "mariadb";
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    this.dialect = noticeDatabaseEngine(config);
    if (this.dialect === "mariadb") this.database = database.withPlugin(noticeMariaDbRowCodec);
  }

  private publicationClock() {
    return this.dialect === "mariadb" ? sql<Date>`UTC_TIMESTAMP(6)` : sql<Date>`CURRENT_TIMESTAMP`;
  }

  async getCollectionContext(actorUserId: string): Promise<NoticeAccessContext> {
    const current = await this.getRawCurrentContext(actorUserId);
    if (current === undefined || current.class_status === "archived") {
      throw new NoticeNotFoundException();
    }
    return this.assertActiveContext(current);
  }

  async getResourceContext(
    actorUserId: string,
    noticeId: string,
  ): Promise<{ context: NoticeAccessContext; notice: NoticeResourceRow }> {
    if (!isPositiveId(noticeId)) throw new NoticeNotFoundException();

    const [current, rawNotice] = await Promise.all([
      this.getRawCurrentContext(actorUserId),
      this.database
        .selectFrom("notices")
        .select([
          "audience_mode",
          "category",
          "class_id",
          "content",
          "content_revision",
          "id",
          "is_important",
          "published_at",
          "row_version",
          "title",
        ])
        .where("id", "=", noticeId)
        .where("deleted_at", "is", null)
        .where("published_at", "<=", this.publicationClock())
        .executeTakeFirst(),
    ]);

    if (
      current === undefined ||
      current.class_status === "archived" ||
      rawNotice === undefined ||
      rawNotice.class_id !== current.class_id
    ) {
      throw new NoticeNotFoundException();
    }

    const context = this.assertActiveContext(current);
    const notice = rawNotice as NoticeResourceRow;
    if (context.role === "student" && notice.audience_mode !== "legacy_class") {
      const recipient = await this.database
        .selectFrom("notice_recipients")
        .select("member_id")
        .where("notice_id", "=", notice.id)
        .where("class_id", "=", context.classId)
        .where("member_id", "=", context.memberId)
        .executeTakeFirst();
      if (recipient === undefined) throw new NoticeNotFoundException();
    }

    return { context, notice };
  }

  async lockActorContext(
    transaction: Transaction<DB>,
    preliminary: NoticeAccessContext,
    actorUserId: string,
    requiredRole: NoticeActorRole,
  ): Promise<LockedNoticeActor> {
    if (this.dialect === "mariadb") transaction = transaction.withPlugin(noticeMariaDbRowCodec);
    const account = await transaction
      .selectFrom("users")
      .select(["deleted_at", "display_name", "is_active"])
      .where("id", "=", actorUserId)
      .forUpdate()
      .executeTakeFirst();
    if (account === undefined || !account.is_active || account.deleted_at !== null) {
      throw new UnauthenticatedException();
    }

    const targetClass = await transaction
      .selectFrom("classes")
      .select(["id", "status"])
      .where("id", "=", preliminary.classId)
      .forUpdate()
      .executeTakeFirst();
    if (targetClass === undefined || targetClass.status === "archived") {
      throw new NoticeNotFoundException();
    }
    if (targetClass.status === "suspended") throw new NoticeClassSuspendedException();
    if (targetClass.status !== "active") throw new NoticeNotFoundException();

    const actorMember = await transaction
      .selectFrom("class_members")
      .select(["id", "role", "status", "user_id"])
      .where("id", "=", preliminary.memberId)
      .where("class_id", "=", targetClass.id)
      .where("user_id", "=", actorUserId)
      .forUpdate()
      .executeTakeFirst();
    if (actorMember === undefined || actorMember.status !== "approved") {
      throw new NoticeNotFoundException();
    }
    if (actorMember.role !== requiredRole) {
      throw new NoticeRoleInsufficientException(
        requiredRole === "teacher"
          ? "이 반의 선생님만 공지를 관리할 수 있어요."
          : "학생만 공지를 확인할 수 있습니다.",
      );
    }

    if (requiredRole === "teacher") {
      const profile = await transaction
        .selectFrom("teacher_profiles")
        .select(["status", "temporary_password_must_change"])
        .where("user_id", "=", actorUserId)
        .executeTakeFirst();
      if (
        profile === undefined ||
        profile.status !== "active" ||
        profile.temporary_password_must_change
      ) {
        throw new NoticeRoleInsufficientException("이 반의 선생님만 공지를 관리할 수 있어요.");
      }
    }

    return {
      classId: targetClass.id,
      displayName: account.display_name,
      memberId: actorMember.id,
      role: requiredRole,
    };
  }

  async lockNotice(
    transaction: Transaction<DB>,
    classId: string,
    noticeId: string,
    studentMemberId?: string,
  ): Promise<NoticeResourceRow> {
    if (this.dialect === "mariadb") transaction = transaction.withPlugin(noticeMariaDbRowCodec);
    if (!isPositiveId(noticeId)) throw new NoticeNotFoundException();
    let builder = transaction
      .selectFrom("notices")
      .select([
        "audience_mode",
        "category",
        "class_id",
        "content",
        "content_revision",
        "id",
        "is_important",
        "published_at",
        "row_version",
        "title",
      ])
      .where("id", "=", noticeId)
      .where("class_id", "=", classId)
      .where("deleted_at", "is", null)
      .where("published_at", "<=", this.publicationClock());
    if (studentMemberId !== undefined) {
      builder = builder.where(sql<boolean>`(
        notices.audience_mode = 'legacy_class'
        OR EXISTS (
          SELECT 1
          FROM notice_recipients AS audience_recipient
          WHERE audience_recipient.notice_id = notices.id
            AND audience_recipient.class_id = notices.class_id
            AND audience_recipient.member_id = ${this.dialect === "mariadb" ? sql`${studentMemberId}` : sql`${studentMemberId}::bigint`}
        )
      )`);
    }
    const notice = await builder.forUpdate().executeTakeFirst();
    if (notice === undefined) throw new NoticeNotFoundException();
    return notice as NoticeResourceRow;
  }

  private async getRawCurrentContext(actorUserId: string): Promise<RawCurrentContext | undefined> {
    return this.database
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
  }

  private assertActiveContext(current: RawCurrentContext): NoticeAccessContext {
    if (current.class_status === "suspended") throw new NoticeClassSuspendedException();
    if (current.class_status !== "active") throw new NoticeNotFoundException();
    if (current.role !== "student" && current.role !== "teacher") {
      throw new NoticeRoleInsufficientException();
    }
    if (
      current.role === "teacher" &&
      (current.profile_status !== "active" || current.temporary_password_must_change !== false)
    ) {
      throw new NoticeRoleInsufficientException("이 반의 선생님만 공지를 관리할 수 있어요.");
    }
    return {
      classId: current.class_id,
      memberId: current.member_id,
      role: current.role,
    };
  }
}
