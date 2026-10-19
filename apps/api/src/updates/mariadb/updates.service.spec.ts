import type { DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import { describe, expect, it } from "vitest";
import type { AppEnvironment } from "../../config/environment.js";
import { NoticesAccessService } from "../../notices/notices-access.service.js";
import { decodeUpdatesCursor, encodeUpdatesCursor } from "../updates.cursor.js";
import { UpdatesService } from "../updates.service.js";
import type { UpdatesFilter } from "../updates.types.js";

const actorId = "9007199255940001";
const memberId = "9007199255940002";
const classId = "9007199255940003";
const itemId = "9007199255940004";
const revision = "9007199254740993";
const publishedAt = "2026-09-07T04:05:06.123987Z";
const serverToday = "2026-09-07";
const config = new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" });
type Row = Record<string, unknown>;
type Step = { sql: RegExp; rows: Row[] };
const context = (role = "teacher", extra: Row = {}): Row => ({
  class_id: classId,
  class_status: "active",
  member_id: memberId,
  role,
  profile_status: role === "teacher" ? "active" : null,
  temporary_password_must_change: role === "teacher" ? 0 : null,
  ...extra,
});
const feedRow = (extra: Row = {}): Row => ({
  server_today: serverToday,
  unresolved_count: 0,
  audience_mode: "selected_snapshot",
  category: "general",
  check_state: null,
  confirmation_state: null,
  content: "설명 %_!\\",
  content_revision: revision,
  id: itemId,
  is_important: 1,
  item_kind: "notice",
  needed_on: null,
  published_at: publishedAt,
  row_version: revision,
  title: "알림",
  ...extra,
});
const sentinel = (): Row =>
  Object.fromEntries(
    Object.keys(feedRow()).map((key) => [
      key,
      key === "server_today" ? serverToday : key === "unresolved_count" ? 0 : null,
    ]),
  );
const accessStep = (role = "teacher", extra: Row = {}): Step => ({
  sql: /^select .* from [`"]class_members[`"]/u,
  rows: [context(role, extra)],
});
const feedStep = (rows: Row[] = [sentinel()]): Step => ({
  sql: /^\s*WITH statement_clock AS/u,
  rows,
});

// Real compilers/codecs and source access checks. The scripted driver is not a SQL server:
// predicates, statement snapshots, and collation execution still need isolated database QA.
function harness(steps: Step[], engine: "mariadb" | "postgres" = "mariadb", selected = true) {
  const queries: CompiledQuery[] = [];
  const events: string[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
          queries.push(query);
          const next = steps.shift();
          expect(next, "unexpected SQL").toBeDefined();
          expect(query.sql).toMatch(next!.sql);
          if (engine === "mariadb") {
            expect(query.sql).toMatch(/^\s*(?:SELECT|WITH)\b/iu);
            expect(query.sql).not.toMatch(/::|\bILIKE\b|\bRETURNING\b|NULLS LAST|AT TIME ZONE/iu);
          }
          return { rows: next!.rows } as QueryResult<R>;
        },
        streamQuery: async function* <R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("unused");
        },
      };
    }
    override async beginTransaction(
      _connection?: DatabaseConnection,
      settings: { isolationLevel?: string } = {},
    ) {
      // Guarded Maria connections reject repeatable-read; the feed must not ask for a transaction.
      expect(engine).toBe("postgres");
      expect(settings.isolationLevel).toBe("repeatable read");
      events.push("begin");
    }
    override async commitTransaction() {
      events.push("commit");
    }
    override async rollbackTransaction() {
      events.push("rollback");
    }
  }
  const database = new Kysely<DB>({
    dialect: {
      createDriver: () => new Driver(),
      createAdapter: () => new MysqlAdapter(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () =>
        engine === "mariadb" ? new MysqlQueryCompiler() : new PostgresQueryCompiler(),
    },
  });
  const selectedConfig = engine === "mariadb" ? config : undefined;
  const access = new NoticesAccessService(database, selectedConfig);
  const audiences = { selectedAudienceEnabled: () => selected };
  const service = new UpdatesService(database, access, audiences as never, selectedConfig);
  return { database, access, audiences, service, steps, queries, events };
}

describe("MariaDB updates statement snapshot", () => {
  it("retains the default PostgreSQL RR clock and feed path", async () => {
    const h = harness(
      [
        accessStep("student"),
        { sql: /^select to_char/u, rows: [{ server_today: serverToday }] },
        { sql: /^\s*WITH feed AS/u, rows: [] },
        { sql: /^\s*SELECT \(/u, rows: [{ unresolved_count: "0" }] },
      ],
      "postgres",
    );
    expect(await h.service.list({ actorUserId: actorId, filter: "all" })).toEqual({
      items: [],
      next_cursor: null,
      selected_audience_enabled: true,
      unresolved_count: 0,
      server_today: serverToday,
    });
    expect(h.events).toEqual(["begin", "commit"]);
    expect(h.queries[2]!.sql).toContain("::bigint");
    expect(h.queries[2]!.parameters).toContain("2026-06-09");
    expect(h.steps).toHaveLength(0);
  });

  it("rejects an unsupported engine at construction", () => {
    const h = harness([]);
    expect(
      () =>
        new UpdatesService(
          h.database,
          h.access,
          h.audiences as never,
          new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "unknown" }),
        ),
    ).toThrow("Unsupported database engine");
  });

  it("returns the KST date sentinel without a transaction or a separate clock read", async () => {
    const h = harness([accessStep(), feedStep()], "mariadb", false);
    expect(await h.service.list({ actorUserId: actorId, filter: "all" })).toEqual({
      items: [],
      next_cursor: null,
      selected_audience_enabled: false,
      unresolved_count: null,
      server_today: serverToday,
    });
    expect(h.queries).toHaveLength(2);
    expect(h.events).toEqual([]);
    const statement = h.queries[1]!.sql;
    expect(statement).toContain("DATE_FORMAT(UTC_TIMESTAMP(6) + INTERVAL 9 HOUR");
    expect(statement).toContain("notice.published_at <= statement_clock.utc_now");
    expect(statement).toContain("LEFT JOIN page ON TRUE");
    expect(statement).toContain(
      "DATE_SUB(CAST(statement_clock.server_today AS DATE), INTERVAL 90 DAY)",
    );
    expect(statement).not.toMatch(/FROM (?:notice|supply)_recipients/u);
    expect(h.steps).toHaveLength(0);
  });

  it("projects student confirmation/check states, native booleans, and precise string identities", async () => {
    const h = harness([
      accessStep("student"),
      feedStep([
        feedRow({ confirmation_state: "confirmed" }),
        feedRow({
          id: "9007199255940005",
          item_kind: "supply",
          is_important: 0,
          category: "homework",
          check_state: "modified_unconfirmed",
          content: null,
          needed_on: serverToday,
        }),
      ]),
    ]);
    const result = await h.service.list({ actorUserId: actorId, filter: "all" });
    expect(result.items).toEqual([
      {
        audience_mode: "selected_snapshot",
        category: "general",
        content: "설명 %_!\\",
        content_revision: revision,
        id: itemId,
        is_important: true,
        kind: "notice",
        needed_on: null,
        published_at: publishedAt,
        row_version: revision,
        title: "알림",
        confirmation_state: "confirmed",
      },
      {
        audience_mode: "selected_snapshot",
        category: "homework",
        content: null,
        content_revision: revision,
        id: "9007199255940005",
        is_important: false,
        kind: "supply",
        needed_on: serverToday,
        published_at: publishedAt,
        row_version: revision,
        title: "알림",
        check_state: "modified_unconfirmed",
      },
    ]);
    const statement = h.queries[1]!.sql;
    expect(statement).toContain("FROM notice_recipients AS audience_recipient");
    expect(statement).toContain("FROM supply_recipients AS audience_recipient");
    expect(
      statement.match(/audience_recipient.class_id = (?:notice|supply).class_id/gu),
    ).toHaveLength(4);
    expect(statement.match(/audience_mode = 'legacy_class'/gu)).toHaveLength(4);
    expect(statement).toContain("WHEN notice_read.id IS NULL THEN 'unread'");
    expect(statement).toContain("ELSE 'modified_unconfirmed'");
    expect(statement).toContain("supply_check.confirmed_revision < supply.content_revision");
    expect(statement).toContain("ELSE 'unchecked'");
    expect(h.queries[1]!.parameters.filter((value) => value === memberId)).toHaveLength(8);
    expect(h.queries[1]!.parameters.filter((value) => value === classId)).toHaveLength(4);
    expect(h.events).toEqual([]);
  });

  it("omits confirmation fields for teachers while keeping the supply age limit", async () => {
    const h = harness([
      accessStep(),
      feedStep([feedRow(), feedRow({ item_kind: "supply", is_important: 0 })]),
    ]);
    const result = await h.service.list({ actorUserId: actorId, filter: "all" });
    for (const item of result.items) {
      expect(item).not.toHaveProperty("confirmation_state");
      expect(item).not.toHaveProperty("check_state");
    }
    expect(h.queries[1]!.sql).toContain("INTERVAL 90 DAY");
    expect(h.queries[1]!.sql).not.toContain("audience_recipient");
    expect(h.queries[1]!.parameters.filter((value) => value === "teacher")).toHaveLength(2);
  });

  it.each([
    ["all", "TRUE", "TRUE"],
    ["notices", "notice.category = 'general'", "FALSE"],
    ["materials", "FALSE", "supply.category = 'general'"],
    ["important", "notice.is_important = TRUE", "FALSE"],
    ["performance", "notice.category = 'performance'", "FALSE"],
    ["supplies", "FALSE", "TRUE"],
    ["homework", "FALSE", "supply.category = 'homework'"],
  ] as const)("preserves %s branch filtering", async (filter, notice, supply) => {
    const h = harness([accessStep(), feedStep()]);
    await h.service.list({ actorUserId: actorId, filter });
    const [noticeSql, supplySql] = h.queries[1]!.sql.split("UNION ALL");
    expect(noticeSql).toContain(`AND ${notice}`);
    expect(supplySql).toContain(`AND ${supply}`);
  });

  it("returns an exact count on an empty searched page and keeps its scope independent of filters", async () => {
    const h = harness([accessStep("student"), feedStep([{ ...sentinel(), unresolved_count: 37 }])]);
    const result = await h.service.list({
      actorUserId: actorId,
      filter: "materials",
      search: "없는 단어",
    });
    expect(result.items).toEqual([]);
    expect(result.unresolved_count).toBe(37);
    const statement = h.queries[1]!.sql;
    const countSql = statement.split("unresolved AS (")[1]!.split("), page AS (")[0]!;
    expect(countSql).toContain("FROM notice_recipients");
    expect(countSql).toContain("FROM supply_recipients");
    expect(countSql).toContain("confirmed.confirmed_revision = notice.content_revision");
    expect(countSql).toContain("confirmed.is_checked = TRUE");
    expect(countSql).toContain("confirmed.confirmed_revision = supply.content_revision");
    expect(countSql).toContain("INTERVAL 90 DAY");
    expect(countSql).not.toMatch(/LIKE|category|source_published_at/gu);
  });

  it("filters students against the latest revision and rejects teachers before querying their feed", async () => {
    const h = harness([
      accessStep("student"),
      feedStep([feedRow({ confirmation_state: "modified_unconfirmed", unresolved_count: 2 })]),
    ]);
    const result = await h.service.list({ actorUserId: actorId, filter: "unresolved" });
    expect(result.unresolved_count).toBe(2);
    expect(h.queries[1]!.sql).toContain(
      "NOT (notice_read.confirmed_revision <=> notice.content_revision)",
    );
    expect(h.queries[1]!.sql).toContain("NOT COALESCE(supply_check.is_checked = TRUE");
    const teacher = harness([accessStep()]);
    await expect(
      teacher.service.list({ actorUserId: actorId, filter: "unresolved" }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: "VALIDATION_FAILED" },
    });
    expect(teacher.queries).toHaveLength(1);
  });

  it("binds normalized case-insensitive literal search without treating backslash as an escape", async () => {
    const h = harness([accessStep("student"), feedStep()]);
    await h.service.list({ actorUserId: actorId, filter: "all", search: "  ABC%_!\\한글  " });
    const statement = h.queries[1]!;
    expect(statement.parameters.filter((value) => value === "%ABC!%!_!!\\한글%")).toHaveLength(4);
    expect(
      statement.sql.match(/COLLATE utf8mb4_nopad_bin LIKE LOWER\(\?\) ESCAPE '!'/gu),
    ).toHaveLength(4);
    expect(statement.sql).not.toContain("ABC");
  });

  it("preserves sub-millisecond cursor position, kind tie-break and signed BIGINT ordering", async () => {
    const cursor = encodeUpdatesCursor({
      filter: "all",
      id: "9223372036854775807",
      itemKind: "notice",
      publishedAt,
      search: "알림",
    });
    const rows = Array.from({ length: 21 }, (_, index) =>
      feedRow({
        id: String(9007199255940040n - BigInt(index)),
        item_kind: index < 10 ? "notice" : "supply",
        published_at: `2026-09-07T04:05:06.123${String(980 - index).padStart(3, "0")}Z`,
      }),
    );
    const h = harness([accessStep(), feedStep(rows)]);
    const result = await h.service.list({
      actorUserId: actorId,
      filter: "all",
      cursor,
      search: " 알림 ",
    });
    expect(result.items).toHaveLength(20);
    expect(decodeUpdatesCursor(result.next_cursor!, "all", "알림")).toEqual({
      filter: "all",
      id: "9007199255940021",
      itemKind: "supply",
      publishedAt: "2026-09-07T04:05:06.123961Z",
      search: "알림",
    });
    const statement = h.queries[1]!;
    expect(
      statement.parameters.filter((value) => value === "2026-09-07 04:05:06.123987"),
    ).toHaveLength(3);
    expect(statement.parameters).toContain("9223372036854775807");
    expect(statement.parameters.at(-1)).toBe(21);
    expect(statement.sql).toContain("feed.item_kind > ?");
    expect(statement.sql).toContain("feed.item_kind = ?");
    expect(statement.sql).toContain("feed.id < CAST(? AS SIGNED)");
    expect(statement.sql).toContain(
      "ORDER BY feed.source_published_at DESC, feed.item_kind ASC, feed.id DESC",
    );
    expect(statement.sql).toContain(
      "ORDER BY page.source_published_at DESC, page.item_kind ASC, page.id DESC",
    );
    expect(statement.sql).toContain("'%Y-%m-%dT%H:%i:%s.%fZ'");
  });

  it.each([
    [{ class_status: "suspended" }, 423],
    [{ class_status: "archived" }, 404],
    [{ temporary_password_must_change: 1 }, 403],
  ] as const)(
    "checks collection access before invalid cursor and feed SQL (%j)",
    async (extra, status) => {
      const h = harness([accessStep("teacher", extra)]);
      await expect(
        h.service.list({ actorUserId: actorId, filter: "all", cursor: "bad" }),
      ).rejects.toMatchObject({ status });
      expect(h.queries).toHaveLength(1);
      expect(h.events).toEqual([]);
    },
  );

  it("rejects a cursor bound to another filter/search before the feed query", async () => {
    const cursor = encodeUpdatesCursor({
      filter: "performance",
      id: itemId,
      itemKind: "notice",
      publishedAt,
      search: "원문",
    });
    for (const [filter, search] of [
      ["all", "원문"],
      ["performance", "변경"],
    ] as [UpdatesFilter, string][]) {
      const h = harness([accessStep("student")]);
      await expect(
        h.service.list({ actorUserId: actorId, filter, search, cursor }),
      ).rejects.toMatchObject({ status: 400 });
      expect(h.queries).toHaveLength(1);
    }
  });

  it.each([
    { is_important: "0" },
    { id: 9007199254740992 },
    { row_version: null },
    { published_at: "2026-02-30T04:05:06.123987Z" },
    { server_today: "2026-02-30" },
    { unresolved_count: -1 },
    { unresolved_count: 1.5 },
  ])("rejects malformed native values before exposing a page (%j)", async (extra) => {
    const h = harness([accessStep(), feedStep([feedRow(extra)])]);
    await expect(h.service.list({ actorUserId: actorId, filter: "all" })).rejects.toThrow(
      "Invalid MariaDB application value.",
    );
  });
});
