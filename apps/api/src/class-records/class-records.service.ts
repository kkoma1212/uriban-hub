import { ForbiddenException, Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type RawBuilder } from "kysely";

import { mariaDbBoolean } from "../common/database/mariadb-values.js";
import { stripRichText } from "../common/text/rich-text.js";
import { ERROR_CODES } from "../common/errors/error-codes.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  NoticesAccessService,
  type NoticeAccessContext,
} from "../notices/notices-access.service.js";
import { PastClassesService } from "../updates/past-classes.service.js";
import {
  classRecordsCsv,
  type ClassRecords,
  type NoticeRecord,
  type PollRecord,
  type ScheduleRecord,
  type SupplyRecord,
} from "./class-records.csv.js";

export class ClassRecordsRoleInsufficientException extends ForbiddenException {
  constructor() {
    super({
      code: ERROR_CODES.ROLE_INSUFFICIENT,
      message: "반 기록은 이 반의 선생님만 내려받을 수 있어요.",
    });
  }
}

type Row = Record<string, unknown>;

const text = (value: unknown): string => String(value);
const optionalText = (value: unknown): string | null => (value === null ? null : String(value));
// PostgreSQL은 true/false, MariaDB는 1/0(비교식 결과 포함 — 격리 MariaDB 시험으로 확인)을 준다.
const flag = mariaDbBoolean;

/**
 * 담임이 반 기록(선생님이 쓴 공지·준비물·숙제·일정·투표)을 CSV로 받는다.
 * 지금 반은 공지 목록과 같은 현재 반 조건, 끝난 반은 '지난 반' 조건(종료 후 365일)을 그대로 쓴다.
 * 지운 글은 넣지 않고, 학생이 쓴 글이 생기더라도 들어가지 않게 작성자가 교사인 글만 고른다.
 */
@Injectable()
export class ClassRecordsService {
  private readonly engine: "postgres" | "mariadb";
  private readonly pollsEnabled: boolean;

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly notices: NoticesAccessService,
    private readonly pastClasses: PastClassesService,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    const engine = config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Unsupported database engine");
    this.engine = engine;
    // 투표 기능이 꺼진 서버에서는 화면에 없는 투표를 파일에도 넣지 않는다.
    this.pollsEnabled = config?.get("POLLS_ENABLED", { infer: true }) === true;
  }

  async currentClassCsv(actorUserId: string): Promise<string> {
    const context = await this.notices.getCollectionContext(actorUserId);
    return this.csvForTeacher(context);
  }

  async pastClassCsv(actorUserId: string, classId: string): Promise<string> {
    const context = await this.pastClasses.getContext(actorUserId, classId);
    return this.csvForTeacher(context);
  }

  private async csvForTeacher(context: NoticeAccessContext): Promise<string> {
    if (context.role !== "teacher") throw new ClassRecordsRoleInsufficientException();
    return classRecordsCsv(await this.readRecords(context.classId));
  }

  private async readRecords(classId: string): Promise<ClassRecords> {
    const [notices, supplies, schedules, polls] = await Promise.all([
      this.readNotices(classId),
      this.readSupplies(classId),
      this.readSchedules(classId),
      this.pollsEnabled ? this.readPolls(classId) : Promise.resolve([]),
    ]);
    return { notices, supplies, schedules, polls };
  }

  private async readNotices(classId: string): Promise<NoticeRecord[]> {
    const { rows } = await sql<Row>`
      SELECT n.category, n.title, n.content, n.audience_mode, n.is_important,
        n.published_at > ${this.now()} AS scheduled,
        ${this.kstMinute(sql.ref("n.published_at"))} AS published_at,
        ${this.editedAt("n")} AS edited_at
      FROM notices AS n
      JOIN class_members AS m ON m.id = n.created_by_member_id
      WHERE n.class_id = ${this.id(classId)} AND n.deleted_at IS NULL AND m.role = 'teacher'
      ORDER BY n.published_at, n.id
    `.execute(this.database);
    return rows.map((row) => ({
      category: text(row.category),
      title: text(row.title),
      // CSV는 서식을 그리지 않으므로 공지·준비물·숙제의 굵게·형광펜 기호를 뺀 글자만 넣는다.
      content: stripRichText(text(row.content)),
      audienceMode: text(row.audience_mode),
      important: flag(row.is_important),
      scheduled: flag(row.scheduled),
      publishedAt: text(row.published_at),
      editedAt: optionalText(row.edited_at),
    }));
  }

  private async readSupplies(classId: string): Promise<SupplyRecord[]> {
    const { rows } = await sql<Row>`
      SELECT s.category, s.title, s.description, s.audience_mode,
        ${this.day(sql.ref("s.needed_on"))} AS needed_on,
        ${this.kstMinute(sql.ref("s.created_at"))} AS created_at,
        ${this.editedAt("s")} AS edited_at
      FROM supplies AS s
      JOIN class_members AS m ON m.id = s.created_by_member_id
      WHERE s.class_id = ${this.id(classId)} AND s.deleted_at IS NULL AND m.role = 'teacher'
      ORDER BY s.needed_on, s.id
    `.execute(this.database);
    return rows.map((row) => ({
      category: text(row.category),
      title: text(row.title),
      // 준비물·숙제 설명도 굵게·형광펜 기호를 뺀 글자만 넣는다(2026-10-23).
      description: row.description === null ? null : stripRichText(text(row.description)),
      neededOn: text(row.needed_on),
      audienceMode: text(row.audience_mode),
      createdAt: text(row.created_at),
      editedAt: optionalText(row.edited_at),
    }));
  }

  private async readSchedules(classId: string): Promise<ScheduleRecord[]> {
    const { rows } = await sql<Row>`
      SELECT s.schedule_type, s.title, s.subject, s.description,
        ${this.day(sql.ref("s.due_date"))} AS due_date,
        ${this.kstMinute(sql.ref("s.created_at"))} AS created_at,
        ${this.editedAt("s")} AS edited_at
      FROM schedules AS s
      JOIN class_members AS m ON m.id = s.created_by_member_id
      WHERE s.class_id = ${this.id(classId)} AND s.deleted_at IS NULL AND m.role = 'teacher'
      ORDER BY s.due_date, s.id
    `.execute(this.database);
    return rows.map((row) => ({
      scheduleType: text(row.schedule_type),
      title: text(row.title),
      subject: optionalText(row.subject),
      description: optionalText(row.description),
      dueDate: text(row.due_date),
      createdAt: text(row.created_at),
      editedAt: optionalText(row.edited_at),
    }));
  }

  /** 투표는 선택지별 표 수와 참여 인원만 — 누가 무엇을 골랐는지는 넣지 않는다. */
  private async readPolls(classId: string): Promise<PollRecord[]> {
    const [polls, options] = await Promise.all([
      sql<Row>`
        SELECT p.id, p.title, p.description,
          ${this.kstMinute(sql`COALESCE(p.closed_at, p.closes_at)`)} AS closes_at,
          (p.closed_at IS NOT NULL AND p.closed_at < p.closes_at) AS closed_early,
          ${this.kstMinute(sql.ref("p.created_at"))} AS created_at,
          (SELECT COUNT(DISTINCT v.member_id) FROM poll_votes AS v WHERE v.poll_id = p.id)
            AS voters
        FROM polls AS p
        JOIN class_members AS m ON m.id = p.created_by_member_id
        WHERE p.class_id = ${this.id(classId)} AND m.role = 'teacher'
        ORDER BY p.created_at, p.id
      `.execute(this.database),
      sql<Row>`
        SELECT o.poll_id, o.label, COUNT(v.id) AS votes
        FROM poll_options AS o
        JOIN polls AS p ON p.id = o.poll_id
        LEFT JOIN poll_votes AS v ON v.option_id = o.id
        WHERE p.class_id = ${this.id(classId)}
        GROUP BY o.poll_id, o.id, o.position, o.label
        ORDER BY o.poll_id, o.position
      `.execute(this.database),
    ]);
    const optionsByPoll = new Map<string, { label: string; votes: number }[]>();
    for (const row of options.rows) {
      const pollId = text(row.poll_id);
      const list = optionsByPoll.get(pollId) ?? [];
      list.push({ label: text(row.label), votes: Number(row.votes) });
      optionsByPoll.set(pollId, list);
    }
    return polls.rows.map((row) => ({
      title: text(row.title),
      description: optionalText(row.description),
      closesAt: text(row.closes_at),
      closedEarly: flag(row.closed_early),
      createdAt: text(row.created_at),
      voters: Number(row.voters),
      options: optionsByPoll.get(text(row.id)) ?? [],
    }));
  }

  private id(value: string): RawBuilder<unknown> {
    return this.engine === "mariadb" ? sql`CAST(${value} AS SIGNED)` : sql`${value}::bigint`;
  }

  private now(): RawBuilder<unknown> {
    return this.engine === "mariadb" ? sql`UTC_TIMESTAMP(6)` : sql`now()`;
  }

  /** MariaDB는 UTC DATETIME으로 저장한다 — 한국은 일광 절약 시간이 없어 9시간을 더한다. */
  private kstMinute(value: RawBuilder<unknown>): RawBuilder<string> {
    return this.engine === "mariadb"
      ? sql<string>`DATE_FORMAT(${value} + INTERVAL 9 HOUR, '%Y-%m-%d %H:%i')`
      : sql<string>`to_char(${value} AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI')`;
  }

  private day(value: RawBuilder<unknown>): RawBuilder<string> {
    return this.engine === "mariadb"
      ? sql<string>`DATE_FORMAT(${value}, '%Y-%m-%d')`
      : sql<string>`to_char(${value}, 'YYYY-MM-DD')`;
  }

  /** 처음 올릴 때는 updated_by_member_id가 비어 있다 — 고친 적이 있을 때만 수정 시각을 적는다. */
  private editedAt(table: "n" | "s"): RawBuilder<string | null> {
    return sql<string | null>`CASE WHEN ${sql.ref(`${table}.updated_by_member_id`)} IS NULL
      THEN NULL ELSE ${this.kstMinute(sql.ref(`${table}.updated_at`))} END`;
  }
}
