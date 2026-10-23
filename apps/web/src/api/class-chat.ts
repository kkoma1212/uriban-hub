import { apiFetch, parseResponse, withCsrfRecovery } from "./auth";

/** 반 단체 대화(선생님 관리형). 서버 설계: planning/class-chat-20260928 */
export type ClassChatRole = "student" | "teacher";
export type ClassChatBlockedReason = "closed" | "night" | "muted";
export type ClassChatMuteDuration = "10m" | "1h" | "today";

export interface ClassChatAuthor {
  /** 대화 상태의 작성자에만, 지금 사진을 받을 수 있는지(2026-10-23~). false면 사진을 요청하지 않는다. */
  has_profile_photo?: boolean;
  member_id: string;
  name: string;
  role: ClassChatRole;
  student_number: number | null;
}

export interface ClassChatMessage {
  author: ClassChatAuthor;
  /** 담임이 가린 메시지는 학생에게 null로 온다. */
  body: string | null;
  created_at: string;
  hidden: boolean;
  id: string;
  mine: boolean;
}

export interface ClassChatState {
  has_more_before: boolean;
  me: {
    blocked_reason: ClassChatBlockedReason | null;
    can_send: boolean;
    member_id: string;
    muted_until: string | null;
    role: ClassChatRole;
  };
  messages: ClassChatMessage[];
  /** 담임에게만 숫자, 학생에게는 null */
  open_report_count: number | null;
  room: { is_open: boolean };
}

export interface ClassChatReport {
  created_at: string;
  id: string;
  message: ClassChatMessage;
  reason: string;
  reporter: ClassChatAuthor;
}

/** 메시지·신고 사유 길이(API·DB와 같다). */
export const CLASS_CHAT_MESSAGE_MAX = 500;
export const CLASS_CHAT_REPORT_REASON_MAX = 200;

const BASE = "/api/v1/class-chat";

export async function getClassChat(after?: string): Promise<ClassChatState> {
  const path = after === undefined ? BASE : `${BASE}?after=${encodeURIComponent(after)}`;
  return parseResponse<ClassChatState>(await apiFetch(path, { credentials: "include" }));
}

export async function listClassChatReports(): Promise<ClassChatReport[]> {
  const response = await apiFetch(`${BASE}/reports`, { credentials: "include" });
  return (await parseResponse<{ items: ClassChatReport[] }>(response)).items;
}

async function parseEmptyResponse(response: Response): Promise<void> {
  if (response.ok) return;
  await parseResponse<never>(response);
}

function write<T>(
  method: "DELETE" | "POST" | "PUT",
  path: string,
  payload: unknown,
  parser: (response: Response) => Promise<T>,
): Promise<T> {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`${BASE}${path}`, {
        method,
        credentials: "include",
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          "X-CSRF-Token": csrfToken,
        },
        ...(body === undefined ? {} : { body }),
      }),
    parser,
  );
}

export function sendClassChatMessage(body: string): Promise<ClassChatState> {
  return write("POST", "/messages", { body }, parseResponse<ClassChatState>);
}

export function hideClassChatMessage(messageId: string): Promise<ClassChatState> {
  return write(
    "POST",
    `/messages/${encodeURIComponent(messageId)}/hide`,
    undefined,
    parseResponse<ClassChatState>,
  );
}

export function reportClassChatMessage(messageId: string, reason: string): Promise<void> {
  return write(
    "POST",
    `/messages/${encodeURIComponent(messageId)}/report`,
    { reason },
    parseEmptyResponse,
  );
}

export function resolveClassChatReport(reportId: string): Promise<void> {
  return write(
    "POST",
    `/reports/${encodeURIComponent(reportId)}/resolve`,
    undefined,
    parseEmptyResponse,
  );
}

export function setClassChatRoomOpen(isOpen: boolean): Promise<ClassChatState> {
  return write("PUT", "/room", { is_open: isOpen }, parseResponse<ClassChatState>);
}

export function muteClassChatMember(
  memberId: string,
  duration: ClassChatMuteDuration,
): Promise<void> {
  return write("PUT", `/mutes/${encodeURIComponent(memberId)}`, { duration }, parseEmptyResponse);
}

export function unmuteClassChatMember(memberId: string): Promise<void> {
  return write("DELETE", `/mutes/${encodeURIComponent(memberId)}`, undefined, parseEmptyResponse);
}
