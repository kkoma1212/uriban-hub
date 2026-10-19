export type StudentAssessmentStatus = "draft" | "recorded";
export type StudentAssessmentType = "performance" | "written";

export interface StudentAssessmentItem {
  connection_scope?: "personal" | "current_class";
  class_id?: string | null;
  class_name?: string | null;
  academic_year: number | null;
  assessment_date: string | null;
  assessment_type: StudentAssessmentType | null;
  created_at: string;
  expires_at: string;
  id: string;
  max_score_hundredths: number | null;
  memo: string | null;
  recorded_at: string | null;
  row_version: string;
  score_hundredths: number | null;
  semester: number | null;
  status: StudentAssessmentStatus;
  subject: string | null;
  title: string | null;
  updated_at: string;
  weight_basis_points: number | null;
}

export interface StudentAssessmentListResult {
  items: StudentAssessmentItem[];
  server_today: string;
}

export interface StudentAssessmentWriteFields {
  academicYear?: number | null;
  assessmentDate?: string | null;
  assessmentType?: StudentAssessmentType | null;
  maxScoreHundredths?: number | null;
  memo?: string | null;
  scoreHundredths?: number | null;
  semester?: number | null;
  subject?: string | null;
  title?: string | null;
  weightBasisPoints?: number | null;
}

export interface CreateStudentAssessmentCommand extends StudentAssessmentWriteFields {
  connectionScope?: "personal" | "current_class";
  currentClassId?: string | null;
  expectedClassId?: string;
  actorUserId: string;
  idempotencyKey: string | string[] | undefined;
}

export interface UpdateStudentAssessmentCommand extends StudentAssessmentWriteFields {
  actorUserId: string;
  assessmentId: string;
  ifMatch: string | string[] | undefined;
}

export interface StudentAssessmentListQuery {
  academicYear?: number;
  actorUserId: string;
  semester?: number;
  status?: StudentAssessmentStatus;
}

export interface StudentAssessmentExportQuery {
  academicYear?: number;
  actorUserId: string;
  semester?: number;
}
