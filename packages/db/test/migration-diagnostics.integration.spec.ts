/*
 * T-HUB-03 진단 프로브가 실제로 발동하는지 확인한다.
 *
 * 프로브는 아주 드문 실패에서만 쓰이므로, 정작 그 실패가 왔을 때 조용히 아무것도
 * 안 남기면 조사 자체가 무산된다. 그래서 확실히 실패하는 접속(죽은 포트)으로
 * 출력이 나오는지 여기서 붙잡아 둔다. 컨테이너가 필요 없어 빠르다.
 */
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
const migrationsDirectory = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

describe("migration failure diagnostics", () => {
  it("records the connection target when a migration run fails", async () => {
    // 이 스펙은 일부러 실패시키는 것이라, 배너가 실제 CI 로그에 섞이면 오해를 부른다.
    // 출력은 삼키고 내용만 검사한다.
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await expect(
        runner({
          databaseUrl: "postgresql://probe_user:probe_password@127.0.0.1:1/probe_db",
          dir: migrationsDirectory,
          direction: "up",
          migrationsTable: "pgmigrations",
          verbose: false,
        }),
      ).rejects.toThrow();
      const output = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("[T-HUB-03 진단]");
      expect(output).toContain("host=127.0.0.1 port=1 db=probe_db user=probe_user");
    } finally {
      stderr.mockRestore();
    }
  });
});

/*
 * **덫 — 시계가 뒤로 가도 되돌리기가 엉뚱한 것을 집지 않는다(T-HUB-47).**
 *
 * 이 저장소가 2026-08-22 하루에 게이트를 열일곱 번 돌리고 절반 이상 빨갰던 원인이
 * 여기다. 원인은 우리 코드 밖(WSL2/Docker 시계 드리프트)이라 **재현을 기다릴 수 없다.**
 * 그래서 시계가 뒤로 간 상태를 손으로 만들어 놓고, 보정이 실제로 발동하는지 본다.
 *
 * 무엇을 재는가: 가장 **먼저** 적용된 마이그레이션의 `run_on` 을 맨 뒤로 밀어 놓는다.
 * 이러면 `ORDER BY run_on, id` 목록의 마지막이 그것이 되고, 보정이 없으면 되돌리기가
 * **기반 마이그레이션을 되돌리려 든다**(또는 순서 검사가 던져 게이트가 빨개진다).
 * 보정이 있으면 이름순 마지막 하나만 사라지고 기반은 그대로 남는다.
 */
describe("migration order repair", () => {
  let container: StartedNativeTestService;
  let migratorDatabaseUrl: string;

  const migrationNames = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => file.replace(/\.sql$/u, ""))
    .sort();
  const firstMigration = migrationNames[0]!;
  const lastMigration = migrationNames.at(-1)!;

  beforeAll(async () => {
    container = await startNativeTestService("postgres", {
      POSTGRES_DB: "classhub_dev",
      POSTGRES_PASSWORD: "local_bootstrap_password",
      POSTGRES_USER: "classhub_bootstrap",
    });
    const host = container.getHost();
    const port = container.getMappedPort(5432);
    const bootstrapPool = new Pool({
      connectionString: `postgresql://classhub_bootstrap:local_bootstrap_password@${host}:${port}/classhub_dev`,
    });
    await bootstrapPool.query(await readFile(bootstrapPath, "utf8"));
    await bootstrapPool.end();
    migratorDatabaseUrl = `postgresql://classhub_migrator:local_migrator_password@${host}:${port}/classhub_dev`;
    await runner({
      databaseUrl: migratorDatabaseUrl,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      verbose: false,
    });
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("reverts the newest migration even when run_on order is skewed", async () => {
    const pool = new Pool({ connectionString: migratorDatabaseUrl });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      // 가장 먼저 적용된 것을 시각상 맨 뒤로 민다 = 시계가 뒤로 간 것과 같은 상태.
      await pool.query(
        "UPDATE pgmigrations SET run_on = (SELECT max(run_on) FROM pgmigrations) + INTERVAL '1 hour' WHERE name = $1",
        [firstMigration],
      );
      const skewed = await pool.query<{ last_by_run_on: string }>(
        "SELECT (array_agg(name ORDER BY run_on, id))[count(*)] AS last_by_run_on FROM pgmigrations",
      );
      // 덫이 실제로 놓였는지 먼저 확인한다 — 안 놓였으면 아래 통과는 아무것도 증명 못 한다.
      expect(skewed.rows[0]?.last_by_run_on).toBe(firstMigration);

      await runner({
        count: 1,
        databaseUrl: migratorDatabaseUrl,
        dir: migrationsDirectory,
        direction: "down",
        migrationsTable: "pgmigrations",
        verbose: false,
      });

      const remaining = await pool.query<{ name: string }>("SELECT name FROM pgmigrations");
      const names = remaining.rows.map((row) => row.name);
      expect(names).toContain(firstMigration);
      expect(names).not.toContain(lastMigration);

      const output = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("[T-HUB-47 보정]");
    } finally {
      stderr.mockRestore();
      await pool.end();
    }
  }, 120_000);
});
