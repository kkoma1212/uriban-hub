import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { databaseDate } from "../common/date/kst-date.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { MemberListItem } from "./members.types.js";

/**
 * 담임이 가입 승인 때 학생 본인인지 확인하도록 생년월일을 덧붙인다(2026-10-01 사용자 결정).
 * 담임 권한 검사를 통과한 목록의 구성원 id만 쓰므로 다른 반·다른 학생의 생년월일은 읽지 않는다.
 * 승인 대기 학생에게만 붙인다. 승인·퇴출 뒤에는 확인할 일이 없어 내려보내지 않는다(총검수 I2-03·I5-07).
 */
@Injectable()
export class MemberBirthDateReader {
  private readonly installed: boolean;

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) environment?: ConfigService<AppEnvironment, true>,
  ) {
    this.installed =
      environment?.get("USER_BIRTH_DATES_DATABASE_INSTALLED", { infer: true }) === true;
  }

  async attach<T extends MemberListItem>(members: T[]): Promise<T[]> {
    if (!this.installed) return members;
    const pending = members.filter((member) => member.status === "pending");
    if (pending.length === 0) return members.map((member) => ({ ...member, birth_date: null }));
    const rows = await this.database
      .selectFrom("class_members as member")
      .innerJoin("users as account", "account.id", "member.user_id")
      .select(["member.id", "account.birth_date"])
      .where(
        "member.id",
        "in",
        pending.map((member) => member.id),
      )
      .execute();
    const birthDates = new Map(
      rows.map((row) => [
        String(row.id),
        row.birth_date === null ? null : databaseDate(row.birth_date),
      ]),
    );
    return members.map((member) => ({
      ...member,
      birth_date: member.status === "pending" ? (birthDates.get(member.id) ?? null) : null,
    }));
  }
}
