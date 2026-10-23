export type ManageableMemberStatus = "pending" | "approved" | "removed" | "rejoin_allowed";

export interface MemberListItem {
  account_state: "active" | "inactive";
  /** 생년월일 칸이 설치된 환경에서만. 담임용 목록·프로필에만 붙는다. */
  birth_date?: string | null;
  display_name: string;
  display_name_in_class: string | null;
  email_masked?: string;
  /** 목록에만. 지금 사진을 받을 수 있으면 true — 화면은 true일 때만 사진을 요청한다. */
  has_profile_photo?: boolean;
  id: string;
  requested_at: string | null;
  row_version: string;
  status: ManageableMemberStatus;
  status_changed_at: string;
  student_number: number | null;
}

export interface ListMembersResult {
  members: MemberListItem[];
}

export interface GetMemberProfileResult {
  member: MemberListItem;
}

export interface ApproveMemberCommand {
  actorUserId: string;
  displayNameInClass: string | null;
  memberId: string;
  requestId: string;
  studentNumber: number | null;
}

export interface ApproveMemberResult {
  email_delivery_status?: "failed" | "sent";
  member: MemberListItem;
  warnings: Array<"EXPECTED_STUDENT_COUNT_EXCEEDED">;
}

export interface UpdateMemberProfileCommand {
  actorUserId: string;
  displayNameInClass?: string | null;
  expectedRowVersion: string;
  memberId: string;
  requestId: string;
  studentNumber?: number | null;
}

export interface UpdateMemberProfileResult {
  member: MemberListItem;
  profile_updated: boolean;
}

export type MemberTransitionStatus = "rejected" | "removed" | "rejoin_allowed";

export interface MemberTransitionCommand {
  actorUserId: string;
  memberId: string;
  reason: string | null;
  requestId: string;
}

export interface MemberTransitionResult {
  email_delivery_status?: "failed" | "sent";
  member: {
    id: string;
    reason: string | null;
    row_version: string;
    status: MemberTransitionStatus;
    status_changed_at: string;
  };
}
