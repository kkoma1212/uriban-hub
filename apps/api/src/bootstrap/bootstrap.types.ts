export const BOOTSTRAP_DESTINATIONS = [
  "TEACHER_REVOKED",
  "CHANGE_TEMPORARY_PASSWORD",
  "VERIFY_EMAIL",
  "SIGNUP_APPROVAL_REQUIRED",
  "HOME",
  "CLASS_SUSPENDED",
  "MEMBERSHIP_PENDING",
  "CREATE_CLASS",
  "ENTER_INVITE_CODE",
] as const;

export type BootstrapDestination = (typeof BOOTSTRAP_DESTINATIONS)[number];

export const BOOTSTRAP_ALLOWED_ACTIONS = [
  "RESEND_EMAIL",
  "CONFIRM_EMAIL",
  "CONFIRM_SIGNUP_APPROVAL",
  "CHANGE_PASSWORD",
  "LOGOUT",
  "DELETE_ACCOUNT",
  "CREATE_CLASS",
  "ENTER_INVITE_CODE",
  "CANCEL_MEMBERSHIP_REQUEST",
  "LEAVE_CLASS",
  "VIEW_CLASS",
  "MANAGE_CLASS",
  "MANAGE_ATTENDANCE_NOTIFICATIONS",
  "MANAGE_OWN_ATTENDANCE_NOTIFICATION",
  "MANAGE_OWN_ASSESSMENTS",
  "MANAGE_POLLS",
  "EDIT_POLLS",
  "VOTE_IN_POLLS",
  "USE_CLASS_CHAT",
  "USE_PROFILE_PHOTOS",
  "MANAGE_ELECTIONS",
  "VOTE_IN_ELECTIONS",
] as const;

export type BootstrapAllowedAction = (typeof BOOTSTRAP_ALLOWED_ACTIONS)[number];

export interface BootstrapResult {
  account: {
    display_name: string;
    email_verified: boolean;
    is_active: boolean;
    signup_role?: "student" | "teacher" | null;
  };
  allowed_actions: BootstrapAllowedAction[];
  current_class: null | {
    id: string;
    name: string;
    school_address: string | null;
    school_homepage_url: string | null;
    school_name: string;
    school_phone_number: string | null;
    status: "active" | "suspended";
  };
  current_membership: null | {
    class_id: string;
    display_name_in_class: string | null;
    id: string;
    student_number: number | null;
    role: "student" | "teacher";
    status: "approved" | "pending";
  };
  destination: BootstrapDestination;
  last_membership_status: string | null;
  last_status_reason: string | null;
  server_today: string;
  teacher_profile: null | {
    status: "active" | "revoked";
    temporary_password_must_change: boolean;
  };
}
