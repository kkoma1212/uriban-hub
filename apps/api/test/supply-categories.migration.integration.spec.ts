import { readFile } from "node:fs/promises";

import type { DB } from "@classhub/db";
import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadAllTestMigrationPaths } from "./migration-test-source.js";
import {
  createClassFixture,
  database,
  seedSupply,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

/*
 * 되돌리기를 실제로 실행해 보는 유일한 자리다. 통합 하니스는 마이그레이션 파일을
 * "-- Down Migration" 앞까지만 잘라 쓰므로, down 쪽 SQL 은 아무 테스트도 돌려본 적이
 * 없다 — 문법 오류가 있어도 운영에서 되돌릴 때야 드러난다. T-HUB-02 와 T-HUB-10 이
 * 마이그레이션 되돌리기에서 두 번 데었기에 T-HUB-17 은 이걸 완료 기준으로 걸었다.
 *
 * 트랜잭션 안에서 돌리고 일부러 실패시켜 되감는다. Postgres 는 DDL 도 트랜잭션에
 * 들어가므로 하니스가 공유하는 DB 는 손대지 않은 채로 남는다 — 컨테이너를 하나 더
 * 띄우지 않으려는 것이다.
 */
/*
 * 파일 경로를 적지 않고 이름 끝으로 찾는다. 번호를 적어 두면 마이그레이션이
 * 다시 매겨질 때 조용히 어긋나고, 저장소 덫(verify:test-migration-source)도
 * 하드코딩된 마이그레이션 경로를 금지한다.
 */
const MIGRATION_SUFFIX = "_supply-categories.sql";

let upSql: string;
let downSql: string;

class Rollback extends Error {}

async function categoryColumnExists(executor: Kysely<DB> | Transaction<DB>): Promise<boolean> {
  const result = await sql<{ present: string }>`
    SELECT count(*)::text AS present
    FROM information_schema.columns
    WHERE table_name = 'supplies' AND column_name = 'category'
  `.execute(executor);
  return result.rows[0]!.present !== "0";
}

beforeAll(async () => {
  await setupSuppliesHarness();
  const migrationPath = (await loadAllTestMigrationPaths()).find((path) =>
    path.endsWith(MIGRATION_SUFFIX),
  );
  if (migrationPath === undefined) {
    throw new Error(`${MIGRATION_SUFFIX} 로 끝나는 마이그레이션을 찾지 못했다`);
  }
  const source = await readFile(migrationPath, "utf8");
  const [up, down] = source.split("-- Down Migration");
  upSql = up!.replace("-- Up Migration", "");
  downSql = down!;
}, 120_000);

afterAll(teardownSuppliesHarness);

describe("supply category migration", () => {
  it("leaves every existing supply an ordinary supply", async () => {
    expect(await categoryColumnExists(database)).toBe(true);

    const fixture = await createClassFixture();
    const supply = await seedSupply(fixture, { title: "기본값 확인용" });
    const stored = await sql<{ category: string }>`
      SELECT category FROM supplies WHERE id = ${supply.id}
    `.execute(database);
    expect(stored.rows[0]!.category).toBe("general");
  });

  it("only allows the two categories the product defined", async () => {
    const definition = await sql<{ definition: string }>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conname = 'supplies_category_check'
    `.execute(database);
    expect(definition.rows).toHaveLength(1);
    expect(definition.rows[0]!.definition).toContain("'general'");
    expect(definition.rows[0]!.definition).toContain("'homework'");
  });

  /*
   * 이 테스트가 이 파일의 핵심이다. down 이 문법적으로 돌고, 컬럼이 실제로 사라지고,
   * 같은 DB 에 up 을 다시 얹을 수 있어야 한다(왕복). 셋 중 하나라도 깨지면 운영에서
   * 되돌릴 수 없다.
   */
  it("runs its own down migration and can be applied again afterwards", async () => {
    let goneAfterDown: boolean | undefined;
    let backAfterUp: boolean | undefined;

    await expect(
      database.transaction().execute(async (transaction) => {
        await sql.raw(downSql).execute(transaction);
        goneAfterDown = await categoryColumnExists(transaction);
        await sql.raw(upSql).execute(transaction);
        backAfterUp = await categoryColumnExists(transaction);
        throw new Rollback("되감기 — 하니스 DB 를 원래대로 둔다");
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(goneAfterDown).toBe(false);
    expect(backAfterUp).toBe(true);
    // 되감았으니 공유 DB 는 그대로여야 한다.
    expect(await categoryColumnExists(database)).toBe(true);
  });

  /*
   * 위 "기본값" 검사는 마이그레이션이 이미 끝난 뒤에 만든 행을 본다. 그건 컬럼
   * DEFAULT 를 확인할 뿐 "종류가 생기기 전부터 있던 준비물"은 확인하지 않는다 —
   * 이름은 기존 행인데 실제로 본 것은 새 행이었다(2026-08-10 R1 검수 S-02).
   * 컬럼을 떼고 행을 만든 뒤 다시 붙여, 진짜 기존 행이 general 로 오는지 본다.
   */
  it("turns a supply that predates the column into an ordinary supply", async () => {
    const fixture = await createClassFixture();
    let categoryOfPreexistingRow: string | undefined;

    await expect(
      database.transaction().execute(async (transaction) => {
        await sql.raw(downSql).execute(transaction);
        const inserted = await transaction
          .insertInto("supplies")
          .values({
            class_id: fixture.classId,
            created_by_member_id: fixture.teacher.memberId!,
            needed_on: sql<Date>`CURRENT_DATE`,
            title: "종류가 생기기 전부터 있던 준비물",
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await sql.raw(upSql).execute(transaction);
        const stored = await sql<{ category: string }>`
          SELECT category FROM supplies WHERE id = ${inserted.id}
        `.execute(transaction);
        categoryOfPreexistingRow = stored.rows[0]?.category;
        throw new Rollback("되감기 — 하니스 DB 를 원래대로 둔다");
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(categoryOfPreexistingRow).toBe("general");
  });

  it("blocks the rollback when homework rows would silently become supplies", async () => {
    const fixture = await createClassFixture();
    const supply = await seedSupply(fixture, { title: "되돌리기 가드 확인용" });

    await expect(
      database.transaction().execute(async (transaction) => {
        await sql
          .raw(`UPDATE supplies SET category = 'homework' WHERE id = ${supply.id}`)
          .execute(transaction);
        await sql.raw(downSql).execute(transaction);
      }),
    ).rejects.toThrow(/category = general/u);
  });
});
