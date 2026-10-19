import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import { UnauthenticatedException } from "../auth/auth.errors.js";
import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbId,
  mariaDbNullable,
  mariaDbTimestamp,
} from "../common/database/mariadb-values.js";
import { countCodePoints, isAllowedPlainText } from "../common/validation/text-validation.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AppEnvironment } from "../config/environment.js";
import {
  decodeAuditLogCursor,
  encodeAuditLogCursor,
  isCanonicalAuditTimestamp,
} from "./audit-logs.cursor.js";
import {
  AuditLogDataInvalidException,
  AuditLogsClassSuspendedException,
  AuditLogsNotFoundException,
  AuditLogsRoleInsufficientException,
} from "./audit-logs.errors.js";
import { CLASS_AUDIT_ACTION_SET } from "./audit-logs.types.js";
import type {
  AuditLogItem,
  AuditLogListQuery,
  AuditLogListResult,
  AuditSafeSnapshot,
  AuditSafeValue,
  ClassAuditAction,
} from "./audit-logs.types.js";

const PAGE_SIZE = 20;
const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;
const REMINDER_SAFE_KEYS = new Set([
  "reminder_batch_id",
  "content_revision",
  "current_unresolved_count",
  "created_count",
  "cooldown_suppressed_count",
]);

const SAFE_KEYS = {
  attendance: new Set([
    "attendance_notification_id",
    "notification_type",
    "notification_date",
    "status",
  ]),
  class: new Set([
    "class_id",
    "name",
    "academic_year",
    "grade",
    "expected_student_count",
    "status",
    "suspended_reason",
    "archived_at",
  ]),
  /* 역할 이름("칠판 지우기")과 순번뿐이다 — 누가 맡았는지는 안 담는다. */
  dutyRole: new Set(["duty_role_id", "name", "required_count", "sort_index", "archived_at"]),
  /* 사람 수만 담고 이름·학생번호는 담지 않는다. */
  dutyRoster: new Set([
    "duty_roster_id",
    "title",
    "role_count",
    "assigned_student_count",
    "unassigned_student_count",
    "status",
    "published_at",
    "superseded_at",
    "deleted_at",
  ]),
  invite: new Set(["invite_code_id", "class_id", "expires_at", "revoked_at", "revoke_reason"]),
  member: new Set(["member_id", "role", "status", "display_name_snapshot", "reason"]),
  notice: new Set([
    "notice_id",
    "title",
    "is_important",
    "content_revision",
    "published_at",
    "deleted_at",
  ]),
  poll: new Set(["poll_id", "title", "closes_at", "option_count", "vote_count", "deleted_at"]),
  schedule: new Set(["schedule_id", "title", "subject", "schedule_type", "due_date", "deleted_at"]),
  seatDraw: new Set([
    "seat_draw_id",
    "title",
    "row_count",
    "column_count",
    "usable_seat_count",
    "assigned_student_count",
    "excluded_student_count",
    "status",
    "published_at",
    "superseded_at",
    "deleted_at",
  ]),
  teamDraw: new Set([
    "team_draw_id",
    "title",
    "group_count",
    "assigned_student_count",
    "excluded_student_count",
    "status",
    "published_at",
    "superseded_at",
    "deleted_at",
  ]),
  supply: new Set(["supply_id", "title", "needed_on", "content_revision", "deleted_at"]),
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeValue(value: unknown): value is AuditSafeValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function allowedKeys(action: string): ReadonlySet<string> | undefined {
  if (!CLASS_AUDIT_ACTION_SET.has(action)) return undefined;
  if (action.startsWith("attendance_notification.")) return SAFE_KEYS.attendance;
  if (action === "class.teacher_transferred" || action.startsWith("member.")) {
    return SAFE_KEYS.member;
  }
  if (action.startsWith("class.")) return SAFE_KEYS.class;
  if (action.startsWith("duty_role.")) return SAFE_KEYS.dutyRole;
  if (action.startsWith("duty_roster.")) return SAFE_KEYS.dutyRoster;
  /*
   * 선거는 일부러 비워 둔다 — 감사에 어떤 JSON 도 싣지 않는 설계다(T-HUB-18:
   * "개별 투표는 어떤 형태로도 남기지 않는다"). 담는 것이 없으니 허용할 것도 없다.
   * 나중에 선거가 무언가를 담게 되면 **그때** 여기 한 줄을 더한다.
   */
  if (action.startsWith("invite_code.")) return SAFE_KEYS.invite;
  if (action === "notice.reminder_created" || action === "supply.reminder_created") {
    return REMINDER_SAFE_KEYS;
  }
  if (action.startsWith("notice.")) return SAFE_KEYS.notice;
  if (action.startsWith("poll.")) return SAFE_KEYS.poll;
  if (action.startsWith("seat_draw.")) return SAFE_KEYS.seatDraw;
  if (action.startsWith("team_draw.")) return SAFE_KEYS.teamDraw;
  if (action.startsWith("supply.")) return SAFE_KEYS.supply;
  if (action.startsWith("schedule.")) return SAFE_KEYS.schedule;
  return undefined;
}

/*
 * ⚠️ 여기에 없는 종류는 봉투 검사에서 **던진다** — 목록 한 줄이 아니라 감사 로그 화면
 * 전체가 500 이 된다. 2026-08-22 감사(BLUE-03)에서 실제로 그랬다: 선거·당번은
 * 종류 목록(`audit-logs.types.ts`)에는 12건이 들어갔는데 여기가 안 따라가서,
 * 교사가 새 기능을 **한 번만 써도** 감사 화면이 안 열렸다.
 * 새 감사 종류를 더할 때는 반드시 이 함수와 `allowedKeys` 를 함께 본다.
 */
export function expectedTargetType(action: string): string | undefined {
  if (!CLASS_AUDIT_ACTION_SET.has(action)) return undefined;
  if (action.startsWith("attendance_notification.")) return "attendance_notification";
  if (action === "class.teacher_transferred" || action.startsWith("member.")) return "member";
  if (action.startsWith("class.")) return "class";
  if (action.startsWith("duty_role.")) return "duty_role";
  if (action.startsWith("duty_roster.")) return "duty_roster";
  if (action.startsWith("election.")) return "election";
  if (action.startsWith("invite_code.")) return "invite_code";
  if (action.startsWith("notice.")) return "notice";
  if (action.startsWith("poll.")) return "poll";
  if (action.startsWith("seat_draw.")) return "seat_draw";
  if (action.startsWith("team_draw.")) return "team_draw";
  if (action.startsWith("supply.")) return "supply";
  if (action.startsWith("schedule.")) return "schedule";
  return undefined;
}

function isPositiveDatabaseId(value: string): boolean {
  if (!/^[1-9][0-9]*$/u.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_DATABASE_ID;
  } catch {
    return false;
  }
}

export function assertSafeAuditEnvelope(value: {
  action: string;
  actorDisplayName: string;
  actorRole: string;
  createdAt: string;
  reason: string | null;
  targetId: string;
  targetType: string;
}): asserts value is typeof value & {
  action: ClassAuditAction;
  actorRole: "operator" | "student" | "teacher";
  createdAt: string;
} {
  const targetType = expectedTargetType(value.action);
  const validActorRole = ["operator", "student", "teacher"].includes(value.actorRole);
  const actorNameLength = countCodePoints(value.actorDisplayName);
  const validActorName =
    actorNameLength >= 2 && actorNameLength <= 20 && isAllowedPlainText(value.actorDisplayName);
  const validReason =
    value.reason === null ||
    (countCodePoints(value.reason) <= 300 && isAllowedPlainText(value.reason));
  if (
    !CLASS_AUDIT_ACTION_SET.has(value.action) ||
    targetType === undefined ||
    !isCanonicalAuditTimestamp(value.createdAt) ||
    value.targetType !== targetType ||
    !isPositiveDatabaseId(value.targetId) ||
    !validActorRole ||
    !validActorName ||
    !validReason
  ) {
    throw new AuditLogDataInvalidException();
  }
}

export function sanitizeAuditSnapshot(action: string, value: unknown): AuditSafeSnapshot | null {
  if (!isRecord(value)) return null;
  const allowlist = allowedKeys(action);
  if (allowlist === undefined) return null;

  const sanitized: AuditSafeSnapshot = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (allowlist.has(key) && safeValue(candidate)) sanitized[key] = candidate;
  }
  return Object.keys(sanitized).length === 0 ? null : sanitized;
}

@Injectable()
export class AuditLogsService {
  private readonly dialect: "postgres" | "mariadb";
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    const dialect = config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (dialect !== "postgres" && dialect !== "mariadb")
      throw new Error("Unsupported audit-log database engine.");
    this.dialect = dialect;
    if (dialect === "mariadb")
      this.database = database.withPlugin(
        createMariaDbRowCodec({
          id: mariaDbId,
          class_id: mariaDbId,
          is_active: mariaDbBoolean,
          temporary_password_must_change: mariaDbNullable(mariaDbBoolean),
          deleted_at: mariaDbNullable(mariaDbTimestamp),
        }),
      );
  }

  async list(query: AuditLogListQuery): Promise<AuditLogListResult> {
    const context = await this.getTeacherContext(query.actorUserId);
    const cursorBinding = {
      action: query.action,
      classId: context.classId,
      days: query.days,
    };
    const cursor =
      query.cursor === undefined ? undefined : decodeAuditLogCursor(query.cursor, cursorBinding);

    let builder = this.database
      .selectFrom("audit_logs as audit")
      .select([
        "audit.action",
        "audit.actor_display_name_snapshot",
        "audit.actor_role_snapshot",
        "audit.after_json",
        "audit.before_json",
        "audit.id",
        "audit.reason",
        "audit.target_id",
        "audit.target_snapshot",
        "audit.target_type",
        (this.dialect === "mariadb"
          ? sql<string>`DATE_FORMAT(audit.created_at, '%Y-%m-%dT%H:%i:%s.%fZ')`
          : sql<string>`to_char(
          audit.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )`
        ).as("created_at_precise"),
      ])
      .where("audit.class_id", "=", context.classId)
      .where(
        this.dialect === "mariadb"
          ? sql<boolean>`audit.created_at >= UTC_TIMESTAMP(6) - INTERVAL ${query.days} DAY`
          : sql<boolean>`
        audit.created_at >= CURRENT_TIMESTAMP - (${query.days}::integer * INTERVAL '1 day')
      `,
      );

    if (query.action !== null) builder = builder.where("audit.action", "=", query.action);

    if (cursor !== undefined) {
      const cursorTime =
        this.dialect === "mariadb"
          ? sql`${mariaDbTimestamp(cursor.createdAt.replace("T", " ").slice(0, -1))}`
          : sql`${cursor.createdAt}::timestamptz`;
      const cursorId =
        this.dialect === "mariadb"
          ? sql`CAST(${mariaDbId(cursor.id)} AS SIGNED)`
          : sql`${cursor.id}::bigint`;
      builder = builder.where(sql<boolean>`(
        audit.created_at < ${cursorTime}
        OR (
          audit.created_at = ${cursorTime}
          AND audit.id < ${cursorId}
        )
      )`);
    }

    const rows = await builder
      .orderBy("audit.created_at", "desc")
      .orderBy("audit.id", "desc")
      .limit(PAGE_SIZE + 1)
      .execute();
    const pageRows = rows.slice(0, PAGE_SIZE);
    const items = pageRows.map((row): AuditLogItem => {
      const envelope = {
        action: row.action,
        actorDisplayName: row.actor_display_name_snapshot,
        actorRole: row.actor_role_snapshot,
        createdAt: row.created_at_precise,
        reason: row.reason,
        targetId: row.target_id,
        targetType: row.target_type,
      };
      assertSafeAuditEnvelope(envelope);
      return {
        action: envelope.action,
        actor: {
          display_name: envelope.actorDisplayName,
          role: envelope.actorRole,
        },
        after: this.snapshot(envelope.action, row.after_json),
        before: this.snapshot(envelope.action, row.before_json),
        created_at: envelope.createdAt,
        reason: row.reason,
        target: {
          id: envelope.targetId,
          snapshot: this.snapshot(envelope.action, row.target_snapshot),
          type: envelope.targetType,
        },
      };
    });
    const last = pageRows.at(-1);
    const nextCursor =
      rows.length > PAGE_SIZE && last !== undefined
        ? encodeAuditLogCursor({
            action: query.action,
            classId: context.classId,
            createdAt: last.created_at_precise,
            days: query.days,
            id: last.id,
          })
        : null;
    return { items, next_cursor: nextCursor };
  }

  private snapshot(action: string, value: unknown): AuditSafeSnapshot | null {
    if (this.dialect === "mariadb" && value !== null) {
      if (typeof value !== "string") throw new AuditLogDataInvalidException();
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        throw new AuditLogDataInvalidException();
      }
    }
    return sanitizeAuditSnapshot(action, value);
  }

  private async getTeacherContext(actorUserId: string): Promise<{ classId: string }> {
    const current = await this.database
      .selectFrom("class_members as member")
      .innerJoin("classes as class", "class.id", "member.class_id")
      .leftJoin("teacher_profiles as profile", "profile.user_id", "member.user_id")
      .innerJoin("users as account", "account.id", "member.user_id")
      .select([
        "account.deleted_at",
        "account.is_active",
        "class.id as class_id",
        "class.status as class_status",
        "member.role",
        "profile.status as profile_status",
        "profile.temporary_password_must_change",
      ])
      .where("member.user_id", "=", actorUserId)
      .where("member.status", "=", "approved")
      .executeTakeFirst();

    if (current !== undefined && (!current.is_active || current.deleted_at !== null)) {
      throw new UnauthenticatedException();
    }
    if (current === undefined || current.class_status === "archived") {
      throw new AuditLogsNotFoundException();
    }
    if (
      current.role !== "teacher" ||
      current.profile_status !== "active" ||
      current.temporary_password_must_change !== false
    ) {
      throw new AuditLogsRoleInsufficientException();
    }
    if (current.class_status === "suspended") throw new AuditLogsClassSuspendedException();
    if (current.class_status !== "active") throw new AuditLogsNotFoundException();

    return { classId: current.class_id };
  }
}
