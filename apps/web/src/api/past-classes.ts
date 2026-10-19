import { apiFetch, parseResponse } from "./auth";
import type { UpdatesFilter, UpdatesListResponse } from "./updates";

/** 내가 속했던 지난 반. 반 종료 후 365일(처리방침 보존 기간) 동안만 서버가 내려 준다. */
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

export async function listPastClasses(): Promise<PastClassSummary[]> {
  const response = await apiFetch("/api/v1/past-classes", { credentials: "include" });
  return (await parseResponse<{ items: PastClassSummary[] }>(response)).items;
}

export async function listPastClassUpdates(
  classId: string,
  filter: UpdatesFilter,
  cursor?: string,
  term?: string,
): Promise<UpdatesListResponse> {
  const search = new URLSearchParams({ filter });
  if (cursor !== undefined) search.set("cursor", cursor);
  // 검색어는 커서에 묶여 있다 — 다음 쪽을 부를 때도 같은 값을 보낸다.
  if (term !== undefined) search.set("q", term);
  const response = await apiFetch(
    `/api/v1/past-classes/${encodeURIComponent(classId)}/updates?${search.toString()}`,
    { credentials: "include" },
  );
  return parseResponse<UpdatesListResponse>(response);
}
