import { databaseDate } from "../common/date/kst-date.js";
import type {
  StudentAssessmentItem,
  StudentAssessmentStatus,
  StudentAssessmentType,
} from "./student-assessments.types.js";

export const STUDENT_ASSESSMENT_SELECT = [
  "academic_year",
  "assessment_date",
  "assessment_type",
  "created_at",
  "expires_at",
  "id",
  "max_score_hundredths",
  "memo",
  "recorded_at",
  "row_version",
  "score_hundredths",
  "semester",
  "status",
  "subject",
  "title",
  "updated_at",
  "weight_basis_points",
] as const;

export interface StudentAssessmentViewRow {
  class_id?: string | null;
  class_name?: string | null;
  academic_year: number | null;
  assessment_date: Date | string | null;
  assessment_type: string | null;
  created_at: Date;
  expires_at: Date;
  id: string;
  max_score_hundredths: number | null;
  memo: string | null;
  recorded_at: Date | null;
  row_version: string;
  score_hundredths: number | null;
  semester: number | null;
  status: string;
  subject: string | null;
  title: string | null;
  updated_at: Date;
  weight_basis_points: number | null;
}

export function studentAssessmentView(row: StudentAssessmentViewRow): StudentAssessmentItem {
  return {
    ...(row.class_id === undefined
      ? {}
      : {
          connection_scope:
            row.class_id === null ? ("personal" as const) : ("current_class" as const),
          class_id: row.class_id,
          class_name: row.class_name ?? null,
        }),
    academic_year: row.academic_year,
    assessment_date: row.assessment_date === null ? null : databaseDate(row.assessment_date),
    assessment_type: row.assessment_type as StudentAssessmentType | null,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    id: row.id,
    max_score_hundredths: row.max_score_hundredths,
    memo: row.memo,
    recorded_at: row.recorded_at?.toISOString() ?? null,
    row_version: row.row_version,
    score_hundredths: row.score_hundredths,
    semester: row.semester,
    status: row.status as StudentAssessmentStatus,
    subject: row.subject,
    title: row.title,
    updated_at: row.updated_at.toISOString(),
    weight_basis_points: row.weight_basis_points,
  };
}
