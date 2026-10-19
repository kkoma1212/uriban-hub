import { readFile } from "node:fs/promises";
import {
  assertPostgresRuntimeRole,
  assertProductionDatabaseUrl,
  createDatabase,
  createMysql2MariaDbPool,
  createConfiguredRuntimeObservation,
  parseMariaDbTlsMode,
  parseMariaDbUrl,
  type DB,
} from "@classhub/db";
import type { Kysely } from "kysely";
import { openMariaDbOperatorDatabase } from "./mariadb/operator-database.js";

const OPERATOR_DATABASE_ROLE = "classhub_operator";

export interface OperatorDatabaseUrlContext {
  environment?: Readonly<Record<string, string | undefined>>;
  nodeEnvironment?: string;
}

export function requireOperatorDatabaseUrl(
  value: string | undefined,
  context: OperatorDatabaseUrlContext = {},
): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("OPERATOR_DATABASE_URL이 필요합니다.");
  }

  const environment = context.environment ?? process.env;
  const engine = environment.DATABASE_ENGINE ?? "postgres";
  if (engine !== "postgres" && engine !== "mariadb") {
    throw new Error("DATABASE_ENGINE은 postgres 또는 mariadb여야 합니다.");
  }
  if (engine === "mariadb") {
    parseMariaDbUrl(value, OPERATOR_DATABASE_ROLE);
    return value;
  }
  if (!/^postgres(?:ql)?:\/\//u.test(value)) {
    throw new Error("OPERATOR_DATABASE_URL과 DATABASE_ENGINE이 일치하지 않습니다.");
  }

  if ((context.nodeEnvironment ?? process.env.NODE_ENV) === "production") {
    assertProductionDatabaseUrl(value, {
      environment: context.environment ?? process.env,
      expectedUsername: OPERATOR_DATABASE_ROLE,
      variableName: "OPERATOR_DATABASE_URL",
    });
  }

  return value;
}

export async function assertOperatorDatabaseRole(database: Kysely<DB>): Promise<void> {
  await assertPostgresRuntimeRole(database, {
    expectedRole: OPERATOR_DATABASE_ROLE,
    runtimeName: "운영 CLI",
  });
}

export async function openOperatorDatabase(
  operatorDatabaseUrl: string | undefined,
  observationEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Kysely<DB>> {
  const observation = createConfiguredRuntimeObservation("operator", observationEnvironment);
  if (observation && process.env.DATABASE_ENGINE !== "mariadb")
    throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
  if (process.env.DATABASE_ENGINE === "mariadb") {
    const url = requireOperatorDatabaseUrl(operatorDatabaseUrl);
    const accountHost = process.env.OPERATOR_DATABASE_ACCOUNT_HOST;
    const caFile = process.env.OPERATOR_DATABASE_TLS_CA_FILE;
    // 기본은 required. 같은 서버·내부망 DB라 운영자가 명시적으로 끈 경우에만 disabled(2026-10-07 사용자 승인).
    const tls = parseMariaDbTlsMode(
      process.env.OPERATOR_DATABASE_TLS_MODE,
      "OPERATOR_DATABASE_TLS_MODE",
    );
    if (observation && tls !== "required") throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
    if (
      !accountHost ||
      !/^[A-Za-z0-9_.:%/-]+$/u.test(accountHost) ||
      (tls === "required" && !caFile?.trim())
    ) {
      throw new Error("운영 MariaDB의 계정 호스트와 신뢰할 수 있는 CA 파일이 필요합니다.");
    }
    if (tls === "disabled" && caFile?.trim()) {
      throw new Error("OPERATOR_DATABASE_TLS_MODE=disabled 이면 CA 파일 설정을 지워야 합니다.");
    }
    let sslCa: string | undefined;
    if (tls === "required" && caFile) {
      try {
        sslCa = await readFile(caFile, "utf8");
      } catch {
        throw new Error("운영 MariaDB의 CA 파일을 읽을 수 없습니다.");
      }
    }
    const database = await openMariaDbOperatorDatabase(createMysql2MariaDbPool, {
      ...parseMariaDbUrl(url, OPERATOR_DATABASE_ROLE),
      accountHost,
      tls,
      ...(sslCa === undefined ? {} : { sslCa }),
      runtimeGrantProfile: "operator_commands_v1",
      ...(observation ? { onRuntimeObservation: observation.sink } : {}),
    });
    try {
      observation?.assertCaptured();
      return database;
    } catch {
      try {
        await database.destroy();
      } catch {}
      throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
    }
  }
  const database = createDatabase<DB>(requireOperatorDatabaseUrl(operatorDatabaseUrl));
  try {
    await assertOperatorDatabaseRole(database);
    return database;
  } catch (attestationError) {
    try {
      await database.destroy();
    } catch {
      throw new Error("운영 CLI DB 역할 검증 실패 후 연결 정리에도 실패했습니다.");
    }

    throw attestationError;
  }
}
