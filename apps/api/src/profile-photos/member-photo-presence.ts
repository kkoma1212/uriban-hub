import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { ProfilePhotoActor } from "./profile-photo.types.js";
import { visibleClassPhotos } from "./profile-photos.service.js";

/**
 * 목록 화면이 사진 없는 구성원의 사진까지 요청해 실패(404)가 쌓이던 것을 막는다(첫 사용 점검 19번,
 * 2026-10-23 사용자 결정). 사진 조회와 같은 조건(visibleClassPhotos)으로, 지금 사진을 내줄 구성원 번호만 고른다.
 * 사진 기능이 꺼진 환경에는 표가 없을 수 있어 조회하지 않고 모두 '없음'으로 둔다. 사진 바이트는 읽지 않는다.
 */
@Injectable()
export class MemberPhotoPresenceReader {
  private readonly enabled: boolean;

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) environment?: ConfigService<AppEnvironment, true>,
  ) {
    this.enabled = environment?.get("PROFILE_PHOTOS_ENABLED", { infer: true }) === true;
  }

  async memberIdsWithPhoto(
    actor: ProfilePhotoActor,
    memberIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const ids = [...new Set(memberIds)];
    if (!this.enabled || actor.currentClassId === null || ids.length === 0) return new Set();
    const rows = await visibleClassPhotos(this.database, actor.userId, actor.currentClassId)
      .select("target.id as member_id")
      .where("target.id", "in", ids)
      .execute();
    return new Set(rows.map((row) => String(row.member_id)));
  }

  /** 현재 반 담임 사진을 지금 받을 수 있는가 — 담임 사진 경로(current-class-teacher)와 같은 조건. */
  async classTeacherHasPhoto(actor: ProfilePhotoActor): Promise<boolean> {
    if (!this.enabled || actor.currentClassId === null) return false;
    const row = await visibleClassPhotos(this.database, actor.userId, actor.currentClassId)
      .select("target.id as member_id")
      .where("target.role", "=", "teacher")
      .executeTakeFirst();
    return row !== undefined;
  }
}
