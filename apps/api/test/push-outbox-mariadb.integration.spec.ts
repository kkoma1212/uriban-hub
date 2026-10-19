import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createMariaDbDatabase, createMysql2MariaDbPool, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, MysqlDialect, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnvironment } from "../src/config/environment.js";
import { readMariaDbNoticeConfirmations } from "../src/notices/notices-confirmations.mariadb.js";
import { PushOutbox } from "../src/push-subscriptions/push-outbox.js";
import { WebPushSender } from "../src/push-subscriptions/web-push-sender.js";
import { listSupplyChecksMariaDb } from "../src/supplies/mariadb/supplies-checks-query.js";

const configPath = process.env.PUSH_OUTBOX_QA_MARIADB_CONFIG;
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
// RFC 8291 부록 A의 합성 키(운영 키 아님).
const UA_PUBLIC =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const SERVER_PUBLIC =
  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const SERVER_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const kst = (value: string) => new Date(`${value}+09:00`);

describe.runIf(configPath !== undefined)("push delivery outbox on an owned TLS MariaDB", () => {
  let admin: Kysely<DB>;
  let app: Kysely<DB>;
  let config: ConfigService<AppEnvironment, true>;
  let requests: string[];
  let outbox: PushOutbox;

  const deliveries = () =>
    admin
      .selectFrom("push_deliveries")
      .select([
        "user_id",
        "class_id",
        "kind",
        "tag",
        "title",
        "body",
        "path",
        "status",
        "accepted_count",
        sql<string>`DATE_FORMAT(CONVERT_TZ(deliver_after, '+00:00', '+09:00'), '%Y-%m-%dT%H:%i')`.as(
          "deliver_kst",
        ),
      ])
      .orderBy("user_id")
      .orderBy("id")
      .execute();

  beforeAll(async () => {
    const target = JSON.parse(await readFile(configPath!, "utf8"));
    expect(target.kind).toBe("classhub-push-outbox-isolated-qa");
    expect(target.database).toBe("classhub_push_outbox_qa");
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
    for (const path of [
      "db/mariadb/migrations/0047_push_subscriptions.sql",
      "db/mariadb/migrations/0048_push_deliveries.sql",
    ])
      await sql.raw(await readFile(new URL(path, root), "utf8")).execute(admin);
    for (const path of [
      "db/mariadb/permissions/0047_push_subscriptions_acl.sql",
      "db/mariadb/permissions/0048_push_deliveries_acl.sql",
    ]) {
      const grant = (await readFile(new URL(path, root), "utf8"))
        .replaceAll("classhub_mariadb_phase1_dev", target.database)
        .replaceAll("'classhub_app'@'%'", "'push_outbox_qa_app'@'localhost'");
      await sql.raw(grant).execute(admin);
    }
    await sql
      .raw(
        `
      INSERT INTO users (id,email_normalized,display_name,password_hash,email_verified_at) VALUES
        (1,'teacher@example.invalid','합성 교사','synthetic',UTC_TIMESTAMP(6)),
        (2,'student1@example.invalid','합성 학생가','synthetic',UTC_TIMESTAMP(6)),
        (3,'student2@example.invalid','합성 학생나','synthetic',UTC_TIMESTAMP(6)),
        (4,'student3@example.invalid','나간 학생','synthetic',UTC_TIMESTAMP(6));
      INSERT INTO operators (id,email_normalized,credential_hash) VALUES (1,'operator@example.invalid',REPEAT('q',32));
      INSERT INTO teacher_profiles (user_id,temporary_password_must_change,created_by_operator_id) VALUES (1,FALSE,1);
      INSERT INTO schools (edu_office_code,school_code,school_name,school_kind,region_name,edu_office_name)
        VALUES ('B10','9000001','합성 학교','middle','합성 지역','합성 교육청');
      INSERT INTO classes (id,name,academic_year,grade,edu_office_code,school_code,expected_student_count,created_by_user_id)
        VALUES (1,'합성 1반',2026,2,'B10','9000001',3,1);
      INSERT INTO class_members (id,class_id,user_id,role,status,student_number,display_name_in_class) VALUES
        (1,1,1,'teacher','approved',NULL,'합성 교사'),
        (2,1,2,'student','approved',1,'합성 학생가'),
        (3,1,3,'student','approved',2,'합성 학생나'),
        (4,1,4,'student','approved',3,'나간 학생');
      INSERT INTO notices (id,class_id,title,content,created_by_member_id,content_revision) VALUES
        (10,1,'체험학습 동의서','내용',1,1),
        (20,1,'시험 범위 안내','바뀐 내용',1,2);
      INSERT INTO notice_reads (class_id,notice_id,member_id,first_confirmed_at,confirmed_at,confirmed_revision) VALUES
        (1,20,2,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),1),
        (1,20,3,UTC_TIMESTAMP(6) - INTERVAL 1 DAY,UTC_TIMESTAMP(6),2);
      INSERT INTO supplies (id,class_id,title,needed_on,created_by_member_id,content_revision) VALUES
        (30,1,'미술 준비물',CURRENT_DATE,1,2);
      INSERT INTO supply_checks (class_id,supply_id,member_id,is_checked,checked_at,unchecked_at,confirmed_revision) VALUES
        (1,30,2,TRUE,UTC_TIMESTAMP(6),NULL,1),
        (1,30,3,FALSE,NULL,UTC_TIMESTAMP(6),NULL);
      INSERT INTO supplies (id,class_id,title,needed_on,created_by_member_id,content_revision,updated_at) VALUES
        (40,1,'체육복',CURRENT_DATE,1,2,UTC_TIMESTAMP(6) - INTERVAL 1 HOUR);
      INSERT INTO supply_checks (class_id,supply_id,member_id,is_checked,checked_at,unchecked_at,confirmed_revision,created_at) VALUES
        (1,40,2,TRUE,UTC_TIMESTAMP(6),NULL,2,UTC_TIMESTAMP(6) - INTERVAL 1 DAY),
        (1,40,3,TRUE,UTC_TIMESTAMP(6) - INTERVAL 1 DAY,NULL,1,UTC_TIMESTAMP(6) - INTERVAL 1 DAY),
        (1,40,4,TRUE,UTC_TIMESTAMP(6),NULL,2,UTC_TIMESTAMP(6));
      INSERT INTO in_app_reminder_batches (id,class_id,notice_id,supply_id,content_revision,created_by_member_id)
        VALUES ('11111111-1111-4111-8111-111111111111',1,10,NULL,1,1);
      INSERT INTO in_app_reminder_recipients (batch_id,class_id,member_id) VALUES
        ('11111111-1111-4111-8111-111111111111',1,2),
        ('11111111-1111-4111-8111-111111111111',1,4);
      INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth_secret) VALUES
        (2,'https://fcm.googleapis.com/fcm/send/qa-student-2','${UA_PUBLIC}','${AUTH}'),
        (3,'https://fcm.googleapis.com/fcm/send/qa-student-3','${UA_PUBLIC}','${AUTH}'),
        (4,'https://fcm.googleapis.com/fcm/send/qa-student-4','${UA_PUBLIC}','${AUTH}');
    `,
      )
      .execute(admin);
    app = createMariaDbDatabase<DB>(createMysql2MariaDbPool, {
      ...connection,
      sslCa: target.sslCa,
      user: target.appUser,
      password: target.appPassword,
    });
    config = new ConfigService<AppEnvironment, true>({
      DATABASE_ENGINE: "mariadb",
      WEB_PUSH_SUBJECT: "mailto:operator@example.invalid",
      WEB_PUSH_VAPID_PRIVATE_KEY: SERVER_PRIVATE,
      WEB_PUSH_VAPID_PUBLIC_KEY: SERVER_PUBLIC,
    });
  });

  beforeEach(async () => {
    await admin.deleteFrom("push_deliveries").execute();
    await admin
      .updateTable("class_members")
      .set({ status: "approved" })
      .where("id", "=", "4")
      .execute();
    requests = [];
    const fakeFetch = (async (url: URL) => {
      requests.push(url.href);
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    outbox = new PushOutbox(app, new WebPushSender(app, config, fakeFetch), config);
  });

  afterAll(async () => {
    await app?.destroy();
    await admin?.destroy();
  });

  const request = (userId: string, tag: string, title = "알림") => ({
    body: "본문",
    classId: "1",
    kind: "schedule_changed" as const,
    path: "/schedules/1",
    tag,
    title,
    userId,
  });

  it("수업 시간과 밤에는 보낼 시각을 뒤로 미룬다", async () => {
    await outbox.enqueue([request("2", "during-class")], kst("2026-09-23T10:00:00"));
    await outbox.enqueue([request("3", "at-night")], kst("2026-09-23T22:30:00"));
    expect((await deliveries()).map((row) => [row.tag, row.deliver_kst])).toEqual([
      ["during-class", "2026-09-23T16:40"],
      ["at-night", "2026-09-24T07:00"],
    ]);
  });

  it("같은 학생·같은 안내의 대기 알림은 최신 하나로 묶는다", async () => {
    await outbox.enqueue([request("2", "schedule:1", "첫 수정")]);
    await outbox.enqueue([request("2", "schedule:1", "두 번째 수정")]);
    await outbox.enqueue([request("2", "schedule:2", "다른 일정")]);
    expect((await deliveries()).map((row) => row.title)).toEqual(["두 번째 수정", "다른 일정"]);
  });

  it("재알림 묶음의 승인된 학생에게만 공지 제목을 넣어 대기열에 넣는다", async () => {
    await admin
      .updateTable("class_members")
      .set({ status: "left", student_number: null })
      .where("id", "=", "4")
      .execute();
    expect(await outbox.enqueueReminderBatch("11111111-1111-4111-8111-111111111111")).toBe(1);
    expect(await deliveries()).toEqual([
      expect.objectContaining({
        body: "확인해 주세요: 체험학습 동의서",
        class_id: "1",
        kind: "reminder",
        path: "/notices/10",
        tag: "notice:10",
        title: "공지 확인 요청",
        user_id: "2",
      }),
    ]);
  });

  it("일정 변경은 그 반의 승인된 학생 모두에게, 교사에게는 보내지 않는다", async () => {
    expect(
      await outbox.enqueueScheduleChange({
        classId: "1",
        scheduleId: "7",
        subject: "국어",
        title: "발표 수행평가",
      }),
    ).toBe(3);
    const rows = await deliveries();
    expect(rows.map((row) => row.user_id)).toEqual(["2", "3", "4"]);
    expect(rows[0]).toMatchObject({
      body: "국어 발표 수행평가 일정이 바뀌었습니다. 바뀐 내용을 확인해 주세요.",
      path: "/schedules/7",
      tag: "schedule:7",
    });
  });

  it("공지가 바뀌면 이전 내용을 확인한 학생에게만 다시 확인을 요청한다", async () => {
    expect(
      await outbox.enqueueRevisionReconfirm({
        classId: "1",
        kind: "notice",
        resourceId: "20",
        revision: "2",
        title: "시험 범위 안내",
      }),
    ).toBe(1);
    expect(await deliveries()).toEqual([
      expect.objectContaining({
        body: "바뀐 내용을 다시 확인해 주세요: 시험 범위 안내",
        path: "/notices/20",
        tag: "notice:20",
        title: "공지 내용 변경",
        user_id: "2",
      }),
    ]);
  });

  it("교사 확인 현황은 수정 뒤 다시 확인한 학생 수를 따로 센다", async () => {
    const result = await readMariaDbNoticeConfirmations(app, {
      classId: "1",
      noticeId: "20",
      state: "confirmed",
    });
    expect(result.counts).toEqual({
      confirmed: 1,
      excluded_member_count: 0,
      modified_unconfirmed: 1,
      reconfirmed: 1,
      unread: 1,
    });
    expect(result.items.map((item) => item.member_id)).toEqual(["3"]);
  });

  it("준비물이 바뀌면 챙김 표시를 했던 학생에게만 다시 확인을 요청한다", async () => {
    expect(
      await outbox.enqueueRevisionReconfirm({
        classId: "1",
        kind: "supply",
        resourceId: "30",
        revision: "2",
        title: "미술 준비물",
      }),
    ).toBe(1);
    expect((await deliveries()).map((row) => [row.user_id, row.tag, row.title])).toEqual([
      ["2", "supply:30", "준비물 내용 변경"],
    ]);
  });

  it("교사 준비물 현황은 수정 전부터 챙겼던 학생의 재확인만 따로 센다", async () => {
    const result = await listSupplyChecksMariaDb(app, {
      classId: "1",
      supplyId: "40",
      state: "checked",
      cursor: undefined,
      serverToday: "2026-09-24",
    });
    // 학생2 = 수정 전 기록 + 새 내용 챙김(재확인), 학생3 = 옛 내용만, 학생4 = 수정 뒤 처음 챙김.
    expect(result.counts).toEqual({
      checked: 2,
      excluded_member_count: 0,
      modified_unconfirmed: 1,
      reconfirmed: 1,
      unchecked: 0,
    });
    expect(result.items.map((item) => item.member_id)).toEqual(["2", "4"]);
  });
  it("보낼 시각이 된 알림만 보내고 결과를 기록한다", async () => {
    await outbox.enqueue([request("2", "due")], kst("2026-09-23T18:00:00"));
    await outbox.enqueue([request("3", "later")], kst("2026-09-23T22:00:00"));
    expect(await outbox.processDue(kst("2026-09-23T18:01:00"))).toEqual({
      processed: 1,
      skipped: 0,
    });
    expect(requests).toEqual(["https://fcm.googleapis.com/fcm/send/qa-student-2"]);
    expect((await deliveries()).map((row) => [row.tag, row.status, row.accepted_count])).toEqual([
      ["due", "done", 1],
      ["later", "pending", 0],
    ]);
  });

  it("보내기 직전에 반을 나간 학생에게는 보내지 않는다", async () => {
    await outbox.enqueue([request("4", "left-before-send")], kst("2026-09-23T18:00:00"));
    await admin
      .updateTable("class_members")
      .set({ status: "left", student_number: null })
      .where("id", "=", "4")
      .execute();
    expect(await outbox.processDue(kst("2026-09-23T18:05:00"))).toEqual({
      processed: 0,
      skipped: 1,
    });
    expect(requests).toEqual([]);
    expect((await deliveries())[0]).toMatchObject({ status: "done", accepted_count: 0 });
  });

  it("보낸 지 30일이 지난 기록은 정리한다", async () => {
    await outbox.enqueue([request("2", "old")], kst("2026-08-01T18:00:00"));
    await outbox.processDue(kst("2026-08-01T18:01:00"));
    expect(await deliveries()).toHaveLength(1);
    await outbox.processDue(kst("2026-09-23T18:00:00"));
    expect(await deliveries()).toHaveLength(0);
  });

  it("앱 계정은 대기 알림의 내용·대상·보낼 시각을 바꿀 수 없다", async () => {
    await outbox.enqueue([request("2", "acl")]);
    for (const statement of [
      sql`UPDATE push_deliveries SET title = 'x'`,
      sql`UPDATE push_deliveries SET user_id = 3`,
      sql`UPDATE push_deliveries SET deliver_after = UTC_TIMESTAMP(6)`,
    ])
      await expect(statement.execute(app)).rejects.toThrow();
  });
});
