import { apiFetch, parseResponse, withCsrfRecovery } from "./auth";

export interface LayoutTemplateItem {
  created_at: string;
  id: string;
  name: string;
  payload: unknown;
  updated_at: string;
}

export async function listLayoutTemplates(): Promise<{ items: LayoutTemplateItem[] }> {
  const response = await apiFetch("/api/v1/layout-templates", { credentials: "include" });
  return parseResponse<{ items: LayoutTemplateItem[] }>(response);
}

/** 같은 이름이면 덮어쓴다 — 서버가 이름을 열쇠로 쓴다. */
export async function saveLayoutTemplate(
  name: string,
  payload: unknown,
): Promise<LayoutTemplateItem> {
  const body = JSON.stringify({ name, payload });
  return withCsrfRecovery<LayoutTemplateItem>(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/layout-templates", {
      body,
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      method: "PUT",
    }),
  );
}

/** 지우기는 204를 준다 — 본문이 없으므로 실패일 때만 오류를 읽는다. */
async function parseEmptyResponse(response: Response): Promise<void> {
  if (response.ok) return;
  await parseResponse<never>(response);
}

export async function deleteLayoutTemplate(templateId: string): Promise<void> {
  await withCsrfRecovery<void>(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/layout-templates/${encodeURIComponent(templateId)}`, {
        credentials: "include",
        headers: { "X-CSRF-Token": csrfToken },
        method: "DELETE",
      }),
    parseEmptyResponse,
  );
}
