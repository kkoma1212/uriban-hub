import { apiFetch, parseResponse, withCsrfRecovery } from "./auth";

/** general = 글과 무관하게 학생이 '선생님께 물어보기'로 시작한 대화. */
export type HelpRequestKind = "question" | "hard_to_prepare" | "general";
export type HelpRequestTargetKind = "notice" | "supply";

export interface HelpRequestItem {
  closed_at: string | null;
  created_at: string;
  id: string;
  kind: HelpRequestKind;
  last_activity_at: string;
  message: string | null;
  reply: string | null;
  status: "open" | "resolved" | "withdrawn";
  /** has_profile_photo는 대화 응답에만, 지금 사진을 받을 수 있는지(2026-10-23~). false면 요청하지 않는다. */
  student: {
    display_name: string;
    has_profile_photo?: boolean;
    member_id: string;
    student_number: number | null;
  } | null;
  /** 글과 무관한 대화(general)는 null이다. */
  target: { id: string; kind: HelpRequestTargetKind; title: string } | null;
}

export interface HelpMessage {
  author: "student" | "teacher";
  body: string;
  created_at: string;
  id: string;
}

export interface HelpThread {
  messages: HelpMessage[];
  request: HelpRequestItem;
  /** 학생이 받는 대화에만, 담임 사진을 지금 받을 수 있는지(2026-10-23~). false면 요청하지 않는다. */
  teacher_has_profile_photo?: boolean;
}

/** 대화 메시지 한 개의 길이(API·DB와 같다). */
export const HELP_MESSAGE_MAX = 500;

export const helpRequestKindLabel: Record<HelpRequestKind, string> = {
  general: "선생님께 물어보기",
  hard_to_prepare: "준비하기 어려워요",
  question: "질문 있어요",
};

export function helpTargetPath(target: NonNullable<HelpRequestItem["target"]>): string {
  return `/${target.kind === "notice" ? "notices" : "supplies"}/${target.id}`;
}

export async function listHelpRequests(
  status: "open" | "all",
  target?: { id: string; kind: HelpRequestTargetKind },
): Promise<HelpRequestItem[]> {
  const search = new URLSearchParams({ status });
  if (target !== undefined) {
    search.set("target_kind", target.kind);
    search.set("target_id", target.id);
  }
  const response = await apiFetch(`/api/v1/help-requests?${search.toString()}`, {
    credentials: "include",
  });
  return (await parseResponse<{ items: HelpRequestItem[] }>(response)).items;
}

const HELP_REQUEST_CHANGED_EVENT = "classhub:help-request-changed";

export function subscribeHelpRequestChanges(listener: () => void): () => void {
  window.addEventListener(HELP_REQUEST_CHANGED_EVENT, listener);
  return () => window.removeEventListener(HELP_REQUEST_CHANGED_EVENT, listener);
}

async function post<T = HelpRequestItem>(path: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload);
  const result = await withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body,
      }),
    parseResponse<T>,
  );
  if (typeof window !== "undefined") window.dispatchEvent(new Event(HELP_REQUEST_CHANGED_EVENT));
  return result;
}

export async function getHelpThread(id: string): Promise<HelpThread> {
  const response = await apiFetch(`/api/v1/help-requests/${encodeURIComponent(id)}/messages`, {
    credentials: "include",
  });
  return parseResponse<HelpThread>(response);
}

export function sendHelpMessage(id: string, body: string): Promise<HelpThread> {
  return post<HelpThread>(`/api/v1/help-requests/${encodeURIComponent(id)}/messages`, { body });
}

/** 학생 전용. 열린 '선생님께 물어보기' 대화가 있으면 서버가 거기에 이어 쓴다. */
export function startGeneralHelp(body: string): Promise<HelpThread> {
  return post<HelpThread>("/api/v1/help-requests/general", { body });
}

export function createHelpRequest(
  target: { id: string; kind: HelpRequestTargetKind },
  kind: Exclude<HelpRequestKind, "general">,
  message: string | null,
): Promise<HelpRequestItem> {
  return post("/api/v1/help-requests", {
    kind,
    message,
    target_id: target.id,
    target_kind: target.kind,
  });
}

export function withdrawHelpRequest(id: string): Promise<HelpRequestItem> {
  return post(`/api/v1/help-requests/${encodeURIComponent(id)}/withdraw`, {});
}

export function resolveHelpRequest(id: string, reply: string | null): Promise<HelpRequestItem> {
  return post(`/api/v1/help-requests/${encodeURIComponent(id)}/resolve`, { reply });
}
