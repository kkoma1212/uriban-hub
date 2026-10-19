import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createMariaDbDatabase, createMysql2MariaDbPool, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, MysqlDialect, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ClassChatClassSuspendedException,
  ClassChatConflictException,
  ClassChatNotFoundException,
  ClassChatRateLimitedException,
  ClassChatRoleInsufficientException,
  ClassChatSendBlockedException,
} from "../src/class-chat/class-chat.errors.js";
import { AdminActivityService } from "../src/admin-management/admin-activity.service.js";
import { AdminDirectoryService } from "../src/admin-management/admin-directory.service.js";
import { AdminOverviewService } from "../src/admin-management/admin-overview.service.js";
import { AdminSessionsService } from "../src/admin-management/admin-sessions.service.js";
import { ClassChatService } from "../src/class-chat/class-chat.service.js";
import { addCalendarDays, kstDate } from "../src/common/date/kst-date.js";
import type { RedisRateLimiter } from "../src/common/rate-limit/redis-rate-limiter.js";
import type { AppEnvironment } from "../src/config/environment.js";

const configPath = process.env.CLASS_CHAT_QA_MARIADB_CONFIG;
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
const installSql = async (path: string, database: string) =>
  (await readFile(new URL(path, root), "utf8"))
    .replaceAll("classhub_mariadb_phase1_dev", database)
    .replaceAll("'classhub_app'@'%'", "'class_chat_qa_app'@'localhost'");

/* 밤 잠금만 고정한다: 한국 시각 낮 12시(UTC 03시)와 밤 11시(UTC 14시). */
const NOON_KST = () => new Date("2026-09-28T03:00:00.000Z");
const NIGHT_KST = () => new Date("2026-09-28T14:00:00.000Z");
const TEACHER = "1";
const STUDENT_A = "2";
const STUDENT_B = "3";
const OTHER_TEACHER = "9";

describe.runIf(configPath !== undefined)("class chat on an owned TLS MariaDB", () => {
  let admin: Kysely<DB>;
  let app: Kysely<DB>;
  let chat: ClassChatService;
  let nightChat: ClassChatService;

  beforeAll(async () => {
    const target = JSON.parse(await readFile(configPath!, "utf8"));
    expect(target.kind).toBe("classhub-class-chat-isolated-qa");
    expect(target.database).toBe("classhub_class_chat_qa");
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
      .raw(await installSql("db/mariadb/migrations/0056_class_chat.sql", target.database))
      .execute(admin);
    await sql
      .raw(await installSql("db/mariadb/permissions/0056_class_chat_acl.sql", target.database))
      .execute(admin);
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
        (3,1,3,'student','approved',2,NULL),
        (9,2,9,'teacher','approved',NULL,'다른 반 교사');
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
    chat = new ClassChatService(app, config, NOON_KST);
    nightChat = new ClassChatService(app, config, NIGHT_KST);
  });

  beforeEach(async () => {
    await admin.deleteFrom("class_chat_reports").execute();
    await admin.deleteFrom("class_chat_messages").execute();
    await admin.deleteFrom("class_chat_mutes").execute();
    await admin.deleteFrom("class_chat_rooms").execute();
    await admin
      .updateTable("classes")
      .set({
        status: "active",
        suspended_reason: null,
        suspended_at: null,
        suspended_by_operator_id: null,
      })
      .where("id", "=", "1")
      .execute();
  });

  afterAll(async () => {
    await app?.destroy();
    await admin?.destroy();
  });

  it("처음에는 닫혀 있어 학생은 못 보내고, 담임은 보내며 방을 열 수 있다", async () => {
    const closed = await chat.state(STUDENT_A);
    expect(closed.room.is_open).toBe(false);
    expect(closed.me).toMatchObject({ role: "student", can_send: false, blocked_reason: "closed" });
    expect(closed.open_report_count).toBeNull();
    await expect(chat.send(STUDENT_A, "안녕")).rejects.toBeInstanceOf(
      ClassChatSendBlockedException,
    );
    await chat.send(TEACHER, "오늘 준비물 알려 줄게요");
    await expect(chat.setRoom(STUDENT_A, true)).rejects.toBeInstanceOf(
      ClassChatRoleInsufficientException,
    );
    const opened = await chat.setRoom(TEACHER, true);
    expect(opened.room.is_open).toBe(true);
    expect(opened.open_report_count).toBe(0);
    // 두 번 눌러도 줄이 하나라 문제없다.
    expect((await chat.setRoom(TEACHER, true)).room.is_open).toBe(true);
    const sent = await chat.send(STUDENT_A, "네 알겠어요");
    expect(sent.me.can_send).toBe(true);
    expect(sent.messages.map((m) => [m.author.name, m.body, m.mine])).toEqual([
      ["합성 교사", "오늘 준비물 알려 줄게요", false],
      ["합성 학생가", "네 알겠어요", true],
    ]);
  });

  it("다른 학생은 이름(반 이름이 없으면 계정 이름)과 새 메시지만 이어 받는다", async () => {
    await chat.setRoom(TEACHER, true);
    const first = await chat.send(STUDENT_A, "첫 번째");
    const lastSeen = first.messages.at(-1)!.id;
    await chat.send(STUDENT_B, "두 번째");
    const next = await chat.state(STUDENT_A, lastSeen);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({
      body: "두 번째",
      mine: false,
      author: { name: "합성 학생나", role: "student", student_number: 2 },
    });
    expect(next.has_more_before).toBe(false);
    // 다른 반 담임은 이 반 대화를 받지 않는다.
    expect((await chat.state(OTHER_TEACHER)).messages).toEqual([]);
  });

  it("밤 10시~아침 7시에는 학생만 잠기고 담임은 보낼 수 있다", async () => {
    await chat.setRoom(TEACHER, true);
    const night = await nightChat.state(STUDENT_A);
    expect(night.me).toMatchObject({ can_send: false, blocked_reason: "night" });
    await expect(nightChat.send(STUDENT_A, "자니?")).rejects.toBeInstanceOf(
      ClassChatSendBlockedException,
    );
    expect((await nightChat.send(TEACHER, "내일 봐요")).messages).toHaveLength(1);
  });

  it("담임이 가린 메시지는 학생에게 내용 없이 가고, 다른 반 담임은 가리지 못한다", async () => {
    await chat.setRoom(TEACHER, true);
    const sent = await chat.send(STUDENT_A, "가릴 말");
    const id = sent.messages.at(-1)!.id;
    await expect(chat.hide(STUDENT_B, id)).rejects.toBeInstanceOf(
      ClassChatRoleInsufficientException,
    );
    await expect(chat.hide(OTHER_TEACHER, id)).rejects.toBeInstanceOf(ClassChatNotFoundException);
    const teacherView = await chat.hide(TEACHER, id);
    expect(teacherView.messages.at(-1)).toMatchObject({ body: "가릴 말", hidden: true });
    // 다시 가려도 오류 없이 그대로다.
    await chat.hide(TEACHER, id);
    const studentView = await chat.state(STUDENT_B);
    expect(studentView.messages.at(-1)).toMatchObject({ body: null, hidden: true });
    expect((await chat.state(STUDENT_A)).messages.at(-1)!.body).toBeNull();
    await expect(chat.hide(TEACHER, "999999")).rejects.toBeInstanceOf(ClassChatNotFoundException);
  });

  it("신고는 한 사람당 한 번, 담임만 목록을 보고 처리한다", async () => {
    await chat.setRoom(TEACHER, true);
    const id = (await chat.send(STUDENT_A, "문제 되는 말")).messages.at(-1)!.id;
    await chat.report(STUDENT_B, id, "놀리는 말이에요");
    await expect(chat.report(STUDENT_B, id, "또")).rejects.toBeInstanceOf(
      ClassChatConflictException,
    );
    await expect(chat.report(OTHER_TEACHER, id, "다른 반")).rejects.toBeInstanceOf(
      ClassChatNotFoundException,
    );
    await expect(chat.reports(STUDENT_B)).rejects.toBeInstanceOf(
      ClassChatRoleInsufficientException,
    );
    expect((await chat.state(TEACHER)).open_report_count).toBe(1);
    const [report] = await chat.reports(TEACHER);
    expect(report).toMatchObject({
      reason: "놀리는 말이에요",
      reporter: { name: "합성 학생나", student_number: 2 },
      message: { id, body: "문제 되는 말", author: { name: "합성 학생가" } },
    });
    await expect(chat.resolveReport(STUDENT_B, report!.id)).rejects.toBeInstanceOf(
      ClassChatRoleInsufficientException,
    );
    await chat.resolveReport(TEACHER, report!.id);
    await expect(chat.resolveReport(TEACHER, report!.id)).rejects.toBeInstanceOf(
      ClassChatNotFoundException,
    );
    expect(await chat.reports(TEACHER)).toEqual([]);
    expect((await chat.state(TEACHER)).open_report_count).toBe(0);
  });

  it("담임이 학생 말하기를 멈추면 그 학생만 못 보내고, 풀면 다시 보낸다", async () => {
    await chat.setRoom(TEACHER, true);
    await expect(chat.mute(STUDENT_A, STUDENT_B, "10m")).rejects.toBeInstanceOf(
      ClassChatRoleInsufficientException,
    );
    await expect(chat.mute(TEACHER, TEACHER, "10m")).rejects.toBeInstanceOf(
      ClassChatNotFoundException,
    );
    await expect(chat.mute(OTHER_TEACHER, STUDENT_A, "1h")).rejects.toBeInstanceOf(
      ClassChatNotFoundException,
    );
    await chat.mute(TEACHER, STUDENT_A, "10m");
    await chat.mute(TEACHER, STUDENT_A, "1h");
    const muted = await chat.state(STUDENT_A);
    expect(muted.me).toMatchObject({ can_send: false, blocked_reason: "muted" });
    const minutesLeft = (Date.parse(muted.me.muted_until!) - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(55);
    expect(minutesLeft).toBeLessThanOrEqual(61);
    await expect(chat.send(STUDENT_A, "왜요")).rejects.toBeInstanceOf(
      ClassChatSendBlockedException,
    );
    await chat.send(STUDENT_B, "저는 보낼 수 있어요");
    await expect(chat.unmute(STUDENT_B, STUDENT_A)).rejects.toBeInstanceOf(
      ClassChatRoleInsufficientException,
    );
    await chat.unmute(TEACHER, STUDENT_A);
    expect((await chat.state(STUDENT_A)).me).toMatchObject({ can_send: true, muted_until: null });
    await chat.send(STUDENT_A, "다시 보내요");
  });

  it("학생은 1분 10개·하루 300개까지, 담임은 제한이 없다", async () => {
    await chat.setRoom(TEACHER, true);
    for (let index = 0; index < 10; index += 1) await chat.send(STUDENT_A, `메시지 ${index}`);
    await expect(chat.send(STUDENT_A, "11번째")).rejects.toBeInstanceOf(
      ClassChatRateLimitedException,
    );
    for (let index = 0; index < 12; index += 1) await chat.send(TEACHER, `안내 ${index}`);
    // 하루 제한: 2시간 전에 이미 300개를 보낸 학생.
    await sql
      .raw(
        `INSERT INTO class_chat_messages (class_id,author_member_id,body,created_at)
         SELECT 1,3,'예전 메시지',UTC_TIMESTAMP(6) - INTERVAL 2 HOUR FROM seq_1_to_300`,
      )
      .execute(admin);
    await expect(chat.send(STUDENT_B, "301번째")).rejects.toBeInstanceOf(
      ClassChatRateLimitedException,
    );
    // 처음 열면 최근 100개만, 더 있음 표시.
    const recent = await chat.state(TEACHER);
    expect(recent.messages).toHaveLength(100);
    expect(recent.has_more_before).toBe(true);
  });

  it("같은 학생이 동시에 25개를 보내도 1분 10개까지만 저장된다(2026-10-05 총검수 F01)", async () => {
    await chat.setRoom(TEACHER, true);
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, index) => chat.send(STUDENT_A, `동시 ${index}`)),
    );
    const saved = await sql<{ n: string }>`
      SELECT CAST(COUNT(*) AS CHAR) AS n FROM class_chat_messages WHERE body LIKE '동시 %'`.execute(
      admin,
    );
    expect(Number(saved.rows[0]?.n)).toBe(10);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toBeInstanceOf(ClassChatRateLimitedException);
  });

  it("앱 계정은 메시지 내용을 고치거나 지우지 못하고, 정지된 반에서는 쓸 수 없다", async () => {
    await chat.setRoom(TEACHER, true);
    await chat.send(STUDENT_A, "원래 내용");
    await expect(
      app.updateTable("class_chat_messages").set({ body: "바꾼 내용" }).execute(),
    ).rejects.toThrow(/denied/iu);
    await expect(app.deleteFrom("class_chat_messages").execute()).rejects.toThrow(/denied/iu);
    await expect(app.deleteFrom("class_chat_reports").execute()).rejects.toThrow(/denied/iu);
    await admin
      .updateTable("classes")
      .set({
        status: "suspended",
        suspended_reason: "합성 정지",
        suspended_at: sql`UTC_TIMESTAMP(6)`,
        suspended_by_operator_id: "1",
      })
      .where("id", "=", "1")
      .execute();
    await expect(chat.state(STUDENT_A)).rejects.toBeInstanceOf(ClassChatClassSuspendedException);
    await expect(chat.send(TEACHER, "정지 중")).rejects.toBeInstanceOf(
      ClassChatClassSuspendedException,
    );
  });

  // 관리자 첫 화면 숫자도 같은 합성 반 자료와 앱 계정 권한으로 센다(운영과 같은 MariaDB 문법 확인).
  it("관리자 한눈에 보기는 가입 대기·학교·반·학생 수·문의·열린 신고를 숫자로만 센다", async () => {
    await sql
      .raw(
        `
      INSERT INTO users (id,email_normalized,display_name,password_hash,signup_role) VALUES
        (10,'pending-teacher@example.invalid','대기 교사','synthetic','teacher'),
        (11,'pending-student@example.invalid','대기 학생','synthetic','student');
      INSERT INTO admin_inquiries (requester_user_id,subject,body,status) VALUES
        (2,'문의1','내용','open'),(3,'문의2','내용','open'),(2,'문의3','내용','in_progress'),(3,'문의4','내용','resolved');
      INSERT INTO admin_system_state (\`key\`,value_json,updated_by_admin_account_id)
        VALUES ('maintenance_mode','{"enabled":true}',1);
    `,
      )
      .execute(admin);
    try {
      await chat.setRoom(TEACHER, true);
      const id = (await chat.send(STUDENT_A, "신고될 말")).messages.at(-1)!.id;
      await chat.report(STUDENT_B, id, "사유");
      const overview = await new AdminOverviewService(
        app,
        new ConfigService<AppEnvironment, true>({
          CLASS_CHAT_ENABLED: true,
          DATABASE_ENGINE: "mariadb",
        }),
        { ensureAvailable: async () => undefined } as unknown as RedisRateLimiter,
      ).overview();
      expect(overview.signups).toEqual({
        pending_teachers: 1,
        pending_students: 1,
        new_last_7_days: 6,
      });
      expect(overview.scale).toEqual({
        schools: 1,
        active_classes: 2,
        teachers: 2,
        students: 2,
        active_users: 6,
      });
      expect(overview.support).toEqual({
        inquiries_open: 2,
        inquiries_in_progress: 1,
        class_chat_reports_open: 1,
      });
      expect(overview.server).toMatchObject({ maintenance_mode: true, redis_ok: true });
      expect(overview.server.database_ms).toBeGreaterThanOrEqual(0);
      // 개인 정보(이름·메일·문의 내용)는 응답 어디에도 없다.
      expect(JSON.stringify(overview)).not.toMatch(/example\.invalid|합성|문의1|신고될 말/u);
    } finally {
      await sql
        .raw(
          "DELETE FROM admin_system_state; DELETE FROM admin_inquiries; DELETE FROM users WHERE id IN (10,11);",
        )
        .execute(admin);
    }
  });
  // 관리자 학교·반 목록도 운영과 같은 앱 계정 권한·MariaDB 문법으로 확인한다.
  it("관리자 학교·반 목록은 반마다 한 줄로 담임 이름·학생 수·대기 수를 보이고 검색·상태·쪽을 지킨다", async () => {
    await sql
      .raw(
        `INSERT INTO users (id,email_normalized,display_name,password_hash) VALUES (12,'pending-member@example.invalid','대기 학생','synthetic');
        INSERT INTO class_members (id,class_id,user_id,role,status) VALUES (20,2,12,'student','pending');`,
      )
      .execute(admin);
    try {
      const directory = new AdminDirectoryService(
        app,
        new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" }),
      );
      const all = await directory.listClasses({});
      expect(all.total).toBe(2);
      expect(all.page_size).toBe(20);
      const byId = new Map(all.classes.map((row) => [row.id, row]));
      expect(byId.get("1")).toMatchObject({
        name: "합성 1반",
        school_name: "합성 학교",
        teacher_name: "합성 교사",
        students: 2,
        pending_members: 0,
      });
      expect(byId.get("2")).toMatchObject({
        teacher_name: "다른 반 교사",
        students: 0,
        pending_members: 1,
      });
      expect(all.classes[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      // 학생 이름·메일은 응답에 없다.
      expect(JSON.stringify(all)).not.toMatch(/example\.invalid|합성 학생|대기 학생/u);

      const searched = await directory.listClasses({ search: "2반" });
      expect(searched.classes.map((row) => row.id)).toEqual(["2"]);
      expect((await directory.listClasses({ search: "합성 학교" })).total).toBe(2);
      // LIKE 특수문자는 글자 그대로 찾는다.
      expect((await directory.listClasses({ search: "%%" })).total).toBe(0);
      expect((await directory.listClasses({ status: "archived" })).total).toBe(0);
      const second = await directory.listClasses({ page: 2 });
      expect(second).toMatchObject({ classes: [], total: 2, page: 2 });
    } finally {
      await sql
        .raw("DELETE FROM class_members WHERE id=20; DELETE FROM users WHERE id=12;")
        .execute(admin);
    }
  });

  it("관리자 선생님·학생 목록은 메일을 가리고 역할·상태·반·마지막 로그인을 보이며 필터·쪽을 지킨다", async () => {
    await sql
      .raw(
        `INSERT INTO users (id,email_normalized,display_name,password_hash,signup_role,is_active) VALUES
          (13,'waiting@example.invalid','가입 대기','synthetic','student',TRUE),
          (14,'stopped@example.invalid','이용 중지','synthetic',NULL,FALSE);
        INSERT INTO sessions (user_id,session_hash,csrf_token_hash,issued_at,expires_at,created_ip) VALUES
          (2,UNHEX(SHA2('s1',256)),UNHEX(SHA2('c1',256)),'2026-09-20 01:00:00.000000','2026-09-20 02:00:00.000000','127.0.0.1'),
          (2,UNHEX(SHA2('s2',256)),UNHEX(SHA2('c2',256)),'2026-09-25 01:00:00.000000','2026-09-25 02:00:00.000000','127.0.0.1');`,
      )
      .execute(admin);
    try {
      const directory = new AdminDirectoryService(
        app,
        new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" }),
      );
      const ids = async (query: Parameters<typeof directory.listPeople>[0]) =>
        (await directory.listPeople(query)).people.map((row) => row.id).sort();
      const all = await directory.listPeople({});
      expect(all.total).toBe(6);
      expect(all.page_size).toBe(30);
      const byId = new Map(all.people.map((row) => [row.id, row]));
      expect(byId.get("1")).toMatchObject({
        role: "teacher",
        status: "active",
        class_name: "합성 1반",
        school_name: "합성 학교",
      });
      expect(byId.get("2")).toMatchObject({
        display_name: "합성 학생가",
        email_masked: "st***@example.invalid",
        role: "student",
        status: "active",
        class_name: "합성 1반",
        last_login_at: "2026-09-25T01:00:00.000Z",
      });
      expect(byId.get("9")).toMatchObject({ role: "teacher", class_name: "합성 2반" });
      expect(byId.get("13")).toMatchObject({
        role: "student",
        status: "pending",
        class_name: null,
        last_login_at: null,
      });
      expect(byId.get("14")).toMatchObject({ status: "inactive" });
      // 전체 메일 주소·비밀번호 값은 응답에 없다.
      expect(JSON.stringify(all)).not.toMatch(/student1@|waiting@|synthetic/u);

      expect(await ids({ role: "teacher" })).toEqual(["1", "9"]);
      expect(await ids({ role: "student" })).toEqual(["13", "14", "2", "3"]);
      expect(await ids({ status: "pending" })).toEqual(["13"]);
      expect(await ids({ status: "inactive" })).toEqual(["14"]);
      expect(await ids({ status: "active" })).toEqual(["1", "2", "3", "9"]);
      expect(await ids({ search: "학생가" })).toEqual(["2"]);
      expect(await ids({ search: "waiting" })).toEqual(["13"]);
      expect(await directory.listPeople({ page: 2 })).toMatchObject({ people: [], total: 6 });
    } finally {
      await sql
        .raw("DELETE FROM sessions WHERE user_id=2; DELETE FROM users WHERE id IN (13,14);")
        .execute(admin);
    }
  });

  it("관리자 반 활동 현황은 운영 중인 반마다 기간 안의 새 건수만 세고 지운 글·지난 글은 빼며 합계를 낸다", async () => {
    await sql
      .raw(
        `INSERT INTO notices (id,class_id,title,content,created_by_member_id) VALUES (50,1,'이번 주 소식','내용',1);
        INSERT INTO notices (id,class_id,title,content,created_by_member_id,deleted_at,deleted_by_member_id) VALUES
          (51,1,'지운 소식','내용',1,UTC_TIMESTAMP(6),1);
        INSERT INTO notices (id,class_id,title,content,created_by_member_id,created_at) VALUES
          (52,1,'지난 소식','내용',1,UTC_TIMESTAMP(6) - INTERVAL 20 DAY);
        INSERT INTO schedules (id,class_id,title,schedule_type,due_date,created_by_member_id) VALUES
          (60,1,'시험','exam',CURRENT_DATE,1);
        INSERT INTO supplies (id,class_id,title,needed_on,created_by_member_id) VALUES (70,2,'물감',CURRENT_DATE,9);
        INSERT INTO attendance_notifications (id,class_id,member_id,notification_date,notification_type) VALUES
          (80,1,2,CURRENT_DATE,'absent');
        INSERT INTO polls (id,class_id,created_by_member_id,title,option_count,closes_at) VALUES
          (90,1,1,'소풍 장소',2,UTC_TIMESTAMP(6) + INTERVAL 1 DAY);
        INSERT INTO help_requests (id,class_id,member_id,notice_id,kind,message) VALUES
          (100,1,2,50,'question','어디서 모이나요?');
        INSERT INTO sessions (user_id,session_hash,csrf_token_hash,issued_at,expires_at,created_ip) VALUES
          (2,UNHEX(SHA2('a1',256)),UNHEX(SHA2('b1',256)),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6) + INTERVAL 1 HOUR,'127.0.0.1');`,
      )
      .execute(admin);
    try {
      const service = (classChat: boolean) =>
        new AdminActivityService(
          app,
          new ConfigService<AppEnvironment, true>({
            DATABASE_ENGINE: "mariadb",
            CLASS_CHAT_ENABLED: classChat,
          }),
        );
      // 앞선 대화 사례가 남긴 메시지 수는 같은 기준으로 직접 세어 맞춘다.
      const chatSince = async (days: number) =>
        Number(
          (
            await sql<{ n: string }>`SELECT COUNT(*) AS n FROM class_chat_messages
              WHERE class_id = 1 AND hidden_at IS NULL
                AND created_at >= UTC_TIMESTAMP(6) - INTERVAL ${sql.lit(days)} DAY`.execute(admin)
          ).rows[0]!.n,
        );
      const week = await service(true).listClassActivity({});
      expect(week).toMatchObject({ days: 7, total: 2, page: 1, page_size: 20 });
      const byId = new Map(week.classes.map((row) => [row.id, row]));
      expect(byId.get("1")).toMatchObject({
        name: "합성 1반",
        school_name: "합성 학교",
        students: 2,
        notices: 1,
        schedules: 1,
        supplies: 0,
        attendance: 1,
        polls: 1,
        help_requests: 1,
        active_students: 1,
        class_chat_messages: await chatSince(7),
      });
      expect(byId.get("2")).toMatchObject({ supplies: 1, notices: 0, active_students: 0 });
      expect(week.totals).toMatchObject({
        notices: 1,
        schedules: 1,
        supplies: 1,
        attendance: 1,
        polls: 1,
        help_requests: 1,
        active_students: 1,
      });
      // 글 제목·내용·이름·메일은 응답에 없다.
      expect(JSON.stringify(week)).not.toMatch(/이번 주 소식|어디서|합성 학생|example\.invalid/u);

      const month = await service(true).listClassActivity({ days: 30 });
      expect(month.classes.find((row) => row.id === "1")).toMatchObject({ notices: 2 });
      expect(month.totals.notices).toBe(2);

      const chatOff = await service(false).listClassActivity({});
      expect(chatOff.totals.class_chat_messages).toBeNull();
      expect(chatOff.classes.every((row) => row.class_chat_messages === null)).toBe(true);
      expect(await service(true).listClassActivity({ page: 2 })).toMatchObject({
        classes: [],
        total: 2,
      });
    } finally {
      await sql
        .raw(
          `DELETE FROM help_requests WHERE id=100; DELETE FROM polls WHERE id=90;
          DELETE FROM attendance_notifications WHERE id=80; DELETE FROM supplies WHERE id=70;
          DELETE FROM schedules WHERE id=60; DELETE FROM notices WHERE id IN (50,51,52);
          DELETE FROM sessions WHERE user_id=2;`,
        )
        .execute(admin);
    }
  });

  it("관리자 일별 추이는 한국 날짜로 하루씩 묶고 기간 첫날 자정 1초 전 글은 빼며 빈 날을 0으로 채운다", async () => {
    const today = kstDate(new Date());
    const first = addCalendarDays(today, -6);
    // 첫날 한국 자정을 UTC 문자열로: 이 시각 글은 포함, 1초 전 글은 7일 범위 밖.
    const midnight = new Date(`${first}T00:00:00+09:00`);
    const utc = (date: Date) => date.toISOString().replace("T", " ").replace("Z", "");
    const edge = utc(midnight);
    const before = utc(new Date(midnight.getTime() - 1_000));
    await sql
      .raw(
        `INSERT INTO users (id,email_normalized,display_name,password_hash,created_at) VALUES
          (15,'first-day@example.invalid','첫날 가입','synthetic','${edge}');
        INSERT INTO notices (id,class_id,title,content,created_by_member_id,created_at) VALUES
          (53,1,'첫날 소식','내용',1,'${edge}'), (54,1,'전날 소식','내용',1,'${before}');
        INSERT INTO notices (id,class_id,title,content,created_by_member_id,deleted_at,deleted_by_member_id,created_at) VALUES
          (55,1,'지운 소식','내용',1,UTC_TIMESTAMP(6),1,'${edge}');`,
      )
      .execute(admin);
    try {
      const service = new AdminActivityService(
        app,
        new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" }),
      );
      const week = await service.activityTrend({});
      expect(week).toMatchObject({ days: 7, from: first, to: today });
      expect(week.series.map((point) => point.date)).toEqual(
        Array.from({ length: 7 }, (_, index) => addCalendarDays(first, index)),
      );
      expect(week.series[0]).toEqual({ date: first, signups: 1, activity: 1 });
      // 합성 사용자들은 오늘 만들어졌으므로 오늘 칸에 들어간다.
      expect(week.series[6]!.signups).toBeGreaterThanOrEqual(4);

      const month = await service.activityTrend({ days: 30 });
      expect(month.series).toHaveLength(30);
      const dayBefore = month.series.find((point) => point.date === addCalendarDays(first, -1));
      expect(dayBefore).toMatchObject({ activity: 1 });
      expect(JSON.stringify(month)).not.toMatch(/첫날|example\.invalid/u);
    } finally {
      await sql
        .raw("DELETE FROM notices WHERE id IN (53,54,55); DELETE FROM users WHERE id=15;")
        .execute(admin);
    }
  });

  it("관리자 세션 목록은 열린 사용자·관리자 세션만 보이고 끝난·만료·쉰 세션과 접속 주소는 빼며 자기 세션을 표시한다", async () => {
    const chrome =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
    await sql
      .raw(
        `INSERT INTO sessions (user_id,session_hash,csrf_token_hash,issued_at,expires_at,created_ip,user_agent) VALUES
          (2,UNHEX(SHA2('open',256)),UNHEX(SHA2('c1',256)),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6) + INTERVAL 1 HOUR,'203.0.113.7','${chrome}'),
          (9,UNHEX(SHA2('expired',256)),UNHEX(SHA2('c3',256)),UTC_TIMESTAMP(6) - INTERVAL 2 HOUR,UTC_TIMESTAMP(6) - INTERVAL 1 HOUR,'203.0.113.8',NULL);
        INSERT INTO sessions (user_id,session_hash,csrf_token_hash,issued_at,expires_at,revoked_at,created_ip) VALUES
          (3,UNHEX(SHA2('revoked',256)),UNHEX(SHA2('c2',256)),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6) + INTERVAL 1 HOUR,UTC_TIMESTAMP(6),'203.0.113.9');
        INSERT INTO admin_sessions (id,admin_account_id,session_hash,csrf_token_hash,issued_at,last_seen_at,absolute_expires_at,mfa_verified_at,revoked_at,created_ip_hmac,hmac_key_version,user_agent) VALUES
          (1,1,UNHEX(SHA2('a1',256)),UNHEX(SHA2('ac1',256)),UTC_TIMESTAMP(6) - INTERVAL 5 MINUTE,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6) + INTERVAL 8 HOUR,UTC_TIMESTAMP(6) - INTERVAL 5 MINUTE,NULL,REPEAT('h',43),'v1','${chrome}'),
          (2,1,UNHEX(SHA2('a2',256)),UNHEX(SHA2('ac2',256)),UTC_TIMESTAMP(6) - INTERVAL 40 MINUTE,UTC_TIMESTAMP(6) - INTERVAL 31 MINUTE,UTC_TIMESTAMP(6) + INTERVAL 8 HOUR,UTC_TIMESTAMP(6) - INTERVAL 40 MINUTE,NULL,REPEAT('h',43),'v1',NULL),
          (3,1,UNHEX(SHA2('a3',256)),UNHEX(SHA2('ac3',256)),UTC_TIMESTAMP(6) - INTERVAL 5 MINUTE,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6) + INTERVAL 8 HOUR,UTC_TIMESTAMP(6) - INTERVAL 5 MINUTE,UTC_TIMESTAMP(6),REPEAT('h',43),'v1',NULL);`,
      )
      .execute(admin);
    try {
      const service = new AdminSessionsService(
        app,
        new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" }),
      );
      const list = await service.list({}, "1");
      expect(list).toMatchObject({ user_total: 1, page: 1, page_size: 30 });
      expect(list.user_sessions).toEqual([
        expect.objectContaining({
          display_name: "합성 학생가",
          email_masked: "st***@example.invalid",
          device: "Chrome · Windows",
        }),
      ]);
      expect(list.admin_sessions.map((row) => [row.id, row.is_current])).toEqual([["1", true]]);
      expect(list.admin_sessions[0]).toMatchObject({ display_name: "합성 관리자" });
      expect(list.user_sessions[0]!.issued_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      // 접속 주소·주소 해시·전체 메일·브라우저 문자열 원문은 응답에 없다.
      expect(JSON.stringify(list)).not.toMatch(/203\.0\.113|hhhh|student1@|Mozilla/u);
      expect((await service.list({}, "999")).admin_sessions[0]!.is_current).toBe(false);
      expect(await service.list({ page: 2 }, "1")).toMatchObject({
        user_sessions: [],
        user_total: 1,
      });
    } finally {
      await sql
        .raw(
          "DELETE FROM admin_sessions WHERE id IN (1,2,3); DELETE FROM sessions WHERE user_id IN (2,3,9);",
        )
        .execute(admin);
    }
  });

  it("관리자 세션 강제 종료는 원장 98 설치 뒤에만 되고 세션을 끝내며 작업 기록을 남기고 자기 세션·중복은 막는다", async () => {
    const chrome = "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36";
    await sql
      .raw(
        `INSERT INTO sessions (id,user_id,session_hash,csrf_token_hash,issued_at,expires_at,created_ip,user_agent) VALUES
          (501,2,UNHEX(SHA2('r1',256)),UNHEX(SHA2('rc1',256)),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6) + INTERVAL 1 HOUR,'203.0.113.7','${chrome}');
        INSERT INTO admin_sessions (id,admin_account_id,session_hash,csrf_token_hash,issued_at,last_seen_at,absolute_expires_at,mfa_verified_at,created_ip_hmac,hmac_key_version) VALUES
          (11,1,UNHEX(SHA2('me',256)),UNHEX(SHA2('mec',256)),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6) + INTERVAL 8 HOUR,UTC_TIMESTAMP(6),REPEAT('h',43),'v1'),
          (12,1,UNHEX(SHA2('other',256)),UNHEX(SHA2('oc',256)),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6) + INTERVAL 8 HOUR,UTC_TIMESTAMP(6),REPEAT('h',43),'v1');`,
      )
      .execute(admin);
    const service = (installed: boolean) =>
      new AdminSessionsService(
        app,
        new ConfigService<AppEnvironment, true>({
          DATABASE_ENGINE: "mariadb",
          ADMIN_SESSION_REVOKE_DATABASE_INSTALLED: installed,
        }),
      );
    const request = (id: string, kind: "user" | "admin") => ({
      id,
      kind,
      reason: "분실한 기기",
      actorAdminId: "1",
      currentSessionId: "11",
      requestId: "8590e08f-899c-4b4e-83f0-1c0842348142",
    });
    try {
      // 설치 전: 목록은 종료 불가로 보이고 종료 요청은 막힌다.
      expect((await service(false).list({}, "11")).revoke_enabled).toBe(false);
      await expect(service(false).revoke(request("501", "user"))).rejects.toMatchObject({
        status: 409,
      });
      await sql
        .raw(
          await installSql(
            "db/mariadb/migrations/0058_admin_session_revoke.sql",
            "classhub_class_chat_qa",
          ),
        )
        .execute(admin);
      const installed = service(true);
      expect((await installed.list({}, "11")).revoke_enabled).toBe(true);

      await expect(installed.revoke(request("501", "user"))).resolves.toEqual({
        id: "501",
        kind: "user",
        revoked: true,
      });
      const revoked = await sql<{
        revoked: number;
      }>`SELECT revoked_at IS NOT NULL AS revoked FROM sessions WHERE id = 501`.execute(admin);
      expect(Number(revoked.rows[0]!.revoked)).toBe(1);
      const logs = await sql<{
        action: string;
        target_type: string;
        target_id: string;
        reason: string;
        before_json: string;
      }>`
        SELECT action, target_type, target_id, reason, before_json FROM admin_operation_audit_logs ORDER BY id`.execute(
        admin,
      );
      expect(logs.rows).toHaveLength(1);
      expect(logs.rows[0]).toMatchObject({
        action: "admin.session.revoked",
        target_type: "session",
        target_id: "user:501",
        reason: "분실한 기기",
      });
      // 시험용 관리 연결은 JSON 열을 이미 객체로 돌려준다.
      const before = logs.rows[0]!.before_json as unknown;
      expect(typeof before === "string" ? JSON.parse(before) : before).toEqual({
        kind: "user",
        owner_id: "2",
        revoked: false,
      });
      // 이미 끝난 세션·없는 번호·잘못된 번호는 찾을 수 없음.
      await expect(installed.revoke(request("501", "user"))).rejects.toMatchObject({ status: 404 });
      await expect(installed.revoke(request("999999", "user"))).rejects.toMatchObject({
        status: 404,
      });
      await expect(installed.revoke(request("abc", "user"))).rejects.toMatchObject({ status: 404 });
      // 자기 세션은 로그아웃으로.
      await expect(installed.revoke(request("11", "admin"))).rejects.toMatchObject({ status: 400 });
      await expect(installed.revoke(request("12", "admin"))).resolves.toMatchObject({
        revoked: true,
      });
      const admins = await sql<{
        id: string;
        revoked: number;
      }>`SELECT id, revoked_at IS NOT NULL AS revoked FROM admin_sessions WHERE id IN (11,12) ORDER BY id`.execute(
        admin,
      );
      expect(admins.rows.map((row) => [String(row.id), Number(row.revoked)])).toEqual([
        ["11", 0],
        ["12", 1],
      ]);
      const count = await sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM admin_operation_audit_logs`.execute(admin);
      expect(Number(count.rows[0]!.n)).toBe(2);
      // 끝난 세션은 목록에서 빠진다.
      const after = await installed.list({}, "11");
      expect(after.user_sessions.map((row) => row.id)).not.toContain("501");
      expect(after.admin_sessions.map((row) => row.id)).toEqual(["11"]);
    } finally {
      await sql
        .raw(
          "DELETE FROM admin_operation_audit_logs; DELETE FROM admin_sessions WHERE id IN (11,12); DELETE FROM sessions WHERE id=501;",
        )
        .execute(admin);
    }
  });
});
