import { Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import { ERROR_CODES } from "../common/errors/error-codes.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { NoticeAccessContext } from "../notices/notices-access.service.js";
import { UpdatesService } from "./updates.service.js";
import type { ListUpdatesQuery, ListUpdatesResult } from "./updates.types.js";

/** 처리방침 4장: 학급 콘텐츠는 학급 아카이브 시점부터 365일 뒤 삭제한다. 그 뒤로는 보여 주지 않는다. */
const PAST_CLASS_VISIBLE_DAYS = 365;
const MAX_PAST_CLASSES = 50;
const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;

export interface PastClassSummary {
  academic_year: number;
  archived_at: string;
  class_id: string;
  class_name: string;
  grade: number;
  role: "student" | "teacher";
  school_name: string;
  visible_until: string;
}

interface PastClassRow {
  academic_year: number | string;
  archived_at: string;
  class_id: string;
  class_name: string;
  grade: number | string;
  member_id: string;
  role: string;
  school_name: string;
  visible_until: string;
}

export class PastClassNotFoundException extends NotFoundException {
  constructor() {
    super({ code: ERROR_CODES.NOT_FOUND, message: "지난 반을 찾을 수 없습니다." });
  }
}

function isPositiveId(value: string): boolean {
  if (!/^[1-9][0-9]*$/u.test(value)) return false;
  return BigInt(value) <= MAX_DATABASE_ID;
}

/**
 * 내가 속했던 지난 반을 읽기 전용으로 보여 준다(2026-09-26 S1).
 * 볼 수 있는 조건: 선생님이 반 운영을 종료했고(운영자 강제 종료 제외), 종료 시점에 내가 승인된
 * 구성원이었으며(대기·중도 퇴장·이관 제외), 종료 후 365일 이내다. 선생님은 지금도 활성 교사
 * 계정이어야 한다. 쓰기 경로는 없다.
 */
@Injectable()
export class PastClassesService {
  private readonly engine: "postgres" | "mariadb";

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly updates: UpdatesService,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    const engine = config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Unsupported database engine");
    this.engine = engine;
  }

  async listMine(actorUserId: string): Promise<PastClassSummary[]> {
    const rows = await this.readPastClasses(actorUserId, undefined);
    return rows.map((row) => ({
      academic_year: Number(row.academic_year),
      archived_at: row.archived_at,
      class_id: row.class_id,
      class_name: row.class_name,
      grade: Number(row.grade),
      role: row.role as PastClassSummary["role"],
      school_name: row.school_name,
      visible_until: row.visible_until,
    }));
  }

  async listUpdates(
    actorUserId: string,
    classId: string,
    query: Omit<ListUpdatesQuery, "actorUserId">,
  ): Promise<ListUpdatesResult> {
    const context = await this.getContext(actorUserId, classId);
    return this.updates.listForContext(context, query, { recentSuppliesOnly: false });
  }

  /** 위의 '볼 수 있는 조건'을 통과한 지난 반의 내 구성원 정보. 반 기록 내려받기도 같은 조건을 쓴다. */
  async getContext(actorUserId: string, classId: string): Promise<NoticeAccessContext> {
    if (!isPositiveId(classId)) throw new PastClassNotFoundException();
    const [row] = await this.readPastClasses(actorUserId, classId);
    if (row === undefined) throw new PastClassNotFoundException();
    return {
      classId: row.class_id,
      memberId: row.member_id,
      role: row.role as NoticeAccessContext["role"],
    };
  }

  private async readPastClasses(
    actorUserId: string,
    classId: string | undefined,
  ): Promise<PastClassRow[]> {
    if (this.engine === "mariadb") {
      const onlyClass = classId === undefined ? sql`` : sql`AND c.id = CAST(${classId} AS SIGNED)`;
      const result = await sql<PastClassRow>`
        SELECT CAST(c.id AS CHAR) AS class_id, c.name AS class_name, s.school_name,
          c.academic_year, c.grade, m.role, CAST(m.id AS CHAR) AS member_id,
          DATE_FORMAT(c.archived_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS archived_at,
          DATE_FORMAT(c.archived_at + INTERVAL ${PAST_CLASS_VISIBLE_DAYS} DAY,
            '%Y-%m-%dT%H:%i:%s.%fZ') AS visible_until
        FROM class_members AS m
        JOIN classes AS c ON c.id = m.class_id
        JOIN schools AS s ON s.edu_office_code = c.edu_office_code AND s.school_code = c.school_code
        LEFT JOIN teacher_profiles AS p ON p.user_id = m.user_id
        WHERE m.user_id = CAST(${actorUserId} AS SIGNED)
          AND m.status = 'archived' AND c.status = 'archived'
          AND c.archived_by_user_id IS NOT NULL
          AND c.archived_at > UTC_TIMESTAMP(6) - INTERVAL ${PAST_CLASS_VISIBLE_DAYS} DAY
          AND (m.role = 'student'
            OR (m.role = 'teacher' AND p.status = 'active'
              AND p.temporary_password_must_change = FALSE))
          ${onlyClass}
        ORDER BY c.academic_year DESC, c.archived_at DESC, c.id DESC
        LIMIT ${MAX_PAST_CLASSES}
      `.execute(this.database);
      return result.rows;
    }
    const onlyClass = classId === undefined ? sql`` : sql`AND c.id = ${classId}::bigint`;
    const result = await sql<PastClassRow>`
      SELECT c.id::text AS class_id, c.name AS class_name, s.school_name,
        c.academic_year, c.grade, m.role, m.id::text AS member_id,
        to_char(c.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS archived_at,
        to_char(
          (c.archived_at + make_interval(days => ${PAST_CLASS_VISIBLE_DAYS})) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS visible_until
      FROM class_members AS m
      JOIN classes AS c ON c.id = m.class_id
      JOIN schools AS s ON s.edu_office_code = c.edu_office_code AND s.school_code = c.school_code
      LEFT JOIN teacher_profiles AS p ON p.user_id = m.user_id
      WHERE m.user_id = ${actorUserId}::bigint
        AND m.status = 'archived' AND c.status = 'archived'
        AND c.archived_by_user_id IS NOT NULL
        AND c.archived_at > now() - make_interval(days => ${PAST_CLASS_VISIBLE_DAYS})
        AND (m.role = 'student'
          OR (m.role = 'teacher' AND p.status = 'active'
            AND p.temporary_password_must_change = FALSE))
        ${onlyClass}
      ORDER BY c.academic_year DESC, c.archived_at DESC, c.id DESC
      LIMIT ${MAX_PAST_CLASSES}
    `.execute(this.database);
    return result.rows;
  }
}
