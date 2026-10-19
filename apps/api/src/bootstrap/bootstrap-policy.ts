import type { BootstrapAllowedAction, BootstrapDestination } from "./bootstrap.types.js";

export interface BootstrapPolicyInput {
  attendanceNotificationsEnabled?: boolean;
  classChatEnabled?: boolean;
  profilePhotosEnabled?: boolean;
  classStatus: "active" | "suspended" | null;
  electionsEnabled?: boolean;
  emailVerified: boolean;
  membershipRole: "student" | "teacher" | null;
  membershipStatus: "approved" | "pending" | null;
  pollsEnabled?: boolean;
  /** 운영 DB에 투표 수정 권한(원장 107·108)이 깔렸는지 — 투표 기능이 켜졌을 때만 의미가 있다. */
  pollEditInstalled?: boolean;
  signupApproved: boolean;
  signupRole?: string | null;
  studentAssessmentsEnabled?: boolean;
  teacherStatus: "active" | "revoked" | null;
  temporaryPasswordMustChange: boolean;
}

export interface BootstrapPolicyResult {
  allowedActions: BootstrapAllowedAction[];
  destination: BootstrapDestination;
}

const ACCOUNT_ACTIONS: BootstrapAllowedAction[] = ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT"];

export function decideBootstrapPolicy(input: BootstrapPolicyInput): BootstrapPolicyResult {
  if (input.teacherStatus === "revoked") {
    return {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT"],
      destination: "TEACHER_REVOKED",
    };
  }

  if (input.teacherStatus !== null && input.temporaryPasswordMustChange) {
    return {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT"],
      destination: "CHANGE_TEMPORARY_PASSWORD",
    };
  }

  if (
    !input.signupApproved &&
    (input.signupRole === "teacher" || (input.teacherStatus === null && !input.emailVerified))
  ) {
    return {
      allowedActions: ["CONFIRM_SIGNUP_APPROVAL", "LOGOUT", "DELETE_ACCOUNT"],
      destination: "SIGNUP_APPROVAL_REQUIRED",
    };
  }

  if (input.membershipStatus === "approved" && input.classStatus === "active") {
    return input.membershipRole === "teacher"
      ? {
          allowedActions: [
            "CHANGE_PASSWORD",
            "LOGOUT",
            "VIEW_CLASS",
            "MANAGE_CLASS",
            ...(input.attendanceNotificationsEnabled
              ? (["MANAGE_ATTENDANCE_NOTIFICATIONS"] as const)
              : []),
            ...(input.pollsEnabled ? (["MANAGE_POLLS"] as const) : []),
            ...(input.pollsEnabled && input.pollEditInstalled ? (["EDIT_POLLS"] as const) : []),
            ...(input.electionsEnabled ? (["MANAGE_ELECTIONS"] as const) : []),
            ...(input.classChatEnabled ? (["USE_CLASS_CHAT"] as const) : []),
            ...(input.profilePhotosEnabled ? (["USE_PROFILE_PHOTOS"] as const) : []),
          ],
          destination: "HOME",
        }
      : {
          allowedActions: [
            ...ACCOUNT_ACTIONS,
            "LEAVE_CLASS",
            "VIEW_CLASS",
            ...(input.attendanceNotificationsEnabled
              ? (["MANAGE_OWN_ATTENDANCE_NOTIFICATION"] as const)
              : []),
            ...(input.studentAssessmentsEnabled ? (["MANAGE_OWN_ASSESSMENTS"] as const) : []),
            ...(input.pollsEnabled ? (["VOTE_IN_POLLS"] as const) : []),
            /* 학생에게는 "투표한다"만 준다 — 개표·발표는 교사 쪽 권한이다. */
            ...(input.electionsEnabled ? (["VOTE_IN_ELECTIONS"] as const) : []),
            ...(input.classChatEnabled ? (["USE_CLASS_CHAT"] as const) : []),
            ...(input.profilePhotosEnabled ? (["USE_PROFILE_PHOTOS"] as const) : []),
          ],
          destination: "HOME",
        };
  }

  if (input.membershipStatus === "approved" && input.classStatus === "suspended") {
    return {
      allowedActions:
        input.membershipRole === "student"
          ? [...ACCOUNT_ACTIONS, "LEAVE_CLASS"]
          : ["CHANGE_PASSWORD", "LOGOUT"],
      destination: "CLASS_SUSPENDED",
    };
  }

  if (input.membershipStatus === "pending") {
    return {
      allowedActions: [...ACCOUNT_ACTIONS, "CANCEL_MEMBERSHIP_REQUEST"],
      destination: "MEMBERSHIP_PENDING",
    };
  }

  if (input.teacherStatus === "active") {
    return {
      allowedActions: [...ACCOUNT_ACTIONS, "CREATE_CLASS"],
      destination: "CREATE_CLASS",
    };
  }

  return {
    allowedActions: [...ACCOUNT_ACTIONS, "ENTER_INVITE_CODE"],
    destination: "ENTER_INVITE_CODE",
  };
}
