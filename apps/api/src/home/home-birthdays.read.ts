import { sql } from "kysely";

import type { ClassHubDatabase } from "../database/database.module.js";
import type { HomeDatabaseEngine } from "./home.database.js";
import type { HomeBirthday } from "./home.types.js";

/**
 * 오늘(한국 날짜) 생일인 우리 반 학생 — 본인이 "생일 알리기"를 켠 경우만(2026-10-01 사용자 결정).
 * 이름만 돌려주고 태어난 해·날짜는 보내지 않는다. 2월 29일생은 평년이면 2월 28일에 보인다.
 */
export async function readHomeBirthdays(
  database: ClassHubDatabase,
  classId: string,
  today: string,
  engine: HomeDatabaseEngine,
): Promise<HomeBirthday[]> {
  const monthDay = today.slice(5);
  const year = Number(today.slice(0, 4));
  const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = monthDay === "02-28" && !leapYear ? ["02-28", "02-29"] : [monthDay];
  const birthMonthDay =
    engine === "mariadb"
      ? sql<string>`DATE_FORMAT(account.birth_date, '%m-%d')`
      : sql<string>`to_char(account.birth_date, 'MM-DD')`;
  const rows = await database
    .selectFrom("class_members as member")
    .innerJoin("users as account", "account.id", "member.user_id")
    .select(["member.id as member_id", "member.display_name_in_class", "account.display_name"])
    .where("member.class_id", "=", classId)
    .where("member.role", "=", "student")
    .where("member.status", "=", "approved")
    .where("account.is_active", "=", true)
    .where("account.deleted_at", "is", null)
    .where("account.birthday_shared", "=", true)
    .where(birthMonthDay, "in", days)
    .orderBy("member.student_number")
    .orderBy("member.id")
    .execute();
  return rows.map((row) => ({
    display_name: row.display_name_in_class ?? row.display_name,
    member_id: String(row.member_id),
  }));
}
