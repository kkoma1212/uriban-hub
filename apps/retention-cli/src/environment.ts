import {
  assertProductionDatabaseUrl,
  parseMariaDbTlsMode,
  parseMariaDbUrl,
  type MariaDbTlsMode,
} from "@classhub/db";

export type RetentionNodeEnvironment = "development" | "production" | "test";

export interface RetentionEnvironment {
  databaseEngine: "postgres" | "mariadb";
  databaseUrl: string;
  mariaDb?: {
    /** tls가 "disabled"면 없다. */
    tlsCaFile?: string;
    tls: MariaDbTlsMode;
    accountHost: string;
    connectionLimit: number;
    /** DB에 정리 계정의 메일 발송 기록 삭제 권한(0061)을 넣었는지. 넣기 전에는 false로 둔다. */
    mailLogsGrantInstalled: boolean;
    /** 관리자 작업 기록·동의 증빙 삭제 권한(0062, 0061 위)을 넣었는지. */
    auditConsentsGrantInstalled: boolean;
    /** 관리자 기록(가입 승인·패스키·복구 코드·문의) 정리 권한(0063, 0062 위)을 넣었는지. */
    adminRecordsGrantInstalled: boolean;
    /** Candidate ACL installed after schema review; omitted/none keeps the new job disabled. */
    classArchivesGrantProfile?: "none" | "active" | "legacy";
  };
  nodeEnvironment: RetentionNodeEnvironment;
}

function loadNodeEnvironment(value: string | undefined): RetentionNodeEnvironment {
  const nodeEnvironment = value ?? "development";
  if (!["development", "production", "test"].includes(nodeEnvironment)) {
    throw new Error("NODE_ENV is invalid.");
  }
  return nodeEnvironment as RetentionNodeEnvironment;
}

export function loadRetentionEnvironment(
  input: NodeJS.ProcessEnv = process.env,
): RetentionEnvironment {
  const nodeEnvironment = loadNodeEnvironment(input.NODE_ENV);
  const databaseEngine = input.DATABASE_ENGINE ?? "postgres";
  if (databaseEngine !== "postgres" && databaseEngine !== "mariadb") {
    throw new Error("DATABASE_ENGINE must be postgres or mariadb.");
  }
  const databaseUrl = input.RETENTION_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    throw new Error("RETENTION_DATABASE_URL is required.");
  }

  if (databaseEngine === "mariadb") {
    try {
      parseMariaDbUrl(databaseUrl, "classhub_retention");
    } catch {
      throw new Error("RETENTION_DATABASE_URL requires MariaDB DNS/TLS and classhub_retention.");
    }
    // 기본은 required. 같은 서버·내부망 DB라 운영자가 명시적으로 끈 경우에만 disabled(2026-10-07 사용자 승인).
    const tls = parseMariaDbTlsMode(
      input.RETENTION_DATABASE_TLS_MODE,
      "RETENTION_DATABASE_TLS_MODE",
    );
    const tlsCaFile = input.RETENTION_DATABASE_TLS_CA_FILE;
    const accountHost = input.RETENTION_DATABASE_ACCOUNT_HOST;
    if (tls === "required" && !tlsCaFile?.trim()) {
      throw new Error("RETENTION_DATABASE_TLS_CA_FILE is required.");
    }
    if (tls === "disabled" && tlsCaFile?.trim()) {
      throw new Error(
        "RETENTION_DATABASE_TLS_CA_FILE must be removed when RETENTION_DATABASE_TLS_MODE=disabled.",
      );
    }
    if (!accountHost || !/^[A-Za-z0-9_.:%/-]+$/u.test(accountHost)) {
      throw new Error("RETENTION_DATABASE_ACCOUNT_HOST is required and must be valid.");
    }
    const rawLimit = input.RETENTION_DATABASE_POOL_MAX ?? "10";
    const connectionLimit = Number(rawLimit);
    if (
      !/^[1-9]\d*$/u.test(rawLimit) ||
      !Number.isSafeInteger(connectionLimit) ||
      connectionLimit > 1000
    ) {
      throw new Error("RETENTION_DATABASE_POOL_MAX must be an integer from 1 through 1000.");
    }
    const mailLogsFlag = input.RETENTION_MAIL_LOGS_GRANT_INSTALLED ?? "false";
    if (mailLogsFlag !== "true" && mailLogsFlag !== "false") {
      throw new Error("RETENTION_MAIL_LOGS_GRANT_INSTALLED must be true or false.");
    }
    const auditConsentsFlag = input.RETENTION_AUDIT_CONSENTS_GRANT_INSTALLED ?? "false";
    if (auditConsentsFlag !== "true" && auditConsentsFlag !== "false") {
      throw new Error("RETENTION_AUDIT_CONSENTS_GRANT_INSTALLED must be true or false.");
    }
    if (auditConsentsFlag === "true" && mailLogsFlag !== "true") {
      throw new Error(
        "RETENTION_AUDIT_CONSENTS_GRANT_INSTALLED requires RETENTION_MAIL_LOGS_GRANT_INSTALLED=true.",
      );
    }
    const adminRecordsFlag = input.RETENTION_ADMIN_RECORDS_GRANT_INSTALLED ?? "false";
    if (adminRecordsFlag !== "true" && adminRecordsFlag !== "false") {
      throw new Error("RETENTION_ADMIN_RECORDS_GRANT_INSTALLED must be true or false.");
    }
    if (adminRecordsFlag === "true" && auditConsentsFlag !== "true") {
      throw new Error(
        "RETENTION_ADMIN_RECORDS_GRANT_INSTALLED requires RETENTION_AUDIT_CONSENTS_GRANT_INSTALLED=true.",
      );
    }
    const classArchivesProfile = input.RETENTION_CLASS_ARCHIVES_GRANT_INSTALLED ?? "none";
    if (!["none", "active", "legacy"].includes(classArchivesProfile))
      throw new Error("RETENTION_CLASS_ARCHIVES_GRANT_INSTALLED must be none, active or legacy.");
    if (classArchivesProfile !== "none" && adminRecordsFlag !== "true")
      throw new Error(
        "RETENTION_CLASS_ARCHIVES_GRANT_INSTALLED requires RETENTION_ADMIN_RECORDS_GRANT_INSTALLED=true.",
      );
    return {
      databaseEngine,
      databaseUrl,
      nodeEnvironment,
      mariaDb: {
        ...(tls === "required" && tlsCaFile ? { tlsCaFile } : {}),
        tls,
        accountHost,
        connectionLimit,
        mailLogsGrantInstalled: mailLogsFlag === "true",
        auditConsentsGrantInstalled: auditConsentsFlag === "true",
        adminRecordsGrantInstalled: adminRecordsFlag === "true",
        classArchivesGrantProfile: classArchivesProfile as "none" | "active" | "legacy",
      },
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("RETENTION_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("RETENTION_DATABASE_URL must be a PostgreSQL URL.");
  }
  if (parsed.username !== "classhub_retention") {
    throw new Error("RETENTION_DATABASE_URL must use the classhub_retention role.");
  }

  if (nodeEnvironment === "production") {
    assertProductionDatabaseUrl(databaseUrl, {
      environment: input,
      expectedUsername: "classhub_retention",
      variableName: "RETENTION_DATABASE_URL",
    });
  }

  return { databaseEngine, databaseUrl, nodeEnvironment };
}

export interface ReminderMailEnvironment {
  auth?: { password: string; username: string } | undefined;
  from: string;
  host: string;
  port: number;
  publicAppOrigin: string;
  requireTls: boolean;
  secure: boolean;
}

function requiredValue(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required.`);
  return value.trim();
}

function booleanValue(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === "") return false;
  if (!["true", "false"].includes(value.trim())) throw new Error(`${name} must be true or false.`);
  return value.trim() === "true";
}

/*
 * SMTP 설정은 리마인더 대상에서만 읽는다. loadRetentionEnvironment에 합치면
 * 메일과 무관한 기존 삭제 작업까지 SMTP 없이는 못 돌게 되어, 스케줄러에 이미
 * 등록된 명령들이 깨진다.
 */
export function loadReminderMailEnvironment(
  input: NodeJS.ProcessEnv = process.env,
): ReminderMailEnvironment {
  const port = Number(requiredValue(input.SMTP_PORT, "SMTP_PORT"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SMTP_PORT must be a valid port number.");
  }

  const username = input.SMTP_USERNAME?.trim();
  const password = input.SMTP_PASSWORD;
  const passwordPresent = password !== undefined && password.trim() !== "";
  if ((username !== undefined && username !== "") !== passwordPresent) {
    throw new Error("SMTP_USERNAME and SMTP_PASSWORD must be set together.");
  }
  const secure = booleanValue(input.SMTP_SECURE, "SMTP_SECURE");
  const requireTls = booleanValue(input.SMTP_REQUIRE_TLS, "SMTP_REQUIRE_TLS");
  const protectedEnvironment =
    loadNodeEnvironment(input.NODE_ENV) === "production" ||
    booleanValue(input.PUBLIC_PREVIEW_ENABLED, "PUBLIC_PREVIEW_ENABLED");
  const rawOrigin = requiredValue(input.PUBLIC_APP_ORIGIN, "PUBLIC_APP_ORIGIN");
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new Error("PUBLIC_APP_ORIGIN must be a valid origin.");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    /[\s<>"']/u.test(rawOrigin)
  ) {
    throw new Error("PUBLIC_APP_ORIGIN must be an HTTP(S) origin without credentials or a path.");
  }
  if (protectedEnvironment) {
    if (!secure && !requireTls)
      throw new Error("Production and public preview reminder SMTP require TLS.");
    if (!passwordPresent || !username)
      throw new Error("Production and public preview reminder SMTP require authentication.");
    if (input.NODE_TLS_REJECT_UNAUTHORIZED === "0")
      throw new Error("Reminder SMTP certificate verification must stay enabled.");
    if (origin.protocol !== "https:")
      throw new Error("Production and public preview PUBLIC_APP_ORIGIN require HTTPS.");
  }

  return {
    auth: username === undefined || username === "" ? undefined : { password: password!, username },
    from: requiredValue(input.SMTP_FROM, "SMTP_FROM"),
    host: requiredValue(input.SMTP_HOST, "SMTP_HOST"),
    port,
    publicAppOrigin: origin.origin,
    requireTls,
    secure,
  };
}
