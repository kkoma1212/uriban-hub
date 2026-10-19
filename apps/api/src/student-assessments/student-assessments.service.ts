import {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  IdempotencyService,
  MariaDbIdempotencyService,
  type JsonObject,
} from "@classhub/db";
import {
  ConflictException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type Insertable, type Transaction } from "kysely";

import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import { mariaDbDateBinding, mariaDbInsertId } from "../common/database/mariadb-values.js";
import type { AppEnvironment } from "../config/environment.js";
import { databaseDate } from "../common/date/kst-date.js";
import { parseRequiredIfMatch, ResourceVersionChangedException } from "../common/http/if-match.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { StudentAssessmentsAccessService } from "./student-assessments-access.service.js";
import { StudentAssessmentBinding } from "./student-assessments-binding.js";
import { studentAssessmentsCsv } from "./student-assessments.csv.js";
import {
  assessmentDatabaseEngine,
  assessmentMariaDbRowCodec,
  assessmentNow,
} from "./student-assessments.database.js";
import {
  mapStudentAssessmentIdempotencyError,
  StudentAssessmentIncompleteException,
  StudentAssessmentNotFoundException,
} from "./student-assessments.errors.js";
import type {
  CreateStudentAssessmentCommand,
  StudentAssessmentExportQuery,
  StudentAssessmentItem,
  StudentAssessmentListQuery,
  StudentAssessmentListResult,
  StudentAssessmentWriteFields,
  UpdateStudentAssessmentCommand,
} from "./student-assessments.types.js";
import {
  STUDENT_ASSESSMENT_SELECT,
  studentAssessmentView,
  type StudentAssessmentViewRow,
} from "./student-assessments.view.js";

const CREATE_ROUTE = "/api/v1/my-assessments";
const OPTIONAL_WRITE_FIELDS = [
  "academic_year",
  "assessment_date",
  "assessment_type",
  "max_score_hundredths",
  "memo",
  "score_hundredths",
  "semester",
  "subject",
  "title",
  "weight_basis_points",
] as const;

type StudentAssessmentItemJson = StudentAssessmentItem & JsonObject;
// MariaDB opt-in candidate only; keep the generated baseline DB contract intact.
type CandidateAssessmentInsert = Insertable<
  import("@classhub/db").DB["student_assessment_records"]
> & {
  class_id?: string;
};

function requestBody(fields: StudentAssessmentWriteFields): Record<string, unknown> {
  return {
    academic_year: fields.academicYear,
    assessment_date: fields.assessmentDate,
    assessment_type: fields.assessmentType,
    max_score_hundredths: fields.maxScoreHundredths,
    memo: fields.memo,
    score_hundredths: fields.scoreHundredths,
    semester: fields.semester,
    subject: fields.subject,
    title: fields.title,
    weight_basis_points: fields.weightBasisPoints,
  };
}

function hasWriteFields(fields: StudentAssessmentWriteFields): boolean {
  return Object.values(requestBody(fields)).some((value) => value !== undefined);
}

function assertScorePair(score: number | null, maximum: number | null): void {
  if (score !== null && maximum !== null && score > maximum) {
    throw new StudentAssessmentIncompleteException("받은 점수는 만점보다 클 수 없어요.");
  }
}

function assertAcademicDate(academicYear: number | null, assessmentDate: string | null): void {
  if (academicYear === null || assessmentDate === null) return;
  const firstDate = `${academicYear}-03-01`;
  const nextFirstDate = `${academicYear + 1}-03-01`;
  if (assessmentDate < firstDate || assessmentDate >= nextFirstDate) {
    throw new StudentAssessmentIncompleteException(
      "평가일은 선택한 학년도의 3월 1일부터 다음 해 2월 말까지 입력해 주세요.",
    );
  }
}

function assertCompleteRecord(record: {
  academic_year: number | null;
  assessment_date: string | null;
  assessment_type: string | null;
  max_score_hundredths: number | null;
  score_hundredths: number | null;
  semester: number | null;
  subject: string | null;
  title: string | null;
}): void {
  if (
    record.academic_year === null ||
    record.semester === null ||
    record.assessment_type === null ||
    record.subject === null ||
    record.title === null ||
    record.assessment_date === null ||
    record.score_hundredths === null ||
    record.max_score_hundredths === null
  ) {
    throw new StudentAssessmentIncompleteException(
      "학년도·학기·구분·과목·평가명·날짜·받은 점수·만점을 모두 입력해 주세요.",
    );
  }
  assertScorePair(record.score_hundredths, record.max_score_hundredths);
  assertAcademicDate(record.academic_year, record.assessment_date);
}

function mergedRecord(
  row: StudentAssessmentViewRow,
  fields: StudentAssessmentWriteFields,
): Parameters<typeof assertCompleteRecord>[0] {
  return {
    academic_year: fields.academicYear === undefined ? row.academic_year : fields.academicYear,
    assessment_date:
      fields.assessmentDate === undefined
        ? row.assessment_date === null
          ? null
          : databaseDate(row.assessment_date)
        : fields.assessmentDate,
    assessment_type:
      fields.assessmentType === undefined ? row.assessment_type : fields.assessmentType,
    max_score_hundredths:
      fields.maxScoreHundredths === undefined
        ? row.max_score_hundredths
        : fields.maxScoreHundredths,
    score_hundredths:
      fields.scoreHundredths === undefined ? row.score_hundredths : fields.scoreHundredths,
    semester: fields.semester === undefined ? row.semester : fields.semester,
    subject: fields.subject === undefined ? row.subject : fields.subject,
    title: fields.title === undefined ? row.title : fields.title,
  };
}

@Injectable()
export class StudentAssessmentsService {
  private readonly idempotency: IdempotencyService | MariaDbIdempotencyService;
  private readonly engine: "postgres" | "mariadb";
  private readonly binding: StudentAssessmentBinding;
  private readonly bindingEnabled: boolean;

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly access: StudentAssessmentsAccessService,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    this.engine = assessmentDatabaseEngine(config);
    if (this.engine === "mariadb") this.database = database.withPlugin(assessmentMariaDbRowCodec);
    this.binding = new StudentAssessmentBinding(this.database, this.engine === "mariadb");
    this.bindingEnabled =
      config?.get("STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED", { infer: true }) === true;
    this.idempotency =
      this.engine === "mariadb"
        ? new MariaDbIdempotencyService(database)
        : new IdempotencyService(database);
  }

  async list(query: StudentAssessmentListQuery): Promise<StudentAssessmentListResult> {
    await this.access.assertStudent(query.actorUserId);
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    let rowsQuery = this.database
      .selectFrom("student_assessment_records")
      .select(STUDENT_ASSESSMENT_SELECT)
      .where("owner_user_id", "=", query.actorUserId)
      .where("expires_at", ">", assessmentNow(this.engine));
    if (query.academicYear !== undefined) {
      rowsQuery = rowsQuery.where("academic_year", "=", query.academicYear);
    }
    if (query.semester !== undefined) {
      rowsQuery = rowsQuery.where("semester", "=", query.semester);
    }
    if (query.status !== undefined) {
      rowsQuery = rowsQuery.where("status", "=", query.status);
    }
    const rows = await rowsQuery
      .orderBy(sql`CASE WHEN status = 'draft' THEN 0 ELSE 1 END`)
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return {
      items: (await this.withBindings(this.database, query.actorUserId, rows)).map(
        studentAssessmentView,
      ),
      server_today: serverToday,
    };
  }

  async get(actorUserId: string, assessmentId: string): Promise<StudentAssessmentItem> {
    await this.access.assertStudent(actorUserId);
    const row = await this.findOwnedRecord(this.database, actorUserId, assessmentId, false);
    return studentAssessmentView(row);
  }

  async create(command: CreateStudentAssessmentCommand): Promise<StudentAssessmentItem> {
    await this.access.assertStudent(command.actorUserId);
    if (command.connectionScope !== "current_class" && command.expectedClassId !== undefined)
      throw new StudentAssessmentIncompleteException("개인 기록에는 반을 지정할 수 없어요.");
    if (command.connectionScope === "current_class" && command.expectedClassId === undefined)
      throw new StudentAssessmentIncompleteException("연결할 현재 반을 다시 확인해 주세요.");
    assertScorePair(command.scoreHundredths ?? null, command.maxScoreHundredths ?? null);
    assertAcademicDate(command.academicYear ?? null, command.assessmentDate ?? null);
    // The guarded native driver marks failed SQL rollback-only. Probe the
    // optional schema before BEGIN and retain this snapshot across lock waits.
    const bindingReadable = await this.binding.readable();

    try {
      const result = await this.idempotency.execute<StudentAssessmentItemJson>(
        {
          actorUserId: command.actorUserId,
          idempotencyKey: command.idempotencyKey as string,
          requestHash: createIdempotencyRequestHash({
            body: {
              ...requestBody(command),
              ...(command.connectionScope === "current_class"
                ? { connection_scope: "current_class", expected_class_id: command.expectedClassId }
                : {}),
            },
            effectiveClassId: null,
            optionalFields: OPTIONAL_WRITE_FIELDS,
          }),
          routeKey: createIdempotencyRouteKey(CREATE_ROUTE, null),
        },
        async (transaction) => {
          if (this.engine === "mariadb")
            transaction = transaction.withPlugin(assessmentMariaDbRowCodec);
          await this.access.assertLockedStudent(transaction, command.actorUserId);
          let classId: string | null = null;
          if (command.connectionScope === "current_class") {
            if (!this.bindingEnabled || !bindingReadable)
              throw new ServiceUnavailableException("현재 반 연결을 사용할 수 없어요.");
            if (command.expectedClassId !== command.currentClassId)
              throw new ConflictException("현재 반이 바뀌었어요. 연결할 반을 다시 확인해 주세요.");
            const current = await this.binding.currentClass(
              transaction,
              command.actorUserId,
              command.currentClassId ?? null,
              true,
            );
            if (current === null)
              throw new StudentAssessmentIncompleteException("승인된 현재 반을 확인해 주세요.");
            classId = current.id;
          }
          const insertValues: CandidateAssessmentInsert = {
            ...(classId === null ? {} : { class_id: classId }),
            academic_year: command.academicYear ?? null,
            assessment_date: command.assessmentDate ?? null,
            assessment_type: command.assessmentType ?? null,
            max_score_hundredths: command.maxScoreHundredths ?? null,
            memo: command.memo ?? null,
            owner_user_id: command.actorUserId,
            score_hundredths: command.scoreHundredths ?? null,
            semester: command.semester ?? null,
            subject: command.subject ?? null,
            title: command.title ?? null,
            weight_basis_points: command.weightBasisPoints ?? null,
          };
          const insert = transaction.insertInto("student_assessment_records").values(insertValues);
          let created: StudentAssessmentViewRow;
          if (this.engine === "mariadb") {
            const result = await insert.executeTakeFirstOrThrow();
            if (result.numInsertedOrUpdatedRows !== 1n)
              throw new Error("Assessment insert failed.");
            created = await this.findOwnedRecord(
              transaction,
              command.actorUserId,
              mariaDbInsertId(result.insertId),
              false,
              bindingReadable,
            );
          } else {
            created = await insert.returning(STUDENT_ASSESSMENT_SELECT).executeTakeFirstOrThrow();
          }
          return {
            body: studentAssessmentView(created) as StudentAssessmentItemJson,
            statusCode: 201,
          };
        },
      );
      return result.body;
    } catch (error) {
      mapStudentAssessmentIdempotencyError(error);
    }
  }

  async update(command: UpdateStudentAssessmentCommand): Promise<StudentAssessmentItem> {
    const expectedVersion = parseRequiredIfMatch(command.ifMatch);
    const bindingReadable = await this.binding.readable();
    return this.database.transaction().execute(async (transaction) => {
      await this.access.assertLockedStudent(transaction, command.actorUserId);
      const row = await this.findOwnedRecord(
        transaction,
        command.actorUserId,
        command.assessmentId,
        true,
        bindingReadable,
      );
      if (row.row_version !== expectedVersion) {
        throw new ResourceVersionChangedException(row.row_version);
      }
      if (!hasWriteFields(command)) return studentAssessmentView(row);

      const merged = mergedRecord(row, command);
      assertScorePair(merged.score_hundredths, merged.max_score_hundredths);
      assertAcademicDate(merged.academic_year, merged.assessment_date);
      if (row.status === "recorded") assertCompleteRecord(merged);

      const update = transaction
        .updateTable("student_assessment_records")
        .set({
          ...(command.academicYear === undefined ? {} : { academic_year: command.academicYear }),
          ...(command.assessmentDate === undefined
            ? {}
            : { assessment_date: command.assessmentDate }),
          ...(command.assessmentType === undefined
            ? {}
            : { assessment_type: command.assessmentType }),
          ...(command.maxScoreHundredths === undefined
            ? {}
            : { max_score_hundredths: command.maxScoreHundredths }),
          ...(command.memo === undefined ? {} : { memo: command.memo }),
          ...(command.scoreHundredths === undefined
            ? {}
            : { score_hundredths: command.scoreHundredths }),
          ...(command.semester === undefined ? {} : { semester: command.semester }),
          ...(command.subject === undefined ? {} : { subject: command.subject }),
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.weightBasisPoints === undefined
            ? {}
            : { weight_basis_points: command.weightBasisPoints }),
          ...(row.status === "draft"
            ? {
                expires_at:
                  this.engine === "mariadb"
                    ? sql<Date>`UTC_TIMESTAMP(6) + INTERVAL 30 DAY`
                    : sql<Date>`clock_timestamp() + interval '30 days'`,
              }
            : {}),
          row_version: sql`row_version + 1`,
          updated_at: assessmentNow(this.engine),
        })
        .where("id", "=", row.id)
        .where("owner_user_id", "=", command.actorUserId)
        .where("row_version", "=", expectedVersion);
      let updated: StudentAssessmentViewRow | undefined;
      if (this.engine === "mariadb") {
        const result = await update.executeTakeFirstOrThrow();
        if (result.numUpdatedRows === 1n)
          updated = await this.findOwnedRecord(
            transaction,
            command.actorUserId,
            row.id,
            false,
            bindingReadable,
          );
      } else {
        updated = await update.returning(STUDENT_ASSESSMENT_SELECT).executeTakeFirst();
      }
      if (updated === undefined) throw new ResourceVersionChangedException(row.row_version);
      return studentAssessmentView(updated);
    });
  }

  async complete(
    actorUserId: string,
    assessmentId: string,
    ifMatch: string | string[] | undefined,
  ): Promise<StudentAssessmentItem> {
    const expectedVersion = parseRequiredIfMatch(ifMatch);
    const bindingReadable = await this.binding.readable();
    return this.database.transaction().execute(async (transaction) => {
      // Capture once immediately after BEGIN, before any row-lock wait. Retain
      // microseconds for the recorded_at + 365 days constraint and every write.
      const completedAt =
        this.engine === "mariadb"
          ? mariaDbDateBinding(
              (
                await sql<{
                  assessment_clock: string;
                }>`SELECT UTC_TIMESTAMP(6) AS assessment_clock`.execute(transaction)
              ).rows[0]?.assessment_clock,
            )
          : sql<Date>`transaction_timestamp()`;
      await this.access.assertLockedStudent(transaction, actorUserId);
      const row = await this.findOwnedRecord(
        transaction,
        actorUserId,
        assessmentId,
        true,
        bindingReadable,
      );
      if (row.row_version !== expectedVersion) {
        throw new ResourceVersionChangedException(row.row_version);
      }
      if (row.status === "recorded") return studentAssessmentView(row);
      assertCompleteRecord(mergedRecord(row, {}));

      const update = transaction
        .updateTable("student_assessment_records")
        .set({
          expires_at:
            this.engine === "mariadb"
              ? sql<Date>`${completedAt} + INTERVAL 365 DAY`
              : sql<Date>`transaction_timestamp() + interval '365 days'`,
          recorded_at: completedAt,
          row_version: sql`row_version + 1`,
          status: "recorded",
          updated_at: completedAt,
        })
        .where("id", "=", row.id)
        .where("owner_user_id", "=", actorUserId)
        .where("row_version", "=", expectedVersion);
      let completed: StudentAssessmentViewRow | undefined;
      if (this.engine === "mariadb") {
        const result = await update.executeTakeFirstOrThrow();
        if (result.numUpdatedRows === 1n)
          completed = await this.findOwnedRecord(
            transaction,
            actorUserId,
            row.id,
            false,
            bindingReadable,
          );
      } else {
        completed = await update.returning(STUDENT_ASSESSMENT_SELECT).executeTakeFirst();
      }
      if (completed === undefined) throw new ResourceVersionChangedException(row.row_version);
      return studentAssessmentView(completed);
    });
  }

  async delete(
    actorUserId: string,
    assessmentId: string,
    ifMatch: string | string[] | undefined,
  ): Promise<void> {
    const expectedVersion = parseRequiredIfMatch(ifMatch);
    const bindingReadable = await this.binding.readable();
    await this.database.transaction().execute(async (transaction) => {
      await this.access.assertLockedStudent(transaction, actorUserId);
      const row = await this.findOwnedRecord(
        transaction,
        actorUserId,
        assessmentId,
        true,
        bindingReadable,
      );
      if (row.row_version !== expectedVersion) {
        throw new ResourceVersionChangedException(row.row_version);
      }
      const deletion = transaction
        .deleteFrom("student_assessment_records")
        .where("id", "=", row.id)
        .where("owner_user_id", "=", actorUserId)
        .where("row_version", "=", expectedVersion);
      const deleted =
        this.engine === "mariadb"
          ? (await deletion.executeTakeFirstOrThrow()).numDeletedRows === 1n
          : (await deletion.returning("id").executeTakeFirst()) !== undefined;
      if (!deleted) throw new ResourceVersionChangedException(row.row_version);
    });
  }

  async exportCsv(query: StudentAssessmentExportQuery): Promise<string> {
    await this.access.assertStudent(query.actorUserId);
    let rowsQuery = this.database
      .selectFrom("student_assessment_records")
      .select(STUDENT_ASSESSMENT_SELECT)
      .where("owner_user_id", "=", query.actorUserId)
      .where("status", "=", "recorded")
      .where("expires_at", ">", assessmentNow(this.engine));
    if (query.academicYear !== undefined) {
      rowsQuery = rowsQuery.where("academic_year", "=", query.academicYear);
    }
    if (query.semester !== undefined) {
      rowsQuery = rowsQuery.where("semester", "=", query.semester);
    }
    const rows = await rowsQuery
      .orderBy("academic_year", "desc")
      .orderBy("semester", "desc")
      .orderBy("assessment_date", "desc")
      .orderBy("id", "desc")
      .execute();
    const available = await this.withBindings(this.database, query.actorUserId, rows);
    return studentAssessmentsCsv(available.map(studentAssessmentView));
  }

  async creationContext(actorUserId: string, currentClassId: string | null) {
    await this.access.assertStudent(actorUserId);
    if (!this.bindingEnabled || !(await this.binding.readable()))
      return { class_connection_available: false, current_class: null };
    const current = await this.binding.currentClass(
      this.database,
      actorUserId,
      currentClassId,
      false,
    );
    return { class_connection_available: current !== null, current_class: current ?? null };
  }

  private async withBinding(
    database: ClassHubDatabase | Transaction<import("@classhub/db").DB>,
    actorUserId: string,
    row: StudentAssessmentViewRow,
    required: boolean,
    readable?: boolean,
  ) {
    if (!(readable ?? (await this.binding.readable(database)))) return row;
    const scope = await this.binding.record(database, actorUserId, row.id);
    if (!scope.alive) {
      if (required) throw new StudentAssessmentNotFoundException();
      return undefined;
    }
    return {
      ...row,
      class_id: scope.class_id,
      class_name: scope.class_name,
      expires_at: scope.effective_expires_at,
    };
  }

  private async withBindings(
    database: ClassHubDatabase,
    actorUserId: string,
    rows: StudentAssessmentViewRow[],
  ): Promise<StudentAssessmentViewRow[]> {
    if (!(await this.binding.readable(database))) return rows;
    const scopes = await this.binding.records(
      database,
      actorUserId,
      rows.map((row) => row.id),
    );
    return rows.flatMap((row) => {
      const scope = scopes.get(row.id);
      if (scope === undefined || !scope.alive) return [];
      return [
        {
          ...row,
          class_id: scope.class_id,
          class_name: scope.class_name,
          expires_at: scope.effective_expires_at,
        },
      ];
    });
  }

  private async findOwnedRecord(
    database: ClassHubDatabase | Transaction<import("@classhub/db").DB>,
    actorUserId: string,
    assessmentId: string,
    lock: boolean,
    bindingReadable?: boolean,
  ): Promise<StudentAssessmentViewRow> {
    let query = database
      .selectFrom("student_assessment_records")
      .select(STUDENT_ASSESSMENT_SELECT)
      .where("id", "=", assessmentId)
      .where("owner_user_id", "=", actorUserId)
      .where("expires_at", ">", assessmentNow(this.engine));
    if (lock) query = query.forUpdate();
    let row = await query.executeTakeFirst();
    // MariaDB's statement clock predates a lock wait. Recheck expiry only
    // after holding the record lock, using the new statement's UTC clock.
    if (row !== undefined && lock && this.engine === "mariadb") {
      row = await database
        .selectFrom("student_assessment_records")
        .select(STUDENT_ASSESSMENT_SELECT)
        .where("id", "=", assessmentId)
        .where("owner_user_id", "=", actorUserId)
        .where("expires_at", ">", assessmentNow(this.engine))
        .executeTakeFirst();
    }
    if (row === undefined) throw new StudentAssessmentNotFoundException();
    return (await this.withBinding(database, actorUserId, row, true, bindingReadable))!;
  }
}
