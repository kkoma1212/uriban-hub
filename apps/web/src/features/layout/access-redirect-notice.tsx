import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import type { BootstrapResponse } from "../../api/auth";

export const ACCESS_REDIRECT_NOTICE = {
  STUDENT_ONLY: "student_only",
  TEACHER_ONLY: "teacher_only",
} as const;

export type AccessRedirectNotice =
  (typeof ACCESS_REDIRECT_NOTICE)[keyof typeof ACCESS_REDIRECT_NOTICE];

export interface AccessRedirectNavigationState {
  accessRedirectNotice: AccessRedirectNotice;
}

export const TEACHER_ONLY_ACCESS_MESSAGE = "선생님 전용 기능이라 홈으로 돌아왔어요.";
export const STUDENT_ONLY_ACCESS_MESSAGE = "학생 전용 기능이라 홈으로 돌아왔어요.";

const TEACHER_ONLY_ACCESS_NAVIGATION_STATE: AccessRedirectNavigationState = {
  accessRedirectNotice: ACCESS_REDIRECT_NOTICE.TEACHER_ONLY,
};
const STUDENT_ONLY_ACCESS_NAVIGATION_STATE: AccessRedirectNavigationState = {
  accessRedirectNotice: ACCESS_REDIRECT_NOTICE.STUDENT_ONLY,
};

type TeacherOnlyBootstrap = Pick<
  BootstrapResponse,
  "allowed_actions" | "current_membership" | "destination"
>;

export type TeacherOnlyAccessRedirect =
  { path: "/bootstrap" } | { path: "/home"; state: AccessRedirectNavigationState };

type StudentOnlyAccessRedirect = TeacherOnlyAccessRedirect | { path: "/home" };

export function teacherOnlyAccessRedirect(
  bootstrap: TeacherOnlyBootstrap,
): TeacherOnlyAccessRedirect | null {
  if (bootstrap.destination !== "HOME") return { path: "/bootstrap" };
  if (
    bootstrap.current_membership?.role !== "teacher" ||
    !bootstrap.allowed_actions.includes("MANAGE_CLASS")
  ) {
    return { path: "/home", state: TEACHER_ONLY_ACCESS_NAVIGATION_STATE };
  }
  return null;
}

export function studentOnlyAccessRedirect(
  bootstrap: TeacherOnlyBootstrap,
): StudentOnlyAccessRedirect | null {
  if (bootstrap.destination !== "HOME") return { path: "/bootstrap" };
  if (bootstrap.current_membership?.role !== "student") {
    return { path: "/home", state: STUDENT_ONLY_ACCESS_NAVIGATION_STATE };
  }
  if (!bootstrap.allowed_actions.includes("MANAGE_OWN_ASSESSMENTS")) return { path: "/home" };
  return null;
}

function accessRedirectNoticeFromState(state: unknown): AccessRedirectNotice | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const keys = Object.keys(state);
  if (keys.length !== 1 || keys[0] !== "accessRedirectNotice") return undefined;
  const value = (state as Partial<AccessRedirectNavigationState>).accessRedirectNotice;
  return Object.values(ACCESS_REDIRECT_NOTICE).includes(value as AccessRedirectNotice)
    ? value
    : undefined;
}

export function AccessRedirectNoticeBanner(): React.JSX.Element | null {
  const location = useLocation();
  const navigate = useNavigate();
  const routedNotice = accessRedirectNoticeFromState(location.state);
  const [notice, setNotice] = useState<AccessRedirectNotice | undefined>(routedNotice);

  useEffect(() => {
    if (routedNotice === undefined) return;
    setNotice(routedNotice);
    void navigate(
      {
        hash: location.hash,
        pathname: location.pathname,
        search: location.search,
      },
      { replace: true, state: null },
    );
  }, [location.hash, location.pathname, location.search, navigate, routedNotice]);

  if (notice === undefined) return null;
  const teacherOnly = notice === ACCESS_REDIRECT_NOTICE.TEACHER_ONLY;
  return (
    <p
      className="mt-3 rounded-2xl border border-home-schedule-line bg-home-schedule-soft px-4 py-3 text-sm font-bold text-home-schedule"
      data-access-redirect-notice={teacherOnly ? "teacher-only" : "student-only"}
      role="status"
    >
      {teacherOnly ? TEACHER_ONLY_ACCESS_MESSAGE : STUDENT_ONLY_ACCESS_MESSAGE}
    </p>
  );
}
