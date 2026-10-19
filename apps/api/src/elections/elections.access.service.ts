import type { DB } from "@classhub/db";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Transaction } from "kysely";

import { UnauthenticatedException } from "../auth/auth.errors.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AppEnvironment } from "../config/environment.js";
import {
  electionDatabase,
  electionTransaction,
  type ElectionDatabaseEngine,
} from "./mariadb/elections-database.js";
import {
  ElectionClassSuspendedException,
  ElectionNotFoundException,
  ElectionRoleInsufficientException,
} from "./elections.errors.js";

/*
 * 이 파일은 duty-rosters.access.service.ts 와 같은 모양이고, 이걸로 **아홉 벌**이
 * 된다(T-HUB-20). 지금 추출하지 않는 이유는 여덟 벌 대조표가 아직 없기 때문이다 —
 * 기능마다 역할 판정 조건이 미묘하게 다를 수 있고, 인가 로직을 확인 없이 합치면
 * 그 차이가 조용히 사라져 구멍이 된다. 부채 카운트만 올린다.
 */

const TEACHER_ONLY_MESSAGE = "이 반의 선생님만 선거를 관리할 수 있어요.";

export interface ElectionActorContext {
  classId: string;
  displayName: string;
  memberId: string;
  role: "student" | "teacher";
}

interface RawElectionActor {
  class_id: string;
  class_status: string;
  deleted_at: Date | null;
  display_name: string;
  is_active: boolean;
  member_id: string;
  profile_status: string | null;
  role: string;
  temporary_password_must_change: boolean | null;
}

@Injectable()
export class ElectionsAccessService {
  private readonly database: ClassHubDatabase;
  private readonly engine: ElectionDatabaseEngine;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    ({ database: this.database, engine: this.engine } = electionDatabase(database, config));
  }

  async actor(actorUserId: string): Promise<ElectionActorContext> {
    const raw = await this.database
      .selectFrom("class_members as member")
      .innerJoin("classes as class", "class.id", "member.class_id")
      .innerJoin("users as user", "user.id", "member.user_id")
      .leftJoin("teacher_profiles as profile", "profile.user_id", "member.user_id")
      .select([
        "class.id as class_id",
        "class.status as class_status",
        "member.id as member_id",
        "member.role",
        "profile.status as profile_status",
        "profile.temporary_password_must_change",
        "user.deleted_at",
        "user.display_name",
        "user.is_active",
      ])
      .where("member.user_id", "=", actorUserId)
      .where("member.status", "=", "approved")
      .executeTakeFirst();
    return this.assertActor(raw as RawElectionActor | undefined);
  }

  assertTeacher(actor: ElectionActorContext, message: string): void {
    if (actor.role !== "teacher") throw new ElectionRoleInsufficientException(message);
  }

  async lockActor(
    transaction: Transaction<DB>,
    preliminary: ElectionActorContext,
    actorUserId: string,
  ): Promise<ElectionActorContext> {
    transaction = electionTransaction(transaction, this.engine);
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
      throw new ElectionNotFoundException();
    }
    if (targetClass.status === "suspended") throw new ElectionClassSuspendedException();
    if (targetClass.status !== "active") throw new ElectionNotFoundException();
    const member = await transaction
      .selectFrom("class_members")
      .select(["id", "role", "status", "user_id"])
      .where("id", "=", preliminary.memberId)
      .where("class_id", "=", targetClass.id)
      .where("user_id", "=", actorUserId)
      .forUpdate()
      .executeTakeFirst();
    if (
      member === undefined ||
      member.status !== "approved" ||
      (member.role !== "student" && member.role !== "teacher")
    ) {
      throw new ElectionNotFoundException();
    }
    if (member.role === "teacher") {
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
        throw new ElectionRoleInsufficientException(TEACHER_ONLY_MESSAGE);
      }
    }
    return {
      classId: targetClass.id,
      displayName: account.display_name,
      memberId: member.id,
      role: member.role,
    };
  }

  private assertActor(raw: RawElectionActor | undefined): ElectionActorContext {
    if (
      raw === undefined ||
      !raw.is_active ||
      raw.deleted_at !== null ||
      raw.class_status === "archived"
    ) {
      throw new ElectionNotFoundException();
    }
    if (raw.class_status === "suspended") throw new ElectionClassSuspendedException();
    if (raw.class_status !== "active") throw new ElectionNotFoundException();
    if (raw.role !== "student" && raw.role !== "teacher") {
      throw new ElectionRoleInsufficientException();
    }
    if (
      raw.role === "teacher" &&
      (raw.profile_status !== "active" || raw.temporary_password_must_change !== false)
    ) {
      throw new ElectionRoleInsufficientException(TEACHER_ONLY_MESSAGE);
    }
    return {
      classId: raw.class_id,
      displayName: raw.display_name,
      memberId: raw.member_id,
      role: raw.role,
    };
  }
}
