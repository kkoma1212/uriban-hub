import { sql } from "kysely";
import { databaseDate } from "../common/date/kst-date.js";
import type { ClassHubDatabase } from "../database/database.module.js";
import type {
  TeacherHomeFollowup,
  TeacherHomeNoticeFollowup,
  TeacherHomeSupplyFollowup,
} from "./home.types.js";
import {
  homeDate,
  homeCurrentTimestamp,
  homeFilteredCount,
  type HomeDatabaseEngine,
} from "./home.database.js";

/*
 * 교사 후속카드 집계의 대상 판정. 예전에는 WHERE로만 걸려 대상 밖 학생이 집계에서
 * 통째로 빠졌고, 그 수를 따로 알릴 방법도 없었다(P1-07). FILTER로 옮겨 같은 쿼리에서
 * 대상 밖 인원까지 센다. 상세 화면과 수가 일치해야 하므로 양쪽을 함께 바꾼다.
 */
const NOTICE_FOLLOWUP_AUDIENCE = sql<boolean>`(
  followup_notice.audience_mode = 'legacy_class'
  OR followup_recipient.member_id IS NOT NULL
)`;
const SUPPLY_FOLLOWUP_AUDIENCE = sql<boolean>`(
  followup_supply.audience_mode = 'legacy_class'
  OR followup_recipient.member_id IS NOT NULL
)`;

export async function readHomeTeacherFollowups(
  database: ClassHubDatabase,
  classId: string,
  today: string,
  tomorrow: string,
  engine: HomeDatabaseEngine,
): Promise<TeacherHomeFollowup[]> {
  const noticeRows = await database
    .selectFrom("notices as followup_notice")
    .innerJoin("class_members as followup_member", (join) =>
      join
        .onRef("followup_member.class_id", "=", "followup_notice.class_id")
        .on("followup_member.role", "=", "student")
        .on("followup_member.status", "=", "approved"),
    )
    .innerJoin("users as followup_account", (join) =>
      join
        .onRef("followup_account.id", "=", "followup_member.user_id")
        .on("followup_account.is_active", "=", true)
        .on("followup_account.deleted_at", "is", null),
    )
    .leftJoin("notice_recipients as followup_recipient", (join) =>
      join
        .onRef("followup_recipient.notice_id", "=", "followup_notice.id")
        .onRef("followup_recipient.class_id", "=", "followup_notice.class_id")
        .onRef("followup_recipient.member_id", "=", "followup_member.id"),
    )
    .leftJoin("notice_reads as followup_read", (join) =>
      join
        .onRef("followup_read.member_id", "=", "followup_member.id")
        .onRef("followup_read.notice_id", "=", "followup_notice.id"),
    )
    .select((expression) => [
      "followup_notice.content_revision",
      "followup_notice.id",
      "followup_notice.is_important",
      "followup_notice.published_at",
      "followup_notice.title",
      homeFilteredCount(
        sql<boolean>`${NOTICE_FOLLOWUP_AUDIENCE}
            AND followup_read.confirmed_revision = followup_notice.content_revision`,
        engine,
      ).as("confirmed"),
      homeFilteredCount(
        sql<boolean>`${NOTICE_FOLLOWUP_AUDIENCE}
            AND followup_read.confirmed_revision < followup_notice.content_revision`,
        engine,
      ).as("modified_unconfirmed"),
      homeFilteredCount(
        sql<boolean>`${NOTICE_FOLLOWUP_AUDIENCE} AND followup_read.id IS NULL`,
        engine,
      ).as("unread"),
      // 상세 화면과 같은 수를 내야 한다 — 통합테스트가 두 화면의 집계가
      // 일치하는지 대조한다. 대상 밖 학생을 여기서만 빼면 두 화면이 갈린다.
      homeFilteredCount(sql<boolean>`NOT ${NOTICE_FOLLOWUP_AUDIENCE}`, engine).as(
        "excluded_member_count",
      ),
      expression
        .selectFrom("in_app_reminder_batches as followup_reminder")
        .select(sql<Date | null>`MAX(followup_reminder.created_at)`.as("requested_at"))
        .whereRef("followup_reminder.class_id", "=", "followup_notice.class_id")
        .whereRef("followup_reminder.notice_id", "=", "followup_notice.id")
        .whereRef("followup_reminder.content_revision", "=", "followup_notice.content_revision")
        .as("last_reminder_requested_at"),
    ])
    .where("followup_notice.class_id", "=", classId)
    .where("followup_notice.deleted_at", "is", null)
    .where("followup_notice.published_at", "<=", homeCurrentTimestamp(engine))
    .groupBy([
      "followup_notice.content_revision",
      "followup_notice.id",
      "followup_notice.is_important",
      "followup_notice.published_at",
      "followup_notice.title",
    ])
    .$if(engine === "mariadb", (query) =>
      query.groupBy(["followup_notice.class_id", "followup_notice.audience_mode"]),
    )
    .having(
      // 대상 술어가 WHERE에서 FILTER로 옮겨졌으므로 여기에도 걸어야 한다.
      // 빼먹으면 대상 밖 학생 때문에 카드가 영원히 미해소로 남는다 —
      // 교사가 해소할 방법이 없는 알림이다.
      sql<boolean>`${homeFilteredCount(
        sql<boolean>`${NOTICE_FOLLOWUP_AUDIENCE}
          AND (
            followup_read.confirmed_revision < followup_notice.content_revision
            OR followup_read.id IS NULL
          )`,
        engine,
      )} > 0`,
    )
    .orderBy("followup_notice.is_important", "desc")
    .orderBy("followup_notice.published_at", "desc")
    .orderBy("followup_notice.id", "desc")
    .limit(3)
    .execute();

  const supplyRows = await database
    .selectFrom("supplies as followup_supply")
    .innerJoin("class_members as followup_member", (join) =>
      join
        .onRef("followup_member.class_id", "=", "followup_supply.class_id")
        .on("followup_member.role", "=", "student")
        .on("followup_member.status", "=", "approved"),
    )
    .innerJoin("users as followup_account", (join) =>
      join
        .onRef("followup_account.id", "=", "followup_member.user_id")
        .on("followup_account.is_active", "=", true)
        .on("followup_account.deleted_at", "is", null),
    )
    .leftJoin("supply_recipients as followup_recipient", (join) =>
      join
        .onRef("followup_recipient.supply_id", "=", "followup_supply.id")
        .onRef("followup_recipient.class_id", "=", "followup_supply.class_id")
        .onRef("followup_recipient.member_id", "=", "followup_member.id"),
    )
    .leftJoin("supply_checks as followup_check", (join) =>
      join
        .onRef("followup_check.member_id", "=", "followup_member.id")
        .onRef("followup_check.supply_id", "=", "followup_supply.id"),
    )
    .select((expression) => [
      /* "가져올 것"과 "할 것"을 갈라 부르려면 교사 줄도 분류를 알아야 한다(BLUE-10). */
      "followup_supply.category",
      "followup_supply.content_revision",
      "followup_supply.created_at",
      "followup_supply.id",
      "followup_supply.needed_on",
      "followup_supply.title",
      homeFilteredCount(
        sql<boolean>`${SUPPLY_FOLLOWUP_AUDIENCE}
          AND followup_check.is_checked = TRUE
          AND followup_check.confirmed_revision = followup_supply.content_revision`,
        engine,
      ).as("checked"),
      homeFilteredCount(
        sql<boolean>`${SUPPLY_FOLLOWUP_AUDIENCE}
          AND followup_check.is_checked = TRUE
          AND followup_check.confirmed_revision < followup_supply.content_revision`,
        engine,
      ).as("modified_unconfirmed"),
      homeFilteredCount(
        sql<boolean>`${SUPPLY_FOLLOWUP_AUDIENCE}
          AND (followup_check.id IS NULL OR followup_check.is_checked = FALSE)`,
        engine,
      ).as("unchecked"),
      homeFilteredCount(sql<boolean>`NOT ${SUPPLY_FOLLOWUP_AUDIENCE}`, engine).as(
        "excluded_member_count",
      ),
      expression
        .selectFrom("in_app_reminder_batches as followup_reminder")
        .select(sql<Date | null>`MAX(followup_reminder.created_at)`.as("requested_at"))
        .whereRef("followup_reminder.class_id", "=", "followup_supply.class_id")
        .whereRef("followup_reminder.supply_id", "=", "followup_supply.id")
        .whereRef("followup_reminder.content_revision", "=", "followup_supply.content_revision")
        .as("last_reminder_requested_at"),
    ])
    .where("followup_supply.class_id", "=", classId)
    .where("followup_supply.deleted_at", "is", null)
    .where("followup_supply.needed_on", "in", [homeDate(today, engine), homeDate(tomorrow, engine)])
    .groupBy([
      "followup_supply.content_revision",
      "followup_supply.created_at",
      "followup_supply.id",
      "followup_supply.needed_on",
      "followup_supply.title",
    ])
    .$if(engine === "mariadb", (query) =>
      query.groupBy([
        "followup_supply.class_id",
        "followup_supply.audience_mode",
        "followup_supply.category",
      ]),
    )
    .having(
      // 공지 쪽과 같은 이유로 대상 술어를 함께 건다.
      sql<boolean>`${homeFilteredCount(
        sql<boolean>`${SUPPLY_FOLLOWUP_AUDIENCE}
          AND (
            (
              followup_check.is_checked = TRUE
              AND followup_check.confirmed_revision < followup_supply.content_revision
            )
            OR followup_check.id IS NULL
            OR followup_check.is_checked = FALSE
          )`,
        engine,
      )} > 0`,
    )
    .orderBy("followup_supply.needed_on", "asc")
    .orderBy("followup_supply.created_at", "desc")
    .orderBy("followup_supply.id", "desc")
    .limit(3)
    .execute();

  const notices: TeacherHomeNoticeFollowup[] = noticeRows.map((row) => ({
    content_revision: row.content_revision,
    counts: {
      confirmed: Number(row.confirmed),
      excluded_member_count: Number(row.excluded_member_count),
      modified_unconfirmed: Number(row.modified_unconfirmed),
      unread: Number(row.unread),
    },
    is_important: row.is_important,
    last_reminder_requested_at: row.last_reminder_requested_at?.toISOString() ?? null,
    published_at: row.published_at.toISOString(),
    resource_id: row.id,
    resource_type: "notice",
    title: row.title,
  }));
  const supplies: TeacherHomeSupplyFollowup[] = supplyRows.map((row) => ({
    /* DB 는 text 로 준다. 392줄의 준비물 목록과 같은 방식으로 좁힌다. */
    category: row.category as TeacherHomeSupplyFollowup["category"],
    content_revision: row.content_revision,
    counts: {
      checked: Number(row.checked),
      excluded_member_count: Number(row.excluded_member_count),
      modified_unconfirmed: Number(row.modified_unconfirmed),
      unchecked: Number(row.unchecked),
    },
    last_reminder_requested_at: row.last_reminder_requested_at?.toISOString() ?? null,
    needed_on: databaseDate(row.needed_on),
    resource_id: row.id,
    resource_type: "supply",
    title: row.title,
  }));

  return [
    ...notices.filter((notice) => notice.is_important),
    ...supplies.filter((supply) => supply.needed_on === today),
    ...supplies.filter((supply) => supply.needed_on === tomorrow),
    ...notices.filter((notice) => !notice.is_important),
  ].slice(0, 3);
}
