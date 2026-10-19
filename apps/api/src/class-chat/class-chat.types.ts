export type ClassChatRole = "student" | "teacher";

/** 학생이 지금 보낼 수 없는 이유. 담임은 늘 보낼 수 있다. */
export type ClassChatBlockedReason = "closed" | "night" | "muted";

export interface ClassChatAuthor {
  member_id: string;
  name: string;
  role: ClassChatRole;
  student_number: number | null;
}

export interface ClassChatMessage {
  id: string;
  author: ClassChatAuthor;
  /** 담임이 가린 메시지는 학생에게 null. 담임은 원문을 본다. */
  body: string | null;
  hidden: boolean;
  created_at: string;
  mine: boolean;
}

export interface ClassChatState {
  room: { is_open: boolean };
  me: {
    member_id: string;
    role: ClassChatRole;
    can_send: boolean;
    blocked_reason: ClassChatBlockedReason | null;
    muted_until: string | null;
  };
  messages: ClassChatMessage[];
  /** after 없이 최근 것만 돌려줄 때, 그보다 앞선 메시지가 더 있는지 */
  has_more_before: boolean;
  /** 담임에게만: 처리하지 않은 신고 수 */
  open_report_count: number | null;
}

export interface ClassChatReport {
  id: string;
  reason: string;
  created_at: string;
  reporter: ClassChatAuthor;
  message: ClassChatMessage;
}

export type ClassChatMuteDuration = "10m" | "1h" | "today";
