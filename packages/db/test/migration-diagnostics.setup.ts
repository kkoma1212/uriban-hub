/*
 * 왜 이 파일이 있나 — T-HUB-03(진단용, 고치는 코드가 아니다).
 *
 * packages/db 통합테스트가 아주 가끔 마이그레이션 이력 불일치로 실패한다:
 * "Not run migration 1783700004000_... is preceding already run migration ...".
 * 스펙마다 새 컨테이너를 띄우므로 DB는 비어 있어야 하고, 비어 있으면 이 오류는
 * 날 수가 없다. 즉 어딘가 "적용 이력이 남은 DB"에 붙었다는 뜻인데, 그게 어느
 * DB인지가 아직 확인되지 않았다(값싼 가설 5건은 이미 기각 — BACKLOG 참조).
 *
 * 발생률이 낮고 요구 시 재현이 안 되므로, 다음 한 번을 놓치지 않도록 실패 순간의
 * 접속 대상을 기록만 한다. 원인이 확인되기 전에는 harness를 고치지 않는다.
 *
 * 가장 중요한 값은 서버 uptime이다. 갓 뜬 컨테이너면 몇 초, 오래 살아 있는 DB에
 * 붙은 것이면 몇 시간으로 찍힌다 — 이 한 줄로 후보가 갈린다.
 *
 * 스펙 16개를 건드리지 않으려고 마이그레이션 실행 함수를 여기 한 곳에서 감쌌다.
 * 성공 경로는 그대로 통과하고, 실패해도 원래 오류를 그대로 다시 던진다.
 */
import { Client } from "pg";
import { vi } from "vitest";

/*
 * 일부 스펙은 마이그레이션이 실패하는 것 자체를 검증한다(예: 데이터가 남아 있으면
 * rollback 거부). 그런 정상적인 실패까지 진단을 찍으면 로그만 시끄러워지므로,
 * 이 조사의 대상인 증상에만 반응한다.
 */
const INVESTIGATED_FAILURE =
  /Not run migration|is preceding already run migration|ECONNREFUSED|ETIMEDOUT|Connection terminated|too many clients/u;

function connectionStringOf(options: unknown): string | null {
  if (typeof options !== "object" || options === null) return null;
  const databaseUrl = (options as { databaseUrl?: unknown }).databaseUrl;
  return typeof databaseUrl === "string" ? databaseUrl : null;
}

function migrationsDirectoryOf(options: unknown): string {
  if (typeof options !== "object" || options === null) return "(알 수 없음)";
  const dir = (options as { dir?: unknown }).dir;
  return typeof dir === "string" ? dir : "(알 수 없음)";
}

function describeTarget(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `host=${url.hostname} port=${url.port} db=${url.pathname.slice(1)} user=${url.username}`;
  } catch {
    return "(databaseUrl를 URL로 읽지 못했다)";
  }
}

async function serverState(databaseUrl: string): Promise<string[]> {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  try {
    await client.connect();
  } catch (error) {
    return [`서버: 진단 접속도 실패 — ${String(error)}`];
  }
  const lines: string[] = [];
  try {
    const identity = await client.query<{
      database: string;
      started_at: string;
      uptime: string;
    }>(`
      SELECT
        current_database() AS database,
        pg_postmaster_start_time()::text AS started_at,
        (now() - pg_postmaster_start_time())::text AS uptime
    `);
    const row = identity.rows[0];
    lines.push(
      `서버: db=${row?.database ?? "?"} 기동=${row?.started_at ?? "?"} uptime=${row?.uptime ?? "?"}`,
    );
  } catch (error) {
    lines.push(`서버: 신원 조회 실패 — ${String(error)}`);
  }
  try {
    /*
     * **두 순서를 나란히 찍는다.** `node-pg-migrate` 의 `checkOrder` 는 DB 목록을
     * `ORDER BY run_on, id` 로 읽어서 파일 이름순과 **인덱스로 짝지어** 비교한다.
     * 즉 적용 시각 순서가 이름순과 어긋나는 순간 "안 돌았다"고 던진다 — 실제로는
     * 다 돌아 있는데도. 예전에는 여기서 `id` 순만 찍어서 "다 있고 순서도 맞다"로
     * 보였고, 그래서 원인이 안 보였다(T-HUB-47, 2026-08-22).
     */
    const history = await client.query<{
      names_by_id: string;
      names_by_run_on: string;
      total: string;
    }>(`
      SELECT
        count(*)::text AS total,
        coalesce(string_agg(name, ', ' ORDER BY id), '(없음)') AS names_by_id,
        coalesce(string_agg(name, ', ' ORDER BY run_on, id), '(없음)') AS names_by_run_on
      FROM pgmigrations
    `);
    const row = history.rows[0];
    lines.push(`pgmigrations: ${row?.total ?? "?"}건 — ${row?.names_by_id ?? "?"}`);
    if (row !== undefined && row.names_by_id !== row.names_by_run_on) {
      lines.push(
        "⚠️ **적용 시각 순서가 이름순과 다르다 — 이것이 곧 실패 원인이다**(T-HUB-47).",
        `   run_on 순: ${row.names_by_run_on}`,
      );
    } else {
      lines.push("   (run_on 순서와 이름순이 같다 — 순서 뒤바뀜은 원인이 아니다)");
    }
  } catch (error) {
    lines.push(`pgmigrations: 조회 실패 — ${String(error)}`);
  }
  await client.end().catch(() => undefined);
  return lines;
}

function migrationsTableOf(options: unknown): string | null {
  if (typeof options !== "object" || options === null) return null;
  const table = (options as { migrationsTable?: unknown }).migrationsTable;
  if (typeof table !== "string") return null;
  /*
   * 표 이름을 SQL 에 그대로 끼워 넣으므로 평범한 식별자만 받는다. 값은 우리 시험이
   * 주는 것이지만, 문자열을 이어 붙이는 자리에 검사를 안 두면 나중에 값의 출처가
   * 바뀌었을 때 아무도 눈치채지 못한다.
   */
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(table) ? table : null;
}

/*
 * **되돌리기 직전에 적용 시각을 삽입 순서대로 다시 적는다 — 왜(T-HUB-47).**
 *
 * `node-pg-migrate` 는 적용 이력을 `ORDER BY run_on, id` 로 읽고(라이브러리 3681행),
 * 되돌릴 때 그 목록의 **마지막 N개**를 집는다(`downMigrations.slice(-count)`).
 * `run_on` 은 `NOW()`(트랜잭션 시작 시각)라, 호출과 호출 사이에 컨테이너 시계가
 * 뒤로 조정되면 이 순서가 실제 적용 순서와 어긋난다. 그러면 둘 중 하나가 된다 —
 * 순서 검사가 "안 돌았다"고 던지거나(게이트가 빨개진다), 검사를 끈 상태라면
 * **엉뚱한 마이그레이션이 되돌려진다.**
 *
 * `id` 는 serial 이라 삽입 순서, 곧 **실제 적용 순서**이고 시계와 무관하다. 그래서
 * `run_on` 을 `id` 순으로 다시 적으면 `ORDER BY run_on, id` 가 곧 적용 순서가 된다.
 * 순서 검사를 **끄는 것이 아니라 옳은 것을 보게 만드는 것**이라, 검사가 원래 잡으려던
 * 것(이미 돌아간 것보다 앞 이름의 새 마이그레이션)은 그대로 잡힌다.
 *
 * ⚠️ **시험 환경 전용이다.** 운영에서는 마이그레이션을 한 방향으로 한 번만 돌리므로
 * 되돌리기 경로 자체가 없고, 이 파일은 `vitest.integration.config.ts` 의 setupFiles
 * 로만 실려서 제품 실행 경로에 들어가지 않는다.
 *
 * 보정은 **최선노력**이다 — 접속·권한·표 부재로 못 하면 조용히 넘어가고 원래 실행이
 * 제 오류로 말하게 둔다. 다만 실제로 고친 경우에는 반드시 찍는다. 말없이 고치면
 * 시계 문제가 사라진 것처럼 보여서 다음 사람이 원인을 다시 찾게 된다.
 */
async function repairRunOnOrder(options: unknown): Promise<void> {
  const databaseUrl = connectionStringOf(options);
  const table = migrationsTableOf(options);
  if (databaseUrl === null || table === null) return;
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  try {
    await client.connect();
  } catch {
    return;
  }
  try {
    const present = await client.query<{ exists: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [table],
    );
    if (present.rows[0]?.exists !== true) return;
    /*
     * `HAVING` 이라 **어긋났을 때만** 행이 나온다. 멀쩡한 실행에서는 빈 결과라
     * 아래 보정과 출력이 통째로 건너뛰어진다.
     */
    const skewed = await client.query<{ names_by_run_on: string | null }>(`
      SELECT string_agg(name, ', ' ORDER BY run_on, id) AS names_by_run_on
      FROM ${table}
      HAVING string_agg(name, ', ' ORDER BY id)
             IS DISTINCT FROM string_agg(name, ', ' ORDER BY run_on, id)
    `);
    const before = skewed.rows[0]?.names_by_run_on;
    if (before === undefined) return;
    await client.query(`
      WITH anchor AS (SELECT min(run_on) AS at FROM ${table}),
           ordered AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM ${table})
      UPDATE ${table} AS m
         SET run_on = anchor.at + (ordered.rn * INTERVAL '1 millisecond')
        FROM ordered, anchor
       WHERE ordered.id = m.id
    `);
    process.stderr.write(
      `${[
        "=== [T-HUB-47 보정] 적용 시각이 삽입 순서와 어긋나 다시 적었다 ===",
        "  시계가 뒤로 갔다는 뜻이다(WSL2/Docker 드리프트 추정 — 우리 코드 밖).",
        `  보정 전 run_on 순: ${before}`,
        "=== [T-HUB-47 보정] 끝 ===",
      ].join("\n")}\n`,
    );
  } catch (error) {
    process.stderr.write(`[T-HUB-47 보정] 건너뜀 — ${String(error)}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function reportMigrationFailure(options: unknown, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (!INVESTIGATED_FAILURE.test(message)) return;
  const databaseUrl = connectionStringOf(options);
  const lines = [
    "=== [T-HUB-03 진단] 마이그레이션 실행 실패 ===",
    `오류: ${message}`,
    `접속 대상: ${databaseUrl === null ? "(databaseUrl이 문자열이 아니다)" : describeTarget(databaseUrl)}`,
    `마이그레이션 파일: ${migrationsDirectoryOf(options)}`,
    ...(databaseUrl === null ? [] : await serverState(databaseUrl)),
    "=== [T-HUB-03 진단] 끝 ===",
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}

/*
 * **시험의 마이그레이션을 한 트랜잭션으로 묶는다 — 왜(T-HUB-47).**
 *
 * `node-pg-migrate` 의 `checkOrder` 는 적용 이력을 `ORDER BY run_on, id`(적용 **시각** 순)로
 * 읽어 파일 이름순과 인덱스로 짝지어 비교한다. 시각 순서가 이름순과 어긋나면
 * "안 돌았다"고 던진다 — 실제로는 다 돌아 있는데도.
 *
 * 2026-08-22 게이트에서 여러 번 터졌고 진단이 원인을 찍었다:
 *   run_on 순: 001000, 002000, 003000, 004000, 005000, 006000, **000000**
 * 첫 마이그레이션이 **맨 뒤**로 기록됐다 — 적용 도중 컨테이너 시계가 뒤로 조정된
 * 것이다(uptime 이 음수로 찍힌 것도 같은 원인). Windows/WSL2 Docker 의 시계 드리프트이고
 * 마이그레이션 자체와는 아무 상관이 없다.
 *
 * **고치는 방식은 두 겹이고 방향에 따라 다르다** — 자세한 것은 아래 `runner` 안 주석에
 * 적었다. 요약하면 ① 한 트랜잭션으로 묶어 한 호출 안의 순서를 못박고 ② 호출 사이까지는
 * 못 막으므로 **올리는 방향에서만** 순서 검사를 끈다(그쪽은 대상을 이름순으로 고른다).
 * **되돌리는 방향은 끄지 않는다** — 거기서는 그 검사가 실제 안전장치다.
 */
vi.mock("node-pg-migrate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-pg-migrate")>();
  return {
    ...actual,
    runner: async (options: Parameters<typeof actual.runner>[0]) => {
      /*
       * 되돌리기는 `run_on` 순 마지막 N개를 집으므로, 그 순서가 실제 적용 순서와
       * 같다는 것을 **먼저 보장**한다(위 `repairRunOnOrder` 주석 참조).
       */
      if (options.direction === "down") await repairRunOnOrder(options);
      try {
        /*
         * **두 겹으로 막는다.**
         *
         * ① `singleTransaction` — `run_on` 은 `NOW()`(**트랜잭션 시작** 시각)라, 한 트랜잭션
         *    으로 묶으면 모든 행이 같은 값이 되고 `id`(삽입 순)가 순서를 정한다. 한 호출
         *    안에서는 시계가 어떻게 흔들려도 안 꼬인다.
         *    실측: 이 저장소에 `CONCURRENTLY` 등 트랜잭션 밖을 요구하는 마이그레이션 0건.
         *
         * ② **올리는 방향만** `checkOrder: false` — ①로도 **호출과 호출 사이는 못 막는다.**
         *    `up 4` → `up 2` 처럼 나눠 부르면 그 사이에 시계가 뒤로 갈 수 있다(실측:
         *    `run_on 순 004000, 005000, 000000 … 003000` — 각 호출 안은 맞고 사이만 뒤집혔다).
         *    올릴 것을 고를 때는 "DB 에 없는 것"을 **파일 이름순**으로 집으므로
         *    (`upMigrations`) 검사를 꺼도 대상이 정확하다.
         *
         * ⚠️ **되돌리는 방향은 절대 끄지 않는다.** 그쪽은 `run_on` 순 **마지막 N개**를
         * 고르므로, 순서가 꼬인 채 검사를 끄면 `identity-foundation` 같은 기반이 되돌려질
         * 수 있다. 실제로 그렇게 껐다가 파괴적 되돌리기를 막는 시험이 통과해 버렸다.
         * 📌 **이 보호는 덫으로 확인할 수 없다** — 시계가 꼬여야만 드러나기 때문이다.
         * 근거는 라이브러리 코드(`downMigrations.slice(-count)`)를 읽은 것뿐이니, 여기를
         * 고칠 사람은 그 코드를 먼저 볼 것.
         *
         * ⚠️ 스프레드 순서 — **시험이 명시하면 그쪽이 이긴다.**
         * `production-role-migration-contract` 는 "중간에 실패하면 그 전까지는 적용된 채로
         * 남는다"는 **운영 동작 그대로**를 재는 계약 시험이라 `singleTransaction: false` 를
         * 직접 준다. 한 트랜잭션으로 묶으면 시험이 운영과 다른 것을 재게 된다.
         */
        return await actual.runner({
          singleTransaction: true,
          ...(options.direction === "down" ? {} : { checkOrder: false }),
          ...options,
        });
      } catch (error) {
        await reportMigrationFailure(options, error);
        throw error;
      }
    },
  };
});
