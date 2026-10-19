import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DB } from "@classhub/db";
import { sql, type Transaction } from "kysely";

import { UnauthenticatedException } from "../auth/auth.errors.js";
import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import { addCalendarDays, databaseDate } from "../common/date/kst-date.js";
import type { ContentAudienceMode } from "../content-audiences/content-audiences.service.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AppEnvironment } from "../config/environment.js";
import { supplyDatabase, supplyTransaction } from "./mariadb/supplies-database.js";
import { supplyBigint, type SupplyDatabaseEngine } from "./mariadb/supplies-sql.js";
import {
  SupplyClassSuspendedException,
  SupplyNotFoundException,
  SupplyRoleInsufficientException,
} from "./supplies.errors.js";

export type SupplyActorRole = "student" | "teacher";

export interface SupplyAccessContext {
  classId: string;
  memberId: string;
  role: SupplyActorRole;
}

export interface SupplyResourceRow {
  audience_mode: ContentAudienceMode;
  category: string;
  class_id: string;
  content_revision: string;
  description: string | null;
  id: string;
  needed_on: Date | string;
  row_version: string;
  title: string;
}

export interface LockedSupplyActor extends SupplyAccessContext {
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
export class SuppliesAccessService {
  private readonly database: ClassHubDatabase;
  private readonly engine: SupplyDatabaseEngine;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    ({ database: this.database, engine: this.engine } = supplyDatabase(database, config));
  }

  async getCollectionContext(actorUserId: string): Promise<SupplyAccessContext> {
    const current = await this.getRawCurrentContext(actorUserId);
    if (current === undefined || current.class_status === "archived") {
      throw new SupplyNotFoundException();
    }
    return this.assertActiveContext(current);
  }

  async getResourceContext(
    actorUserId: string,
    supplyId: string,
    serverToday?: string,
  ): Promise<{ context: SupplyAccessContext; supply: SupplyResourceRow }> {
    if (!isPositiveId(supplyId)) throw new SupplyNotFoundException();

    const [current, rawSupply] = await Promise.all([
      this.getRawCurrentContext(actorUserId),
      this.database
        .selectFrom("supplies")
        .select([
          "audience_mode",
          "category",
          "class_id",
          "content_revision",
          "description",
          "id",
          "needed_on",
          "row_version",
          "title",
        ])
        .where("id", "=", supplyId)
        .where("deleted_at", "is", null)
        .executeTakeFirst(),
    ]);

    if (
      current === undefined ||
      current.class_status === "archived" ||
      rawSupply === undefined ||
      rawSupply.class_id !== current.class_id
    ) {
      throw new SupplyNotFoundException();
    }

    const context = this.assertActiveContext(current);
    const supply = rawSupply as SupplyResourceRow;
    if (context.role === "student") {
      if (supply.audience_mode !== "legacy_class") {
        const recipient = await this.database
          .selectFrom("supply_recipients")
          .select("member_id")
          .where("supply_id", "=", supply.id)
          .where("class_id", "=", context.classId)
          .where("member_id", "=", context.memberId)
          .executeTakeFirst();
        if (recipient === undefined) throw new SupplyNotFoundException();
      }
      const effectiveServerToday =
        serverToday ?? (await readDatabaseKstToday(this.database, this.engine));
      this.assertStudentHistoryWindow(context, supply, effectiveServerToday);
    }
    return { context, supply };
  }

  async lockActorContext(
    transaction: Transaction<DB>,
    preliminary: SupplyAccessContext,
    actorUserId: string,
    requiredRole: SupplyActorRole,
  ): Promise<LockedSupplyActor> {
    transaction = supplyTransaction(transaction, this.engine);
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
      throw new SupplyNotFoundException();
    }
    if (targetClass.status === "suspended") throw new SupplyClassSuspendedException();
    if (targetClass.status !== "active") throw new SupplyNotFoundException();

    const actorMember = await transaction
      .selectFrom("class_members")
      .select(["id", "role", "status", "user_id"])
      .where("id", "=", preliminary.memberId)
      .where("class_id", "=", targetClass.id)
      .where("user_id", "=", actorUserId)
      .forUpdate()
      .executeTakeFirst();
    if (actorMember === undefined || actorMember.status !== "approved") {
      throw new SupplyNotFoundException();
    }
    if (actorMember.role !== requiredRole) {
      throw new SupplyRoleInsufficientException(
        requiredRole === "teacher"
          ? "이 반의 선생님만 준비물을 관리할 수 있어요."
          : "학생만 준비물 챙김 상태를 변경할 수 있습니다.",
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
        throw new SupplyRoleInsufficientException("이 반의 선생님만 준비물을 관리할 수 있어요.");
      }
    }

    return {
      classId: targetClass.id,
      displayName: account.display_name,
      memberId: actorMember.id,
      role: requiredRole,
    };
  }

  async lockSupply(
    transaction: Transaction<DB>,
    classId: string,
    supplyId: string,
    studentMemberId?: string,
  ): Promise<SupplyResourceRow> {
    transaction = supplyTransaction(transaction, this.engine);
    if (!isPositiveId(supplyId)) throw new SupplyNotFoundException();
    let builder = transaction
      .selectFrom("supplies")
      .select([
        "audience_mode",
        "category",
        "class_id",
        "content_revision",
        "description",
        "id",
        "needed_on",
        "row_version",
        "title",
      ])
      .where("id", "=", supplyId)
      .where("class_id", "=", classId)
      .where("deleted_at", "is", null);
    if (studentMemberId !== undefined) {
      builder = builder.where(sql<boolean>`(
        supplies.audience_mode = 'legacy_class'
        OR EXISTS (
          SELECT 1
          FROM supply_recipients AS audience_recipient
          WHERE audience_recipient.supply_id = supplies.id
            AND audience_recipient.class_id = supplies.class_id
            AND audience_recipient.member_id = ${supplyBigint(studentMemberId, this.engine)}
        )
      )`);
    }
    const supply = await builder.forUpdate().executeTakeFirst();
    if (supply === undefined) throw new SupplyNotFoundException();
    return supply as SupplyResourceRow;
  }

  assertStudentHistoryWindow(
    context: SupplyAccessContext,
    supply: Pick<SupplyResourceRow, "needed_on">,
    serverToday: string,
  ): void {
    if (context.role !== "student") return;
    this.assertWithinStudentHistoryWindow(supply, serverToday);
  }

  assertWithinStudentHistoryWindow(
    supply: Pick<SupplyResourceRow, "needed_on">,
    serverToday: string,
  ): void {
    const oldestVisible = addCalendarDays(serverToday, -90);
    if (databaseDate(supply.needed_on) < oldestVisible) throw new SupplyNotFoundException();
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

  private assertActiveContext(current: RawCurrentContext): SupplyAccessContext {
    if (current.class_status === "suspended") throw new SupplyClassSuspendedException();
    if (current.class_status !== "active") throw new SupplyNotFoundException();
    if (current.role !== "student" && current.role !== "teacher") {
      throw new SupplyRoleInsufficientException();
    }
    if (
      current.role === "teacher" &&
      (current.profile_status !== "active" || current.temporary_password_must_change !== false)
    ) {
      throw new SupplyRoleInsufficientException("이 반의 선생님만 준비물을 관리할 수 있어요.");
    }
    return {
      classId: current.class_id,
      memberId: current.member_id,
      role: current.role,
    };
  }
}
