import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createMariaDbDatabase, createMysql2MariaDbPool, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, MysqlDialect, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnvironment } from "../src/config/environment.js";
import { includeMemberInClassWideContent } from "../src/content-audiences/class-wide-recipients.js";
import { ContentAudiencesService } from "../src/content-audiences/content-audiences.service.js";
import { NoticesAccessService } from "../src/notices/notices-access.service.js";
import {
  PastClassNotFoundException,
  PastClassesService,
} from "../src/updates/past-classes.service.js";
import { UpdatesService } from "../src/updates/updates.service.js";

const configPath = process.env.PAST_CLASSES_QA_MARIADB_CONFIG;
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

/*
 * 합성 데이터: 1반(2025, 교사가 10일 전 종료)·2반(현재 반)·3반(운영자 강제 종료)·
 * 4반(400일 전 종료)·5반(임시 비밀번호 교사의 반, 5일 전 종료).
 * 사용자: 1 교사A · 2 학생가(1반 종료 뒤 2반 재학) · 3 대기 중이었던 학생 · 4 중도 퇴장 학생 ·
 * 5 임시 비밀번호 교사 · 6 강제 종료 반 학생 · 7 오래된 반 학생 · 8 반을 넘긴 교사 · 9 2반 교사.
 */
describe.runIf(configPath !== undefined)("past classes on an owned TLS MariaDB", () => {
  let admin: Kysely<DB>;
  let app: Kysely<DB>;
  let pastClasses: PastClassesService;
  const updatesOf = (userId: string, classId: string, search?: string) =>
    pastClasses.listUpdates(userId, classId, {
      filter: "all",
      ...(search === undefined ? {} : { search }),
    });
  const titles = async (userId: string, classId: string, search?: string) =>
    (await updatesOf(userId, classId, search)).items.map((item) => item.title).sort();

  beforeAll(async () => {
    const target = JSON.parse(await readFile(configPath!, "utf8"));
    expect(target.kind).toBe("classhub-past-classes-isolated-qa");
    expect(target.database).toBe("classhub_past_classes_qa");
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
      .raw(
        `
      INSERT INTO users (id,email_normalized,display_name,password_hash,email_verified_at) VALUES
        (1,'t1@example.invalid','교사가','synthetic',UTC_TIMESTAMP(6)),
        (2,'s2@example.invalid','학생가','synthetic',UTC_TIMESTAMP(6)),
        (3,'s3@example.invalid','학생나','synthetic',UTC_TIMESTAMP(6)),
        (4,'s4@example.invalid','학생다','synthetic',UTC_TIMESTAMP(6)),
        (5,'t5@example.invalid','교사나','synthetic',UTC_TIMESTAMP(6)),
        (6,'s6@example.invalid','학생라','synthetic',UTC_TIMESTAMP(6)),
        (7,'s7@example.invalid','학생마','synthetic',UTC_TIMESTAMP(6)),
        (8,'t8@example.invalid','교사다','synthetic',UTC_TIMESTAMP(6)),
        (9,'t9@example.invalid','교사라','synthetic',UTC_TIMESTAMP(6));
      INSERT INTO operators (id,email_normalized,credential_hash) VALUES (1,'op@example.invalid',REPEAT('q',32));
      INSERT INTO teacher_profiles (user_id,temporary_password_must_change,temporary_password_expires_at,created_by_operator_id) VALUES
        (1,FALSE,NULL,1),(5,TRUE,UTC_TIMESTAMP(6) + INTERVAL 1 DAY,1),(8,FALSE,NULL,1),(9,FALSE,NULL,1);
      INSERT INTO schools (edu_office_code,school_code,school_name,school_kind,region_name,edu_office_name)
        VALUES ('B10','9000001','합성 고등학교','high','합성 지역','합성 교육청');
      INSERT INTO classes (id,name,academic_year,grade,edu_office_code,school_code,expected_student_count,created_by_user_id,status,archived_at,archived_by_user_id,archived_by_operator_id) VALUES
        (1,'합성 1반',2025,1,'B10','9000001',5,1,'archived',UTC_TIMESTAMP(6) - INTERVAL 10 DAY,1,NULL),
        (2,'합성 2반',2026,2,'B10','9000001',5,9,'active',NULL,NULL,NULL),
        (3,'강제 종료 반',2025,1,'B10','9000001',5,1,'archived',UTC_TIMESTAMP(6) - INTERVAL 10 DAY,NULL,1),
        (4,'오래된 반',2024,1,'B10','9000001',5,1,'archived',UTC_TIMESTAMP(6) - INTERVAL 400 DAY,1,NULL),
        (5,'임시 교사 반',2025,1,'B10','9000001',5,5,'archived',UTC_TIMESTAMP(6) - INTERVAL 5 DAY,5,NULL);
      INSERT INTO class_members (id,class_id,user_id,role,status,student_number) VALUES
        (1,1,1,'teacher','archived',NULL),
        (2,1,2,'student','archived',NULL),
        (3,1,3,'student','canceled',NULL),
        (4,1,4,'student','left',NULL),
        (8,1,8,'teacher','transferred',NULL),
        (20,2,9,'teacher','approved',NULL),
        (21,2,2,'student','approved',1),
        (30,3,6,'student','archived',NULL),
        (40,4,1,'teacher','archived',NULL),
        (41,4,7,'student','archived',NULL),
        (50,5,5,'teacher','archived',NULL);
      INSERT INTO notices (id,class_id,title,content,created_by_member_id,audience_mode,published_at) VALUES
        (10,1,'반 전체 공지','수행평가 안내 알파',1,'legacy_class',UTC_TIMESTAMP(6) - INTERVAL 20 DAY),
        (11,1,'학생가만 받은 공지','개별 안내',1,'selected_snapshot',UTC_TIMESTAMP(6) - INTERVAL 19 DAY),
        (12,1,'다른 학생만 받은 공지','개별 안내',1,'selected_snapshot',UTC_TIMESTAMP(6) - INTERVAL 18 DAY),
        (60,3,'강제 종료 반 공지','내용',30,'legacy_class',UTC_TIMESTAMP(6) - INTERVAL 20 DAY),
        (70,4,'오래된 반 공지','내용',40,'legacy_class',UTC_TIMESTAMP(6) - INTERVAL 500 DAY),
        (80,2,'현재 반 공지','내용',20,'legacy_class',UTC_TIMESTAMP(6));
      INSERT INTO notices (id,class_id,title,content,created_by_member_id,audience_mode,published_at,deleted_at,deleted_by_member_id) VALUES
        (13,1,'지운 공지','내용',1,'legacy_class',UTC_TIMESTAMP(6) - INTERVAL 17 DAY,UTC_TIMESTAMP(6),1);
      INSERT INTO notice_recipients (notice_id,class_id,member_id) VALUES (11,1,2),(12,1,4);
      INSERT INTO supplies (id,class_id,title,needed_on,created_by_member_id,audience_mode) VALUES
        (30,1,'200일 전 준비물',CURRENT_DATE - INTERVAL 200 DAY,1,'legacy_class'),
        (31,1,'다른 학생 준비물',CURRENT_DATE - INTERVAL 30 DAY,1,'selected_snapshot');
      INSERT INTO supply_recipients (supply_id,class_id,member_id) VALUES (31,1,4);
    `,
      )
      .execute(admin);
    app = createMariaDbDatabase<DB>(createMysql2MariaDbPool, {
      ...connection,
      sslCa: target.sslCa,
      user: target.appUser,
      password: target.appPassword,
    });
    const config = new ConfigService<AppEnvironment, true>({
      CONTENT_SELECTED_AUDIENCE_ENABLED: true,
      DATABASE_ENGINE: "mariadb",
    });
    const updates = new UpdatesService(
      app,
      new NoticesAccessService(app, config),
      new ContentAudiencesService(config),
      config,
    );
    pastClasses = new PastClassesService(app, updates, config);
  });

  afterAll(async () => {
    await app?.destroy();
    await admin?.destroy();
  });

  it("교사는 자기가 종료한 365일 이내 반만 본다 — 현재 반·강제 종료·오래된 반은 없다", async () => {
    const list = await pastClasses.listMine("1");
    expect(list).toEqual([
      expect.objectContaining({
        academic_year: 2025,
        class_id: "1",
        class_name: "합성 1반",
        grade: 1,
        role: "teacher",
        school_name: "합성 고등학교",
      }),
    ]);
    expect(list[0]!.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
    expect(Date.parse(list[0]!.visible_until) - Date.parse(list[0]!.archived_at)).toBe(
      365 * 24 * 60 * 60 * 1000,
    );
    await expect(updatesOf("1", "4")).rejects.toBeInstanceOf(PastClassNotFoundException);
    expect(await titles("1", "1")).toEqual([
      "200일 전 준비물",
      "다른 학생 준비물",
      "다른 학생만 받은 공지",
      "반 전체 공지",
      "학생가만 받은 공지",
    ]);
  });

  it("학생은 자기가 받은 글만 본다 — 90일이 지난 준비물도 지난 반에서는 보인다", async () => {
    expect((await pastClasses.listMine("2")).map((item) => item.class_id)).toEqual(["1"]);
    expect(await titles("2", "1")).toEqual([
      "200일 전 준비물",
      "반 전체 공지",
      "학생가만 받은 공지",
    ]);
    expect(await titles("2", "1", "알파")).toEqual(["반 전체 공지"]);
    // 지금 다니는 반은 지난 반 창구로 열리지 않는다.
    await expect(updatesOf("2", "2")).rejects.toBeInstanceOf(PastClassNotFoundException);
  });

  it("종료 때 대기·중도 퇴장·반을 넘긴 구성원은 볼 수 없다", async () => {
    for (const userId of ["3", "4", "8"]) {
      expect(await pastClasses.listMine(userId)).toEqual([]);
      await expect(updatesOf(userId, "1")).rejects.toBeInstanceOf(PastClassNotFoundException);
    }
  });

  it("운영자 강제 종료 반, 365일이 지난 반, 임시 비밀번호 교사는 볼 수 없다", async () => {
    expect(await pastClasses.listMine("6")).toEqual([]);
    await expect(updatesOf("6", "3")).rejects.toBeInstanceOf(PastClassNotFoundException);
    expect(await pastClasses.listMine("7")).toEqual([]);
    await expect(updatesOf("7", "4")).rejects.toBeInstanceOf(PastClassNotFoundException);
    expect(await pastClasses.listMine("5")).toEqual([]);
    await expect(updatesOf("5", "5")).rejects.toBeInstanceOf(PastClassNotFoundException);
  });

  it("남의 반·없는 반·잘못된 번호는 모두 같은 '찾을 수 없음'이다", async () => {
    await expect(updatesOf("9", "1")).rejects.toBeInstanceOf(PastClassNotFoundException);
    await expect(updatesOf("1", "999")).rejects.toBeInstanceOf(PastClassNotFoundException);
    for (const bad of ["0", "-1", "abc", "1 OR 1=1", "99999999999999999999"]) {
      await expect(updatesOf("1", bad)).rejects.toBeInstanceOf(PastClassNotFoundException);
    }
  });

  // 2026-10-02 사용자 결정(P-025①): 늦게 승인된 학생을 기존 '반 전체' 글 받는 사람에 넣는 SQL이
  // 실제 MariaDB에서 돌고, 고른 학생 글은 건드리지 않으며, 두 번 돌려도 겹치지 않는다.
  it("승인된 학생을 그 반의 기존 '반 전체' 공지·준비물 받는 사람에 넣는다", async () => {
    await sql
      .raw(
        `
      INSERT INTO class_members (id,class_id,user_id,role,status,student_number) VALUES (22,2,3,'student','approved',2);
      INSERT INTO notices (id,class_id,title,content,created_by_member_id,audience_mode,published_at) VALUES
        (81,2,'반 전체 새 공지','내용',20,'all_snapshot',UTC_TIMESTAMP(6)),
        (82,2,'고른 학생 공지','내용',20,'selected_snapshot',UTC_TIMESTAMP(6));
      INSERT INTO notice_recipients (notice_id,class_id,member_id) VALUES (81,2,21),(82,2,21);
      INSERT INTO supplies (id,class_id,title,needed_on,created_by_member_id,audience_mode) VALUES
        (32,2,'반 전체 숙제',CURRENT_DATE,20,'all_snapshot');
      INSERT INTO supply_recipients (supply_id,class_id,member_id) VALUES (32,2,21);
    `,
      )
      .execute(admin);
    // 이 시험의 앱 계정은 지난 반 읽기 전용이라, SQL은 관리자 연결로 돌린다. 실제 앱 계정의
    // INSERT·SELECT 권한은 db/mariadb/permissions/0039_current_runtime_acl.sql에 있다.
    for (let run = 0; run < 2; run += 1)
      await admin
        .transaction()
        .execute((transaction) => includeMemberInClassWideContent(transaction, "2", "22"));
    const notices = await sql<{ notice_id: string }>`
      SELECT notice_id FROM notice_recipients WHERE member_id = 22 ORDER BY notice_id`.execute(
      admin,
    );
    expect(notices.rows.map((row) => String(row.notice_id))).toEqual(["81"]);
    const supplies = await sql<{ supply_id: string }>`
      SELECT supply_id FROM supply_recipients WHERE member_id = 22`.execute(admin);
    expect(supplies.rows.map((row) => String(row.supply_id))).toEqual(["32"]);
  });
});
