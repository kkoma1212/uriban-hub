import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createMariaDbDatabase, createMysql2MariaDbPool, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, MysqlDialect, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnvironment } from "../src/config/environment.js";
import { PollsService } from "../src/polls/polls.service.js";
import type { PollItem } from "../src/polls/polls.types.js";

const configPath = process.env.POLL_CLOSE_QA_MARIADB_CONFIG;
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

describe.runIf(configPath !== undefined)("manual poll close on an owned TLS MariaDB", () => {
  let admin: Kysely<DB>;
  let app: Kysely<DB>;
  let service: PollsService;
  let poll: PollItem;
  const close = (actorUserId = "1", ifMatch = '"1"') =>
    service.close({ actorUserId, pollId: poll.id, ifMatch, requestId: randomUUID() });
  const vote = (actorUserId = "2") =>
    service.vote({
      actorUserId,
      pollId: poll.id,
      optionId: poll.options[0]!.id,
      idempotencyKey: randomUUID(),
    });
  const row = () =>
    admin
      .selectFrom("polls")
      .select(["closed_at", "closes_at", "row_version"])
      .where("id", "=", poll.id)
      .executeTakeFirstOrThrow();
  beforeAll(async () => {
    const target = JSON.parse(await readFile(configPath!, "utf8"));
    expect(target.kind).toBe("classhub-poll-isolated-qa");
    expect(target.database).toBe("classhub_poll_qa");
    expect(target.host).toBe("localhost");
    expect(target.port).toBeGreaterThan(1024);
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
        (1,'teacher@example.invalid','합성 교사','synthetic',UTC_TIMESTAMP(6)),
        (2,'student1@example.invalid','합성 학생가','synthetic',UTC_TIMESTAMP(6)),
        (3,'student2@example.invalid','합성 학생나','synthetic',UTC_TIMESTAMP(6)),
        (4,'foreign@example.invalid','다른 교사','synthetic',UTC_TIMESTAMP(6));
      INSERT INTO operators (id,email_normalized,credential_hash) VALUES (1,'operator@example.invalid',REPEAT('q',32));
      INSERT INTO teacher_profiles (user_id,temporary_password_must_change,created_by_operator_id) VALUES (1,FALSE,1),(4,FALSE,1);
      INSERT INTO schools (edu_office_code,school_code,school_name,school_kind,region_name,edu_office_name)
        VALUES ('B10','9000001','합성 학교','elementary','합성 지역','합성 교육청');
      INSERT INTO classes (id,name,academic_year,grade,edu_office_code,school_code,expected_student_count,created_by_user_id)
        VALUES (1,'합성 1반',2026,3,'B10','9000001',2,1),(2,'합성 2반',2026,3,'B10','9000001',2,4);
      INSERT INTO class_members (id,class_id,user_id,role,status,student_number,display_name_in_class)
        VALUES (1,1,1,'teacher','approved',NULL,'합성 교사'),(2,1,2,'student','approved',1,'합성 학생가'),
          (3,1,3,'student','approved',2,'합성 학생나'),(4,2,4,'teacher','approved',NULL,'다른 교사');
      INSERT INTO polls (id,class_id,created_by_member_id,title,option_count,closes_at) VALUES
        (100,1,1,'이전 투표',2,UTC_TIMESTAMP(6) + INTERVAL 1 HOUR);
      INSERT INTO poll_options (id,poll_id,position,label) VALUES (201,100,1,'첫 선택'),(202,100,2,'둘째 선택');
      INSERT INTO poll_votes (poll_id,class_id,option_id,member_id) VALUES (100,1,201,2);
    `,
      )
      .execute(admin);
    const legacy = await admin
      .selectFrom("polls")
      .select(["id", "closes_at", "row_version"])
      .where("id", "=", "100")
      .executeTakeFirstOrThrow();
    await sql
      .raw(
        await readFile(new URL("db/mariadb/migrations/0046_poll_manual_close.sql", root), "utf8"),
      )
      .execute(admin);
    expect(
      await admin
        .selectFrom("polls")
        .select(["id", "closed_at", "closes_at", "row_version"])
        .where("id", "=", "100")
        .executeTakeFirstOrThrow(),
    ).toEqual({ ...legacy, closed_at: null });
    const grant = (
      await readFile(new URL("db/mariadb/permissions/0046_poll_manual_close_acl.sql", root), "utf8")
    )
      .replaceAll("classhub_mariadb_phase1_dev", target.database)
      .replaceAll("'classhub_app'@'%'", "'poll_qa_app'@'localhost'");
    await sql.raw(grant).execute(admin);
    app = createMariaDbDatabase<DB>(createMysql2MariaDbPool, {
      ...connection,
      sslCa: target.sslCa,
      user: target.appUser,
      password: target.appPassword,
    });
    service = new PollsService(
      app,
      new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" }),
    );
    const old = await service.get({ actorUserId: "1", pollId: "100" });
    expect(old).toMatchObject({
      status: "open",
      closed_at: null,
      results_visible: false,
      total_vote_count: null,
    });
  });
  beforeEach(async () => {
    poll = await service.create({
      actorUserId: "1",
      ballotVisibility: "private",
      resultsPolicy: "after_close",
      closesAt: new Date(Date.now() + 3600_000).toISOString(),
      description: null,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
      options: ["첫 선택", "둘째 선택"],
      title: "즉시 종료 검증",
    });
  });
  afterAll(async () => {
    await Promise.allSettled([app?.destroy(), admin?.destroy()]);
  });

  it("closes before five minutes without changing the deadline or losing responses", async () => {
    await vote();
    const result = await close();
    expect(result).toMatchObject({
      status: "closed",
      row_version: "2",
      closes_at: poll.closes_at,
      total_vote_count: 1,
    });
    expect(result.closed_at).not.toBeNull();
    expect(
      new Date(result.closed_at!).getTime() - new Date(poll.created_at).getTime(),
    ).toBeLessThan(300_000);
    await expect(vote("3")).rejects.toMatchObject({ status: 409 });
    expect(await service.get({ actorUserId: "3", pollId: poll.id })).toMatchObject({
      results_visible: true,
      total_vote_count: 1,
      status: "closed",
    });
    expect(
      (await service.list({ actorUserId: "1", scope: "open" })).items.map(({ id }) => id),
    ).not.toContain(poll.id);
    expect(
      (await service.list({ actorUserId: "1", scope: "closed" })).items.map(({ id }) => id),
    ).toContain(poll.id);
    const audits = await admin
      .selectFrom("audit_logs")
      .select(["after_json", "before_json"])
      .where("action", "=", "poll.closed")
      .where("target_id", "=", poll.id)
      .execute();
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toMatch(/member_id|option_id/u);
  });
  it("denies students, foreign teachers and stale versions without writes", async () => {
    const before = await row();
    await expect(close("2")).rejects.toMatchObject({ status: 403 });
    await expect(close("4")).rejects.toMatchObject({ status: 404 });
    await expect(close("1", '"2"')).rejects.toMatchObject({ status: 409 });
    expect(await row()).toEqual(before);
  });
  it("keeps updates limited to closure and version columns", async () => {
    await expect(
      app.updateTable("polls").set({ title: "허용 안 됨" }).where("id", "=", poll.id).execute(),
    ).rejects.toThrow();
    await expect(
      app
        .updateTable("polls")
        .set({ closed_at: sql<Date>`created_at - INTERVAL 1 SECOND` })
        .where("id", "=", poll.id)
        .execute(),
    ).rejects.toThrow();
    expect((await row()).closed_at).toBeNull();
  });
  it("serializes a vote racing with closure", async () => {
    const [voting, closing] = await Promise.allSettled([vote(), close()]);
    expect(closing.status).toBe("fulfilled");
    if (voting.status === "rejected") expect(voting.reason).toMatchObject({ status: 409 });
    expect((await service.get({ actorUserId: "1", pollId: poll.id })).total_vote_count).toBe(
      voting.status === "fulfilled" ? 1 : 0,
    );
  });
  it("records one closure across concurrent requests and a current-version repeat", async () => {
    const results = await Promise.allSettled([close(), close()]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
    await close("1", '"2"');
    expect(
      await admin
        .selectFrom("audit_logs")
        .select("id")
        .where("action", "=", "poll.closed")
        .where("target_id", "=", poll.id)
        .execute(),
    ).toHaveLength(1);
  });
  it("rolls closure back if the audit write fails", async () => {
    await sql`REVOKE INSERT ON classhub_poll_qa.audit_logs FROM 'poll_qa_app'@'localhost'`.execute(
      admin,
    );
    try {
      await expect(close()).rejects.toThrow();
      expect(await row()).toMatchObject({ closed_at: null, row_version: "1" });
    } finally {
      await sql`GRANT INSERT ON classhub_poll_qa.audit_logs TO 'poll_qa_app'@'localhost'`.execute(
        admin,
      );
    }
  });
  // 진행 중 투표 수정(원장 107·108, 2026-10-04 사용자 결정, 제한형). 위 마감 시험이 모두 끝난 뒤 같은 DB에
  // 107·108을 깔고 시작한다 — 위의 "제목 수정 거부" 시험은 108 이전 권한을 확인하는 것이라 순서가 중요하다.
  describe("teacher edits of an open poll (ledger 107-108)", () => {
    let editor: PollsService;
    type Changes = Partial<{
      closesAt: string;
      description: string | null;
      options: string[];
      title: string;
    }>;
    const edit = (
      changes: Changes = {},
      { actorUserId = "1", ifMatch = '"1"', using = () => editor } = {},
    ) =>
      using().update({
        actorUserId,
        closesAt: changes.closesAt ?? poll.closes_at,
        description: changes.description === undefined ? poll.description : changes.description,
        ifMatch,
        options: changes.options ?? poll.options.map(({ label }) => label),
        pollId: poll.id,
        requestId: randomUUID(),
        title: changes.title ?? poll.title,
      });
    const options = () =>
      admin
        .selectFrom("poll_options")
        .select(["label", "position"])
        .where("poll_id", "=", poll.id)
        .orderBy("position", "asc")
        .execute();
    const voteCount = async () =>
      (await admin.selectFrom("poll_votes").select("id").where("poll_id", "=", poll.id).execute())
        .length;
    const edits = () =>
      admin
        .selectFrom("audit_logs")
        .select(["after_json", "before_json", "reason"])
        .where("action", "=", "poll.updated")
        .where("target_id", "=", poll.id)
        .execute();
    beforeAll(async () => {
      // 108 이전 설정의 서비스는 수정 요청을 받지 않는다(바깥 beforeEach가 만든 투표로 확인).
      poll = await service.create({
        actorUserId: "1",
        ballotVisibility: "private",
        resultsPolicy: "after_close",
        closesAt: new Date(Date.now() + 3600_000).toISOString(),
        description: null,
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
        options: ["첫 선택", "둘째 선택"],
        title: "설치 전",
      });
      await expect(edit({ title: "고침" }, { using: () => service })).rejects.toMatchObject({
        status: 409,
        response: { code: "POLL_EDIT_UNAVAILABLE" },
      });
      await sql
        .raw(await readFile(new URL("db/mariadb/migrations/0064_poll_edit.sql", root), "utf8"))
        .execute(admin);
      const grant = (
        await readFile(new URL("db/mariadb/permissions/0064_poll_edit_acl.sql", root), "utf8")
      )
        .replaceAll("classhub_mariadb_phase1_dev", "classhub_poll_qa")
        .replaceAll("'classhub_app'@'%'", "'poll_qa_app'@'localhost'");
      await sql.raw(grant).execute(admin);
      editor = new PollsService(
        app,
        new ConfigService<AppEnvironment, true>({
          DATABASE_ENGINE: "mariadb",
          POLL_EDIT_DATABASE_INSTALLED: true,
        }),
      );
    });

    it("edits title, description and deadline after votes while options stay identical", async () => {
      await vote();
      const later = new Date(new Date(poll.closes_at).getTime() + 86_400_000).toISOString();
      const result = await edit({ closesAt: later, description: "설명 추가", title: "고친 제목" });
      expect(result).toMatchObject({
        closes_at: later,
        description: "설명 추가",
        row_version: "2",
        status: "open",
        title: "고친 제목",
      });
      expect(await options()).toEqual([
        { label: "첫 선택", position: 1 },
        { label: "둘째 선택", position: 2 },
      ]);
      // 마감 후 공개 투표라 진행 중에는 교사에게도 표 수가 숨겨진다 — DB에서 직접 센다.
      expect(await voteCount()).toBe(1);
      const audits = await edits();
      expect(audits).toHaveLength(1);
      expect(audits[0]!.reason).toBe("teacher_edit");
      expect(JSON.stringify(audits)).toMatch(/고친 제목/u);
      expect(JSON.stringify(audits)).not.toMatch(/member_id|option_id|설명 추가/u);
    });

    it("replaces options while nobody has voted, and the new options take votes", async () => {
      const result = await edit({ options: ["가", "나", "다"] });
      expect(result.options.map(({ label }) => label)).toEqual(["가", "나", "다"]);
      expect(await options()).toEqual([
        { label: "가", position: 1 },
        { label: "나", position: 2 },
        { label: "다", position: 3 },
      ]);
      expect((await edits())[0]!.reason).toBe("teacher_edit_with_options");
      await editor.vote({
        actorUserId: "2",
        idempotencyKey: randomUUID(),
        optionId: result.options[2]!.id,
        pollId: poll.id,
      });
      // 마감 후 공개 투표라 진행 중에는 교사에게도 표 수가 숨겨진다 — DB에서 직접 센다.
      expect(await voteCount()).toBe(1);
    });

    it("locks options once a vote exists and writes nothing", async () => {
      await vote();
      const before = await row();
      await expect(edit({ options: ["첫 선택", "새 선택"] })).rejects.toMatchObject({
        status: 409,
        response: { code: "POLL_OPTIONS_LOCKED" },
      });
      expect(await row()).toEqual(before);
      expect(await options()).toEqual([
        { label: "첫 선택", position: 1 },
        { label: "둘째 선택", position: 2 },
      ]);
      expect(await edits()).toHaveLength(0);
    });

    it("denies students, foreign teachers, stale versions, closed polls and bad deadlines", async () => {
      const before = await row();
      await expect(edit({ title: "학생" }, { actorUserId: "2" })).rejects.toMatchObject({
        status: 403,
      });
      await expect(edit({ title: "남의 반" }, { actorUserId: "4" })).rejects.toMatchObject({
        status: 404,
      });
      await expect(edit({ title: "옛 판" }, { ifMatch: '"2"' })).rejects.toMatchObject({
        status: 409,
      });
      const tooSoon = new Date(Date.now() + 60_000).toISOString();
      const tooLate = new Date(new Date(poll.created_at).getTime() + 31 * 86_400_000).toISOString();
      for (const closesAt of [tooSoon, tooLate])
        await expect(edit({ closesAt })).rejects.toMatchObject({ status: 400 });
      await expect(edit({ options: ["같음", " 같음 "] })).rejects.toMatchObject({ status: 400 });
      expect(await row()).toEqual(before);
      await close();
      await expect(edit({ title: "마감 뒤" }, { ifMatch: '"2"' })).rejects.toMatchObject({
        status: 409,
        response: { code: "POLL_CLOSED" },
      });
      expect(await edits()).toHaveLength(0);
    });

    it("returns the same version without an audit record when nothing changed", async () => {
      expect(await edit()).toMatchObject({ row_version: "1", title: poll.title });
      expect(await edits()).toHaveLength(0);
    });

    it("never leaves a vote on a removed option when a vote races an options change", async () => {
      const [voting, editing] = await Promise.allSettled([
        vote(),
        edit({ options: ["새 가", "새 나"] }),
      ]);
      // 먼저 잠근 쪽이 이긴다: 표가 먼저면 선택지가 잠기고, 수정이 먼저면 옛 선택지 표는 거절된다.
      if (voting.status === "fulfilled") expect(editing.status).toBe("rejected");
      else expect(editing.status).toBe("fulfilled");
      const orphanVotes = await admin
        .selectFrom("poll_votes")
        .leftJoin("poll_options", "poll_options.id", "poll_votes.option_id")
        .select("poll_votes.id")
        .where("poll_votes.poll_id", "=", poll.id)
        .where("poll_options.id", "is", null)
        .execute();
      expect(orphanVotes).toHaveLength(0);
    });

    it("still cannot change the ballot visibility or results policy", async () => {
      await expect(
        app
          .updateTable("polls")
          .set({ ballot_visibility: "teacher_visible" })
          .where("id", "=", poll.id)
          .execute(),
      ).rejects.toThrow();
      await expect(
        app
          .updateTable("polls")
          .set({ results_policy: "after_vote" })
          .where("id", "=", poll.id)
          .execute(),
      ).rejects.toThrow();
    });
  });
});
