import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createMariaDbDatabase, createMysql2MariaDbPool, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, MysqlDialect, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnvironment } from "../src/config/environment.js";
import { ScheduleLinksService } from "../src/schedules/schedule-links.service.js";
import { SchedulesAccessService } from "../src/schedules/schedules-access.service.js";

const configPath = process.env.SCHEDULE_LINKS_QA_MARIADB_CONFIG;
if (
  !configPath &&
  (process.env.CLASSHUB_REQUIRE_MARIADB === "1" ||
    process.env.CI === "true" ||
    process.env.CI === "1")
) {
  throw new Error(
    "MariaDB cannot be skipped in CI/the gate. Run corepack pnpm test:mariadb-isolated.",
  );
}
const root = new URL("../../../", import.meta.url);

describe.runIf(configPath !== undefined)("schedule links on an owned TLS MariaDB", () => {
  let admin: Kysely<DB>;
  let app: Kysely<DB>;
  let links: ScheduleLinksService;
  const request = (actorUserId: string, noticeIds: string[], supplyIds: string[]) => ({
    actorUserId,
    noticeIds,
    requestId: randomUUID(),
    scheduleId: "50",
    supplyIds,
  });
  const auditCount = async () =>
    Number(
      (
        await admin
          .selectFrom("audit_logs")
          .select(sql<string>`COUNT(*)`.as("count"))
          .where("action", "=", "schedule.links_updated")
          .executeTakeFirstOrThrow()
      ).count,
    );

  beforeAll(async () => {
    const target = JSON.parse(await readFile(configPath!, "utf8"));
    expect(target.kind).toBe("classhub-schedule-links-isolated-qa");
    expect(target.database).toBe("classhub_schedule_links_qa");
    expect([3306, 3307, 5173, 5174]).not.toContain(target.port);
    const require = createRequire(new URL("packages/db/package.json", root));
    const mysql = require("mysql2");
    const connection = {
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.user,
      password: target.password,
    };
    admin = new Kysely<DB>({
      dialect: new MysqlDialect({
        pool: mysql.createPool({
          ...connection,
          ssl: { ca: target.sslCa, rejectUnauthorized: true, verifyIdentity: true },
          timezone: "Z",
          supportBigNumbers: true,
          bigNumberStrings: true,
          dateStrings: true,
          multipleStatements: true,
          connectionLimit: 3,
        }),
      }),
    });
    await sql
      .raw(await readFile(new URL("db/mariadb/migrations/0049_schedule_links.sql", root), "utf8"))
      .execute(admin);
    const grant = (
      await readFile(new URL("db/mariadb/permissions/0049_schedule_links_acl.sql", root), "utf8")
    )
      .replaceAll("classhub_mariadb_phase1_dev", target.database)
      .replaceAll("'classhub_app'@'%'", "'schedule_links_qa_app'@'localhost'");
    await sql.raw(grant).execute(admin);
    await sql
      .raw(
        `
      INSERT INTO users (id,email_normalized,display_name,password_hash,email_verified_at) VALUES
        (1,'teacher@example.invalid','합성 교사','synthetic',UTC_TIMESTAMP(6)),
        (2,'student1@example.invalid','합성 학생가','synthetic',UTC_TIMESTAMP(6)),
        (3,'student2@example.invalid','합성 학생나','synthetic',UTC_TIMESTAMP(6)),
        (9,'teacher2@example.invalid','다른 반 교사','synthetic',UTC_TIMESTAMP(6));
      INSERT INTO operators (id,email_normalized,credential_hash) VALUES (1,'operator@example.invalid',REPEAT('q',32));
      INSERT INTO teacher_profiles (user_id,temporary_password_must_change,created_by_operator_id) VALUES
        (1,FALSE,1),(9,FALSE,1);
      INSERT INTO schools (edu_office_code,school_code,school_name,school_kind,region_name,edu_office_name)
        VALUES ('B10','9000001','합성 학교','middle','합성 지역','합성 교육청');
      INSERT INTO classes (id,name,academic_year,grade,edu_office_code,school_code,expected_student_count,created_by_user_id)
        VALUES (1,'합성 1반',2026,2,'B10','9000001',2,1), (2,'합성 2반',2026,2,'B10','9000001',1,9);
      INSERT INTO class_members (id,class_id,user_id,role,status,student_number,display_name_in_class) VALUES
        (1,1,1,'teacher','approved',NULL,'합성 교사'),
        (2,1,2,'student','approved',1,'합성 학생가'),
        (3,1,3,'student','approved',2,'합성 학생나'),
        (9,2,9,'teacher','approved',NULL,'다른 반 교사');
      INSERT INTO schedules (id,class_id,title,due_date,schedule_type,created_by_member_id)
        VALUES (50,1,'미술 수행평가',CURRENT_DATE,'performance',1);
      INSERT INTO notices (id,class_id,title,content,created_by_member_id,audience_mode,published_at) VALUES
        (10,1,'반 전체 공지','내용',1,'legacy_class',UTC_TIMESTAMP(6)),
        (11,1,'학생가만 보는 공지','내용',1,'selected_snapshot',UTC_TIMESTAMP(6)),
        (12,1,'예약 공지','내용',1,'legacy_class',UTC_TIMESTAMP(6) + INTERVAL 1 DAY),
        (90,2,'다른 반 공지','내용',9,'legacy_class',UTC_TIMESTAMP(6));
      INSERT INTO notice_recipients (notice_id,class_id,member_id) VALUES (11,1,2);
      INSERT INTO supplies (id,class_id,title,needed_on,created_by_member_id,audience_mode) VALUES
        (30,1,'물감',CURRENT_DATE,1,'legacy_class'),
        (31,1,'지난 준비물',CURRENT_DATE - INTERVAL 120 DAY,1,'legacy_class'),
        (32,1,'학생나만 챙길 것',CURRENT_DATE,1,'selected_snapshot');
      INSERT INTO supply_recipients (supply_id,class_id,member_id) VALUES (32,1,3);
    `,
      )
      .execute(admin);
    app = createMariaDbDatabase<DB>(createMysql2MariaDbPool, {
      ...connection,
      sslCa: target.sslCa,
      user: target.appUser,
      password: target.appPassword,
    });
    const config = new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" });
    links = new ScheduleLinksService(app, new SchedulesAccessService(app, config), config);
  });

  beforeEach(async () => {
    await admin.deleteFrom("schedule_notice_links").execute();
    await admin.deleteFrom("schedule_supply_links").execute();
  });

  afterAll(async () => {
    await app?.destroy();
    await admin?.destroy();
  });

  it("DB는 같은 반 항목끼리만·한 번씩만 연결하고, 앱은 수정하지 못하며, 일정이 지워지면 연결도 지운다", async () => {
    await app
      .insertInto("schedule_notice_links")
      .values({ class_id: "1", schedule_id: "50", notice_id: "10" })
      .execute();
    await expect(
      app
        .insertInto("schedule_notice_links")
        .values({ class_id: "1", schedule_id: "50", notice_id: "90" })
        .execute(),
    ).rejects.toThrow(/foreign key/iu);
    await expect(
      app
        .insertInto("schedule_notice_links")
        .values({ class_id: "1", schedule_id: "50", notice_id: "10" })
        .execute(),
    ).rejects.toThrow(/duplicate/iu);
    await expect(
      sql`UPDATE schedule_notice_links SET notice_id=11 WHERE schedule_id=50`.execute(app),
    ).rejects.toThrow(/denied/iu);
    await sql
      .raw(
        `INSERT INTO schedules (id,class_id,title,due_date,schedule_type,created_by_member_id)
          VALUES (51,1,'지울 일정',CURRENT_DATE,'other',1);
         INSERT INTO schedule_supply_links (class_id,schedule_id,supply_id) VALUES (1,51,30);
         DELETE FROM schedules WHERE id=51;`,
      )
      .execute(admin);
    const remaining = await admin
      .selectFrom("schedule_supply_links")
      .select("id")
      .where("schedule_id", "=", "51")
      .execute();
    expect(remaining).toEqual([]);
  });
  it("교사는 연결을 저장하고 같은 요청을 반복해도 감사 기록이 한 번만 남는다", async () => {
    const before = await auditCount();
    const saved = await links.replace(request("1", ["10", "11", "12"], ["30", "31", "32"]));
    expect(saved.notices.map((item) => item.id)).toEqual(["10", "11", "12"]);
    expect(saved.supplies.map((item) => [item.id, item.needed_on.length])).toEqual([
      ["30", 10],
      ["31", 10],
      ["32", 10],
    ]);
    await links.replace(request("1", ["10", "11", "12"], ["30", "31", "32"]));
    expect(await auditCount()).toBe(before + 1);
  });

  it("학생에게는 게시됐고 자기에게 공개된 최근 항목만 보인다", async () => {
    await links.replace(request("1", ["10", "11", "12"], ["30", "31", "32"]));
    const first = await links.get({ actorUserId: "2", scheduleId: "50" });
    expect(first.notices.map((item) => item.id)).toEqual(["10", "11"]);
    expect(first.supplies.map((item) => item.id)).toEqual(["30"]);
    const second = await links.get({ actorUserId: "3", scheduleId: "50" });
    expect(second.notices.map((item) => item.id)).toEqual(["10"]);
    expect(second.supplies.map((item) => item.id)).toEqual(["30", "32"]);
  });

  it("빈 목록으로 교체하면 연결이 모두 풀린다", async () => {
    await links.replace(request("1", ["10"], ["30"]));
    const cleared = await links.replace(request("1", [], []));
    expect(cleared).toEqual({ notices: [], supplies: [] });
  });

  it("다른 반 공지나 없는 준비물은 연결하지 못한다", async () => {
    await expect(links.replace(request("1", ["90"], []))).rejects.toMatchObject({ status: 422 });
    await expect(links.replace(request("1", [], ["999"]))).rejects.toMatchObject({ status: 422 });
    expect((await links.get({ actorUserId: "1", scheduleId: "50" })).notices).toEqual([]);
  });

  it("학생은 연결을 바꿀 수 없다", async () => {
    await expect(links.replace(request("2", ["10"], []))).rejects.toMatchObject({ status: 403 });
  });

  it("다른 반 교사는 이 일정의 연결을 보거나 바꿀 수 없다", async () => {
    await expect(links.get({ actorUserId: "9", scheduleId: "50" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(links.replace(request("9", [], []))).rejects.toMatchObject({ status: 404 });
  });
});
