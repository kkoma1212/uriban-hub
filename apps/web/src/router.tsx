import { createBrowserRouter } from "react-router";
import type { RouteObject } from "react-router";

import {
  RouteErrorBoundary,
  RouteHydrationFallback,
  RouteRuntime,
} from "./features/layout/router-runtime";
import { routeMetadataForPattern } from "./features/layout/app-route-metadata";

const childRoutes: RouteObject[] = [
  {
    /*
     * 첫 진입은 로그인이다(2026-08-10 Hex 결정). 이 서비스는 이미 반에 들어와 있는
     * 사람이 매일 다시 오는 곳이라, 올 때마다 가입 화면을 먼저 보여줄 이유가 없다.
     * 가입은 `/sign-up`으로 남아 있고 로그인 화면에서 눌러 갈 수 있다.
     */
    path: "/",
    lazy: async () => {
      const module = await import("./features/auth/login-page");
      return { Component: module.LoginPage };
    },
  },
  {
    path: "/sign-up",
    lazy: async () => {
      const module = await import("./app");
      return { Component: module.App };
    },
  },
  {
    path: "/login",
    lazy: async () => {
      const module = await import("./features/auth/login-page");
      return { Component: module.LoginPage };
    },
  },
  {
    path: "/demo",
    lazy: async () => {
      const module = await import("./features/demo/demo-page");
      return { Component: module.DemoPage };
    },
  },
  {
    // QR 합류: 초대 코드를 담아 두고 참여 화면으로 보낸다.
    path: "/join",
    lazy: async () => {
      const module = await import("./features/bootstrap/join-invite-page");
      return { Component: module.JoinInvitePage };
    },
  },
  {
    path: "/bootstrap",
    lazy: async () => {
      const module = await import("./features/bootstrap/bootstrap-page");
      return { Component: module.BootstrapPage };
    },
  },
  {
    path: "/legal/terms",
    lazy: async () => {
      const module = await import("./features/legal/legal-document-page");
      return { Component: module.LegalDocumentPage };
    },
  },
  {
    path: "/legal/privacy-consent",
    lazy: async () => {
      const module = await import("./features/legal/legal-document-page");
      return { Component: module.LegalDocumentPage };
    },
  },
  {
    path: "/legal/privacy-policy",
    lazy: async () => {
      const module = await import("./features/legal/legal-document-page");
      return { Component: module.LegalDocumentPage };
    },
  },
  {
    path: "/legal/guardian-consent",
    lazy: async () => {
      const module = await import("./features/legal/legal-document-page");
      return { Component: module.LegalDocumentPage };
    },
  },
  {
    path: "/account/profile",
    lazy: async () => {
      const module = await import("./features/account/account-profile-page");
      return { Component: module.AccountProfilePage };
    },
  },
  {
    path: "/account/social",
    lazy: async () => {
      const module = await import("./features/account/social-connections-page");
      return { Component: module.SocialConnectionsPage };
    },
  },
  {
    path: "/account/password",
    lazy: async () => {
      const module = await import("./features/account/change-password-page");
      return { Component: module.ChangePasswordPage };
    },
  },
  {
    path: "/account/deletion",
    lazy: async () => {
      const module = await import("./features/account/account-deletion-page");
      return { Component: module.AccountDeletionPage };
    },
  },
  {
    path: "/home",
    lazy: async () => {
      const module = await import("./features/home/home-page");
      return { Component: module.HomePage };
    },
  },
  {
    path: "/members/manage",
    lazy: async () => {
      const module = await import("./features/members/member-management-page");
      return { Component: module.MemberManagementPage };
    },
  },
  {
    path: "/members/manage/:memberId",
    lazy: async () => {
      const module = await import("./features/members/member-profile-management-page");
      return { Component: module.MemberProfileManagementPage };
    },
  },
  {
    path: "/class/archive",
    lazy: async () => {
      const module = await import("./features/classes/teacher-class-archive-page");
      return { Component: module.TeacherClassArchivePage };
    },
  },
  {
    path: "/class/manage/audit-logs",
    lazy: async () => {
      const module = await import("./features/classes/teacher-audit-logs-page");
      return { Component: module.TeacherAuditLogsPage };
    },
  },
  {
    path: "/class/manage",
    lazy: async () => {
      const module = await import("./features/classes/teacher-class-management-page");
      return { Component: module.TeacherClassManagementPage };
    },
  },
  {
    path: "/class/create",
    lazy: async () => {
      const module = await import("./features/classes/teacher-class-create-page");
      return { Component: module.TeacherClassCreatePage };
    },
  },
  {
    path: "/settings",
    lazy: async () => {
      const module = await import("./features/settings/student-settings-page");
      return { Component: module.StudentSettingsPage };
    },
  },
  {
    path: "/updates/catch-up",
    lazy: async () => {
      const module = await import("./features/updates/student-catch-up-page");
      return { Component: module.StudentCatchUpPage };
    },
  },
  {
    path: "/updates/followups",
    lazy: async () => {
      const module = await import("./features/updates/student-followups-page");
      return { Component: module.StudentFollowupsPage };
    },
  },
  {
    path: "/updates/reuse/:kind/:sourceId",
    lazy: async () => {
      const module = await import("./features/updates/content-reuse-page");
      return { Component: module.ContentReusePage };
    },
  },
  {
    path: "/updates",
    lazy: async () => {
      const module = await import("./features/updates/updates-page");
      return { Component: module.UpdatesPage };
    },
  },
  {
    path: "/attendance",
    lazy: async () => {
      const module = await import("./features/attendance/attendance-page");
      return { Component: module.AttendancePage };
    },
  },
  {
    path: "/activities",
    lazy: async () => {
      const module = await import("./features/activities/activities-page");
      return { Component: module.ActivitiesPage };
    },
  },
  {
    path: "/past-classes",
    lazy: async () => {
      const module = await import("./features/past-classes/past-classes-page");
      return { Component: module.PastClassesPage };
    },
  },
  {
    path: "/past-classes/:classId",
    lazy: async () => {
      const module = await import("./features/past-classes/past-class-updates-page");
      return { Component: module.PastClassUpdatesPage };
    },
  },
  {
    path: "/more",
    lazy: async () => {
      const module = await import("./features/more/more-page");
      return { Component: module.MorePage };
    },
  },
  {
    path: "/polls",
    lazy: async () => {
      const module = await import("./features/polls/polls-page");
      return { Component: module.PollsPage };
    },
  },
  {
    path: "/polls/:pollId",
    lazy: async () => {
      const module = await import("./features/polls/poll-detail-page");
      return { Component: module.PollDetailPage };
    },
  },
  {
    path: "/elections",
    lazy: async () => {
      const module = await import("./features/elections/elections-page");
      return { Component: module.ElectionsPage };
    },
  },
  {
    path: "/supplies",
    lazy: async () => {
      const module = await import("./features/supplies/supplies-page");
      return { Component: module.SuppliesPage };
    },
  },
  {
    path: "/supplies/:supplyId",
    lazy: async () => {
      const module = await import("./features/supplies/supply-detail-page");
      return { Component: module.SupplyDetailPage };
    },
  },
  {
    path: "/notices",
    lazy: async () => {
      const module = await import("./features/notices/notices-page");
      return { Component: module.NoticesPage };
    },
  },
  {
    path: "/notices/:noticeId",
    lazy: async () => {
      const module = await import("./features/notices/notice-detail-page");
      return { Component: module.NoticeDetailPage };
    },
  },
  {
    path: "/help-requests",
    lazy: async () => {
      const module = await import("./features/help-requests/help-requests-page");
      return { Component: module.HelpRequestsPage };
    },
  },
  {
    // ':helpRequestId'보다 먼저 둔다 — 'ask'가 대화 번호로 읽히지 않게.
    path: "/help-requests/ask",
    lazy: async () => {
      const module = await import("./features/help-requests/help-thread-page");
      return { Component: module.AskTeacherPage };
    },
  },
  {
    path: "/help-requests/:helpRequestId",
    lazy: async () => {
      const module = await import("./features/help-requests/help-thread-page");
      return { Component: module.HelpThreadPage };
    },
  },
  {
    path: "/class-chat",
    lazy: async () => {
      const module = await import("./features/class-chat/class-chat-page");
      return { Component: module.ClassChatPage };
    },
  },
  {
    path: "/schedules",
    lazy: async () => {
      const module = await import("./features/schedules/schedules-page");
      return { Component: module.SchedulesPage };
    },
  },
  {
    path: "/schedules/:scheduleId/change-review",
    lazy: async () => {
      const module = await import("./features/schedules/schedule-change-review-page");
      return { Component: module.ScheduleChangeReviewPage };
    },
  },
  {
    path: "/schedules/:scheduleId",
    lazy: async () => {
      const module = await import("./features/schedules/schedule-detail-page");
      return { Component: module.ScheduleDetailPage };
    },
  },
  {
    path: "/assessments",
    lazy: async () => {
      const module = await import("./features/assessments/student-assessments-page");
      return { Component: module.StudentAssessmentsPage };
    },
  },
  {
    path: "/meals",
    lazy: async () => {
      const module = await import("./features/meals/meals-page");
      return { Component: module.MealsPage };
    },
  },
  {
    path: "/verify-email",
    lazy: async () => {
      const module = await import("./features/auth/verify-email-page");
      return { Component: module.VerifyEmailPage };
    },
  },
  {
    path: "/guardian-consent",
    lazy: async () => {
      const module = await import("./features/auth/guardian-consent-page");
      return { Component: module.GuardianConsentPage };
    },
  },
  {
    path: "/forgot-account",
    lazy: async () => {
      const module = await import("./features/auth/forgot-account-page");
      return { Component: module.ForgotAccountPage };
    },
  },
  {
    path: "/forgot-password",
    lazy: async () => {
      const module = await import("./features/auth/forgot-password-page");
      return { Component: module.ForgotPasswordPage };
    },
  },
  {
    path: "/reset-password",
    lazy: async () => {
      const module = await import("./features/auth/reset-password-page");
      return { Component: module.ResetPasswordPage };
    },
  },
];

// 관리자 경로는 이 이용자 화면 묶음에 넣지 않는다. 관리자 화면은 admin-router.tsx의 별도 묶음이다
// (T-ADMIN-SPLIT, 2026-10-07 사용자 결정).

if (import.meta.env.DEV) {
  childRoutes.push({
    path: "/local-test-admin",
    lazy: async () => {
      const module = await import("./features/local-test-admin/local-test-admin-page");
      return { Component: module.LocalTestAdminPage };
    },
  });
}

childRoutes.push({
  path: "*",
  lazy: async () => {
    const module = await import("./features/layout/not-found-page");
    return { Component: module.NotFoundPage };
  },
});

export const routes: RouteObject[] = [
  {
    element: <RouteRuntime />,
    errorElement: <RouteErrorBoundary />,
    hydrateFallbackElement: <RouteHydrationFallback />,
    children: childRoutes.map((route) => {
      const metadata = route.path === undefined ? undefined : routeMetadataForPattern(route.path);
      return metadata === undefined ? route : { ...route, handle: { routeMetadata: metadata } };
    }),
  },
];

export const router = createBrowserRouter(routes);
