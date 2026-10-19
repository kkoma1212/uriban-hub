import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createMariaDbDatabase, createMysql2MariaDbPool, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, MysqlDialect, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnvironment } from "../src/config/environment.js";
import {
  HelpRequestNotFoundException,
  HelpRequestRateLimitedException,
  HelpRequestRoleInsufficientException,
  HelpRequestStateConflictException,
} from "../src/help-requests/help-requests.errors.js";
import { HelpRequestsService } from "../src/help-requests/help-requests.service.js";

const configPath = process.env.HELP_REQUESTS_QA_MARIADB_CONFIG;
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

describe.runIf(configPath !== undefined)("help requests on an owned TLS MariaDB", () => {
  let admin: Kysely<DB>;
  let app: Kysely<DB>;
  let service: HelpRequestsService;
  const notice = (id: string) => ({ id, kind: "notice" as const });
  const supply = (id: string) => ({ id, kind: "supply" as const });
  const request = (actorUserId: string, target: { id: string; kind: "notice" | "supply" }) =>
    service.create({ actorUserId, kind: "question", message: null, target });
  const ask = (values: Record<string, unknown>) =>
    app
      .insertInto("help_requests")
      .values({ class_id: "1", member_id: "2", kind: "question", ...values })
      .execute();

  beforeAll(async () => {
    const target = JSON.parse(await readFile(configPath!, "utf8"));
    expect(target.kind).toBe("classhub-help-requests-isolated-qa");
    expect(target.database).toBe("classhub_help_requests_qa");
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
      .raw(await readFile(new URL("db/mariadb/migrations/0050_help_requests.sql", root), "utf8"))
      .execute(admin);
    // 서비스는 대화 변경(0052, T-HELP-CHAT)이 얹힌 최종 스키마를 전제로 한다(목록이 메시지 표를 읽는다).
    await sql
      .raw(await readFile(new URL("db/mariadb/migrations/0052_help_chat.sql", root), "utf8"))
      .execute(admin);
    for (const acl of ["0050_help_requests_acl.sql", "0052_help_chat_acl.sql"]) {
      const grant = (await readFile(new URL(`db/mariadb/permissions/${acl}`, root), "utf8"))
        .replaceAll("classhub_mariadb_phase1_dev", target.database)
        .replaceAll("'classhub_app'@'%'", "'help_requests_qa_app'@'localhost'");
      await sql.raw(grant).execute(admin);
    }
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
      INSERT INTO notices (id,class_id,title,content,created_by_member_id,audience_mode,published_at) VALUES
        (10,1,'반 전체 공지','내용',1,'legacy_class',UTC_TIMESTAMP(6)),
        (11,1,'지울 공지','내용',1,'legacy_class',UTC_TIMESTAMP(6)),
        (12,1,'예약 공지','내용',1,'legacy_class',UTC_TIMESTAMP(6) + INTERVAL 1 DAY),
        (13,1,'학생가만 보는 공지','내용',1,'selected_snapshot',UTC_TIMESTAMP(6)),
        (14,1,'숨길 공지','내용',1,'legacy_class',UTC_TIMESTAMP(6)),
        (90,2,'다른 반 공지','내용',9,'legacy_class',UTC_TIMESTAMP(6));
      INSERT INTO supplies (id,class_id,title,needed_on,created_by_member_id,audience_mode) VALUES
        (30,1,'물감',CURRENT_DATE,1,'legacy_class'),
        (31,1,'지난 준비물',CURRENT_DATE - INTERVAL 120 DAY,1,'legacy_class');
      INSERT INTO notice_recipients (notice_id,class_id,member_id) VALUES (13,1,2);
    `,
      )
      .execute(admin);
    app = createMariaDbDatabase<DB>(createMysql2MariaDbPool, {
      ...connection,
      sslCa: target.sslCa,
      user: target.appUser,
      password: target.appPassword,
    });
    service = new HelpRequestsService(
      app,
      new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" }),
    );
  });

  beforeEach(async () => {
    await admin.deleteFrom("help_requests").execute();
  });

  afterAll(async () => {
    await app?.destroy();
    await admin?.destroy();
  });

  it("DB는 안내 하나·같은 반·처리 중 1건만 받고, 앱은 지우거나 요청 내용을 고치지 못한다", async () => {
    await ask({ notice_id: "10", message: "준비물을 어디서 사나요?" });
    await expect(ask({ notice_id: "10", kind: "hard_to_prepare" })).rejects.toThrow(
      /Duplicate entry/iu,
    );
    await ask({ member_id: "3", notice_id: "10" });
    await ask({ supply_id: "30", kind: "hard_to_prepare", message: "가".repeat(200) });

    // 대상은 공지·준비물 중 정확히 하나, 같은 반 것만(0052 뒤에도 질문·준비 요청은 그대로).
    await expect(ask({})).rejects.toThrow(/help_requests_target_v2_check/u);
    await expect(ask({ notice_id: "11", supply_id: "30" })).rejects.toThrow(
      /help_requests_target_v2_check/u,
    );
    await expect(ask({ notice_id: "90" })).rejects.toThrow(/foreign key/iu);
    await expect(ask({ member_id: "9", notice_id: "11" })).rejects.toThrow(/foreign key/iu);
    await expect(ask({ notice_id: "11", kind: "chat" })).rejects.toThrow(
      /help_requests_kind_v2_check/u,
    );
    await expect(ask({ notice_id: "11", message: "" })).rejects.toThrow(
      /help_requests_message_check/u,
    );
    await expect(ask({ notice_id: "11", message: "가".repeat(201) })).rejects.toThrow(
      /Data too long|help_requests_message_check/u,
    );

    // 처리 완료에는 종료 시각이 필요하고, 철회에는 답변을 둘 수 없다.
    const target = (member: string) =>
      app
        .updateTable("help_requests")
        .where("member_id", "=", member)
        .where("notice_id", "=", "10");
    await expect(target("2").set({ status: "resolved" }).execute()).rejects.toThrow(
      /help_requests_closed_v2_check/u,
    );
    await expect(
      target("3")
        .set({ status: "withdrawn", reply: "답", closed_at: sql`UTC_TIMESTAMP(6)` })
        .execute(),
    ).rejects.toThrow(/help_requests_closed_v2_check/u);
    await target("2")
      .set({ status: "resolved", reply: "문구점에 있어요", closed_at: sql`UTC_TIMESTAMP(6)` })
      .execute();
    // 해결된 뒤에는 같은 안내에 새 요청을 다시 남길 수 있다.
    await ask({ notice_id: "10", kind: "hard_to_prepare" });

    await expect(target("2").set({ message: "바꾼 내용" }).execute()).rejects.toThrow(
      /command denied/iu,
    );
    await expect(app.deleteFrom("help_requests").execute()).rejects.toThrow(/command denied/iu);

    // 원 안내가 실제로 지워지면 요청도 함께 지워져 보존·파기 흐름을 막지 않는다.
    await ask({ notice_id: "11" });
    await admin.deleteFrom("notices").where("id", "=", "11").execute();
    const remaining = await admin
      .selectFrom("help_requests")
      .select(["notice_id", "supply_id", "status"])
      .orderBy("id")
      .execute();
    expect(remaining).toEqual([
      { notice_id: "10", supply_id: null, status: "resolved" },
      { notice_id: "10", supply_id: null, status: "open" },
      { notice_id: null, supply_id: "30", status: "open" },
      { notice_id: "10", supply_id: null, status: "open" },
    ]);
  });

  it("학생은 자기에게 보이는 안내에만 요청하고, 처리 중 요청은 안내마다 1건이다", async () => {
    const created = await service.create({
      actorUserId: "2",
      kind: "hard_to_prepare",
      message: "물감이 없어요",
      target: supply("30"),
    });
    expect(created).toMatchObject({
      kind: "hard_to_prepare",
      message: "물감이 없어요",
      reply: null,
      status: "open",
      student: null,
      target: { id: "30", kind: "supply", title: "물감" },
    });
    await expect(request("2", supply("30"))).rejects.toBeInstanceOf(
      HelpRequestStateConflictException,
    );
    await request("2", notice("13"));
    // 예약 공지·대상이 아닌 공지·지난 준비물·다른 반 공지는 학생에게 없는 안내로 다룬다.
    for (const [actor, target] of [
      ["2", notice("12")],
      ["3", notice("13")],
      ["2", supply("31")],
      ["2", notice("90")],
    ] as const)
      await expect(request(actor, target)).rejects.toBeInstanceOf(HelpRequestNotFoundException);
    await expect(request("1", notice("10"))).rejects.toBeInstanceOf(
      HelpRequestRoleInsufficientException,
    );
  });

  it("담임은 반 전체를, 학생은 자기 요청만 보고 다른 반 교사는 보지 못한다", async () => {
    await request("2", notice("10"));
    await request("3", notice("10"));
    const teacher = await service.list({ actorUserId: "1", status: "open" });
    expect(teacher.items.map((item) => item.student?.display_name)).toEqual([
      "합성 학생나",
      "합성 학생가",
    ]);
    expect(teacher.items[0]?.student).toEqual({
      display_name: "합성 학생나",
      member_id: "3",
      student_number: 2,
    });
    const student = await service.list({ actorUserId: "2", status: "open" });
    expect(student.items).toHaveLength(1);
    expect(student.items[0]?.student).toBeNull();
    expect((await service.list({ actorUserId: "9", status: "all" })).items).toEqual([]);
    const filtered = await service.list({
      actorUserId: "1",
      status: "open",
      target: supply("30"),
    });
    expect(filtered.items).toEqual([]);
  });

  it("반 이름이 없으면 계정 표시 이름을 쓰고, 이름 보정 뒤에도 대화 조회 범위를 유지한다", async () => {
    await admin
      .updateTable("class_members")
      .set({ display_name_in_class: null })
      .where("id", "=", "2")
      .execute();
    try {
      const created = await request("2", notice("10"));
      const teacher = await service.list({ actorUserId: "1", status: "open" });
      expect(teacher.items[0]?.student?.display_name).toBe("합성 학생가");
      expect((await service.thread("1", created.id)).request.student?.display_name).toBe(
        "합성 학생가",
      );
      expect((await service.thread("2", created.id)).request.student).toBeNull();
      for (const actorUserId of ["3", "9"]) {
        expect((await service.list({ actorUserId, status: "all" })).items).toEqual([]);
        await expect(service.thread(actorUserId, created.id)).rejects.toBeInstanceOf(
          HelpRequestNotFoundException,
        );
      }
      await admin
        .updateTable("class_members")
        .set({ display_name_in_class: "반에서 쓰는 이름" })
        .where("id", "=", "2")
        .execute();
      expect(
        (await service.list({ actorUserId: "1", status: "open" })).items[0]?.student?.display_name,
      ).toBe("반에서 쓰는 이름");
      expect((await service.thread("1", created.id)).request.student?.display_name).toBe(
        "반에서 쓰는 이름",
      );
    } finally {
      await admin
        .updateTable("class_members")
        .set({ display_name_in_class: "합성 학생가" })
        .where("id", "=", "2")
        .execute();
    }
  });

  it("학생은 자기 요청만 철회하고, 담임은 처리 완료와 한 줄 답변을 남긴다", async () => {
    const mine = await request("2", notice("10"));
    const other = await request("3", notice("10"));
    await expect(
      service.withdraw({ actorUserId: "2", helpRequestId: other.id }),
    ).rejects.toBeInstanceOf(HelpRequestNotFoundException);
    expect((await service.withdraw({ actorUserId: "3", helpRequestId: other.id })).status).toBe(
      "withdrawn",
    );
    await expect(
      service.withdraw({ actorUserId: "3", helpRequestId: other.id }),
    ).rejects.toBeInstanceOf(HelpRequestStateConflictException);
    await expect(
      service.resolve({ actorUserId: "2", helpRequestId: mine.id, reply: null }),
    ).rejects.toBeInstanceOf(HelpRequestRoleInsufficientException);
    await expect(
      service.resolve({ actorUserId: "9", helpRequestId: mine.id, reply: null }),
    ).rejects.toBeInstanceOf(HelpRequestNotFoundException);
    const resolved = await service.resolve({
      actorUserId: "1",
      helpRequestId: mine.id,
      reply: "내일 교실에서 설명할게요",
    });
    expect(resolved).toMatchObject({ reply: "내일 교실에서 설명할게요", status: "resolved" });
    expect(resolved.closed_at).not.toBeNull();
    await expect(
      service.resolve({ actorUserId: "1", helpRequestId: mine.id, reply: null }),
    ).rejects.toBeInstanceOf(HelpRequestStateConflictException);
    const history = await service.list({ actorUserId: "2", status: "all" });
    expect(history.items.map((item) => [item.status, item.reply])).toEqual([
      ["resolved", "내일 교실에서 설명할게요"],
    ]);
    // 해결 뒤에는 같은 안내에 다시 도움을 요청할 수 있다.
    expect((await request("2", notice("10"))).status).toBe("open");
  });

  it("같은 학생이 동시에 30개를 보내도 1분 20개까지만 저장된다(2026-10-05 동시 우회 수정)", async () => {
    try {
      const started = await service.startGeneral({ actorUserId: "2", body: "첫 질문" });
      const results = await Promise.allSettled(
        Array.from({ length: 30 }, (_, index) =>
          service.send({
            actorUserId: "2",
            body: `동시 ${index}`,
            helpRequestId: started.request.id,
          }),
        ),
      );
      const saved = await admin
        .selectFrom("help_request_messages")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("author_member_id", "=", "2")
        .executeTakeFirstOrThrow();
      // 첫 질문 1개 + 동시 전송 19개 = 1분 20개
      expect(Number(saved.n)).toBe(20);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(19);
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason).toBeInstanceOf(HelpRequestRateLimitedException);
    } finally {
      await admin.deleteFrom("help_request_messages").execute();
    }
  });

  it("지워진 안내에 딸린 요청은 목록에서 빠진다", async () => {
    await request("2", notice("14"));
    await admin
      .updateTable("notices")
      .set({ deleted_at: sql`UTC_TIMESTAMP(6)`, deleted_by_member_id: "1" })
      .where("id", "=", "14")
      .execute();
    expect((await service.list({ actorUserId: "1", status: "all" })).items).toEqual([]);
  });
});
