import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import type { Kysely } from "kysely";
import { type Observable, mergeMap } from "rxjs";

import type { DB } from "@classhub/db";
import {
  type AuthenticatedAdminRequest,
  getAuthenticatedAdminSession,
} from "../admin-auth/admin-auth.request.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";

// 관리자 개인정보 조회 접속기록(2026-10-03 사용자 결정, 총검수 C2-01·I3-05·I2-01).
// 누가 · 언제 · 어디서(IP 원문) · 누구의 정보를(화면에 나온 행의 내부 번호만) · 어떤 화면에서.
// 검색어 원문은 남기지 않는다(검색했는지만). 표(원장 101·102)가 설치된 뒤에만 켜진다.
export type AdminAccessKind =
  | "people.list"
  | "users.list"
  | "members.list"
  | "classes.list"
  | "class_audit.list"
  | "operation_audit.list"
  | "auth_audit.list"
  | "terms_consents.list"
  | "inquiries.list"
  | "sessions.list"
  | "signup_approvals.list"
  | "admin_accounts.list"
  | "signup_account.lookup";
export type AdminAccessSubject =
  | "user"
  | "member"
  | "class"
  | "admin_account"
  | "inquiry"
  | "session"
  | "audit_log"
  | "signup_approval";
interface AdminAccessTarget {
  kind: AdminAccessKind;
  subject: AdminAccessSubject;
  ids: (body: unknown) => string[];
}
type AccessLogTables = {
  admin_access_logs: {
    admin_account_id: string;
    access_kind: string;
    searched: boolean;
    subject_type: string;
    subject_count: number;
    subject_ids: string;
    client_ip: string;
    request_id: string;
  };
};

const ADMIN_ACCESS_TARGET = "classhub:admin-access-target";
/** 이 조회 화면을 열 때마다 접속기록을 남긴다. 기록을 못 남기면 화면 자료도 내보내지 않는다. */
export const RecordAdminAccess = (
  kind: AdminAccessKind,
  subject: AdminAccessSubject,
  ids: (body: unknown) => string[] = accessedSubjectIds,
) => SetMetadata(ADMIN_ACCESS_TARGET, { kind, subject, ids } satisfies AdminAccessTarget);

/** 응답(배열, 또는 배열을 담은 객체)의 각 행 id. 목록 화면의 응답 모양이 이 두 가지뿐이다. */
export function accessedSubjectIds(body: unknown): string[] {
  const rows = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null
      ? Object.values(body).filter(Array.isArray).flat()
      : [];
  return rows.flatMap((row: unknown) =>
    typeof row === "object" && row !== null && "id" in row && row.id != null
      ? [String(row.id)]
      : [],
  );
}

@Injectable()
export class AdminAccessLogInterceptor implements NestInterceptor {
  private readonly installed: boolean;
  private readonly db: Kysely<AccessLogTables>;

  constructor(
    private readonly reflector: Reflector,
    @Inject(DATABASE) database: ClassHubDatabase,
    config: ConfigService<AppEnvironment, true>,
  ) {
    this.installed = config.get("ADMIN_ACCESS_LOGS_DATABASE_INSTALLED", { infer: true }) === true;
    this.db = (database as Kysely<DB>).withoutPlugins().withTables<AccessLogTables>() as never;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const target = this.reflector.get<AdminAccessTarget | undefined>(
      ADMIN_ACCESS_TARGET,
      context.getHandler(),
    );
    if (!this.installed || target === undefined) return next.handle();
    const request = context.switchToHttp().getRequest<AuthenticatedAdminRequest>();
    return next.handle().pipe(
      mergeMap(async (body) => {
        const ids = target.ids(body);
        const query = (request.query ?? {}) as Record<string, unknown>;
        // 실패하면 예외가 그대로 올라가 자료 대신 오류가 나간다(기록 없는 조회를 만들지 않는다).
        await this.db
          .insertInto("admin_access_logs")
          .values({
            admin_account_id: getAuthenticatedAdminSession(request).adminAccountId,
            access_kind: target.kind,
            // 이름·메일로 찾았는지(검색어 원문은 남기지 않는다).
            searched: [query.search, query.email].some(
              (value) => typeof value === "string" && value.trim() !== "",
            ),
            subject_type: target.subject,
            subject_count: ids.length,
            subject_ids: JSON.stringify(ids),
            client_ip: request.ip,
            request_id: request.id,
          })
          .execute();
        return body;
      }),
    );
  }
}
