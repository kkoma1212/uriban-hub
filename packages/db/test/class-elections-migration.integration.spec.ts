/*
 * T-HUB-18 선거 — 무기명 저장 경로.
 *
 * 여기서 지키려는 것 중 가장 중요한 하나는 **개인의 선택이 어디에도 남지 않는
 * 것**이다. 나머지가 다 맞아도 이게 깨지면 기능의 존재 이유가 사라진다.
 * 그래서 "표가 있다"가 아니라 "짝지을 칸이 없다"를 칼럼 수준에서 단언한다.
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
const studentMemberIds: string[] = [];

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

/** 한 표를 던진다 — 득표 수를 올리고 "투표했음"만 남긴다. 선택은 어디에도 안 남는다. */
async function castVote(candidateId: string, memberId: string): Promise<void> {
  const client = await bootstrapPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE election_tallies SET vote_count = vote_count + 1 WHERE candidate_id = $1",
      [candidateId],
    );
    await client.query(
      "INSERT INTO election_participants (election_id, class_id, member_id) SELECT election_id, $1, $2 FROM election_tallies WHERE candidate_id = $3",
      [classId, memberId, candidateId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
   * 선거 마이그레이션 직후에 세운다. 전부 올리면 나중에 뒤에 붙는 마이그레이션이
   * `down 1` 대상을 바꿔 놓는다 — "이게 마지막"이라 가정한 스펙이 하루 만에 깨진
   * 선례가 있다(2026-08-07).
   */
  await migrate("up", 33);
  const head = await bootstrapPool.query<{ latest: string }>(
    "SELECT max(name) AS latest FROM pgmigrations",
  );
  expect(head.rows[0]?.latest).toBe("1783700032000_election-results");

  const teacherUserId = await addUser("선거 담임", "election-teacher@example.com");
  const operator = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO operators (credential_hash, email_normalized)
    VALUES (sha256('election-operator'::bytea), 'election-operator@classhub.local')
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
    ) VALUES ('B10', '테스트 교육청', '서울', '9200001', 'high', '선거 학교')
  `);

  const client = await bootstrapPool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query<{ id: string }>(
      `
        INSERT INTO classes (
          academic_year, created_by_user_id, edu_office_code,
          expected_student_count, grade, name, school_code
        ) VALUES (2026, $1, 'B10', 30, 3, '선거반', '9200001')
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

  for (const index of [1, 2, 3]) {
    const studentUserId = await addUser(`선거학생${index}`, `election-student${index}@example.com`);
    const member = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, role, status, user_id)
        VALUES ($1, 'student', 'approved', $2)
        RETURNING id
      `,
      [classId, studentUserId],
    );
    studentMemberIds.push(member.rows[0]!.id);
  }
}, 180_000);

afterAll(async () => {
  await bootstrapPool?.end();
  await container?.stop({ remove: true, removeVolumes: true });
}, 120_000);

describe.sequential("class elections migration", () => {
  it("keeps the ballot secret — no column can pair a member with a choice", async () => {
    const columns = await bootstrapPool.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('election_tallies', 'election_participants')
      ORDER BY table_name, column_name
    `);
    const byTable = new Map<string, string[]>();
    for (const row of columns.rows) {
      byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.column_name]);
    }

    /*
     * 득표 표에 구성원 칸이 없고, 참여 표에 후보 칸이 없다. 둘을 아무리 조인해도
     * 개인의 선택이 나오지 않는 이유가 바로 이것이다.
     * 타임스탬프도 없다 — 있으면 득표가 오른 순서와 맞춰 볼 수 있다.
     */
    expect(byTable.get("election_tallies")).toEqual(["candidate_id", "election_id", "vote_count"]);
    expect(byTable.get("election_participants")).toEqual(["class_id", "election_id", "member_id"]);
  });

  it("counts votes without recording who chose whom", async () => {
    const election = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO elections (
          class_id, created_by_member_id, title, status, tie_break, results_visibility
        ) VALUES ($1, $2, '2학기 반장 선거', 'open', 'revote', 'with_counts')
        RETURNING id
      `,
      [classId, teacherMemberId],
    );
    const electionId = election.rows[0]!.id;

    const candidateIds: string[] = [];
    for (const [index, memberId] of [studentMemberIds[0]!, studentMemberIds[1]!].entries()) {
      const candidate = await bootstrapPool.query<{ id: string }>(
        `
          INSERT INTO election_candidates (
            election_id, class_id, member_id, display_name_snapshot, student_number_snapshot
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING id
        `,
        [electionId, classId, memberId, `선거학생${index + 1}`, index + 1],
      );
      candidateIds.push(candidate.rows[0]!.id);
      await bootstrapPool.query(
        "INSERT INTO election_tallies (election_id, candidate_id) VALUES ($1, $2)",
        [electionId, candidate.rows[0]!.id],
      );
    }

    await castVote(candidateIds[0]!, studentMemberIds[0]!);
    await castVote(candidateIds[0]!, studentMemberIds[1]!);
    await castVote(candidateIds[1]!, studentMemberIds[2]!);

    const tallies = await bootstrapPool.query<{ candidate_id: string; vote_count: number }>(
      "SELECT candidate_id, vote_count FROM election_tallies WHERE election_id = $1 ORDER BY candidate_id",
      [electionId],
    );
    expect(tallies.rows.map((row) => row.vote_count)).toEqual([2, 1]);

    const participants = await bootstrapPool.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM election_participants WHERE election_id = $1",
      [electionId],
    );
    expect(participants.rows[0]?.total).toBe("3");
  });

  it("blocks a second vote from the same student", async () => {
    const electionId = (
      await bootstrapPool.query<{ election_id: string }>(
        "SELECT election_id FROM election_participants LIMIT 1",
      )
    ).rows[0]!.election_id;
    await expect(
      bootstrapPool.query(
        "INSERT INTO election_participants (election_id, class_id, member_id) VALUES ($1, $2, $3)",
        [electionId, classId, studentMemberIds[0]!],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("refuses to change the tie break rule after the election exists", async () => {
    // 결과를 보고 방식을 고르면 그건 선거가 아니다.
    await expect(
      bootstrapPool.query("UPDATE elections SET tie_break = 'teacher_decides'"),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("records who ran the election without touching the allowlist", async () => {
    // 감사 행에 JSON 스냅샷을 싣지 않으므로 허용목록 CHECK를 다시 쓸 필요가 없다.
    await bootstrapPool.query(
      `
        INSERT INTO audit_logs (
          class_id, actor_display_name_snapshot, actor_role_snapshot,
          action, target_type, target_id, request_id
        ) VALUES ($1, '선거 담임', 'teacher', 'election.created', 'election', '1', gen_random_uuid())
      `,
      [classId],
    );
    const logged = await bootstrapPool.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM audit_logs WHERE action = 'election.created'",
    );
    expect(logged.rows[0]?.total).toBe("1");
  });

  it("refuses to roll back while votes exist", async () => {
    /*
     * 두 걸음이다 — 결과 칸(1783700032000)을 먼저 내리고, 그다음 선거 표를 내리려다
     * 안전장치에 걸려야 한다. 표는 복구할 수 없으므로 여기서 막는 것이 맞다.
     */
    await expect(migrate("down", 2)).rejects.toThrow(/participation records to be empty/u);
  });
});
