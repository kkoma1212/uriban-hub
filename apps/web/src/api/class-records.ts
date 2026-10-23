import { apiFetch, parseResponse } from "./auth";

/**
 * 담임이 반 기록(선생님이 쓴 공지·준비물·숙제·일정·투표)을 CSV로 받는다.
 * pastClassId가 없으면 지금 반, 있으면 끝난 반(종료 후 365일 이내).
 */
export async function downloadClassRecordsCsv(pastClassId?: string): Promise<Blob> {
  const path =
    pastClassId === undefined
      ? "/api/v1/classes/current/records.csv"
      : `/api/v1/past-classes/${encodeURIComponent(pastClassId)}/records.csv`;
  const response = await apiFetch(path, { credentials: "include" });
  if (!response.ok) await parseResponse<never>(response);
  return response.blob();
}
