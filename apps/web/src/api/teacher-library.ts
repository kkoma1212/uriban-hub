import { apiFetch, parseResponse, withCsrfRecovery } from "./auth";

export type TeacherLibraryKind = "notice" | "supply";

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

export interface PersonalInfoHit {
  kind: "email" | "name" | "phone";
  text: string;
}

export interface TeacherLibraryDraft {
  body: string | null;
  kind: TeacherLibraryKind;
  source_id: string;
  title: string;
}

function send<T>(path: string, method: "DELETE" | "POST", payload?: unknown): Promise<T> {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return withCsrfRecovery(
    ({ apiFetch: fetchWithCsrf, csrfToken }) =>
      fetchWithCsrf(path, {
        method,
        credentials: "include",
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          "X-CSRF-Token": csrfToken,
        },
        ...(body === undefined ? {} : { body }),
      }),
    method === "DELETE" ? async () => undefined as T : parseResponse<T>,
  );
}

export async function listTeacherLibrary(filters: {
  cursor?: string;
  kind?: TeacherLibraryKind;
  q?: string;
  year?: number;
}): Promise<{ items: TeacherLibraryItem[]; next_cursor: string | null }> {
  const search = new URLSearchParams();
  if (filters.kind !== undefined) search.set("kind", filters.kind);
  if (filters.year !== undefined) search.set("year", String(filters.year));
  if (filters.q !== undefined) search.set("q", filters.q);
  if (filters.cursor !== undefined) search.set("cursor", filters.cursor);
  const response = await apiFetch(`/api/v1/teacher-library?${search.toString()}`, {
    credentials: "include",
  });
  return parseResponse(response);
}

export async function getTeacherLibraryItem(id: string): Promise<TeacherLibraryItem> {
  const response = await apiFetch(`/api/v1/teacher-library/${encodeURIComponent(id)}`, {
    credentials: "include",
  });
  return parseResponse(response);
}

export function checkTeacherLibraryDraft(
  draft: TeacherLibraryDraft,
): Promise<{ hits: PersonalInfoHit[] }> {
  return send("/api/v1/teacher-library/check", "POST", draft);
}

export function saveTeacherLibraryItem(draft: TeacherLibraryDraft): Promise<TeacherLibraryItem> {
  return send("/api/v1/teacher-library", "POST", { ...draft, confirm_personal_info: true });
}

export function deleteTeacherLibraryItem(id: string): Promise<void> {
  return send(`/api/v1/teacher-library/${encodeURIComponent(id)}`, "DELETE");
}
