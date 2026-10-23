import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createMariaDbDatabase, createMysql2MariaDbPool, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, MysqlDialect, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnvironment } from "../src/config/environment.js";
import type { RedisRateLimiter } from "../src/common/rate-limit/redis-rate-limiter.js";
import { MemberPhotoPresenceReader } from "../src/profile-photos/member-photo-presence.js";
import { deleteAccountProfilePhotoIfInstalled } from "../src/profile-photos/profile-photo-deletion.js";
import { ProfilePhotoNotFoundException } from "../src/profile-photos/profile-photo.errors.js";
import { ProfilePhotoImageService } from "../src/profile-photos/profile-photo-image.service.js";
import { ProfilePhotosService } from "../src/profile-photos/profile-photos.service.js";

const configPath = process.env.PROFILE_PHOTOS_QA_MARIADB_CONFIG;
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

/**
 * T-PHOTO 1단계(2026-09-29): 프로필 사진 표(0053, 원장 96)와 권한(ACL, 원장 97)을 설치 파일 그대로
 * 적용하고, 제한된 앱 계정으로 실제 서비스(올리기·보기·같은 반 권한·지우기·탈퇴 정리)를 돌린다.
 */
describe.runIf(configPath !== undefined)("profile photos on an owned TLS MariaDB", () => {
  let admin: Kysely<DB>;
  let app: Kysely<DB>;
  let photos: ProfilePhotosService;
  let pngBase64: (color: string) => Promise<string>;
  const actor = (userId: string, sessionId: string, currentClassId: string | null = "1") => ({
    userId,
    sessionId,
    currentClassId,
  });
  const teacher = actor("1", "1");
  const student = actor("2", "2");
  const otherClassTeacher = actor("9", "9", "2");

  beforeAll(async () => {
    const target = JSON.parse(await readFile(configPath!, "utf8"));
    expect(target.kind).toBe("classhub-profile-photos-isolated-qa");
    expect(target.database).toBe("classhub_profile_photos_qa");
    expect([3306, 3307, 5173, 5174]).not.toContain(target.port);
    const require = createRequire(new URL("packages/db/package.json", root));
    const mysql = require("mysql2");
    const sharp = createRequire(new URL("apps/api/package.json", root))("sharp");
    pngBase64 = async (color) =>
      (
        await sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
          .png()
          .toBuffer()
      ).toString("base64");
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
      .raw(await readFile(new URL("db/mariadb/migrations/0053_profile_photos.sql", root), "utf8"))
      .execute(admin);
    const grant = (
      await readFile(new URL("db/mariadb/permissions/0053_profile_photos_acl.sql", root), "utf8")
    )
      .replaceAll("classhub_mariadb_phase1_dev", target.database)
      .replaceAll("'classhub_app'@'%'", "'profile_photos_qa_app'@'localhost'");
    await sql.raw(grant).execute(admin);
    await sql
      .raw(
        `INSERT INTO users (id,email_normalized,display_name,password_hash,email_verified_at) VALUES
          (1,'teacher@example.invalid','합성 교사','synthetic',UTC_TIMESTAMP(6)),
          (2,'student1@example.invalid','합성 학생가','synthetic',UTC_TIMESTAMP(6)),
          (3,'student2@example.invalid','합성 학생나','synthetic',UTC_TIMESTAMP(6)),
          (4,'left@example.invalid','나간 학생','synthetic',UTC_TIMESTAMP(6)),
          (9,'teacher2@example.invalid','다른 반 교사','synthetic',UTC_TIMESTAMP(6));
        INSERT INTO sessions (id,user_id,session_hash,csrf_token_hash,expires_at,created_ip) VALUES
          (1,1,REPEAT('a',32),REPEAT('b',32),UTC_TIMESTAMP(6) + INTERVAL 1 DAY,'127.0.0.1'),
          (2,2,REPEAT('c',32),REPEAT('d',32),UTC_TIMESTAMP(6) + INTERVAL 1 DAY,'127.0.0.1'),
          (3,3,REPEAT('e',32),REPEAT('f',32),UTC_TIMESTAMP(6) + INTERVAL 1 DAY,'127.0.0.1'),
          (4,4,REPEAT('g',32),REPEAT('h',32),UTC_TIMESTAMP(6) + INTERVAL 1 DAY,'127.0.0.1'),
          (9,9,REPEAT('i',32),REPEAT('j',32),UTC_TIMESTAMP(6) + INTERVAL 1 DAY,'127.0.0.1'),
          (10,2,REPEAT('k',32),REPEAT('l',32),UTC_TIMESTAMP(6) + INTERVAL 1 DAY,'127.0.0.1');
        UPDATE sessions SET issued_at = UTC_TIMESTAMP(6) - INTERVAL 2 DAY, expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = 10;
        INSERT INTO operators (id,email_normalized,credential_hash) VALUES (1,'operator@example.invalid',REPEAT('q',32));
        INSERT INTO teacher_profiles (user_id,temporary_password_must_change,created_by_operator_id) VALUES
          (1,FALSE,1),(9,FALSE,1);
        INSERT INTO schools (edu_office_code,school_code,school_name,school_kind,region_name,edu_office_name)
          VALUES ('B10','9000001','합성 학교','middle','합성 지역','합성 교육청');
        INSERT INTO classes (id,name,academic_year,grade,edu_office_code,school_code,expected_student_count,created_by_user_id)
          VALUES (1,'합성 1반',2026,2,'B10','9000001',3,1), (2,'합성 2반',2026,2,'B10','9000001',1,9);
        INSERT INTO class_members (id,class_id,user_id,role,status,student_number,display_name_in_class) VALUES
          (1,1,1,'teacher','approved',NULL,'합성 교사'),
          (2,1,2,'student','approved',1,'합성 학생가'),
          (3,1,3,'student','approved',2,NULL),
          (4,1,4,'student','left',NULL,NULL),
          (9,2,9,'teacher','approved',NULL,'다른 반 교사');`,
      )
      .execute(admin);
    app = createMariaDbDatabase<DB>(createMysql2MariaDbPool, {
      ...connection,
      sslCa: target.sslCa,
      user: target.appUser,
      password: target.appPassword,
    });
    const allowAll = {
      consume: async () => ({ allowed: true, remaining: 9, retryAfterSeconds: 0 }),
    } as unknown as RedisRateLimiter;
    photos = new ProfilePhotosService(
      app,
      new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" }),
      allowAll,
      new ProfilePhotoImageService(),
    );
  });

  beforeEach(async () => {
    await admin.deleteFrom("user_profile_photos").execute();
  });

  afterAll(async () => {
    await app?.destroy();
    await admin?.destroy();
  });

  it("DB가 크기·버전 형식·계정 참조를 지키고, 앱 계정은 설치 권한 밖의 쓰기를 못 한다", async () => {
    const insert = (values: Record<string, unknown>) =>
      admin
        .insertInto("user_profile_photos")
        .values({
          user_id: "3",
          photo_version: "00000000-0000-4000-8000-000000000000",
          image_bytes: Buffer.alloc(10, 1),
          ...values,
        } as never)
        .execute();
    await insert({ image_bytes: Buffer.alloc(64000, 1) });
    await admin.deleteFrom("user_profile_photos").execute();
    await expect(insert({ image_bytes: Buffer.alloc(64001, 1) })).rejects.toThrow(
      /Data too long|user_profile_photos_size_check/u,
    );
    await expect(insert({ image_bytes: Buffer.alloc(0) })).rejects.toThrow(
      /user_profile_photos_size_check/u,
    );
    await expect(insert({ photo_version: "not-a-uuid" })).rejects.toThrow(
      /user_profile_photos_version_check/u,
    );
    await expect(insert({ user_id: "99" })).rejects.toThrow(/foreign key/iu);

    await insert({});
    await expect(
      app
        .updateTable("user_profile_photos")
        .set({ user_id: "2" } as never)
        .execute(),
    ).rejects.toThrow(/command denied|UPDATE command/iu);
    await expect(
      app.updateTable("users").set({ display_name: "바꿈" }).where("id", "=", "3").execute(),
    ).rejects.toThrow(/command denied/iu);
    // 사진은 계정 행이 사라지면 함께 지워진다(ON DELETE CASCADE). 반 소속이 없는 합성 계정으로 확인한다.
    await sql
      .raw(
        "INSERT INTO users (id,email_normalized,display_name,password_hash) VALUES (5,'solo@example.invalid','소속 없음','synthetic')",
      )
      .execute(admin);
    await insert({ user_id: "5", photo_version: "00000000-0000-4000-8000-000000000005" });
    await admin.deleteFrom("users").where("id", "=", "5").execute();
    expect(
      await admin
        .selectFrom("user_profile_photos")
        .select("user_id")
        .where("user_id", "=", "5")
        .execute(),
    ).toEqual([]);
  });

  it("올린 사진은 256px WebP로 저장되고, 같은 사진을 다시 올리면 버전이 그대로다", async () => {
    const first = await photos.updateOwn(student, await pngBase64("#3a7d44"));
    expect(first.photo).toMatchObject({ width: 256, height: 256, content_type: "image/webp" });
    const image = await photos.getOwnImage(student);
    expect(image.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(image.subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(image.length).toBeLessThanOrEqual(64000);
    const again = await photos.updateOwn(student, await pngBase64("#3a7d44"));
    expect(again.photo?.version).toBe(first.photo?.version);
    const changed = await photos.updateOwn(student, await pngBase64("#d4a017"));
    expect(changed.photo?.version).not.toBe(first.photo?.version);
    expect((await photos.getOwn(student)).photo?.version).toBe(changed.photo?.version);
  });

  it("같은 반 승인 구성원끼리만 보고, 다른 반·나간 구성원·만료 세션은 막는다", async () => {
    await photos.updateOwn(teacher, await pngBase64("#8b5a2b"));
    await photos.updateOwn(student, await pngBase64("#3a7d44"));

    // 학생은 담임 사진을, 담임은 학생 사진을 본다.
    expect((await photos.getClassImage(student, { teacher: true })).length).toBeGreaterThan(0);
    expect((await photos.getClassImage(teacher, { memberId: "2" })).length).toBeGreaterThan(0);
    // 같은 반의 다른 학생도 본다.
    expect((await photos.getClassImage(actor("3", "3"), { memberId: "2" })).length).toBeGreaterThan(
      0,
    );

    // 다른 반 교사는 볼 수 없다 — 없는 것과 구별되지 않는 404.
    await expect(photos.getClassImage(otherClassTeacher, { memberId: "2" })).rejects.toBeInstanceOf(
      ProfilePhotoNotFoundException,
    );
    // 현재 반을 1반이라고 우겨도 1반 소속이 아니면 볼 수 없다.
    await expect(
      photos.getClassImage(actor("9", "9", "1"), { memberId: "2" }),
    ).rejects.toBeInstanceOf(ProfilePhotoNotFoundException);
    // 나간 학생은 반 사진을 볼 수 없고, 나간 학생의 사진도 보이지 않는다.
    await expect(photos.getClassImage(actor("4", "4"), { teacher: true })).rejects.toBeInstanceOf(
      ProfilePhotoNotFoundException,
    );
    await admin
      .insertInto("user_profile_photos")
      .values({
        user_id: "4",
        photo_version: "00000000-0000-4000-8000-000000000004",
        image_bytes: Buffer.alloc(10, 4),
      } as never)
      .execute();
    await expect(photos.getClassImage(teacher, { memberId: "4" })).rejects.toBeInstanceOf(
      ProfilePhotoNotFoundException,
    );
    // 만료된 세션으로는 올릴 수 없다.
    await expect(
      photos.updateOwn(actor("2", "10"), await pngBase64("#000000")),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("지우기와 탈퇴 정리: 앱 계정으로 표를 찾아 같은 트랜잭션에서 지우고, 실패하면 되돌린다", async () => {
    await photos.updateOwn(student, await pngBase64("#3a7d44"));
    expect((await photos.deleteOwn(student)).photo).toBeNull();
    await expect(photos.getOwnImage(student)).rejects.toBeInstanceOf(ProfilePhotoNotFoundException);

    await photos.updateOwn(student, await pngBase64("#3a7d44"));
    // 탈퇴 트랜잭션의 뒤 단계가 실패하면 사진 삭제도 되돌아간다.
    await expect(
      app.transaction().execute(async (transaction) => {
        await deleteAccountProfilePhotoIfInstalled(transaction, true, "2");
        throw new Error("synthetic later deletion failure");
      }),
    ).rejects.toThrow("synthetic later deletion failure");
    expect((await photos.getOwn(student)).photo).not.toBeNull();
    // 성공하면 지워진다(앱 계정에게 표가 보여야 설치로 판단한다).
    await app
      .transaction()
      .execute((transaction) => deleteAccountProfilePhotoIfInstalled(transaction, true, "2"));
    expect((await photos.getOwn(student)).photo).toBeNull();
  });

  it("설치됨으로 선언했는데 앱 권한이 빠지면 탈퇴 정리가 사진을 남기지 않고 실패한다(Codex R4)", async () => {
    await photos.updateOwn(student, await pngBase64("#3a7d44"));
    const database = (await readFile(configPath!, "utf8")).match(/"database":"([a-z_]+)"/u)![1];
    const revoke = `REVOKE SELECT, INSERT, DELETE ON ${database}.user_profile_photos FROM 'profile_photos_qa_app'@'localhost';
      REVOKE UPDATE (photo_version, image_bytes, updated_at) ON ${database}.user_profile_photos FROM 'profile_photos_qa_app'@'localhost'`;
    const grant = `GRANT SELECT, INSERT, DELETE ON ${database}.user_profile_photos TO 'profile_photos_qa_app'@'localhost';
      GRANT UPDATE (photo_version, image_bytes, updated_at) ON ${database}.user_profile_photos TO 'profile_photos_qa_app'@'localhost'`;
    await sql.raw(revoke).execute(admin);
    try {
      // 이전 방식(표 목록 확인)은 표를 못 봐서 조용히 건너뛴다 — 잔존 위험을 기록으로 남긴다.
      await app
        .transaction()
        .execute((transaction) => deleteAccountProfilePhotoIfInstalled(transaction, true, "2"));
      // 설치 선언이 있으면 바로 지우려다 권한 오류로 실패하고, 탈퇴 트랜잭션 전체가 되돌아간다.
      await expect(
        app.transaction().execute((transaction) =>
          deleteAccountProfilePhotoIfInstalled(transaction, true, "2", {
            declaredInstalled: true,
          }),
        ),
      ).rejects.toThrow(/command denied/iu);
    } finally {
      await sql.raw(grant).execute(admin);
    }
    const left = await admin
      .selectFrom("user_profile_photos")
      .select("user_id")
      .where("user_id", "=", "2")
      .execute();
    expect(left).toHaveLength(1);
    // 권한이 정상이면 설치 선언 경로로 지워진다.
    await app
      .transaction()
      .execute((transaction) =>
        deleteAccountProfilePhotoIfInstalled(transaction, true, "2", { declaredInstalled: true }),
      );
    expect((await photos.getOwn(student)).photo).toBeNull();
  });

  it("같은 사용자가 동시에 두 번 올려도 사진은 하나로 남는다", async () => {
    const [one, two] = await Promise.all([
      photos.updateOwn(student, await pngBase64("#112233")),
      photos.updateOwn(student, await pngBase64("#445566")),
    ]);
    const rows = await admin
      .selectFrom("user_profile_photos")
      .select("photo_version")
      .where("user_id", "=", "2")
      .execute();
    expect(rows).toHaveLength(1);
    expect([one.photo?.version, two.photo?.version]).toContain(rows[0]?.photo_version);
  });

  // 2026-09-29 Codex 독립 검증(verification/codex-review-claude-20260929 §7)이 추가로 시험한 공격 경로.
  it("담임 사진 경로는 다른 반에서, 현재 반을 우겨도 쓸 수 없다", async () => {
    await photos.updateOwn(teacher, await pngBase64("#123456"));
    await expect(photos.getClassImage(otherClassTeacher, { teacher: true })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      photos.getClassImage(actor("9", "9", "1"), { teacher: true }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("정지된 반에서는 구성원·담임 사진이 모두 가려진다", async () => {
    await photos.updateOwn(teacher, await pngBase64("#123456"));
    await photos.updateOwn(student, await pngBase64("#abcdef"));
    await sql
      .raw(
        "UPDATE classes SET status='suspended',suspended_at=UTC_TIMESTAMP(6),suspended_reason='synthetic',suspended_by_operator_id=1 WHERE id=1",
      )
      .execute(admin);
    try {
      await expect(photos.getClassImage(student, { teacher: true })).rejects.toMatchObject({
        status: 404,
      });
      await expect(photos.getClassImage(teacher, { memberId: "2" })).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      await sql
        .raw(
          "UPDATE classes SET status='active',suspended_at=NULL,suspended_reason=NULL,suspended_by_operator_id=NULL WHERE id=1",
        )
        .execute(admin);
    }
  });

  it("임시 비밀번호 교사는 보지도, 보이지도, 올리지도 못한다", async () => {
    await photos.updateOwn(teacher, await pngBase64("#123456"));
    await photos.updateOwn(student, await pngBase64("#abcdef"));
    await sql
      .raw(
        "UPDATE teacher_profiles SET temporary_password_must_change=TRUE,temporary_password_expires_at=UTC_TIMESTAMP(6)+INTERVAL 1 DAY WHERE user_id=1",
      )
      .execute(admin);
    try {
      await expect(photos.getClassImage(student, { teacher: true })).rejects.toMatchObject({
        status: 404,
      });
      await expect(photos.getClassImage(teacher, { memberId: "2" })).rejects.toMatchObject({
        status: 404,
      });
      await expect(photos.updateOwn(teacher, await pngBase64("#000000"))).rejects.toMatchObject({
        status: 403,
      });
    } finally {
      await sql
        .raw(
          "UPDATE teacher_profiles SET temporary_password_must_change=FALSE,temporary_password_expires_at=NULL WHERE user_id=1",
        )
        .execute(admin);
    }
  });

  it("비활성 계정은 보지도, 보이지도, 올리지도 못한다", async () => {
    await photos.updateOwn(teacher, await pngBase64("#123456"));
    await photos.updateOwn(student, await pngBase64("#abcdef"));
    await sql.raw("UPDATE users SET is_active=FALSE WHERE id=2").execute(admin);
    try {
      await expect(photos.getClassImage(student, { teacher: true })).rejects.toMatchObject({
        status: 404,
      });
      await expect(photos.getClassImage(teacher, { memberId: "2" })).rejects.toMatchObject({
        status: 404,
      });
      await expect(photos.updateOwn(student, await pngBase64("#000000"))).rejects.toMatchObject({
        status: 401,
      });
    } finally {
      await sql.raw("UPDATE users SET is_active=TRUE WHERE id=2").execute(admin);
    }
  });

  it("대기·제외 상태는 보는 쪽이든 보이는 쪽이든 막힌다", async () => {
    await photos.updateOwn(teacher, await pngBase64("#123456"));
    await photos.updateOwn(student, await pngBase64("#abcdef"));
    for (const status of ["pending", "removed"]) {
      await sql
        .raw(`UPDATE class_members SET status='${status}',student_number=NULL WHERE id=2`)
        .execute(admin);
      try {
        await expect(photos.getClassImage(student, { teacher: true })).rejects.toMatchObject({
          status: 404,
        });
        await expect(photos.getClassImage(teacher, { memberId: "2" })).rejects.toMatchObject({
          status: 404,
        });
      } finally {
        await sql
          .raw("UPDATE class_members SET status='approved',student_number=1 WHERE id=2")
          .execute(admin);
      }
    }
  });

  it("잘못되거나 범위를 넘는 구성원 번호로 다른 사람 사진을 조회하지 못한다", async () => {
    await photos.updateOwn(student, await pngBase64("#abcdef"));
    for (const memberId of ["0", "-1", "01", "9223372036854775808", "1 OR 1=1"])
      await expect(photos.getClassImage(teacher, { memberId })).rejects.toMatchObject({
        status: 404,
      });
  });

  // 첫 사용 점검 19번(2026-10-23): 목록의 '사진 있음'이 사진 조회와 어긋나면 404 요청이 다시 생기거나 사진이 사라진다.
  it("목록의 '사진 있음'은 상황마다 사진 조회가 실제로 내주는 구성원과 같다", async () => {
    const reader = new MemberPhotoPresenceReader(
      app,
      new ConfigService<AppEnvironment, true>({ PROFILE_PHOTOS_ENABLED: true }),
    );
    await photos.updateOwn(teacher, await pngBase64("#123456"));
    await photos.updateOwn(student, await pngBase64("#abcdef"));
    await admin
      .insertInto("user_profile_photos")
      .values({
        user_id: "4",
        photo_version: "00000000-0000-4000-8000-000000000004",
        image_bytes: Buffer.alloc(10, 4),
      } as never)
      .execute();
    const memberIds = ["1", "2", "3", "4", "9"];
    const served = async (viewer: ReturnType<typeof actor>) => {
      const ids: string[] = [];
      for (const memberId of memberIds)
        await photos.getClassImage(viewer, { memberId }).then(
          () => ids.push(memberId),
          (error: unknown) => {
            if (!(error instanceof ProfilePhotoNotFoundException)) throw error;
          },
        );
      return ids;
    };
    const viewers = [teacher, student, actor("3", "3"), actor("4", "4"), otherClassTeacher];
    const servesTeacher = (viewer: ReturnType<typeof actor>) =>
      photos.getClassImage(viewer, { teacher: true }).then(
        () => true,
        (error: unknown) => {
          if (!(error instanceof ProfilePhotoNotFoundException)) throw error;
          return false;
        },
      );
    const sameAsServed = async () => {
      for (const viewer of [...viewers, actor("9", "9", "1")]) {
        expect([...(await reader.memberIdsWithPhoto(viewer, memberIds))].sort()).toEqual(
          await served(viewer),
        );
        // 학생 도움 대화의 '담임 사진 있음'(2026-10-23)도 담임 사진 경로와 같아야 한다.
        expect(await reader.classTeacherHasPhoto(viewer)).toBe(await servesTeacher(viewer));
      }
    };

    // 평소: 담임은 자기와 사진 올린 학생만 '있음'(사진 없는 학생·나간 학생·다른 반은 없음).
    expect([...(await reader.memberIdsWithPhoto(teacher, memberIds))].sort()).toEqual(["1", "2"]);
    expect(await reader.classTeacherHasPhoto(student)).toBe(true);
    expect(await reader.classTeacherHasPhoto(otherClassTeacher)).toBe(false);
    await sameAsServed();
    const situations = [
      [
        "UPDATE classes SET status='suspended',suspended_at=UTC_TIMESTAMP(6),suspended_reason='synthetic',suspended_by_operator_id=1 WHERE id=1",
        "UPDATE classes SET status='active',suspended_at=NULL,suspended_reason=NULL,suspended_by_operator_id=NULL WHERE id=1",
      ],
      [
        "UPDATE teacher_profiles SET temporary_password_must_change=TRUE,temporary_password_expires_at=UTC_TIMESTAMP(6)+INTERVAL 1 DAY WHERE user_id=1",
        "UPDATE teacher_profiles SET temporary_password_must_change=FALSE,temporary_password_expires_at=NULL WHERE user_id=1",
      ],
      ["UPDATE users SET is_active=FALSE WHERE id=2", "UPDATE users SET is_active=TRUE WHERE id=2"],
      [
        "UPDATE class_members SET status='pending',student_number=NULL WHERE id=2",
        "UPDATE class_members SET status='approved',student_number=1 WHERE id=2",
      ],
    ] as const;
    for (const [change, restore] of situations) {
      await sql.raw(change).execute(admin);
      try {
        await sameAsServed();
      } finally {
        await sql.raw(restore).execute(admin);
      }
    }
  });
});
