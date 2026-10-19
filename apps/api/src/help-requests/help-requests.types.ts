/** general = 글과 무관하게 학생이 시작한 대화(T-HELP-CHAT). */
export type HelpRequestKind = "question" | "hard_to_prepare" | "general";
export type HelpRequestStatus = "open" | "resolved" | "withdrawn";
export type HelpRequestTargetKind = "notice" | "supply";

export interface HelpRequestItem {
  closed_at: string | null;
  created_at: string;
  id: string;
  kind: HelpRequestKind;
  /** 요청이나 마지막 메시지 중 늦은 시각. 목록은 이 순서로 보여 준다. */
  last_activity_at: string;
  message: string | null;
  reply: string | null;
  status: HelpRequestStatus;
  /** 교사에게만 채운다. 학생은 자기 요청만 받으므로 null이다. */
  student: { display_name: string; member_id: string; student_number: number | null } | null;
  /** 글과 무관한 대화(general)는 null이다. */
  target: { id: string; kind: HelpRequestTargetKind; title: string } | null;
}

export interface HelpRequestMessage {
  author: "student" | "teacher";
  body: string;
  created_at: string;
  id: string;
}

export interface HelpRequestThread {
  /** 오래된 것부터. 요청의 첫 설명(message)·예전 답변(reply)은 request에 따로 있다. */
  messages: HelpRequestMessage[];
  request: HelpRequestItem;
}

export interface SendHelpMessageCommand {
  actorUserId: string;
  body: string;
  helpRequestId: string;
}

export interface StartGeneralHelpCommand {
  actorUserId: string;
  body: string;
}

export interface HelpRequestListResult {
  items: HelpRequestItem[];
}

export interface ListHelpRequestsQuery {
  actorUserId: string;
  status: "open" | "all";
  target?: { id: string; kind: HelpRequestTargetKind };
}

export interface CreateHelpRequestCommand {
  actorUserId: string;
  kind: Exclude<HelpRequestKind, "general">;
  message: string | null;
  target: { id: string; kind: HelpRequestTargetKind };
}

export interface CloseHelpRequestCommand {
  actorUserId: string;
  helpRequestId: string;
}

export interface ResolveHelpRequestCommand extends CloseHelpRequestCommand {
  reply: string | null;
}
