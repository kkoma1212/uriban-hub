/*
 * T-HUB-31 임시저장 — 만들던 자리·모둠이 사라지지 않게.
 *
 * 여기서 지키려는 것 둘. ① 한 사람이 한 종류에 **하나만** 갖는다(Hex 결정 —
 * 목록 화면을 두지 않기로 했으므로 여러 개가 쌓이면 갈 곳 없는 행이 된다).
 * ② 자리와 모둠이 한 표를 쓰되 **그 둘만** 들어온다. 종류 칸이 열려 있으면
 * 오타 하나로 영영 안 읽히는 임시저장이 생긴다.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
const migrationsDirectory = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

let bootstrapPool: Pool;
let container: StartedNativeTestService;
let migratorDatabaseUrl: string;
let classId: string;
let teacherMemberId: string;
let otherMemberId: string;

function databaseUrl(username: string, password: string): string {
  return `postgresql://${username}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/classhub_dev`;
}

async function migrate(direction: "down" | "up", count?: number): Promise<void> {
  await runner({
    ...(count === undefined ? {} : { count }),
    databaseUrl: migratorDatabaseUrl,
    direction,
    dir: migrationsDirectory,
    migrationsTable: "pgmigrations",
    verbose: false,
  });
}

async function addUser(name: string, email: string): Promise<string> {
  const inserted = await bootstrapPool.query<{ id: string }>(
    `
      INSERT INTO users (display_name, email_normalized, email_verified_at, is_active, password_hash)
      VALUES ($1, $2, now(), TRUE, 'fixture-password-hash')
      RETURNING id
    `,
    [name, email],
  );
  return inserted.rows[0]!.id;
}

async function saveAutosave(memberId: string, kind: string, payload: unknown): Promise<void> {
  await bootstrapPool.query(
    `
      INSERT INTO layout_draft_autosaves (class_id, member_id, kind, payload)
      VALUES ($1, $2, $3, $4)
    `,
    [classId, memberId, kind, JSON.stringify(payload)],
  );
}

beforeAll(async () => {
  container = await startNativeTestService("postgres", {
    POSTGRES_DB: "classhub_dev",
    POSTGRES_PASSWORD: "local_bootstrap_password",
    POSTGRES_USER: "classhub_bootstrap",
  });

  bootstrapPool = new Pool({
    connectionString: databaseUrl("classhub_bootstrap", "local_bootstrap_password"),
  });
  await bootstrapPool.query(await readFile(bootstrapPath, "utf8"));
  migratorDatabaseUrl = databaseUrl("classhub_migrator", "local_migrator_password");

  /*
   * 이 마이그레이션 직후까지만 올린다. 전부 올리면 뒤에 새 마이그레이션이 붙는 날
   * `down 1` 대상이 바뀌어 스펙이 하루 만에 깨진다(2026-08-07 선례).
   */
  await migrate("up", 34);
  const head = await bootstrapPool.query<{ latest: string }>(
    "SELECT max(name) AS latest FROM pgmigrations",
  );
  expect(head.rows[0]?.latest).toBe("1783700033000_layout-draft-autosaves");

  const teacherUserId = await addUser("임시저장 담임", "autosave-teacher@example.com");
  const operator = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO operators (credential_hash, email_normalized)
    VALUES (sha256('autosave-operator'::bytea), 'autosave-operator@classhub.local')
    RETURNING id
  `);
  await bootstrapPool.query(
    `
      INSERT INTO teacher_profiles (
        created_by_operator_id, temporary_password_expires_at,
        temporary_password_must_change, user_id
      ) VALUES ($1, NULL, FALSE, $2)
    `,
    [operator.rows[0]!.id, teacherUserId],
  );
  await bootstrapPool.query(`
    INSERT INTO schools (
      edu_office_code, edu_office_name, region_name, school_code, school_kind, school_name
    ) VALUES ('B10', '테스트 교육청', '서울', '9200002', 'high', '임시저장 학교')
  `);

  const client = await bootstrapPool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query<{ id: string }>(
      `
        INSERT INTO classes (
          academic_year, created_by_user_id, edu_office_code,
          expected_student_count, grade, name, school_code
        ) VALUES (2026, $1, 'B10', 30, 3, '임시저장반', '9200002')
        RETURNING id
      `,
      [teacherUserId],
    );
    classId = target.rows[0]!.id;
    const teacherMember = await client.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, role, status, user_id)
        VALUES ($1, 'teacher', 'approved', $2)
        RETURNING id
      `,
      [classId, teacherUserId],
    );
    teacherMemberId = teacherMember.rows[0]!.id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  /*
   * 한 학급에 승인된 교사는 하나뿐이다(`class_members_one_approved_teacher`). 그래서
   * "사람이 다르면 따로 담긴다"는 학생 회원으로 잰다 — 여기서 보려는 것은 역할이 아니라
   * 열쇠가 member_id 로 갈리는가이므로 이걸로 충분하다.
   */
  const otherUserId = await addUser("임시저장 학생", "autosave-other@example.com");
  const otherMember = await bootstrapPool.query<{ id: string }>(
    `
      INSERT INTO class_members (class_id, role, status, user_id)
      VALUES ($1, 'student', 'approved', $2)
      RETURNING id
    `,
    [classId, otherUserId],
  );
  otherMemberId = otherMember.rows[0]!.id;
}, 180_000);

afterAll(async () => {
  await bootstrapPool?.end();
  await container?.stop();
});

describe("layout draft autosaves migration", () => {
  it("keeps one autosave per member and kind", async () => {
    await saveAutosave(teacherMemberId, "seat_draw", { step: 1 });

    await expect(saveAutosave(teacherMemberId, "seat_draw", { step: 2 })).rejects.toThrow(
      /layout_draft_autosaves_owner_kind_unique/u,
    );

    /* 같은 사람이라도 종류가 다르면 따로 담긴다 — 자리와 모둠은 별개 작업이다. */
    await saveAutosave(teacherMemberId, "team_draw", { step: 1 });
    /* 다른 사람의 것도 막히지 않는다. */
    await saveAutosave(otherMemberId, "seat_draw", { step: 1 });

    const stored = await bootstrapPool.query<{ count: string }>(
      "SELECT count(*) AS count FROM layout_draft_autosaves WHERE class_id = $1",
      [classId],
    );
    expect(stored.rows[0]?.count).toBe("3");
  });

  it("refuses a kind outside seat and team draws", async () => {
    await expect(saveAutosave(teacherMemberId, "poll", { step: 1 })).rejects.toThrow(
      /layout_draft_autosaves_kind_check/u,
    );
  });

  it("exposes exactly the columns the autosave needs", async () => {
    const columns = await bootstrapPool.query<{ column_name: string }>(
      `
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'layout_draft_autosaves'
        ORDER BY column_name
      `,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "class_id",
      "created_at",
      "id",
      "kind",
      "member_id",
      "payload",
      "row_version",
      "updated_at",
    ]);
  });

  it("lets the app role read and clear its own autosaves", async () => {
    const grants = await bootstrapPool.query<{ privilege_type: string }>(
      `
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'layout_draft_autosaves' AND grantee = 'classhub_app'
        ORDER BY privilege_type
      `,
    );
    /* 지우기가 빠지면 공개 시 삭제도 만료 삭제도 못 한다. */
    expect(grants.rows.map((row) => row.privilege_type)).toEqual([
      "DELETE",
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
  });

  it("rolls back cleanly", async () => {
    await migrate("down", 1);
    const remaining = await bootstrapPool.query<{ count: string }>(
      "SELECT count(*) AS count FROM information_schema.tables WHERE table_name = 'layout_draft_autosaves'",
    );
    expect(remaining.rows[0]?.count).toBe("0");
    await migrate("up", 1);
  });
});
