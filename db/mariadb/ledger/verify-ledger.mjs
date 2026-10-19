import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readRecordBytes } from "../../../OPERATIONS/project-records/store.mjs";

const ledgerDirectory = dirname(fileURLToPath(import.meta.url));
const paths = {
  migration: resolve(ledgerDirectory, "../migrations/0001_identity_foundation.sql"),
  table: resolve(ledgerDirectory, "0000_create_schema_migrations.sql"),
  record: resolve(ledgerDirectory, "0001_identity_foundation_applied.sql"),
};
// 2026-09-11 문서 DB 전환으로 README.md는 파일이 아니라 data/project-records.sqlite의 기록이다.
const documentationRecordId = "db/mariadb/ledger/README.md";

const expectedPhaseTables = [
  "api_idempotency_keys",
  "email_verification_tokens",
  "password_reset_tokens",
  "sessions",
  "user_consents",
  "users",
];

function requireContract(condition, message) {
  if (!condition) throw new Error(message);
}

function requirePattern(value, pattern, message) {
  requireContract(pattern.test(value), message);
}

function requireSameRows(actual, expected, message) {
  const actualRows = [...actual].sort();
  const expectedRows = [...expected].sort();
  requireContract(
    JSON.stringify(actualRows) === JSON.stringify(expectedRows),
    `${message}: expected ${JSON.stringify(expectedRows)}, found ${JSON.stringify(actualRows)}`,
  );
}

export function verifyLedger({
  migrationBytes = readFileSync(paths.migration),
  tableSql = readFileSync(paths.table, "utf8"),
  recordSql = readFileSync(paths.record, "utf8"),
  documentation = readRecordBytes(documentationRecordId).toString("utf8"),
} = {}) {
  const sourceBytes = Buffer.isBuffer(migrationBytes)
    ? migrationBytes
    : Buffer.from(migrationBytes);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");

  const hashLiterals = [...recordSql.matchAll(/\bUNHEX\(\s*'([0-9a-f]{64})'\s*\)/giu)].map(
    (match) => match[1].toLowerCase(),
  );
  requireContract(hashLiterals.length === 1, "record artifact must contain one binary SHA-256");
  requireContract(
    hashLiterals[0] === sourceSha256,
    `record SHA-256 does not match source bytes: expected ${sourceSha256}, found ${hashLiterals[0]}`,
  );

  for (const [pattern, message] of [
    [/\bCREATE TABLE classhub_schema_migrations\s*\(/iu, "ledger table declaration is missing"],
    [/\bversion BIGINT UNSIGNED NOT NULL\b/iu, "version contract is missing"],
    [/\bdescription VARCHAR\(255\) NOT NULL\b/iu, "description contract is missing"],
    [/\bsource_sha256 VARBINARY\(32\) NOT NULL\b/iu, "binary SHA-256 contract is missing"],
    [/\bapplied_at_utc DATETIME\(6\) NOT NULL\b/iu, "UTC timestamp contract is missing"],
    [
      /\bserver_version VARCHAR\(128\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL\b/iu,
      "server version contract is missing",
    ],
    [/\bPRIMARY KEY \(version\)/iu, "ledger version primary key is missing"],
    [/\bOCTET_LENGTH\(source_sha256\) = 32\b/iu, "exact SHA-256 length check is missing"],
    [/\bENGINE=InnoDB\b/iu, "ledger must use InnoDB"],
    [/\bCOLLATE=utf8mb4_bin\b/iu, "ledger collation contract is missing"],
    [/excluded from product table inventory/iu, "product inventory separation is missing"],
  ]) {
    requirePattern(tableSql, pattern, message);
  }
  requireContract(
    !/\bCREATE TABLE IF NOT EXISTS\b/iu.test(tableSql),
    "ledger bootstrap must not silently accept an unknown existing table",
  );
  requireContract(
    !/\b(?:FOREIGN KEY|REFERENCES)\b/iu.test(tableSql),
    "ledger must remain independent from product tables",
  );

  requirePattern(
    recordSql,
    /\bINSERT INTO classhub_schema_migrations\s*\(\s*version\s*,\s*description\s*,\s*source_sha256\s*,\s*applied_at_utc\s*,\s*server_version\s*\)/iu,
    "plain ledger insert contract is missing",
  );
  for (const [pattern, message] of [
    [/\bCASE WHEN phase_table_count = 6 THEN 1 ELSE 0 END\b/iu, "partial-phase guard is missing"],
    [/'identity_foundation'/u, "phase description is missing"],
    [/\bUTC_TIMESTAMP\(6\)/iu, "UTC application time is missing"],
    [/\bVERSION\(\)/iu, "server version capture is missing"],
    [/\bTABLE_SCHEMA = DATABASE\(\)/iu, "current database boundary is missing"],
    [/\bTABLE_TYPE = 'BASE TABLE'/iu, "base-table guard is missing"],
    [/\bENGINE = 'InnoDB'/iu, "phase InnoDB guard is missing"],
  ]) {
    requirePattern(recordSql, pattern, message);
  }

  const phaseTableList = /\bTABLE_NAME IN\s*\(([\s\S]*?)\)\s*\n\s*\) AS phase_0001_guard/iu.exec(
    recordSql,
  );
  requireContract(phaseTableList !== null, "phase table allowlist is missing");
  const guardedTables = [...phaseTableList[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  requireSameRows(guardedTables, expectedPhaseTables, "phase table allowlist mismatch");

  const combinedSql = `${tableSql}\n${recordSql}`;
  for (const [pattern, message] of [
    [/\bDROP\b/iu, "ledger SQL must not contain destructive DROP statements"],
    [/\b(?:CREATE|ALTER)\s+USER\b/iu, "ledger SQL must not manage accounts"],
    [/\bIDENTIFIED\s+BY\b/iu, "ledger SQL must not contain credentials"],
    [/\bPASSWORD\b/iu, "ledger SQL must not contain password operations"],
    [/\bINSERT\s+IGNORE\b/iu, "record artifact must use a fail-closed plain INSERT"],
    [
      /\bREPLACE\s+(?:INTO\s+)?classhub_schema_migrations\b/iu,
      "record artifact must not replace ledger rows",
    ],
    [/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/iu, "record artifact must not hide duplicate versions"],
    [/\bDELETE\s+FROM\s+classhub_schema_migrations\b/iu, "ledger SQL must not delete history"],
    [/\bUPDATE\s+classhub_schema_migrations\b/iu, "ledger SQL must not rewrite history"],
  ]) {
    requireContract(!pattern.test(combinedSql), message);
  }

  for (const phrase of [
    "65개 product table",
    "DDL은 statement 단위로 auto-commit",
    "ledger row가 없는 상태",
    "이전 부분 적용으로 간주하고 즉시 중단",
    "INSERT IGNORE",
    "실제 DB에도 적용하지 않았다",
    sourceSha256,
  ]) {
    requireContract(documentation.includes(phrase), `documentation contract is missing: ${phrase}`);
  }

  return {
    ledgerTable: "classhub_schema_migrations",
    migration: "0001_identity_foundation.sql",
    sourceBytes: sourceBytes.length,
    sourceSha256,
    status: "pass",
  };
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(verifyLedger())}\n`);
}
