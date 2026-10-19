import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createMariaDbDatabase, createMysql2MariaDbPool, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, MysqlDialect, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnvironment } from "../src/config/environment.js";
import { TeacherLibraryService } from "../src/teacher-library/teacher-library.service.js";

const configPath = process.env.TEACHER_LIBRARY_QA_MARIADB_CONFIG;
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

/** S2 교사 자료함 표(0051)와 권한(ACL)을 설치 파일 그대로 적용해 DB 규칙을 확인한다. */
describe.runIf(configPath !== undefined)("teacher library on an owned TLS MariaDB", () => {
  let admin: Kysely<DB>;
  let app: Kysely<DB>;
  let library: TeacherLibraryService;
  const draft = (source_id: string, extra: Record<string, unknown> = {}) => ({
    kind: "notice" as const,
    source_id,
    title: "수행평가 안내",
    body: "범위는 1단원입니다." as string | null,
    ...extra,
  });
  const keep = (userId: string, source_id: string, extra: Record<string, unknown> = {}) =>
    library.create(userId, { ...draft(source_id, extra), confirm_personal_info: true } as never);
  const item = (values: Record<string, unknown> = {}) => ({
    owner_user_id: "1",
    kind: "notice",
    category: "general",
    title: "수행평가 안내",
    body: "다음 주 수행평가 범위입니다.",
    source_item_id: "10",
    source_academic_year: 2025,
    source_grade: 1,
    source_school_name: "합성 고등학교",
    source_class_name: "1반",
    personal_info_confirmed_at: sql`UTC_TIMESTAMP(6)`,
    ...values,
  });
  const save = (values: Record<string, unknown> = {}) =>
    app
      .insertInto("teacher_library_items")
      .values(item(values) as never)
      .execute();

  beforeAll(async () => {
    const target = JSON.parse(await readFile(configPath!, "utf8"));
    expect(target.kind).toBe("classhub-teacher-library-isolated-qa");
    expect(target.database).toBe("classhub_teacher_library_qa");
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
      .raw(await readFile(new URL("db/mariadb/migrations/0051_teacher_library.sql", root), "utf8"))
      .execute(admin);
    const grant = (
      await readFile(new URL("db/mariadb/permissions/0051_teacher_library_acl.sql", root), "utf8")
    )
      .replaceAll("classhub_mariadb_phase1_dev", target.database)
      .replaceAll("'classhub_app'@'%'", "'teacher_library_qa_app'@'localhost'");
    await sql.raw(grant).execute(admin);
    await sql
      .raw(
        `INSERT INTO users (id,email_normalized,display_name,password_hash,email_verified_at) VALUES
          (1,'t1@example.invalid','합성 교사가','synthetic',UTC_TIMESTAMP(6)),
          (2,'t2@example.invalid','합성 교사나','synthetic',UTC_TIMESTAMP(6)),
          (3,'s3@example.invalid','김민수','synthetic',UTC_TIMESTAMP(6)),
          (9,'t9@example.invalid','지울 교사','synthetic',UTC_TIMESTAMP(6));
        INSERT INTO operators (id,email_normalized,credential_hash) VALUES (1,'op@example.invalid',REPEAT('q',32));
        INSERT INTO teacher_profiles (user_id,temporary_password_must_change,created_by_operator_id) VALUES
          (1,FALSE,1),(2,FALSE,1);
        INSERT INTO schools (edu_office_code,school_code,school_name,school_kind,region_name,edu_office_name)
          VALUES ('B10','9000001','합성 고등학교','high','합성 지역','합성 교육청');
        INSERT INTO classes (id,name,academic_year,grade,edu_office_code,school_code,expected_student_count,created_by_user_id,status,archived_at,archived_by_user_id) VALUES
          (1,'지금 반',2026,2,'B10','9000001',5,1,'active',NULL,NULL),
          (2,'작년 반',2025,1,'B10','9000001',5,1,'archived',UTC_TIMESTAMP(6) - INTERVAL 10 DAY,1),
          (3,'오래된 반',2024,1,'B10','9000001',5,1,'archived',UTC_TIMESTAMP(6) - INTERVAL 400 DAY,1),
          (4,'남의 반',2026,2,'B10','9000001',5,2,'active',NULL,NULL);
        INSERT INTO class_members (id,class_id,user_id,role,status,student_number,display_name_in_class) VALUES
          (1,1,1,'teacher','approved',NULL,NULL),
          (2,1,3,'student','approved',1,'민수'),
          (3,2,1,'teacher','archived',NULL,NULL),
          (4,3,1,'teacher','archived',NULL,NULL),
          (5,4,2,'teacher','approved',NULL,NULL);
        INSERT INTO notices (id,class_id,title,content,created_by_member_id,audience_mode,category,is_important,published_at) VALUES
          (10,1,'지금 반 공지','내용',1,'legacy_class','performance',TRUE,UTC_TIMESTAMP(6) - INTERVAL 1 DAY),
          (20,2,'작년 반 공지','내용',3,'legacy_class','general',FALSE,UTC_TIMESTAMP(6) - INTERVAL 30 DAY),
          (30,3,'오래된 반 공지','내용',4,'legacy_class','general',FALSE,UTC_TIMESTAMP(6) - INTERVAL 500 DAY),
          (40,4,'남의 반 공지','내용',5,'legacy_class','general',FALSE,UTC_TIMESTAMP(6) - INTERVAL 1 DAY),
          (12,1,'예약 공지','내용',1,'legacy_class','general',FALSE,UTC_TIMESTAMP(6) + INTERVAL 1 DAY);
        INSERT INTO notices (id,class_id,title,content,created_by_member_id,audience_mode,published_at,deleted_at,deleted_by_member_id) VALUES
          (11,1,'지운 공지','내용',1,'legacy_class',UTC_TIMESTAMP(6) - INTERVAL 1 DAY,UTC_TIMESTAMP(6),1);
        INSERT INTO supplies (id,class_id,title,description,needed_on,created_by_member_id,audience_mode,category) VALUES
          (50,1,'숙제 1','문제집 10쪽',CURRENT_DATE,1,'legacy_class','homework');`,
      )
      .execute(admin);
    app = createMariaDbDatabase<DB>(createMysql2MariaDbPool, {
      ...connection,
      sslCa: target.sslCa,
      user: target.appUser,
      password: target.appPassword,
    });
    library = new TeacherLibraryService(
      app,
      new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" }),
    );
  });

  beforeEach(async () => {
    await admin.deleteFrom("teacher_library_items").execute();
  });

  afterAll(async () => {
    await app?.destroy();
    await admin?.destroy();
  });

  it("공지·준비물 글을 담고, 종류·분류·중요 표시·길이·출처 규칙을 DB가 지킨다", async () => {
    await save();
    await save({ kind: "supply", category: "homework", source_item_id: "30", title: "숙제" });
    await save({ source_item_id: null, title: "직접 담은 글" });
    await save({ source_item_id: null, title: "직접 담은 글 2" });

    await expect(save({ source_item_id: "11", category: "homework" })).rejects.toThrow(
      /teacher_library_items_kind_check/u,
    );
    await expect(
      save({ kind: "supply", category: "general", source_item_id: "31", is_important: true }),
    ).rejects.toThrow(/teacher_library_items_important_check/u);
    await expect(save({ source_item_id: "12", title: "   " })).rejects.toThrow(
      /teacher_library_items_title_check/u,
    );
    await expect(save({ source_item_id: "13", title: "가".repeat(101) })).rejects.toThrow(
      /Data too long|teacher_library_items_title_check/u,
    );
    await expect(save({ source_item_id: "14", body: "가".repeat(2001) })).rejects.toThrow(
      /teacher_library_items_body_check/u,
    );
    await expect(save({ source_item_id: "15", source_grade: 7 })).rejects.toThrow(
      /teacher_library_items_source_check/u,
    );
    await expect(save({ source_item_id: "16", owner_user_id: "99" })).rejects.toThrow(
      /foreign key/iu,
    );
  });

  it("같은 글을 두 번 담지 못한다 — 다른 교사는 같은 원글을 따로 담을 수 있다", async () => {
    await save();
    await expect(save()).rejects.toThrow(/Duplicate entry/iu);
    await save({ owner_user_id: "2" });
    await save({ kind: "supply", category: "general", title: "같은 번호의 준비물" });
    expect((await app.selectFrom("teacher_library_items").select("id").execute()).length).toBe(3);
  });

  it("앱 계정은 담기·보기·지우기만 한다 — 고치기는 권한이 없다", async () => {
    await save();
    await expect(
      app.updateTable("teacher_library_items").set({ title: "몰래 수정" }).execute(),
    ).rejects.toThrow(/UPDATE command denied/iu);
    await app.deleteFrom("teacher_library_items").where("owner_user_id", "=", "1").execute();
    expect(await app.selectFrom("teacher_library_items").select("id").execute()).toEqual([]);
  });

  it("계정이 실제로 지워지면 그 교사의 자료도 함께 지워진다", async () => {
    await save();
    await save({ owner_user_id: "9" });
    await admin.deleteFrom("users").where("id", "=", "9").execute();
    const rest = await admin.selectFrom("teacher_library_items").select("owner_user_id").execute();
    expect(rest.map((row) => String(row.owner_user_id))).toEqual(["1"]);
  });

  it("지금 반과 종료 1년 안의 지난 반 원글만 담는다 — 오래된·남의 반·지운·예약 글은 못 담는다", async () => {
    const saved = await keep("1", "10", { title: "고친 제목" });
    expect(saved).toMatchObject({
      category: "performance",
      is_important: true,
      kind: "notice",
      source: {
        academic_year: 2026,
        class_name: "지금 반",
        grade: 2,
        school_name: "합성 고등학교",
      },
      title: "고친 제목",
    });
    await keep("1", "20");
    await keep("1", "50", { kind: "supply", title: "숙제 1", body: "문제집 10쪽" });
    for (const source of ["30", "40", "11", "12", "999"])
      await expect(keep("1", source)).rejects.toMatchObject({ status: 404 });
    await expect(keep("1", "10")).rejects.toMatchObject({ status: 409 });
    // 같은 번호라도 종류가 다르면 다른 원글이다.
    await expect(keep("1", "10", { kind: "supply" })).rejects.toMatchObject({ status: 404 });
  });

  it("담기 전 검사가 반 학생 이름과 전화번호·이메일 모양을 찾는다", async () => {
    const { hits } = await library.check(
      "1",
      draft("10", {
        body: "김민수(민수)는 010-1234-5678, a.b@example.com 으로 연락. 2025-03-02 제출",
      }) as never,
    );
    expect(hits).toEqual(
      expect.arrayContaining([
        { kind: "name", text: "김민수" },
        { kind: "name", text: "민수" },
        { kind: "phone", text: "010-1234-5678" },
        { kind: "email", text: "a.b@example.com" },
      ]),
    );
    expect(hits.some((hit) => hit.text.includes("2025-03-02"))).toBe(false);
    expect((await library.check("1", draft("10") as never)).hits).toEqual([]);
  });

  it("목록 검색·종류·학년도·쪽 넘김이 되고, 남의 자료는 보지도 지우지도 못한다", async () => {
    await keep("1", "10", { title: "수행평가 안내 알파" });
    await keep("1", "20");
    await keep("1", "50", { kind: "supply", title: "숙제 1", body: null });
    const other = await keep("2", "40");
    await sql
      .raw(
        `INSERT INTO teacher_library_items (owner_user_id,kind,category,title,source_academic_year,source_grade,source_school_name,source_class_name,personal_info_confirmed_at)
         SELECT 1,'notice','general',CONCAT('예전 글 ',seq),2023,1,'합성 고등학교','옛 반',UTC_TIMESTAMP(6) - INTERVAL seq MINUTE
         FROM seq_1_to_22`,
      )
      .execute(admin);
    const first = await library.list("1", {});
    expect(first.items).toHaveLength(20);
    const second = await library.list("1", { cursor: first.next_cursor! });
    expect(first.items.length + second.items.length).toBe(25);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(25);
    expect((await library.list("1", { q: "알파" })).items.map((item) => item.title)).toEqual([
      "수행평가 안내 알파",
    ]);
    expect((await library.list("1", { kind: "supply" })).items.map((item) => item.kind)).toEqual([
      "supply",
    ]);
    expect((await library.list("1", { year: 2025 })).items).toHaveLength(1);
    await expect(library.get("1", other.id)).rejects.toMatchObject({ status: 404 });
    await expect(library.remove("1", other.id)).rejects.toMatchObject({ status: 404 });
    await library.remove("2", other.id);
    await expect(library.get("2", other.id)).rejects.toMatchObject({ status: 404 });
    await expect(library.list("1", { cursor: "bad" })).rejects.toMatchObject({ status: 400 });
  });

  it("학생 계정은 자료함을 쓰지 못하고, 준비물 설명은 500자까지다", async () => {
    await expect(library.list("3", {})).rejects.toMatchObject({ status: 403 });
    await expect(keep("3", "10")).rejects.toMatchObject({ status: 403 });
    await expect(
      keep("1", "50", { kind: "supply", title: "숙제 1", body: "가".repeat(501) }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
