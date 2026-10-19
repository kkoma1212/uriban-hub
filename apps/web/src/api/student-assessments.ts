import { apiFetch, entityEtag, parseResponse, withCsrfRecovery } from "./auth";

export type StudentAssessmentStatus = "draft" | "recorded";
export type StudentAssessmentType = "performance" | "written";
export type StudentAssessmentConnectionScope = "personal" | "current_class";

export interface StudentAssessmentCreationContext {
  class_connection_available: boolean;
  current_class: { id: string; name: string } | null;
}

export interface StudentAssessmentItem {
  connection_scope?: StudentAssessmentConnectionScope | null;
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

export interface StudentAssessmentListResponse {
  items: StudentAssessmentItem[];
  server_today: string;
}

export interface StudentAssessmentWriteRequest {
  academic_year?: number | null;
  assessment_date?: string | null;
  assessment_type?: StudentAssessmentType | null;
  max_score_hundredths?: number | null;
  memo?: string | null;
  score_hundredths?: number | null;
  semester?: number | null;
  subject?: string | null;
  title?: string | null;
  weight_basis_points?: number | null;
}

export interface StudentAssessmentCreateRequest extends StudentAssessmentWriteRequest {
  connection_scope?: StudentAssessmentConnectionScope;
  expected_class_id?: string;
}

export interface StudentAssessmentEntityResponse {
  etag: string;
  item: StudentAssessmentItem;
}

async function parseEntity(response: Response): Promise<StudentAssessmentEntityResponse> {
  const item = await parseResponse<StudentAssessmentItem>(response);
  return { etag: entityEtag(item.row_version, response.headers.get("ETag")), item };
}

async function parseEmptyResponse(response: Response): Promise<void> {
  if (response.ok) return;
  await parseResponse<never>(response);
}

export async function listStudentAssessments(): Promise<StudentAssessmentListResponse> {
  const response = await apiFetch("/api/v1/my-assessments", { credentials: "include" });
  return parseResponse<StudentAssessmentListResponse>(response);
}

export async function getStudentAssessmentCreationContext(): Promise<StudentAssessmentCreationContext> {
  const response = await apiFetch("/api/v1/my-assessments/creation-context", {
    credentials: "include",
  });
  return parseResponse<StudentAssessmentCreationContext>(response);
}

export async function getStudentAssessment(
  assessmentId: string,
): Promise<StudentAssessmentEntityResponse> {
  const response = await apiFetch(`/api/v1/my-assessments/${encodeURIComponent(assessmentId)}`, {
    credentials: "include",
  });
  return parseEntity(response);
}

export async function createStudentAssessment(
  request: StudentAssessmentCreateRequest,
  idempotencyKey: string,
): Promise<StudentAssessmentEntityResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch("/api/v1/my-assessments", {
        body,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-CSRF-Token": csrfToken,
        },
        method: "POST",
      }),
    parseEntity,
  );
}

export async function updateStudentAssessment(
  assessmentId: string,
  request: StudentAssessmentWriteRequest,
  etag: string,
): Promise<StudentAssessmentEntityResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/my-assessments/${encodeURIComponent(assessmentId)}`, {
        body,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
          "X-CSRF-Token": csrfToken,
        },
        method: "PATCH",
      }),
    parseEntity,
  );
}

export async function completeStudentAssessment(
  assessmentId: string,
  etag: string,
): Promise<StudentAssessmentEntityResponse> {
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/my-assessments/${encodeURIComponent(assessmentId)}/complete`, {
        credentials: "include",
        headers: {
          "If-Match": etag,
          "X-CSRF-Token": csrfToken,
        },
        method: "POST",
      }),
    parseEntity,
  );
}

export async function deleteStudentAssessment(assessmentId: string, etag: string): Promise<void> {
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/my-assessments/${encodeURIComponent(assessmentId)}`, {
        credentials: "include",
        headers: {
          "If-Match": etag,
          "X-CSRF-Token": csrfToken,
        },
        method: "DELETE",
      }),
    parseEmptyResponse,
  );
}

export async function exportStudentAssessmentsCsv(): Promise<Blob> {
  const response = await apiFetch("/api/v1/my-assessments/export.csv", {
    credentials: "include",
  });
  if (!response.ok) await parseResponse<never>(response);
  return response.blob();
}
