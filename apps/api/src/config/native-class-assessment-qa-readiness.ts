import { performance } from "node:perf_hooks";
import { sql } from "kysely";
import type { AppEnvironment } from "./environment.js";
import type { ClassHubDatabase } from "../database/database.module.js";

const FAILURE = "반 연결 QA 시작에 필요한 데이터베이스 조건을 확인하지 못했습니다.";
export const CLASS_ASSESSMENT_QA_STARTUP_QUERIES = Object.freeze({
  identity:
    "SELECT DATABASE() AS database_name, CAST(@@port AS CHAR) AS server_port, VERSION() AS server_version, CURRENT_USER() AS account, (SELECT VARIABLE_VALUE FROM information_schema.SESSION_STATUS WHERE VARIABLE_NAME='SSL_CIPHER') AS ssl_cipher, (SELECT VARIABLE_VALUE FROM information_schema.SESSION_STATUS WHERE VARIABLE_NAME='SSL_VERSION') AS ssl_version",
  columns:
    "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='student_assessment_records' AND COLUMN_NAME IN ('class_id','expires_at')) OR (TABLE_NAME='classes' AND COLUMN_NAME IN ('archived_at','retention_purged_at'))) ORDER BY TABLE_NAME,COLUMN_NAME",
  foreignKey:
    "SELECT k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_SCHEMA AS referenced_schema, k.REFERENCED_TABLE_NAME AS referenced_table, k.REFERENCED_COLUMN_NAME AS referenced_column, k.ORDINAL_POSITION AS ordinal_position, r.DELETE_RULE AS delete_rule, r.UPDATE_RULE AS update_rule FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON k.CONSTRAINT_SCHEMA=r.CONSTRAINT_SCHEMA AND k.TABLE_NAME=r.TABLE_NAME AND k.CONSTRAINT_NAME=r.CONSTRAINT_NAME WHERE k.CONSTRAINT_SCHEMA=DATABASE() AND k.TABLE_NAME='student_assessment_records' AND k.CONSTRAINT_NAME='student_assessment_records_class_fk' ORDER BY k.ORDINAL_POSITION",
  indexes:
    "SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, SEQ_IN_INDEX AS seq_in_index, COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique, SUB_PART AS sub_part, INDEX_TYPE AS index_type FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='student_assessment_records' AND INDEX_NAME='student_assessment_records_class_index') OR (TABLE_NAME='classes' AND INDEX_NAME='classes_retention_index')) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX",
});
const expectedColumns = [
  ["classes", "archived_at", "datetime(6)", "YES"],
  ["classes", "retention_purged_at", "datetime(6)", "YES"],
  ["student_assessment_records", "class_id", "bigint(20)", "YES"],
  ["student_assessment_records", "expires_at", "datetime(6)", "NO"],
].map(([table_name, column_name, column_type, is_nullable]) => ({
  table_name,
  column_name,
  column_type,
  is_nullable,
}));
const expectedIndexes = [
  ["classes", "classes_retention_index", ["status", "retention_purged_at", "archived_at", "id"]],
  [
    "student_assessment_records",
    "student_assessment_records_class_index",
    ["class_id", "expires_at", "id"],
  ],
] as const;
function need(value: unknown): asserts value {
  if (!value) throw new Error(FAILURE);
}
function exact(row: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return (
    Object.keys(row).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, value]) =>
        row[key] === value ||
        (typeof value === "number" && Number.isSafeInteger(value) && row[key] === String(value)),
    )
  );
}
/** Necessary startup checks only: not full active98 schema/ACL or deployment attestation. */
export async function assertNativeClassAssessmentQaReadiness(
  environment: AppEnvironment,
  database: ClassHubDatabase,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (!environment.NATIVE_CLASS_ASSESSMENT_QA_ENABLED) return;
  const timeoutMs = options.timeoutMs ?? 15000;
  let active = true;
  const start = performance.now();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const bounded = async <T>(task: Promise<T>, milliseconds: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            active = false;
            reject(new Error(FAILURE));
          }, milliseconds);
          timers.add(timer);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    }
  };
  const live = () => need(active && performance.now() - start < timeoutMs);
  try {
    need(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 15000);
    const url = new URL(environment.DATABASE_URL);
    need(
      environment.API_HOST === "127.0.0.1" &&
        environment.API_PORT === 3010 &&
        environment.PUBLIC_APP_ORIGIN === "http://localhost:5176" &&
        environment.PUBLIC_API_ORIGIN === "http://localhost:5176" &&
        environment.REDIS_URL === "redis://127.0.0.1:6380/1" &&
        environment.DATABASE_ACCOUNT_HOST === "%" &&
        (environment.DATABASE_TLS_CA_FILE?.trim().length ?? 0) > 0 &&
        ["mysql:", "mariadb:"].includes(url.protocol) &&
        url.username === "classhub_app" &&
        url.hostname === "localhost" &&
        url.port === "3309" &&
        url.pathname === "/classhub_mariadb_phase1_dev" &&
        url.search === "" &&
        url.hash === "",
    );
    need(
      environment.NODE_ENV === "development" &&
        environment.API_SURFACE === "user" &&
        !environment.ADMIN_WEB_ENABLED &&
        !environment.LOCAL_TEST_ADMIN_ENABLED &&
        !environment.PUBLIC_PREVIEW_ENABLED &&
        environment.DATABASE_ENGINE === "mariadb" &&
        environment.DATABASE_TLS_MODE === "required" &&
        environment.STUDENT_ASSESSMENTS_ENABLED &&
        environment.STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED &&
        !environment.NATIVE_ASSESSMENT_QA_ENABLED,
    );
    await bounded(
      database.connection().execute(async (leased) => {
        const read = async (statement: string) => {
          live();
          const result = await bounded(
            sql.raw<Record<string, unknown>>(statement).execute(leased),
            Math.min(5000, Math.max(1, timeoutMs - (performance.now() - start))),
          );
          live();
          return result.rows;
        };
        const identity = await read(CLASS_ASSESSMENT_QA_STARTUP_QUERIES.identity);
        need(identity.length === 1);
        const row = identity[0]!;
        need(
          Object.keys(row).length === 6 &&
            row.database_name === "classhub_mariadb_phase1_dev" &&
            row.server_port === "3309" &&
            row.account === "classhub_app@%" &&
            typeof row.server_version === "string" &&
            /^11\.4\.(\d+)-MariaDB(?:-[0-9A-Za-z.~+-]+)?$/.test(row.server_version) &&
            Number(/^11\.4\.(\d+)/.exec(row.server_version)?.[1]) >= 13 &&
            typeof row.ssl_cipher === "string" &&
            row.ssl_cipher.length > 0 &&
            typeof row.ssl_version === "string" &&
            ["TLSv1.2", "TLSv1.3"].includes(row.ssl_version),
        );
        const columns = await read(CLASS_ASSESSMENT_QA_STARTUP_QUERIES.columns);
        need(
          columns.length === expectedColumns.length &&
            columns.every((column, index) => exact(column, expectedColumns[index]!)),
        );
        const foreignKey = await read(CLASS_ASSESSMENT_QA_STARTUP_QUERIES.foreignKey);
        need(
          foreignKey.length === 1 &&
            exact(foreignKey[0]!, {
              column_name: "class_id",
              referenced_schema: "classhub_mariadb_phase1_dev",
              referenced_table: "classes",
              referenced_column: "id",
              ordinal_position: 1,
              delete_rule: "RESTRICT",
              update_rule: "RESTRICT",
            }),
        );
        const indexes = await read(CLASS_ASSESSMENT_QA_STARTUP_QUERIES.indexes);
        const expected = expectedIndexes.flatMap(([table_name, index_name, columns]) =>
          columns.map((column_name, index) => ({
            table_name,
            index_name,
            seq_in_index: index + 1,
            column_name,
            non_unique: 1,
            sub_part: null,
            index_type: "BTREE",
          })),
        );
        need(
          indexes.length === expected.length &&
            indexes.every((index, i) => exact(index, expected[i]!)),
        );
        live();
      }),
      timeoutMs,
    );
    live();
  } catch {
    throw new Error(FAILURE);
  } finally {
    active = false;
    for (const timer of timers) clearTimeout(timer);
  }
}
