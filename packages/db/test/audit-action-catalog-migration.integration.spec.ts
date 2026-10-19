/*
 * T-HUB-21 (A안) — 감사 action 목록을 CHECK에서 참조 표 + FK로 옮긴 마이그레이션.
 *
 * 여기서 지키려는 것은 셋이다.
 *  ① 금지된 action은 여전히 막힌다 — 제약을 옮기면서 느슨해지면 안 된다.
 *  ② action 추가가 INSERT 한 줄이 된다 — 이 과업의 존재 이유다.
 *  ③ 런타임 역할이 감사 기록을 계속 남길 수 있다 — GRANT 누락으로 기능이
 *     통째로 죽는 사고가 이 저장소에 있었다(T-HUB-08).
 *
 * 마지막 마이그레이션 번호를 박지 않는다. "이게 마지막"이라 가정한 스펙이
 * 하루 만에 깨진 적이 있다(2026-08-07). 전부 올린 뒤 한 걸음만 내린다.
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

let appPool: Pool;
let bootstrapPool: Pool;
let container: StartedNativeTestService;
let migratorDatabaseUrl: string;
let classId: string;

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

async function insertAudit(pool: Pool, action: string, requestId: string): Promise<void> {
  await pool.query(
    `
      INSERT INTO audit_logs (
        class_id, actor_display_name_snapshot, actor_role_snapshot,
        action, target_type, target_id, target_snapshot, request_id
      ) VALUES (
        $1, '감사 계약 교사', 'teacher',
        $2, 'class', $3,
        jsonb_build_object('class_id', $4::bigint, 'name', '감사 계약 학급'), $5
      )
    `,
    // 같은 값이라도 자리마다 타입이 달라 인자를 나눈다(하나로 묶으면 추론이 충돌한다).
    [classId, action, classId, classId, requestId],
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
  appPool = new Pool({ connectionString: databaseUrl("classhub_app", "local_app_password") });

  /*
   * 이 스펙은 "감사 목록 마이그레이션 직후"를 재는 것이라 그 지점에 세운다.
   * 전부 올리면 뒤에 오는 마이그레이션이 목록에 action을 더해 전제가 깨진다
   * (2026-08-11 선거 마이그레이션이 실제로 깨뜨렸다). 도착 지점을 이름으로
   * 확인하므로, 앞에 마이그레이션이 끼어들면 걸음 수가 아니라 이 단언이 알려준다.
   */
  await migrate("up", 31);
  const head = await bootstrapPool.query<{ latest: string }>(
    "SELECT max(name) AS latest FROM pgmigrations",
  );
  expect(head.rows[0]?.latest).toBe("1783700030000_audit-action-catalog");

  const teacher = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO users (display_name, email_normalized, email_verified_at, is_active, password_hash)
    VALUES ('감사 계약 교사', 'audit-catalog@example.com', now(), TRUE, 'fixture-password-hash')
    RETURNING id
  `);
  /*
   * 담임 판정이 teacher_profiles(status='active')까지 조인해서 센다
   * (1783700001000:314-322). 프로필이 없으면 학급 생성이 커밋에서 막힌다.
   */
  const operator = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO operators (credential_hash, email_normalized)
    VALUES (sha256('audit-catalog-operator'::bytea), 'audit-catalog-operator@classhub.local')
    RETURNING id
  `);
  await bootstrapPool.query(
    `
      INSERT INTO teacher_profiles (
        created_by_operator_id, temporary_password_expires_at,
        temporary_password_must_change, user_id
      ) VALUES ($1, NULL, FALSE, $2)
    `,
    [operator.rows[0]!.id, teacher.rows[0]!.id],
  );
  await bootstrapPool.query(`
    INSERT INTO schools (
      edu_office_code, edu_office_name, region_name, school_code, school_kind, school_name
    ) VALUES ('B10', '테스트 교육청', '서울', '9100001', 'high', '감사 계약 학교')
  `);
  /*
   * 학급은 "승인된 담임 정확히 한 명"을 지연 제약으로 요구한다. 학급만 따로
   * 넣으면 커밋 순간에 걸리므로 담임 등록까지 한 트랜잭션으로 묶는다.
   */
  const client = await bootstrapPool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query<{ id: string }>(
      `
        INSERT INTO classes (
          academic_year, created_by_user_id, edu_office_code,
          expected_student_count, grade, name, school_code
        ) VALUES (2026, $1, 'B10', 30, 2, '감사계약반', '9100001')
        RETURNING id
      `,
      [teacher.rows[0]!.id],
    );
    classId = target.rows[0]!.id;
    await client.query(
      `
        INSERT INTO class_members (class_id, role, status, user_id)
        VALUES ($1, 'teacher', 'approved', $2)
      `,
      [classId, teacher.rows[0]!.id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([appPool?.end(), bootstrapPool?.end()]);
  await container?.stop({ remove: true, removeVolumes: true });
}, 120_000);

describe.sequential("audit action catalog migration", () => {
  it("moves the action list into a table without loosening what is allowed", async () => {
    const seeded = await bootstrapPool.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM audit_log_actions",
    );
    expect(seeded.rows[0]?.total).toBe("51");

    // CHECK는 사라지고 FK가 그 자리를 지킨다 — 둘 다 선언적이라 스키마에 보인다.
    const constraints = await bootstrapPool.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'audit_logs'::regclass
        AND conname IN ('audit_logs_action_check', 'audit_logs_action_catalog_fkey')
    `);
    expect(constraints.rows.map((row) => row.conname)).toEqual(["audit_logs_action_catalog_fkey"]);

    await expect(
      insertAudit(bootstrapPool, "class.exploded", "00000000-0000-4000-8000-000000009001"),
    ).rejects.toMatchObject({ code: "23503" });

    await insertAudit(bootstrapPool, "class.created", "00000000-0000-4000-8000-000000009002");
  });

  it("makes a new action in an existing family cost one insert", async () => {
    await bootstrapPool.query("INSERT INTO audit_log_actions (action) VALUES ('class.renamed')");
    await insertAudit(bootstrapPool, "class.renamed", "00000000-0000-4000-8000-000000009003");
    await bootstrapPool.query("DELETE FROM audit_logs WHERE action = 'class.renamed'");
    await bootstrapPool.query("DELETE FROM audit_log_actions WHERE action = 'class.renamed'");
  });

  it("still needs the json allowlist rewritten for a brand new family", async () => {
    /*
     * 이 과업이 무엇을 안 고쳤는지 못박아 둔다 — 다음 사람이 "이제 INSERT 한 줄"
     * 이라고 읽고 선거 작업에 들어가면 여기서 막힌다.
     *
     * JSON 허용목록 CASE의 ELSE가 schedule 모양 catch-all이라(1783700028000:441)
     * 12갈래 어디에도 안 걸리는 새 계열은 schedule 키만 가질 수 있다. 즉 목록에
     * action을 넣어도 그 계열의 스냅샷은 통과하지 못한다.
     */
    await bootstrapPool.query("INSERT INTO audit_log_actions (action) VALUES ('election.created')");
    await expect(
      insertAudit(bootstrapPool, "election.created", "00000000-0000-4000-8000-000000009007"),
    ).rejects.toMatchObject({ code: "23514" });
    await bootstrapPool.query("DELETE FROM audit_log_actions WHERE action = 'election.created'");
  });

  it("keeps the runtime role able to write audit rows", async () => {
    // FK가 걸린 표를 앱이 못 읽어 감사 기록이 통째로 막히는 일이 없어야 한다.
    await insertAudit(appPool, "class.updated", "00000000-0000-4000-8000-000000009004");
  });

  it("puts the check back on the way down", async () => {
    await migrate("down", 1);

    const catalog = await bootstrapPool.query<{ exists: boolean }>(
      "SELECT to_regclass('audit_log_actions') IS NOT NULL AS exists",
    );
    expect(catalog.rows[0]?.exists).toBe(false);

    await expect(
      insertAudit(bootstrapPool, "class.exploded", "00000000-0000-4000-8000-000000009005"),
    ).rejects.toMatchObject({ code: "23514" });

    await insertAudit(bootstrapPool, "class.archived", "00000000-0000-4000-8000-000000009006");
  });
});
