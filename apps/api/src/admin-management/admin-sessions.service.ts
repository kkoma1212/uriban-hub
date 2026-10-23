import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import { adminAuthDate, adminAuthJson } from "../admin-auth/admin-auth.database.js";
import { ADMIN_SESSION_LIFETIME_MS } from "../admin-auth/admin-auth.types.js";
import {
  createMariaDbRowCodec,
  mariaDbDateTime,
  mariaDbId,
} from "../common/database/mariadb-values.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AdminSessionKind } from "./admin-directory.dto.js";
import { maskEmail } from "../common/privacy/mask-email.js";
import { adminError } from "./admin-error.js";

export const ADMIN_USER_SESSION_PAGE_SIZE = 30;
/** 관리자 세션은 몇 개뿐이라 쪽 없이 이 수까지 보인다. */
const ADMIN_SESSION_LIMIT = 50;

/** 로그인 중인 사용자 세션 한 줄: 접속 주소·토큰 없이 이름·가린 메일·기기 요약·시각만. */
export interface AdminUserSessionRow {
  id: string;
  display_name: string;
  email_masked: string;
  device: string;
  issued_at: string;
  expires_at: string;
}

export interface AdminConsoleSessionRow {
  id: string;
  display_name: string;
  device: string;
  issued_at: string;
  last_seen_at: string;
  absolute_expires_at: string;
  /** 지금 이 화면을 보고 있는 관리자 자신의 세션 */
  is_current: boolean;
}

export interface AdminSessionList {
  user_sessions: AdminUserSessionRow[];
  user_total: number;
  page: number;
  page_size: number;
  admin_sessions: AdminConsoleSessionRow[];
  /** 운영 DB에 종료 기록값(원장 98)이 설치돼 강제 종료를 쓸 수 있는지 */
  revoke_enabled: boolean;
}

const isDatabaseId = (value: string): boolean =>
  /^[1-9]\d{0,18}$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;

const mariaSessionCodec = createMariaDbRowCodec({
  id: mariaDbId,
  issued_at: mariaDbDateTime,
  expires_at: mariaDbDateTime,
  last_seen_at: mariaDbDateTime,
  absolute_expires_at: mariaDbDateTime,
});

const toIso = (value: unknown): string => new Date(value as string | Date).toISOString();

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/SamsungBrowser\//u, "삼성 인터넷"],
  [/Whale\//u, "웨일"],
  [/Edg\//u, "Edge"],
  [/Firefox\//u, "Firefox"],
  [/Chrome\//u, "Chrome"],
  [/Safari\//u, "Safari"],
];
const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/Android/u, "Android"],
  [/iPhone|iPad/u, "iOS"],
  [/Windows/u, "Windows"],
  [/CrOS/u, "ChromeOS"],
  [/Mac OS X|Macintosh/u, "macOS"],
  [/Linux/u, "Linux"],
];

/** 브라우저 식별 문자열 전체는 보내지 않고 "Chrome · Windows" 정도로만 줄인다. */
export function summarizeDevice(userAgent: string | null): string {
  if (userAgent === null || userAgent.trim() === "") return "알 수 없음";
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return [browser, system].filter(Boolean).join(" · ") || "기타";
}

@Injectable()
export class AdminSessionsService {
  private readonly db: ClassHubDatabase;
  private readonly engine: "postgres" | "mariadb";
  private readonly revokeInstalled: boolean;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    config: ConfigService<AppEnvironment, true>,
  ) {
    const engine = config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Invalid administrator session list database engine.");
    this.engine = engine;
    this.db = engine === "mariadb" ? database.withPlugin(mariaSessionCodec) : database;
    this.revokeInstalled =
      config.get("ADMIN_SESSION_REVOKE_DATABASE_INSTALLED", { infer: true }) === true;
  }

  async list(
    query: { page?: number | undefined },
    currentSessionId: string,
  ): Promise<AdminSessionList> {
    const page = query.page ?? 1;
    const now = this.databaseNow();
    // 사용자 세션: 끝나지 않았고 만료 전이며 탈퇴하지 않은 계정의 것만.
    const openUserSessions = this.db
      .selectFrom("sessions as s")
      .innerJoin("users as u", "u.id", "s.user_id")
      .where("s.revoked_at", "is", null)
      .where("s.expires_at", ">", now)
      .where("u.deleted_at", "is", null);
    // 관리자 세션: 로그인 규칙과 같게 — 절대 만료 전이고 마지막 활동 후 30분 안.
    const idleSince = this.secondsAgo(ADMIN_SESSION_LIFETIME_MS / 1000);
    const [totalRow, userRows, adminRows] = await Promise.all([
      openUserSessions.select((eb) => eb.fn.countAll().as("total")).executeTakeFirstOrThrow(),
      openUserSessions
        .select([
          "s.id",
          "s.issued_at",
          "s.expires_at",
          "s.user_agent",
          "u.display_name",
          "u.email_normalized",
        ])
        .orderBy("s.issued_at", "desc")
        .orderBy("s.id", "desc")
        .limit(ADMIN_USER_SESSION_PAGE_SIZE)
        .offset((page - 1) * ADMIN_USER_SESSION_PAGE_SIZE)
        .execute(),
      this.db
        .selectFrom("admin_sessions as a")
        .innerJoin("admin_accounts as ac", "ac.id", "a.admin_account_id")
        .select([
          "a.id",
          "a.issued_at",
          "a.last_seen_at",
          "a.absolute_expires_at",
          "a.user_agent",
          "ac.display_name",
        ])
        .where("a.revoked_at", "is", null)
        .where("a.absolute_expires_at", ">", now)
        .where("a.last_seen_at", ">", idleSince)
        .orderBy("a.last_seen_at", "desc")
        .orderBy("a.id", "desc")
        .limit(ADMIN_SESSION_LIMIT)
        .execute(),
    ]);
    return {
      user_sessions: userRows.map((row) => ({
        id: String(row.id),
        display_name: row.display_name,
        email_masked: maskEmail(row.email_normalized),
        device: summarizeDevice(row.user_agent),
        issued_at: toIso(row.issued_at),
        expires_at: toIso(row.expires_at),
      })),
      user_total: Number(totalRow.total),
      page,
      page_size: ADMIN_USER_SESSION_PAGE_SIZE,
      admin_sessions: adminRows.map((row) => ({
        id: String(row.id),
        display_name: row.display_name,
        device: summarizeDevice(row.user_agent),
        issued_at: toIso(row.issued_at),
        last_seen_at: toIso(row.last_seen_at),
        absolute_expires_at: toIso(row.absolute_expires_at),
        is_current: String(row.id) === currentSessionId,
      })),
      revoke_enabled: this.revokeInstalled,
    };
  }

  /**
   * 세션 하나를 끝낸다(다음 요청부터 로그아웃). 끝낸 사실은 관리자 작업 기록에 남는다 — 기록값(원장 98)이
   * 설치되기 전에는 기록을 남길 수 없으므로 종료도 막는다. 자기 세션은 로그아웃으로 끝낸다.
   */
  async revoke(input: {
    id: string;
    kind: AdminSessionKind;
    reason: string;
    actorAdminId: string;
    currentSessionId: string;
    requestId: string;
  }): Promise<{ id: string; kind: AdminSessionKind; revoked: true }> {
    if (!this.revokeInstalled)
      throw adminError(ConflictException, "ADMIN_SESSION_REVOKE_NOT_INSTALLED");
    if (!isDatabaseId(input.id)) throw adminError(NotFoundException, "ADMIN_SESSION_NOT_FOUND");
    if (input.kind === "admin" && input.id === input.currentSessionId)
      throw new BadRequestException({
        code: "ADMIN_SESSION_REVOKE_SELF",
        message: "지금 쓰는 세션은 로그아웃으로 끝내 주세요.",
      });
    const now = new Date();
    await this.db.transaction().execute(async (transaction) => {
      const owner =
        input.kind === "user"
          ? await transaction
              .selectFrom("sessions")
              .select(["user_id as owner_id"])
              .where("id", "=", input.id)
              .where("revoked_at", "is", null)
              .forUpdate()
              .executeTakeFirst()
          : await transaction
              .selectFrom("admin_sessions")
              .select(["admin_account_id as owner_id"])
              .where("id", "=", input.id)
              .where("revoked_at", "is", null)
              .forUpdate()
              .executeTakeFirst();
      if (owner === undefined) throw adminError(NotFoundException, "ADMIN_SESSION_NOT_FOUND");
      const revokedAt = adminAuthDate(now, this.engine);
      if (input.kind === "user")
        await transaction
          .updateTable("sessions")
          .set({ revoked_at: revokedAt })
          .where("id", "=", input.id)
          .where("revoked_at", "is", null)
          .execute();
      else
        await transaction
          .updateTable("admin_sessions")
          .set({ revoked_at: revokedAt })
          .where("id", "=", input.id)
          .where("revoked_at", "is", null)
          .execute();
      await transaction
        .insertInto("admin_operation_audit_logs")
        .values({
          action: "admin.session.revoked",
          actor_admin_account_id: input.actorAdminId,
          after_json: adminAuthJson({ revoked: true }, this.engine),
          before_json: adminAuthJson(
            { kind: input.kind, owner_id: String(owner.owner_id), revoked: false },
            this.engine,
          ),
          reason: input.reason,
          request_id: input.requestId,
          target_id: `${input.kind}:${input.id}`,
          target_type: "session",
        })
        .execute();
    });
    return { id: input.id, kind: input.kind, revoked: true };
  }

  private databaseNow() {
    return this.engine === "mariadb" ? sql<Date>`UTC_TIMESTAMP(6)` : sql<Date>`clock_timestamp()`;
  }

  private secondsAgo(seconds: number) {
    return this.engine === "mariadb"
      ? sql<Date>`UTC_TIMESTAMP(6) - INTERVAL ${sql.lit(seconds)} SECOND`
      : sql<Date>`clock_timestamp() - ${sql.lit(seconds)} * INTERVAL '1 second'`;
  }
}
