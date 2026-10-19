import { describe, it, expect, vi } from "vitest";
import { loadEnvironment } from "./environment.js";
import {
  assertNativeClassAssessmentQaReadiness,
  CLASS_ASSESSMENT_QA_STARTUP_QUERIES as queries,
} from "./native-class-assessment-qa-readiness.js";
import type { ClassHubDatabase } from "../database/database.module.js";
const environment = loadEnvironment({
  NODE_ENV: "development",
  NATIVE_CLASS_ASSESSMENT_QA_ENABLED: "true",
  API_SURFACE: "user",
  ADMIN_WEB_ENABLED: "false",
  API_HOST: "127.0.0.1",
  API_PORT: "3010",
  PUBLIC_APP_ORIGIN: "http://localhost:5176",
  PUBLIC_API_ORIGIN: "http://localhost:5176",
  DATABASE_ENGINE: "mariadb",
  DATABASE_URL: "mysql://classhub_app:synthetic-only@localhost:3309/classhub_mariadb_phase1_dev",
  DATABASE_TLS_MODE: "required",
  DATABASE_TLS_CA_FILE: "synthetic.pem",
  DATABASE_ACCOUNT_HOST: "%",
  REDIS_URL: "redis://127.0.0.1:6380/1",
  STUDENT_ASSESSMENTS_ENABLED: "true",
  STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED: "true",
});
function rows() {
  return {
    [queries.identity]: [
      {
        database_name: "classhub_mariadb_phase1_dev",
        server_port: "3309",
        server_version: "11.4.13-MariaDB",
        account: "classhub_app@%",
        ssl_cipher: "synthetic-cipher",
        ssl_version: "TLSv1.3",
      },
    ],
    [queries.columns]: [
      ["classes", "archived_at", "datetime(6)", "YES"],
      ["classes", "retention_purged_at", "datetime(6)", "YES"],
      ["student_assessment_records", "class_id", "bigint(20)", "YES"],
      ["student_assessment_records", "expires_at", "datetime(6)", "NO"],
    ].map(([table_name, column_name, column_type, is_nullable]) => ({
      table_name,
      column_name,
      column_type,
      is_nullable,
    })),
    [queries.foreignKey]: [
      {
        column_name: "class_id",
        referenced_schema: "classhub_mariadb_phase1_dev",
        referenced_table: "classes",
        referenced_column: "id",
        ordinal_position: 1,
        delete_rule: "RESTRICT",
        update_rule: "RESTRICT",
      },
    ],
    [queries.indexes]: [
      [
        "classes",
        "classes_retention_index",
        ["status", "retention_purged_at", "archived_at", "id"],
      ],
      [
        "student_assessment_records",
        "student_assessment_records_class_index",
        ["class_id", "expires_at", "id"],
      ],
    ].flatMap(([table, index, columns]) =>
      (columns as string[]).map((column, i) => ({
        table_name: table,
        index_name: index,
        seq_in_index: i + 1,
        column_name: column,
        non_unique: 1,
        sub_part: null,
        index_type: "BTREE",
      })),
    ),
  } as Record<string, Record<string, unknown>[]>;
}
function fixture(data = rows()) {
  const executeQuery = vi.fn(async (query: { sql: string }) => ({
    rows: data[query.sql],
    numAffectedRows: 0n,
  }));
  const leased = {
    getExecutor: () => ({
      transformQuery: (node: unknown) => node,
      compileQuery: (node: { sqlFragments: string[] }) => ({
        sql: node.sqlFragments.join(""),
        parameters: [],
        query: node,
      }),
      executeQuery,
    }),
  };
  const lease = vi.fn(async (callback: (database: unknown) => Promise<unknown>) =>
    callback(leased),
  );
  return {
    database: { connection: () => ({ execute: lease }) } as unknown as ClassHubDatabase,
    executeQuery,
    lease,
  };
}
describe("native class assessment necessary startup checks", () => {
  it("performs no database access for default or personal profile", async () => {
    const database = {
      connection: () => {
        throw Error("must not query");
      },
    } as unknown as ClassHubDatabase;
    await assertNativeClassAssessmentQaReadiness(
      { ...environment, NATIVE_CLASS_ASSESSMENT_QA_ENABLED: false },
      database,
    );
  });
  it("checks fixed actual identity and metadata within one lease", async () => {
    const f = fixture();
    await assertNativeClassAssessmentQaReadiness(environment, f.database);
    expect(f.lease).toHaveBeenCalledOnce();
    expect(f.executeQuery.mock.calls.map(([query]) => query.sql)).toEqual(Object.values(queries));
  });
  it("accepts exact bigint metadata strings observed with mysql2 bigNumberStrings", async () => {
    const data = rows();
    data[queries.foreignKey]![0]!.ordinal_position = "1";
    for (const index of data[queries.indexes]!) index.non_unique = "1";
    const f = fixture(data);
    await assertNativeClassAssessmentQaReadiness(environment, f.database);
    expect(f.executeQuery).toHaveBeenCalledTimes(4);
  });
  it.each(["01", "1.0", "+1", " 1", "1 ", "-1", "0", "2", true, null])(
    "rejects noncanonical numeric metadata %s",
    async (value) => {
      for (const category of [queries.foreignKey, queries.indexes]) {
        const data = rows();
        data[category]![0]![category === queries.foreignKey ? "ordinal_position" : "non_unique"] =
          value;
        await expect(
          assertNativeClassAssessmentQaReadiness(environment, fixture(data).database),
        ).rejects.toThrow("반 연결 QA 시작에 필요한");
      }
    },
  );
  it("still rejects extra keys on otherwise canonical bigint metadata", async () => {
    const data = rows();
    data[queries.foreignKey]![0]!.ordinal_position = "1";
    data[queries.foreignKey]![0]!.unexpected = "1";
    await expect(
      assertNativeClassAssessmentQaReadiness(environment, fixture(data).database),
    ).rejects.toThrow("반 연결 QA 시작에 필요한");
  });
  it.each([
    "old-schema",
    "foreign-key",
    "cascade",
    "partial-index",
    "prefix-index",
    "unsigned-column",
    "wrong-account",
    "wrong-db",
    "wrong-port",
    "no-tls",
    "old-version",
    "malformed",
  ])("rejects %s without returning raw diagnostics", async (attack) => {
    const data = rows();
    if (attack === "old-schema") data[queries.columns] = [];
    if (attack === "foreign-key") data[queries.foreignKey] = [];
    if (attack === "cascade") data[queries.foreignKey]![0]!.delete_rule = "CASCADE";
    if (attack === "partial-index") data[queries.indexes]!.pop();
    if (attack === "prefix-index") data[queries.indexes]![0]!.sub_part = 3;
    if (attack === "unsigned-column")
      data[queries.columns]![2]!.column_type = "bigint(20) unsigned";
    if (attack === "wrong-account") data[queries.identity]![0]!.account = "classhub_root@%";
    if (attack === "wrong-db") data[queries.identity]![0]!.database_name = "classhub";
    if (attack === "wrong-port") data[queries.identity]![0]!.server_port = "13307";
    if (attack === "no-tls") data[queries.identity]![0]!.ssl_cipher = "";
    if (attack === "old-version") data[queries.identity]![0]!.server_version = "11.4.12-MariaDB";
    if (attack === "malformed") data[queries.identity]![0]!.secret = "must-not-leak";
    const f = fixture(data);
    await expect(assertNativeClassAssessmentQaReadiness(environment, f.database)).rejects.toThrow(
      "반 연결 QA 시작에 필요한",
    );
  });
  it("rejects a bypassed configuration before any database access", async () => {
    for (const change of [
      { API_SURFACE: "all" },
      { API_PORT: 3000 },
      { DATABASE_TLS_MODE: "disabled" },
      { PUBLIC_PREVIEW_ENABLED: true },
      { LOCAL_TEST_ADMIN_ENABLED: true },
      { REDIS_URL: "redis://127.0.0.1:6380/0" },
      { DATABASE_URL: "mysql://classhub_app:synthetic-only@localhost:13307/classhub" },
    ]) {
      const f = fixture();
      await expect(
        assertNativeClassAssessmentQaReadiness(
          { ...environment, ...change } as typeof environment,
          f.database,
        ),
      ).rejects.toThrow("반 연결 QA 시작에 필요한");
      expect(f.lease).not.toHaveBeenCalled();
    }
  });

  it("bounds a late query and suppresses subsequent queries", async () => {
    const f = fixture();
    let finish!: (value: Awaited<ReturnType<typeof f.executeQuery>>) => void;
    f.executeQuery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await expect(
      assertNativeClassAssessmentQaReadiness(environment, f.database, { timeoutMs: 10 }),
    ).rejects.toThrow("반 연결 QA 시작에 필요한");
    finish({ rows: rows()[queries.identity]!, numAffectedRows: 0n });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.executeQuery).toHaveBeenCalledOnce();
  });
  it("masks permission and connection failures", async () => {
    const f = fixture();
    f.executeQuery.mockRejectedValueOnce(Error("synthetic secret diagnostics"));
    await expect(assertNativeClassAssessmentQaReadiness(environment, f.database)).rejects.toThrow(
      /^반 연결 QA 시작에 필요한 데이터베이스 조건을 확인하지 못했습니다\.$/,
    );
  });
});
