import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createMariaDbDatabase, createMysql2MariaDbPool, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, MysqlDialect, sql, type KyselyPlugin } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../src/config/environment.js";
import {
  HelpRequestNotFoundException,
  HelpRequestRateLimitedException,
  HelpRequestRoleInsufficientException,
  HelpRequestStateConflictException,
} from "../src/help-requests/help-requests.errors.js";
import { HelpRequestsService } from "../src/help-requests/help-requests.service.js";
import type { PushDeliveryRequest, PushOutbox } from "../src/push-subscriptions/push-outbox.js";

const configPath = process.env.HELP_CHAT_QA_MARIADB_CONFIG;
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
    .replaceAll("'classhub_app'@'%'", "'help_chat_qa_app'@'localhost'");

describe.runIf(configPath !== undefined)("help chat schema on an owned TLS MariaDB", () => {
  let admin: Kysely<DB>;
  let app: Kysely<DB>;
  let legacyRows: unknown[];
  let service: HelpRequestsService;
  const pushed: PushDeliveryRequest[] = [];
  const ask = (values: Record<string, unknown>) =>
    app
      .insertInto("help_requests")
      .values({ class_id: "1", member_id: "2", kind: "general", ...values })
      .execute();
  const say = (values: { help_request_id: string } & Record<string, unknown>) =>
    app
      .insertInto("help_request_messages")
      .values({ class_id: "1", author_member_id: "2", body: "안녕하세요", ...values })
      .execute();
  const legacySnapshot = () =>
    admin
      .selectFrom("help_requests")
      .select(["id", "kind", "message", "reply", "status", "closed_at", "open_target"])
      .where("id", "in", ["100", "101"])
      .orderBy("id")
      .execute();

  beforeAll(async () => {
    const target = JSON.parse(await readFile(configPath!, "utf8"));
    expect(target.kind).toBe("classhub-help-chat-isolated-qa");
    expect(target.database).toBe("classhub_help_chat_qa");
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
    // 운영과 같은 순서: 도움 요청(0050)이 이미 쓰이는 상태에서 대화 변경(0052)을 얹는다.
    await sql
      .raw(await installSql("db/mariadb/migrations/0050_help_requests.sql", target.database))
      .execute(admin);
    await sql
      .raw(await installSql("db/mariadb/permissions/0050_help_requests_acl.sql", target.database))
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
        (3,1,3,'student','approved',2,'합성 학생나'),
        (9,2,9,'teacher','approved',NULL,'다른 반 교사');
      INSERT INTO notices (id,class_id,title,content,created_by_member_id,audience_mode,published_at) VALUES
        (10,1,'반 전체 공지','내용',1,'legacy_class',UTC_TIMESTAMP(6)),
        (11,1,'지울 공지','내용',1,'legacy_class',UTC_TIMESTAMP(6));
      INSERT INTO supplies (id,class_id,title,needed_on,created_by_member_id,audience_mode) VALUES
        (30,1,'물감',CURRENT_DATE,1,'legacy_class');
      INSERT INTO help_requests (id,class_id,member_id,notice_id,kind,message) VALUES
        (100,1,2,10,'question','준비물을 어디서 사나요?');
      INSERT INTO help_requests (id,class_id,member_id,supply_id,kind,status,reply,closed_at) VALUES
        (101,1,3,30,'hard_to_prepare','resolved','문구점에 있어요','2026-09-20 01:02:03.000000');
    `,
      )
      .execute(admin);
    legacyRows = await legacySnapshot();
    await sql
      .raw(await installSql("db/mariadb/migrations/0052_help_chat.sql", target.database))
      .execute(admin);
    await sql
      .raw(await installSql("db/mariadb/permissions/0052_help_chat_acl.sql", target.database))
      .execute(admin);
    app = createMariaDbDatabase<DB>(createMysql2MariaDbPool, {
      ...connection,
      sslCa: target.sslCa,
      user: target.appUser,
      password: target.appPassword,
    });
    // 푸시는 대기열에 무엇을 넣는지만 본다(실제 발송·보류 시각은 push-outbox 스펙이 검사).
    const outbox = {
      enqueue: vi.fn(async (requests: readonly PushDeliveryRequest[]) => {
        pushed.push(...requests);
        return requests.length;
      }),
    } as unknown as PushOutbox;
    service = new HelpRequestsService(
      app,
      new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" }),
      outbox,
    );
  });

  beforeEach(async () => {
    pushed.length = 0;
    await admin.deleteFrom("push_deliveries").execute();
    await admin.deleteFrom("help_request_messages").execute();
    await admin.deleteFrom("help_requests").where("id", "not in", ["100", "101"]).execute();
  });

  afterAll(async () => {
    await app?.destroy();
    await admin?.destroy();
  });

  it("변경 전부터 있던 요청은 설명·답변·상태·열림 표시까지 한 글자도 바뀌지 않는다", async () => {
    expect(legacyRows).toHaveLength(2);
    expect(await legacySnapshot()).toEqual(legacyRows);
    expect(legacyRows).toMatchObject([
      { id: "100", open_target: "n10", status: "open" },
      { id: "101", open_target: null, reply: "문구점에 있어요", status: "resolved" },
    ]);
  });

  it("글과 무관한 대화는 대상 없이만, 학생마다 열린 것 1개만 된다", async () => {
    await ask({});
    await expect(ask({})).rejects.toThrow(/Duplicate entry/iu);
    await ask({ member_id: "3" });
    await expect(ask({ member_id: "3", notice_id: "10" })).rejects.toThrow(
      /help_requests_target_v2_check/u,
    );
    // 공지·준비물 요청은 여전히 대상이 정확히 하나여야 한다.
    await expect(ask({ kind: "question" })).rejects.toThrow(/help_requests_target_v2_check/u);
    await expect(ask({ kind: "question", notice_id: "11", supply_id: "30" })).rejects.toThrow(
      /help_requests_target_v2_check/u,
    );
    await expect(ask({ kind: "chat", notice_id: "11" })).rejects.toThrow(
      /help_requests_kind_v2_check/u,
    );
    const general = await admin
      .selectFrom("help_requests")
      .select("open_target")
      .where("kind", "=", "general")
      .execute();
    expect(general).toEqual([{ open_target: "g" }, { open_target: "g" }]);
  });

  it("닫힌 대화는 다시 열 수 있고, 예전 답변은 남으며, 앱은 요청을 지우지 못한다", async () => {
    await app
      .updateTable("help_requests")
      .set({ status: "open", closed_at: null })
      .where("id", "=", "101")
      .execute();
    expect(
      await admin
        .selectFrom("help_requests")
        .select(["status", "reply", "open_target"])
        .where("id", "=", "101")
        .executeTakeFirst(),
    ).toEqual({ status: "open", reply: "문구점에 있어요", open_target: "s30" });
    await expect(
      app
        .updateTable("help_requests")
        .set({ status: "resolved" })
        .where("id", "=", "101")
        .execute(),
    ).rejects.toThrow(/help_requests_closed_v2_check/u);
    await app
      .updateTable("help_requests")
      // 원래 닫힌 시각으로 되돌려 뒤 검사의 '기존 요청 그대로' 비교를 흐리지 않는다.
      .set({ status: "resolved", closed_at: "2026-09-20 01:02:03.000000" })
      .where("id", "=", "101")
      .execute();
    await expect(
      app
        .updateTable("help_requests")
        .set({ message: "바꾼 내용" })
        .where("id", "=", "100")
        .execute(),
    ).rejects.toThrow(/command denied/iu);
    await expect(app.deleteFrom("help_requests").execute()).rejects.toThrow(/command denied/iu);
  });

  it("말은 같은 반 대화·같은 반 사람만, 1~500자, 고치거나 지울 수 없다", async () => {
    await say({ help_request_id: "100" });
    await say({ help_request_id: "100", author_member_id: "1", body: "가".repeat(500) });
    await expect(say({ help_request_id: "100", body: "" })).rejects.toThrow(
      /help_request_messages_body_check/u,
    );
    await expect(say({ help_request_id: "100", body: "가".repeat(501) })).rejects.toThrow(
      /Data too long|help_request_messages_body_check/u,
    );
    // 다른 반으로 꾸민 대화·작성자는 복합 외래키가 막는다.
    await expect(
      say({ help_request_id: "100", class_id: "2", author_member_id: "9" }),
    ).rejects.toThrow(/foreign key/iu);
    await expect(say({ help_request_id: "100", author_member_id: "9" })).rejects.toThrow(
      /foreign key/iu,
    );
    await expect(say({ help_request_id: "999" })).rejects.toThrow(/foreign key/iu);
    await expect(
      app.updateTable("help_request_messages").set({ body: "몰래 수정" }).execute(),
    ).rejects.toThrow(/command denied/iu);
    await expect(app.deleteFrom("help_request_messages").execute()).rejects.toThrow(
      /command denied/iu,
    );
    expect(
      (await app.selectFrom("help_request_messages").select("body").orderBy("id").execute()).map(
        (row) => row.body.length,
      ),
    ).toEqual([5, 500]);
  });

  it("원 안내가 실제로 지워지면 요청과 주고받은 말도 함께 지워진다", async () => {
    await ask({ kind: "question", notice_id: "11" });
    const request = await admin
      .selectFrom("help_requests")
      .select("id")
      .where("notice_id", "=", "11")
      .executeTakeFirstOrThrow();
    await say({ help_request_id: request.id });
    await say({ help_request_id: request.id, author_member_id: "1", body: "내일 알려 줄게요" });
    await admin.deleteFrom("notices").where("id", "=", "11").execute();
    expect(await admin.selectFrom("help_request_messages").select("id").execute()).toEqual([]);
    expect(await legacySnapshot()).toEqual(legacyRows);
  });

  it("새 메시지 알림 종류를 대기열에 넣을 수 있고, 모르는 종류는 여전히 거부한다", async () => {
    const delivery = (kind: string) =>
      app
        .insertInto("push_deliveries")
        .values({
          user_id: "1",
          class_id: "1",
          kind,
          tag: "help-100",
          title: "새 메시지",
          body: "학생이 메시지를 보냈어요",
          path: "/help-requests",
          deliver_after: sql`UTC_TIMESTAMP(6)`,
        })
        .execute();
    await delivery("help_message");
    await delivery("reminder");
    await expect(delivery("chat")).rejects.toThrow(/push_deliveries_kind_v2_check/u);
  });

  // ── API 서비스(3단계). 아래 검사는 맨 끝에 두고, 건드린 기존 요청(100·101)은 스스로 되돌린다.

  it("학생은 선생님께 묻기를 시작·이어 쓰고, 담임만 보고 답하며, 알림에는 이름·내용이 없다", async () => {
    const first = await service.startGeneral({
      actorUserId: "2",
      body: "수행평가 범위가 궁금해요",
    });
    expect(first.request).toMatchObject({ kind: "general", status: "open", target: null });
    const again = await service.startGeneral({ actorUserId: "2", body: "하나 더 있어요" });
    expect(again.request.id).toBe(first.request.id);
    expect(again.messages.map((m) => [m.author, m.body])).toEqual([
      ["student", "수행평가 범위가 궁금해요"],
      ["student", "하나 더 있어요"],
    ]);
    // 선생님은 이 대화를 만들 수 없고, 다른 반 선생님은 보지도 쓰지도 못한다.
    await expect(service.startGeneral({ actorUserId: "1", body: "안녕" })).rejects.toBeInstanceOf(
      HelpRequestRoleInsufficientException,
    );
    await expect(service.thread("9", first.request.id)).rejects.toBeInstanceOf(
      HelpRequestNotFoundException,
    );
    await expect(
      service.send({ actorUserId: "9", helpRequestId: first.request.id, body: "끼어들기" }),
    ).rejects.toBeInstanceOf(HelpRequestNotFoundException);
    expect((await service.list({ actorUserId: "9", status: "all" })).items).toEqual([]);
    // 담임 목록: 최근에 말이 오간 대화가 맨 위, 글과 무관한 대화는 대상 없이 학생 이름과 함께.
    const teacherList = await service.list({ actorUserId: "1", status: "open" });
    expect(teacherList.items[0]).toMatchObject({
      id: first.request.id,
      student: { display_name: "합성 학생가" },
      target: null,
    });
    const answered = await service.send({
      actorUserId: "1",
      helpRequestId: first.request.id,
      body: "내일 수업 시간에\n다시 알려 줄게요",
    });
    expect(answered.messages.at(-1)).toMatchObject({ author: "teacher" });
    expect(answered.messages.at(-1)?.body).toBe("내일 수업 시간에\n다시 알려 줄게요");
    // 학생이 보낸 2번은 선생님께 알리지 않고(교권 보호, 9/27 사용자 결정), 담임 답장 1번만 학생에게 간다.
    // 알림 본문에는 메시지·이름을 싣지 않는다.
    expect(pushed.map((p) => [p.userId, p.kind, p.path, p.tag])).toEqual([
      ["2", "help_message", `/help-requests/${first.request.id}`, `help:${first.request.id}`],
    ]);
    for (const delivery of pushed)
      expect(`${delivery.title} ${delivery.body}`).not.toMatch(/수행평가|하나 더|내일|학생가/u);
  });

  it("남의 대화엔 못 쓰고, 닫힌 대화는 다시 열리며, 철회·겹치는 대화는 409다", async () => {
    await expect(
      service.send({ actorUserId: "3", helpRequestId: "100", body: "남의 대화" }),
    ).rejects.toBeInstanceOf(HelpRequestNotFoundException);
    // 예전에 처리 완료된 요청(101)에 학생이 이어 쓰면 다시 열리고 예전 답변은 남는다.
    const reopened = await service.send({ actorUserId: "3", helpRequestId: "101", body: "아직요" });
    expect(reopened.request).toMatchObject({
      closed_at: null,
      reply: "문구점에 있어요",
      status: "open",
    });
    // 같은 안내에 열린 요청이 따로 있으면, 닫힌 옛 대화를 다시 열 수 없다.
    const older = await service.create({
      actorUserId: "3",
      kind: "question",
      message: null,
      target: { id: "10", kind: "notice" },
    });
    await service.resolve({ actorUserId: "1", helpRequestId: older.id, reply: null });
    const newer = await service.create({
      actorUserId: "3",
      kind: "question",
      message: null,
      target: { id: "10", kind: "notice" },
    });
    await expect(
      service.send({ actorUserId: "3", helpRequestId: older.id, body: "옛 대화로" }),
    ).rejects.toBeInstanceOf(HelpRequestStateConflictException);
    await service.withdraw({ actorUserId: "3", helpRequestId: newer.id });
    await expect(
      service.send({ actorUserId: "3", helpRequestId: newer.id, body: "철회 뒤" }),
    ).rejects.toBeInstanceOf(HelpRequestStateConflictException);
    // 되돌리기: 101을 원래 상태로(앞 검사의 '기존 요청 그대로' 기준과 맞춘다).
    await admin
      .updateTable("help_requests")
      .set({ status: "resolved", closed_at: "2026-09-20 01:02:03.000000" })
      .where("id", "=", "101")
      .execute();
  });

  it("학생은 1분 20개·하루 200개까지만 보내고, 선생님은 제한이 없다", async () => {
    for (let n = 1; n <= 20; n += 1)
      await service.startGeneral({ actorUserId: "2", body: `질문 ${n}` });
    await expect(
      service.startGeneral({ actorUserId: "2", body: "스물한 번째" }),
    ).rejects.toBeInstanceOf(HelpRequestRateLimitedException);
    await expect(
      service.send({ actorUserId: "2", helpRequestId: "100", body: "다른 대화도" }),
    ).rejects.toBeInstanceOf(HelpRequestRateLimitedException);
    for (let n = 1; n <= 21; n += 1)
      await service.send({ actorUserId: "1", helpRequestId: "100", body: `답 ${n}` });
    // 하루 제한: 1분보다 오래전에 보낸 200개가 있으면 막힌다.
    await admin.deleteFrom("help_request_messages").execute();
    await sql
      .raw(
        `INSERT INTO help_request_messages (help_request_id,class_id,author_member_id,body,created_at)
         SELECT 100,1,2,'예전 질문',UTC_TIMESTAMP(6) - INTERVAL 2 HOUR FROM seq_1_to_200`,
      )
      .execute(admin);
    await expect(
      service.send({ actorUserId: "2", helpRequestId: "100", body: "201번째" }),
    ).rejects.toBeInstanceOf(HelpRequestRateLimitedException);
  });

  it.each(["resolved", "withdrawn"] as const)(
    "전송 대기 중 대화가 %s 상태로 바뀌면 최신 상태로 재개하거나 차단한다",
    async (status) => {
      const started = await service.startGeneral({ actorUserId: "2", body: "처음 질문" });
      let releaseLock!: () => void;
      let locked!: () => void;
      const ready = new Promise<void>((done) => (locked = done));
      const hold = new Promise<void>((done) => (releaseLock = done));
      const blocker = admin.transaction().execute(async (transaction) => {
        await transaction
          .updateTable("help_requests")
          .set({ status, closed_at: sql`UTC_TIMESTAMP(6)` })
          .where("id", "=", started.request.id)
          .execute();
        locked();
        await hold;
      });
      await ready;
      let awaitingMember!: () => void;
      const memberQueryReached = new Promise<void>((done) => (awaitingMember = done));
      // 실제 FOR UPDATE가 보내질 때 알려 주기만 한다. SQL·결과·실제 DB 잠금은 바꾸지 않는다.
      const observeLock: KyselyPlugin = {
        transformQuery({ node }) {
          if (
            node.kind === "SelectQueryNode" &&
            node.endModifiers?.some((modifier) => modifier.modifier === "ForUpdate")
          )
            awaitingMember();
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      };
      const observedService = new HelpRequestsService(
        app.withPlugin(observeLock),
        new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" }),
      );
      const sending = observedService
        .send({ actorUserId: "2", helpRequestId: started.request.id, body: "기다린 질문" })
        .then(
          (thread) => ({ thread, error: null }),
          (error: unknown) => ({ thread: null, error }),
        );
      try {
        await memberQueryReached;
      } finally {
        releaseLock();
        await blocker;
      }
      const sent = await sending;
      const finalThread = await service.thread("2", started.request.id);
      if (status === "resolved") {
        expect(sent.error).toBeNull();
        expect(finalThread.request.status).toBe("open");
        expect(finalThread.request.closed_at).toBeNull();
        expect(finalThread.messages.map((message) => message.body)).toEqual([
          "처음 질문",
          "기다린 질문",
        ]);
      } else {
        expect(sent.error).toBeInstanceOf(HelpRequestStateConflictException);
        expect(finalThread.request.status).toBe("withdrawn");
        expect(finalThread.messages.map((message) => message.body)).toEqual(["처음 질문"]);
      }
    },
  );

  it.each([
    ["removed", "send"],
    ["inactive", "send"],
    ["archived", "send"],
    ["teacher_revoked", "send"],
    ["removed", "start"],
    ["removed", "create"],
    ["removed", "withdraw"],
    ["teacher_revoked", "resolve"],
  ] as const)(
    "권한 조회 직후 %s 변경이 커밋되면 %s 쓰기는 이전 권한으로 저장하지 않는다",
    async (change, mutation) => {
      const started = await service.startGeneral({ actorUserId: "2", body: "처음 질문" });
      let actorRead!: () => void;
      let releaseActor!: () => void;
      const read = new Promise<void>((done) => (actorRead = done));
      const resume = new Promise<void>((done) => (releaseActor = done));
      let paused = false;
      const observeActor: KyselyPlugin = {
        transformQuery: ({ node }) => node,
        async transformResult({ result }) {
          // 실제 조회 결과의 전달만 늦춰 권한 조회와 쓰기 사이의 상태 변경을 고정한다.
          const row = result.rows[0];
          if (!paused && row && "class_status" in row && "profile_status" in row) {
            paused = true;
            actorRead();
            await resume;
          }
          return result;
        },
      };
      const observedService = new HelpRequestsService(
        app.withPlugin(observeActor),
        new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" }),
      );
      const write =
        mutation === "start"
          ? observedService.startGeneral({ actorUserId: "2", body: "권한 변경 뒤 질문" })
          : mutation === "create"
            ? observedService.create({
                actorUserId: "2",
                kind: "question",
                message: null,
                target: { id: "30", kind: "supply" },
              })
            : mutation === "withdraw"
              ? observedService.withdraw({ actorUserId: "2", helpRequestId: started.request.id })
              : mutation === "resolve"
                ? observedService.resolve({
                    actorUserId: "1",
                    helpRequestId: started.request.id,
                    reply: null,
                  })
                : observedService.send({
                    actorUserId: change === "teacher_revoked" ? "1" : "2",
                    helpRequestId: started.request.id,
                    body: "권한 변경 뒤 질문",
                  });
      const sending = write.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await read;
        if (change === "removed")
          await admin
            .updateTable("class_members")
            .set({ status: "removed", student_number: null })
            .where("id", "=", "2")
            .execute();
        else if (change === "inactive")
          await admin
            .updateTable("users")
            .set({ is_active: false })
            .where("id", "=", "2")
            .execute();
        else if (change === "archived")
          await admin
            .updateTable("classes")
            .set({
              status: "archived",
              archived_at: sql`UTC_TIMESTAMP(6)`,
              archived_by_user_id: "1",
            })
            .where("id", "=", "1")
            .execute();
        else
          await admin
            .updateTable("teacher_profiles")
            .set({
              status: "revoked",
              revoked_by_operator_id: "1",
              revoked_at: sql`UTC_TIMESTAMP(6)`,
            })
            .where("user_id", "=", "1")
            .execute();
        releaseActor();
        expect
          .soft(await sending)
          .toBeInstanceOf(
            change === "teacher_revoked"
              ? HelpRequestRoleInsufficientException
              : HelpRequestNotFoundException,
          );
        expect(
          (
            await admin
              .selectFrom("help_request_messages")
              .select("body")
              .where("help_request_id", "=", started.request.id)
              .orderBy("id")
              .execute()
          ).map((row) => row.body),
        ).toEqual(["처음 질문"]);
        expect(
          await admin
            .selectFrom("help_requests")
            .select(["id", "status"])
            .where("id", "not in", ["100", "101"])
            .execute(),
        ).toEqual([{ id: started.request.id, status: "open" }]);
      } finally {
        releaseActor();
        await sending;
        await admin
          .updateTable("class_members")
          .set({ status: "approved", student_number: 1 })
          .where("id", "=", "2")
          .execute();
        await admin.updateTable("users").set({ is_active: true }).where("id", "=", "2").execute();
        await admin
          .updateTable("classes")
          .set({ status: "active", archived_at: null, archived_by_user_id: null })
          .where("id", "=", "1")
          .execute();
        await admin
          .updateTable("teacher_profiles")
          .set({ status: "active", revoked_by_operator_id: null, revoked_at: null })
          .where("user_id", "=", "1")
          .execute();
      }
    },
  );
  it("추방 트랜잭션의 학생 행 잠금을 기다린 전송은 추방 커밋 뒤 차단한다", async () => {
    const started = await service.startGeneral({ actorUserId: "2", body: "처음 질문" });
    let releaseLock!: () => void;
    let locked!: () => void;
    let awaitingMember!: () => void;
    const ready = new Promise<void>((done) => (locked = done));
    const hold = new Promise<void>((done) => (releaseLock = done));
    const memberQueryReached = new Promise<void>((done) => (awaitingMember = done));
    const blocker = admin.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("class_members")
        .set({ status: "removed", student_number: null })
        .where("id", "=", "2")
        .execute();
      locked();
      await hold;
    });
    await ready;
    const observeLock: KyselyPlugin = {
      transformQuery({ node }) {
        if (
          node.kind === "SelectQueryNode" &&
          node.endModifiers?.some((modifier) => modifier.modifier === "ForUpdate")
        )
          awaitingMember();
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    };
    const observedService = new HelpRequestsService(
      app.withPlugin(observeLock),
      new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" }),
    );
    const sending = observedService
      .send({ actorUserId: "2", helpRequestId: started.request.id, body: "추방 대기 질문" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    try {
      await memberQueryReached;
      releaseLock();
      await blocker;
      expect.soft(await sending).toBeInstanceOf(HelpRequestNotFoundException);
      expect(
        (
          await admin
            .selectFrom("help_request_messages")
            .select("body")
            .where("help_request_id", "=", started.request.id)
            .orderBy("id")
            .execute()
        ).map((row) => row.body),
      ).toEqual(["처음 질문"]);
    } finally {
      releaseLock();
      await blocker;
      await sending;
      await admin
        .updateTable("class_members")
        .set({ status: "approved", student_number: 1 })
        .where("id", "=", "2")
        .execute();
    }
  });
  it("학생과 담임의 같은 대화 동시 전송은 권한 잠금 충돌 없이 모두 저장된다", async () => {
    const started = await service.startGeneral({ actorUserId: "2", body: "처음 질문" });
    const writes = Array.from({ length: 10 }, (_, index) => [
      service.send({ actorUserId: "2", helpRequestId: started.request.id, body: "학생 " + index }),
      service.send({ actorUserId: "1", helpRequestId: started.request.id, body: "담임 " + index }),
    ]).flat();
    const results = await Promise.allSettled(writes);
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    const thread = await service.thread("1", started.request.id);
    expect(thread.messages).toHaveLength(21);
    expect(new Set(thread.messages.map((message) => message.body)).size).toBe(21);
  });
});
