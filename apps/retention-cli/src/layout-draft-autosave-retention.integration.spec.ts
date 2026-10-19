/*
 * T-HUB-31 5단계 — 만들다 만 자리·모둠을 1주일 뒤에 지운다.
 *
 * 여기서 지키는 것 둘. ① **아직 살아 있어야 할 것을 지우지 않는다** — 어제 손댄
 * 임시저장을 지우면 교사가 만들던 것을 잃는다. ② **지운 기록에 내용을 옮기지 않는다** —
 * 임시저장에는 아직 공개하지 않은 배치가 들어 있어, 감사 로그에 실으면 지운 보람이 없다.
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createDatabase, type DB } from "@classhub/db";
import { sql } from "kysely";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openRetentionDatabase, type RetentionDatabase } from "./database.js";
import { runLayoutDraftAutosaveRetention } from "./layout-draft-autosave-retention.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
const migrationsDirectory = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

let bootstrapDatabase: ReturnType<typeof createDatabase<DB>>;
let container: StartedNativeTestService;
let retentionDatabase: RetentionDatabase;
let classId: string;
let teacherMemberId: string;

function databaseUrl(username: string, password: string): string {
  return `postgresql://${username}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/classhub_dev`;
}

async function applyMigrations(): Promise<void> {
  const migrator = createDatabase<DB>(databaseUrl("classhub_migrator", "local_migrator_password"));
  try {
    await sql`
      CREATE TABLE pgmigrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        run_on TIMESTAMPTZ NOT NULL
      )
    `.execute(migrator);
    const migrationNames = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_[a-z0-9-]+\.sql$/u.test(name))
      .sort();
    for (const name of migrationNames) {
      const migration = await readFile(`${migrationsDirectory}/${name}`, "utf8");
      const up = migration.split("-- Down Migration", 1)[0]!.replace("-- Up Migration", "");
      await migrator.transaction().execute((transaction) => sql.raw(up).execute(transaction));
    }
  } finally {
    await migrator.destroy();
  }
}

/** 마지막으로 손댄 시각을 정해 임시저장을 하나 심는다. */
async function seedAutosave(kind: string, updatedDaysAgo: number): Promise<void> {
  await sql`
    INSERT INTO layout_draft_autosaves (class_id, member_id, kind, payload, updated_at)
    VALUES (
      ${classId}::bigint,
      ${teacherMemberId}::bigint,
      ${kind},
      ${JSON.stringify({ secret: "아직 공개하지 않은 배치" })}::jsonb,
      clock_timestamp() - make_interval(days => ${updatedDaysAgo})
    )
  `.execute(bootstrapDatabase);
}

async function remainingKinds(): Promise<string[]> {
  const rows = await sql<{ kind: string }>`
    SELECT kind FROM layout_draft_autosaves ORDER BY kind
  `.execute(bootstrapDatabase);
  return rows.rows.map((row) => row.kind);
}

beforeAll(async () => {
  container = await startNativeTestService("postgres", {
    POSTGRES_DB: "classhub_dev",
    POSTGRES_PASSWORD: "local_bootstrap_password",
    POSTGRES_USER: "classhub_bootstrap",
  });
  bootstrapDatabase = createDatabase<DB>(
    databaseUrl("classhub_bootstrap", "local_bootstrap_password"),
  );
  await sql.raw(await readFile(bootstrapPath, "utf8")).execute(bootstrapDatabase);
  await applyMigrations();
  retentionDatabase = await openRetentionDatabase(
    databaseUrl("classhub_retention", "local_retention_password"),
  );

  const teacher = await sql<{ id: string }>`
    INSERT INTO users (display_name, email_normalized, email_verified_at, is_active, password_hash)
    VALUES ('임시저장 담임', 'autosave-retention@example.com', now(), TRUE, 'fixture-hash')
    RETURNING id
  `.execute(bootstrapDatabase);
  /* 담임으로 세려면 교사 프로필이 있어야 한다 — 없으면 "활성 담임 하나" 제약에 걸린다. */
  const operator = await sql<{ id: string }>`
    INSERT INTO operators (credential_hash, email_normalized)
    VALUES (sha256('autosave-retention-operator'::bytea), 'autosave-retention@classhub.local')
    RETURNING id
  `.execute(bootstrapDatabase);
  await sql`
    INSERT INTO teacher_profiles (
      created_by_operator_id, temporary_password_expires_at,
      temporary_password_must_change, user_id
    ) VALUES (${operator.rows[0]!.id}::bigint, NULL, FALSE, ${teacher.rows[0]!.id}::bigint)
  `.execute(bootstrapDatabase);
  await sql`
    INSERT INTO schools (
      edu_office_code, edu_office_name, region_name, school_code, school_kind, school_name
    ) VALUES ('B10', '테스트 교육청', '서울', '9200003', 'high', '보존 학교')
  `.execute(bootstrapDatabase);
  /*
   * 학급과 담임은 한 트랜잭션에서 함께 넣어야 한다 — "활성 학급에는 승인된 담임이
   * 정확히 하나"라는 제약이 학급만 먼저 넣는 순간 걸린다.
   */
  await bootstrapDatabase.transaction().execute(async (transaction) => {
    const target = await sql<{ id: string }>`
      INSERT INTO classes (
        academic_year, created_by_user_id, edu_office_code,
        expected_student_count, grade, name, school_code
      ) VALUES (2026, ${teacher.rows[0]!.id}::bigint, 'B10', 30, 3, '보존반', '9200003')
      RETURNING id
    `.execute(transaction);
    classId = target.rows[0]!.id;
    const member = await sql<{ id: string }>`
      INSERT INTO class_members (class_id, role, status, user_id)
      VALUES (${classId}::bigint, 'teacher', 'approved', ${teacher.rows[0]!.id}::bigint)
      RETURNING id
    `.execute(transaction);
    teacherMemberId = member.rows[0]!.id;
  });
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([retentionDatabase?.destroy(), bootstrapDatabase?.destroy()]);
  await container?.stop({ remove: true, removeVolumes: true });
}, 120_000);

describe.sequential("layout draft autosave retention", () => {
  it("counts without deleting in dry-run", async () => {
    await seedAutosave("seat_draw", 9);
    await seedAutosave("team_draw", 1);

    const result = await runLayoutDraftAutosaveRetention(retentionDatabase, { mode: "dry-run" });

    expect(result.eligible_count).toBe(1);
    expect(result.deleted_count).toBe(0);
    expect(result.run_id).toBeNull();
    /* dry-run 이 아무것도 지우지 않았는지 실제로 확인한다. */
    expect(await remainingKinds()).toEqual(["seat_draw", "team_draw"]);
  });

  it("deletes only what has sat untouched for a week", async () => {
    const result = await runLayoutDraftAutosaveRetention(retentionDatabase, { mode: "execute" });

    expect(result.deleted_count).toBe(1);
    expect(result.remaining_eligible_count).toBe(0);
    /* 어제 손댄 것은 남는다 — 이걸 지우면 교사가 만들던 것을 잃는다. */
    expect(await remainingKinds()).toEqual(["team_draw"]);
  });

  it("audits the run without carrying the unpublished layout into the log", async () => {
    const logs = await sql<{ after_json: unknown; target_id: string }>`
      SELECT after_json, target_id FROM operator_audit_logs
      WHERE target_id = 'layout_draft_autosaves'
      ORDER BY id DESC
      LIMIT 1
    `.execute(bootstrapDatabase);

    const entry = logs.rows[0]!;
    expect(entry.target_id).toBe("layout_draft_autosaves");
    expect(Object.keys(entry.after_json as Record<string, unknown>).sort()).toEqual([
      "cutoff_at",
      "deleted_count",
      "table_name",
    ]);
    /* 지운 내용이 로그로 옮겨 갔으면 지운 보람이 없다. */
    expect(JSON.stringify(entry.after_json)).not.toContain("아직 공개하지 않은 배치");
  });

  it("leaves a freshly touched draft alone on the next run", async () => {
    const result = await runLayoutDraftAutosaveRetention(retentionDatabase, { mode: "execute" });

    expect(result.deleted_count).toBe(0);
    expect(await remainingKinds()).toEqual(["team_draw"]);
  });
});
