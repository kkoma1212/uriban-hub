import type { DB } from "@classhub/db";
import { ServiceUnavailableException } from "@nestjs/common";
import { sql, type Kysely, type Transaction } from "kysely";
import { mariaDbBoolean, mariaDbDateTime } from "../common/database/mariadb-values.js";

type Database = Kysely<DB> | Transaction<DB>;
export type AssessmentBinding = {
  class_id: string | null;
  class_name: string | null;
  effective_expires_at: Date;
  alive: boolean;
};

export class StudentAssessmentBinding {
  private schema: Promise<boolean> | undefined;
  private negativeUntil = 0;
  constructor(
    private readonly database: Database,
    private readonly mariaDb: boolean,
  ) {}

  async readable(database: Database = this.database): Promise<boolean> {
    if (!this.mariaDb) return Promise.resolve(false);
    if (this.negativeUntil !== 0 && Date.now() >= this.negativeUntil) {
      this.schema = undefined;
      this.negativeUntil = 0;
    }
    const available = await (this.schema ??= this.probe(database));
    if (!available && this.negativeUntil === 0) this.negativeUntil = Date.now() + 5000;
    if (available) this.negativeUntil = 0;
    return available;
  }

  private async probe(database: Database): Promise<boolean> {
    try {
      await sql`SELECT class_id FROM student_assessment_records LIMIT 0`.execute(database);
    } catch (error) {
      const code = (error as { code?: string }).code;
      // An absent candidate column is the supported baseline. Permission and
      // connection failures cannot establish whether linked records exist.
      if (code === "ER_BAD_FIELD_ERROR") return false;
      this.schema = undefined;
      throw new ServiceUnavailableException(
        "평가 기록의 보관 범위를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.",
      );
    }
    try {
      // Once the link column exists, incomplete retention metadata is unsafe.
      await sql`SELECT retention_purged_at, archived_at FROM classes LIMIT 0`.execute(database);
      return true;
    } catch {
      this.schema = undefined;
      throw new ServiceUnavailableException(
        "평가 기록의 보관 범위를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.",
      );
    }
  }

  async currentClass(database: Database, userId: string, classId: string | null, lock: boolean) {
    if (classId === null) return null;
    let query = database
      .selectFrom("classes")
      .select(["id", "name"])
      .where("id", "=", classId)
      .where("status", "=", "active");
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (row === undefined) return null;
    let memberQuery = database
      .selectFrom("class_members")
      .select("id")
      .where("class_id", "=", classId)
      .where("user_id", "=", userId)
      .where("role", "=", "student")
      .where("status", "=", "approved");
    if (lock) memberQuery = memberQuery.forUpdate();
    return (await memberQuery.executeTakeFirst()) === undefined ? null : row;
  }

  async record(database: Database, userId: string, id: string): Promise<AssessmentBinding> {
    const rows = await this.records(database, userId, [id]);
    const row = rows.get(id);
    if (row === undefined) throw new ServiceUnavailableException();
    return row;
  }

  async records(
    database: Database,
    userId: string,
    ids: string[],
  ): Promise<Map<string, AssessmentBinding>> {
    if (ids.length === 0) return new Map();
    const result = await sql<
      AssessmentBinding & { id: string }
    >`SELECT CAST(a.id AS CHAR) AS id, CAST(a.class_id AS CHAR) AS class_id, c.name AS class_name,
      LEAST(a.expires_at, COALESCE(c.archived_at + INTERVAL 365 DAY, a.expires_at)) AS effective_expires_at,
      (LEAST(a.expires_at, COALESCE(c.archived_at + INTERVAL 365 DAY, a.expires_at)) > UTC_TIMESTAMP(6)) AS alive
      FROM student_assessment_records a LEFT JOIN classes c ON c.id=a.class_id
      WHERE a.id IN (${sql.join(ids)}) AND a.owner_user_id=${userId}`.execute(database);
    return new Map(
      result.rows.map((row) => [
        row.id,
        {
          ...row,
          effective_expires_at: mariaDbDateTime(row.effective_expires_at),
          alive: mariaDbBoolean(row.alive),
        },
      ]),
    );
  }
}
