import { describe, expect, it } from "vitest";

import { decideBootstrapPolicy, type BootstrapPolicyInput } from "./bootstrap-policy.js";

const studentWithoutMembership: BootstrapPolicyInput = {
  classStatus: null,
  emailVerified: true,
  membershipRole: null,
  membershipStatus: null,
  signupApproved: false,
  teacherStatus: null,
  temporaryPasswordMustChange: false,
};

describe("bootstrap destination policy", () => {
  it("keeps email-verified teachers awaiting administrator approval", () => {
    expect(decideBootstrapPolicy({ ...studentWithoutMembership, signupRole: "teacher" })).toEqual({
      destination: "SIGNUP_APPROVAL_REQUIRED",
      allowedActions: ["CONFIRM_SIGNUP_APPROVAL", "LOGOUT", "DELETE_ACCOUNT"],
    });
  });
  it.each([
    {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT"],
      destination: "TEACHER_REVOKED",
      input: {
        ...studentWithoutMembership,
        teacherStatus: "revoked",
        temporaryPasswordMustChange: true,
      },
    },
    {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT"],
      destination: "CHANGE_TEMPORARY_PASSWORD",
      input: {
        ...studentWithoutMembership,
        teacherStatus: "active",
        temporaryPasswordMustChange: true,
      },
    },
    {
      allowedActions: ["CONFIRM_SIGNUP_APPROVAL", "LOGOUT", "DELETE_ACCOUNT"],
      destination: "SIGNUP_APPROVAL_REQUIRED",
      input: { ...studentWithoutMembership, emailVerified: false },
    },
    {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "ENTER_INVITE_CODE"],
      destination: "ENTER_INVITE_CODE",
      input: {
        ...studentWithoutMembership,
        emailVerified: false,
        signupApproved: true,
      },
    },
    {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "LEAVE_CLASS", "VIEW_CLASS"],
      destination: "HOME",
      input: {
        ...studentWithoutMembership,
        classStatus: "active",
        membershipRole: "student",
        membershipStatus: "approved",
      },
    },
    {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "LEAVE_CLASS"],
      destination: "CLASS_SUSPENDED",
      input: {
        ...studentWithoutMembership,
        classStatus: "suspended",
        membershipRole: "student",
        membershipStatus: "approved",
      },
    },
    {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "CANCEL_MEMBERSHIP_REQUEST"],
      destination: "MEMBERSHIP_PENDING",
      input: {
        ...studentWithoutMembership,
        classStatus: "active",
        membershipRole: "student",
        membershipStatus: "pending",
      },
    },
    {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "CREATE_CLASS"],
      destination: "CREATE_CLASS",
      input: { ...studentWithoutMembership, teacherStatus: "active" },
    },
    {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "ENTER_INVITE_CODE"],
      destination: "ENTER_INVITE_CODE",
      input: studentWithoutMembership,
    },
  ] as const)(
    "selects $destination in PRD 4.8 priority order with exact actions",
    ({ allowedActions, destination, input }) => {
      const result = decideBootstrapPolicy(input);
      expect(result.destination).toBe(destination);
      expect(result.allowedActions).toEqual(allowedActions);
    },
  );

  it("adds the private assessment action only for an approved student when enabled", () => {
    expect(
      decideBootstrapPolicy({
        ...studentWithoutMembership,
        classStatus: "active",
        membershipRole: "student",
        membershipStatus: "approved",
        studentAssessmentsEnabled: true,
      }),
    ).toEqual({
      allowedActions: [
        "CHANGE_PASSWORD",
        "LOGOUT",
        "DELETE_ACCOUNT",
        "LEAVE_CLASS",
        "VIEW_CLASS",
        "MANAGE_OWN_ASSESSMENTS",
      ],
      destination: "HOME",
    });

    expect(
      decideBootstrapPolicy({
        ...studentWithoutMembership,
        classStatus: "active",
        membershipRole: "teacher",
        membershipStatus: "approved",
        studentAssessmentsEnabled: true,
        teacherStatus: "active",
      }).allowedActions,
    ).not.toContain("MANAGE_OWN_ASSESSMENTS");
  });

  it("exposes separate teacher and student attendance actions only when enabled", () => {
    expect(
      decideBootstrapPolicy({
        ...studentWithoutMembership,
        attendanceNotificationsEnabled: true,
        classStatus: "active",
        membershipRole: "teacher",
        membershipStatus: "approved",
        teacherStatus: "active",
      }).allowedActions,
    ).toContain("MANAGE_ATTENDANCE_NOTIFICATIONS");
    expect(
      decideBootstrapPolicy({
        ...studentWithoutMembership,
        attendanceNotificationsEnabled: true,
        classStatus: "active",
        membershipRole: "student",
        membershipStatus: "approved",
      }).allowedActions,
    ).toContain("MANAGE_OWN_ATTENDANCE_NOTIFICATION");

    const disabledStudent = decideBootstrapPolicy({
      ...studentWithoutMembership,
      classStatus: "active",
      membershipRole: "student",
      membershipStatus: "approved",
    });
    expect(disabledStudent.allowedActions).not.toContain("MANAGE_OWN_ATTENDANCE_NOTIFICATION");
    expect(disabledStudent.allowedActions).not.toContain("MANAGE_ATTENDANCE_NOTIFICATIONS");
  });

  it("exposes separate teacher-manage and student-vote poll actions only when enabled", () => {
    expect(
      decideBootstrapPolicy({
        ...studentWithoutMembership,
        classStatus: "active",
        membershipRole: "teacher",
        membershipStatus: "approved",
        pollsEnabled: true,
        teacherStatus: "active",
      }).allowedActions,
    ).toContain("MANAGE_POLLS");
    expect(
      decideBootstrapPolicy({
        ...studentWithoutMembership,
        classStatus: "active",
        membershipRole: "student",
        membershipStatus: "approved",
        pollsEnabled: true,
      }).allowedActions,
    ).toContain("VOTE_IN_POLLS");

    const disabledStudent = decideBootstrapPolicy({
      ...studentWithoutMembership,
      classStatus: "active",
      membershipRole: "student",
      membershipStatus: "approved",
    });
    expect(disabledStudent.allowedActions).not.toContain("VOTE_IN_POLLS");
    expect(disabledStudent.allowedActions).not.toContain("MANAGE_POLLS");
  });

  it("offers poll editing to teachers only when polls are on and ledger 107-108 is installed", () => {
    const activeClass = {
      ...studentWithoutMembership,
      classStatus: "active" as const,
      membershipStatus: "approved" as const,
    };
    const teacher = {
      ...activeClass,
      membershipRole: "teacher" as const,
      teacherStatus: "active" as const,
    };
    expect(
      decideBootstrapPolicy({ ...teacher, pollsEnabled: true, pollEditInstalled: true })
        .allowedActions,
    ).toContain("EDIT_POLLS");
    for (const flags of [{ pollsEnabled: true }, { pollEditInstalled: true }])
      expect(decideBootstrapPolicy({ ...teacher, ...flags }).allowedActions).not.toContain(
        "EDIT_POLLS",
      );
    expect(
      decideBootstrapPolicy({
        ...activeClass,
        membershipRole: "student",
        pollsEnabled: true,
        pollEditInstalled: true,
      }).allowedActions,
    ).not.toContain("EDIT_POLLS");
  });

  it("gives the class chat to approved teachers and students only while the switch is on", () => {
    const approved = {
      ...studentWithoutMembership,
      classStatus: "active",
      membershipStatus: "approved",
    } as const;
    for (const membershipRole of ["student", "teacher"] as const) {
      expect(
        decideBootstrapPolicy({ ...approved, classChatEnabled: true, membershipRole })
          .allowedActions,
      ).toContain("USE_CLASS_CHAT");
      expect(decideBootstrapPolicy({ ...approved, membershipRole }).allowedActions).not.toContain(
        "USE_CLASS_CHAT",
      );
    }
    expect(
      decideBootstrapPolicy({
        ...approved,
        classChatEnabled: true,
        classStatus: "suspended",
        membershipRole: "student",
      }).allowedActions,
    ).not.toContain("USE_CLASS_CHAT");
  });

  it("gives profile photos to approved members of an active class only while the switch is on", () => {
    const approved = {
      ...studentWithoutMembership,
      classStatus: "active",
      membershipStatus: "approved",
    } as const;
    for (const membershipRole of ["student", "teacher"] as const) {
      expect(
        decideBootstrapPolicy({ ...approved, profilePhotosEnabled: true, membershipRole })
          .allowedActions,
      ).toContain("USE_PROFILE_PHOTOS");
      expect(decideBootstrapPolicy({ ...approved, membershipRole }).allowedActions).not.toContain(
        "USE_PROFILE_PHOTOS",
      );
    }
    for (const blocked of [
      { classStatus: "suspended", membershipStatus: "approved" },
      { classStatus: null, membershipStatus: "pending" },
    ] as const)
      expect(
        decideBootstrapPolicy({
          ...studentWithoutMembership,
          ...blocked,
          profilePhotosEnabled: true,
          membershipRole: "student",
        }).allowedActions,
      ).not.toContain("USE_PROFILE_PHOTOS");
  });

  it("never grants retired seat, team or duty actions to teachers or students", () => {
    // P-016 은퇴, 2026-10-03 설정 스위치·권한 이름 삭제. 어떤 역할에도 그 이름의 권한이 나가지 않는다.
    for (const role of ["teacher", "student"] as const) {
      const actions = decideBootstrapPolicy({
        ...studentWithoutMembership,
        classStatus: "active",
        membershipRole: role,
        membershipStatus: "approved",
        ...(role === "teacher" ? { teacherStatus: "active" as const } : {}),
      }).allowedActions;
      expect(actions.filter((action) => /SEAT|TEAM_DRAW|DUTY/u.test(action))).toEqual([]);
    }
  });

  it.each([
    {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
      destination: "HOME",
      label: "active",
      overrides: {
        classStatus: "active",
        teacherStatus: "active",
        temporaryPasswordMustChange: false,
      },
    },
    {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT"],
      destination: "CLASS_SUSPENDED",
      label: "suspended",
      overrides: {
        classStatus: "suspended",
        teacherStatus: "active",
        temporaryPasswordMustChange: false,
      },
    },
    {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT"],
      destination: "TEACHER_REVOKED",
      label: "revoked",
      overrides: {
        classStatus: "suspended",
        teacherStatus: "revoked",
        temporaryPasswordMustChange: false,
      },
    },
    {
      allowedActions: ["CHANGE_PASSWORD", "LOGOUT"],
      destination: "CHANGE_TEMPORARY_PASSWORD",
      label: "temporary-password",
      overrides: {
        classStatus: "active",
        teacherStatus: "active",
        temporaryPasswordMustChange: true,
      },
    },
  ] as const)(
    "does not offer account deletion to an approved teacher with a $label class",
    ({ allowedActions, destination, overrides }) => {
      expect(
        decideBootstrapPolicy({
          ...studentWithoutMembership,
          ...overrides,
          membershipRole: "teacher",
          membershipStatus: "approved",
        }),
      ).toEqual({ allowedActions, destination });
    },
  );
});
