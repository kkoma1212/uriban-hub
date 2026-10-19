import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type RawBuilder } from "kysely";

import { ERROR_CODES } from "../common/errors/error-codes.js";
import { normalizeSearchTerm } from "../common/validation/search-term.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { findPersonalInfo, type PersonalInfoHit } from "./personal-info.js";
import type {
  CheckTeacherLibraryItemDto,
  CreateTeacherLibraryItemDto,
  ListTeacherLibraryQueryDto,
  TeacherLibraryKind,
} from "./teacher-library.dto.js";

const PAGE_SIZE = 20;
const SUPPLY_BODY_MAX = 500;
const PAST_CLASS_VISIBLE_DAYS = 365;
const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;

export interface TeacherLibraryItem {
  body: string | null;
  category: string;
  created_at: string;
  id: string;
  is_important: boolean;
  kind: TeacherLibraryKind;
  source: { academic_year: number; class_name: string; grade: number; school_name: string };
  title: string;
}

interface ItemRow {
  body: string | null;
  category: string;
  created_at: string;
  id: string;
  is_important: boolean | number | string;
  kind: string;
  source_academic_year: number | string;
  source_class_name: string;
  source_grade: number | string;
  source_school_name: string;
  title: string;
}

interface SourceRow {
  academic_year: number | string;
  body: string | null;
  category: string;
  class_id: string;
  class_name: string;
  grade: number | string;
  is_important: boolean | number | string;
  school_name: string;
  title: string;
}

class TeacherLibraryNotFoundException extends NotFoundException {
  constructor() {
    super({ code: ERROR_CODES.NOT_FOUND, message: "자료나 원글을 찾을 수 없어요." });
  }
}

const isPositiveId = (value: string): boolean =>
  /^[1-9][0-9]*$/u.test(value) && BigInt(value) <= MAX_DATABASE_ID;
const truthy = (value: boolean | number | string): boolean =>
  value === true || value === 1 || value === "1";

function toItem(row: ItemRow): TeacherLibraryItem {
  return {
    body: row.body,
    category: row.category,
    created_at: row.created_at,
    id: String(row.id),
    is_important: truthy(row.is_important),
    kind: row.kind as TeacherLibraryKind,
    source: {
      academic_year: Number(row.source_academic_year),
      class_name: row.source_class_name,
      grade: Number(row.source_grade),
      school_name: row.source_school_name,
    },
    title: row.title,
  };
}

function encodeCursor(row: ItemRow): string {
  return Buffer.from(JSON.stringify({ i: String(row.id), t: row.created_at })).toString(
    "base64url",
  );
}

function decodeCursor(value: string): { id: string; time: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      i?: unknown;
      t?: unknown;
    };
    if (
      typeof parsed.i === "string" &&
      isPositiveId(parsed.i) &&
      typeof parsed.t === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(parsed.t)
    )
      return { id: parsed.i, time: parsed.t };
  } catch {
    /* 아래에서 거부한다. */
  }
  throw new BadRequestException({
    code: ERROR_CODES.INVALID_CURSOR,
    message: "자료함 목록 위치를 해석할 수 없어요. 처음부터 다시 조회해 주세요.",
  });
}

/**
 * S2 교사 자료함(P-024). 교사 계정이 소유하는 글 사본 — 반과 묶지 않아 반이 닫히거나 학교를
 * 옮겨도 남는다. 원글은 지금 담임인 반이거나 S1 규칙으로 볼 수 있는 지난 반(종료 1년 이내)의
 * 것만 담을 수 있다. 학생 기록은 옮기지 않고, 저장 전에 교사의 개인정보 확인을 받는다.
 */
@Injectable()
export class TeacherLibraryService {
  private readonly engine: "postgres" | "mariadb";

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    const engine = config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Unsupported database engine");
    this.engine = engine;
  }

  async check(
    userId: string,
    dto: CheckTeacherLibraryItemDto,
  ): Promise<{ hits: PersonalInfoHit[] }> {
    await this.assertActiveTeacher(userId);
    const source = await this.readSource(userId, dto.kind, dto.source_id);
    this.assertBodyLength(dto.kind, dto.body);
    const names = await this.readStudentNames(source.class_id);
    return { hits: findPersonalInfo(`${dto.title}\n${dto.body ?? ""}`, names) };
  }

  async create(userId: string, dto: CreateTeacherLibraryItemDto): Promise<TeacherLibraryItem> {
    await this.assertActiveTeacher(userId);
    const source = await this.readSource(userId, dto.kind, dto.source_id);
    this.assertBodyLength(dto.kind, dto.body);
    const now = this.engine === "mariadb" ? sql`UTC_TIMESTAMP(6)` : sql`clock_timestamp()`;
    try {
      await this.database
        .insertInto("teacher_library_items")
        .values({
          body: dto.body,
          category: source.category,
          is_important: dto.kind === "notice" && truthy(source.is_important),
          kind: dto.kind,
          owner_user_id: userId,
          personal_info_confirmed_at: now as unknown as Date,
          source_academic_year: Number(source.academic_year),
          source_class_name: source.class_name,
          source_grade: Number(source.grade),
          source_item_id: dto.source_id,
          source_school_name: source.school_name,
          title: dto.title,
        })
        .execute();
    } catch (error) {
      const code = (error as { code?: unknown; errno?: unknown }).code;
      if (code === "ER_DUP_ENTRY" || code === "23505")
        throw new ConflictException({
          code: ERROR_CODES.CONFLICT,
          message: "이미 자료함에 담긴 글이에요.",
        });
      throw error;
    }
    const [row] = await this.readItems(
      userId,
      sql`AND i.kind = ${dto.kind} AND i.source_item_id = ${this.id(dto.source_id)}`,
      1,
    );
    if (row === undefined) throw new TeacherLibraryNotFoundException();
    return toItem(row);
  }

  async list(
    userId: string,
    query: ListTeacherLibraryQueryDto,
  ): Promise<{ items: TeacherLibraryItem[]; next_cursor: string | null }> {
    await this.assertActiveTeacher(userId);
    const search = normalizeSearchTerm(query.q);
    const conditions: RawBuilder<unknown>[] = [];
    if (query.kind !== undefined) conditions.push(sql`AND i.kind = ${query.kind}`);
    if (query.year !== undefined) conditions.push(sql`AND i.source_academic_year = ${query.year}`);
    if (search !== undefined) {
      const pattern = `%${search.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
      conditions.push(
        this.engine === "mariadb"
          ? sql`AND (LOWER(i.title) LIKE LOWER(${pattern}) ESCAPE '!' OR LOWER(COALESCE(i.body, '')) LIKE LOWER(${pattern}) ESCAPE '!')`
          : sql`AND (i.title ILIKE ${pattern} ESCAPE '!' OR COALESCE(i.body, '') ILIKE ${pattern} ESCAPE '!')`,
      );
    }
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      const time =
        this.engine === "mariadb"
          ? sql`CAST(${cursor.time.replace("T", " ").slice(0, -1)} AS DATETIME(6))`
          : sql`${cursor.time}::timestamptz`;
      conditions.push(
        sql`AND (i.created_at < ${time} OR (i.created_at = ${time} AND i.id < ${this.id(cursor.id)}))`,
      );
    }
    const rows = await this.readItems(userId, sql.join(conditions, sql` `), PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map(toItem),
      next_cursor: rows.length > PAGE_SIZE && last !== undefined ? encodeCursor(last) : null,
    };
  }

  async get(userId: string, id: string): Promise<TeacherLibraryItem> {
    await this.assertActiveTeacher(userId);
    if (!isPositiveId(id)) throw new TeacherLibraryNotFoundException();
    const [row] = await this.readItems(userId, sql`AND i.id = ${this.id(id)}`, 1);
    if (row === undefined) throw new TeacherLibraryNotFoundException();
    return toItem(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.assertActiveTeacher(userId);
    if (!isPositiveId(id)) throw new TeacherLibraryNotFoundException();
    const result = await this.database
      .deleteFrom("teacher_library_items")
      .where("id", "=", id)
      .where("owner_user_id", "=", userId)
      .executeTakeFirst();
    if (Number(result.numDeletedRows) !== 1) throw new TeacherLibraryNotFoundException();
  }

  private id(value: string): RawBuilder<unknown> {
    return this.engine === "mariadb" ? sql`CAST(${value} AS SIGNED)` : sql`${value}::bigint`;
  }

  private assertBodyLength(kind: TeacherLibraryKind, body: string | null): void {
    if (kind === "supply" && body !== null && [...body].length > SUPPLY_BODY_MAX)
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `준비물·숙제 설명은 ${SUPPLY_BODY_MAX}자까지 담을 수 있어요.`,
      });
  }

  private async assertActiveTeacher(userId: string): Promise<void> {
    const profile = await this.database
      .selectFrom("teacher_profiles")
      .select(["status", "temporary_password_must_change"])
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (
      profile === undefined ||
      profile.status !== "active" ||
      truthy(profile.temporary_password_must_change as boolean | number | string)
    )
      throw new ForbiddenException({
        code: ERROR_CODES.ROLE_INSUFFICIENT,
        message: "선생님 계정만 자료함을 쓸 수 있어요.",
      });
  }

  private async readItems(
    userId: string,
    where: RawBuilder<unknown>,
    limit: number,
  ): Promise<ItemRow[]> {
    const createdAt =
      this.engine === "mariadb"
        ? sql`DATE_FORMAT(i.created_at, '%Y-%m-%dT%H:%i:%s.%fZ')`
        : sql`to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const idText = this.engine === "mariadb" ? sql`CAST(i.id AS CHAR)` : sql`i.id::text`;
    const result = await sql<ItemRow>`
      SELECT ${idText} AS id, i.kind, i.category, i.title, i.body, i.is_important,
        i.source_academic_year, i.source_grade, i.source_school_name, i.source_class_name,
        ${createdAt} AS created_at
      FROM teacher_library_items AS i
      WHERE i.owner_user_id = ${this.id(userId)} ${where}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT ${limit}
    `.execute(this.database);
    return result.rows;
  }

  /** 지금 담임인 반, 또는 S1 규칙의 지난 반(교사가 종료·종료 1년 이내)의 원글만 연다. */
  private async readSource(
    userId: string,
    kind: TeacherLibraryKind,
    sourceId: string,
  ): Promise<SourceRow> {
    if (!isPositiveId(sourceId)) throw new TeacherLibraryNotFoundException();
    const maria = this.engine === "mariadb";
    const now = maria ? sql`UTC_TIMESTAMP(6)` : sql`now()`;
    const visibleSince = maria
      ? sql`UTC_TIMESTAMP(6) - INTERVAL ${PAST_CLASS_VISIBLE_DAYS} DAY`
      : sql`now() - make_interval(days => ${PAST_CLASS_VISIBLE_DAYS})`;
    const classIdText = maria ? sql`CAST(c.id AS CHAR)` : sql`c.id::text`;
    const content =
      kind === "notice"
        ? sql`SELECT n.id, n.class_id, n.title, n.content AS body, n.category, n.is_important
            FROM notices AS n WHERE n.deleted_at IS NULL AND n.published_at <= ${now}`
        : sql`SELECT s.id, s.class_id, s.title, s.description AS body, s.category, FALSE AS is_important
            FROM supplies AS s WHERE s.deleted_at IS NULL`;
    const result = await sql<SourceRow>`
      SELECT ${classIdText} AS class_id, src.title, src.body, src.category, src.is_important,
        c.academic_year, c.grade, c.name AS class_name, sc.school_name
      FROM (${content}) AS src
      JOIN classes AS c ON c.id = src.class_id
      JOIN schools AS sc ON sc.edu_office_code = c.edu_office_code AND sc.school_code = c.school_code
      JOIN class_members AS m ON m.class_id = c.id AND m.user_id = ${this.id(userId)}
        AND m.role = 'teacher'
      WHERE src.id = ${this.id(sourceId)}
        AND ((m.status = 'approved' AND c.status = 'active')
          OR (m.status = 'archived' AND c.status = 'archived'
            AND c.archived_by_user_id IS NOT NULL AND c.archived_at > ${visibleSince}))
      LIMIT 1
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) throw new TeacherLibraryNotFoundException();
    return row;
  }

  private async readStudentNames(classId: string): Promise<string[]> {
    const result = await sql<{ name: string | null }>`
      SELECT m.display_name_in_class AS name FROM class_members AS m
        WHERE m.class_id = ${this.id(classId)} AND m.role = 'student'
      UNION
      SELECT u.display_name AS name FROM class_members AS m
        JOIN users AS u ON u.id = m.user_id
        WHERE m.class_id = ${this.id(classId)} AND m.role = 'student'
    `.execute(this.database);
    return result.rows.map((row) => row.name).filter((name): name is string => name !== null);
  }
}
