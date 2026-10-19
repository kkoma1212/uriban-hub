import { Inject, Injectable } from "@nestjs/common";

import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  LayoutDraftClassSuspendedException,
  LayoutDraftNotFoundException,
  LayoutDraftRoleInsufficientException,
} from "./layout-drafts.errors.js";

/*
 * ⚠️ 이 파일은 elections.access.service.ts 와 같은 모양이고, 이걸로 **열 번째 사본**이
 * 된다(T-HUB-20 부채 +1). 지금 추출하지 않는 이유는 아홉 벌 대조표가 아직 없기
 * 때문이다 — 기능마다 역할 판정 조건이 미묘하게 다를 수 있고, 인가 로직을 확인 없이
 * 합치면 그 차이가 조용히 사라져 구멍이 된다. 부채 카운트만 올린다.
 *
 * 다만 여기는 앞선 아홉과 다른 점이 하나 있다: **잠금(lockActor)이 없다.** 임시저장은
 * 덮어쓰기 한 번이 전부라 다른 행과 함께 맞춰야 할 상태가 없다. 없는 잠금을 흉내내면
 * 읽는 사람이 "여기도 트랜잭션이 걸려 있구나"로 잘못 읽는다.
 */

const TEACHER_ONLY_MESSAGE = "이 반의 선생님만 자리표·모둠표를 만들 수 있어요.";

export interface LayoutDraftActorContext {
  classId: string;
  memberId: string;
}

interface RawLayoutDraftActor {
  class_id: string;
  class_status: string;
  deleted_at: Date | null;
  is_active: boolean;
  member_id: string;
  profile_status: string | null;
  role: string;
  temporary_password_must_change: boolean | null;
}

@Injectable()
export class LayoutDraftsAccessService {
  constructor(@Inject(DATABASE) private readonly database: ClassHubDatabase) {}

  async teacherActor(actorUserId: string): Promise<LayoutDraftActorContext> {
    const raw = (await this.database
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
      .executeTakeFirst()) as RawLayoutDraftActor | undefined;

    if (raw === undefined || !raw.is_active || raw.deleted_at !== null) {
      throw new LayoutDraftNotFoundException();
    }
    if (raw.class_status === "suspended") throw new LayoutDraftClassSuspendedException();
    if (raw.class_status !== "active") throw new LayoutDraftNotFoundException();
    if (raw.role !== "teacher") {
      throw new LayoutDraftRoleInsufficientException(TEACHER_ONLY_MESSAGE);
    }
    /*
     * 임시 비밀번호를 아직 안 바꾼 교사는 다른 화면에서도 막힌다. 여기만 열어 두면
     * 그 계정으로 학급 자료를 만들어 둘 수 있게 된다.
     */
    if (raw.profile_status !== "active" || raw.temporary_password_must_change === true) {
      throw new LayoutDraftRoleInsufficientException(TEACHER_ONLY_MESSAGE);
    }
    return { classId: raw.class_id, memberId: raw.member_id };
  }
}
