import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BootstrapResponse } from "../../api/auth";
import { TeacherAuditLogsPage } from "../classes/teacher-audit-logs-page";
import { TeacherClassManagementPage } from "../classes/teacher-class-management-page";
import { MemberManagementPage } from "../members/member-management-page";
import {
  ACCESS_REDIRECT_NOTICE,
  AccessRedirectNoticeBanner,
  studentOnlyAccessRedirect,
  STUDENT_ONLY_ACCESS_MESSAGE,
  teacherOnlyAccessRedirect,
  TEACHER_ONLY_ACCESS_MESSAGE,
} from "./access-redirect-notice";

const teacherMembership: NonNullable<BootstrapResponse["current_membership"]> = {
  class_id: "41",
  display_name_in_class: null,
  id: "51",
  role: "teacher",
  status: "approved",
  student_number: null,
};

const teacherAccess: Pick<
  BootstrapResponse,
  "allowed_actions" | "current_membership" | "destination"
> = {
  allowed_actions: ["MANAGE_CLASS"],
  current_membership: teacherMembership,
  destination: "HOME",
};

const studentBootstrap: BootstrapResponse = {
  account: { display_name: "테스트 학생", email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS"],
  current_class: { id: "41", name: "테스트 1반", status: "active" },
  current_membership: {
    ...teacherMembership,
    role: "student",
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-25",
  teacher_profile: null,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function HomeStateProbe(): React.JSX.Element {
  const location = useLocation();
  return <span data-testid="home-state">{JSON.stringify(location.state)}</span>;
}

const teacherOnlyPages = [
  {
    Component: TeacherClassManagementPage,
    label: "반 관리",
    path: "/class/manage",
  },
  {
    Component: TeacherAuditLogsPage,
    label: "감사 로그",
    path: "/class/manage/audit-logs",
  },
  {
    Component: MemberManagementPage,
    label: "멤버 관리",
    path: "/members/manage",
  },
] as const;

describe("teacher-only access redirect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps lifecycle destinations on bootstrap and limits HOME denials to one enum", () => {
    expect(teacherOnlyAccessRedirect(teacherAccess)).toBeNull();
    expect(
      teacherOnlyAccessRedirect({
        ...teacherAccess,
        allowed_actions: ["VIEW_CLASS"],
      }),
    ).toEqual({
      path: "/home",
      state: { accessRedirectNotice: ACCESS_REDIRECT_NOTICE.TEACHER_ONLY },
    });
    expect(
      teacherOnlyAccessRedirect({
        ...teacherAccess,
        current_membership: {
          ...teacherMembership,
          role: "student",
        },
      }),
    ).toEqual({
      path: "/home",
      state: { accessRedirectNotice: ACCESS_REDIRECT_NOTICE.TEACHER_ONLY },
    });
    expect(
      teacherOnlyAccessRedirect({
        ...teacherAccess,
        destination: "MEMBERSHIP_PENDING",
      }),
    ).toEqual({ path: "/bootstrap" });
  });

  it.each(teacherOnlyPages)(
    "redirects a HOME student from $label without requesting teacher data",
    async ({ Component, path }) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = requestUrl(input);
        if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(studentBootstrap));
        throw new Error(`Unexpected teacher data request: ${url}`);
      });

      render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<Component />} path={path} />
            <Route element={<HomeStateProbe />} path="/home" />
            <Route element={<p>계정 상태 화면</p>} path="/bootstrap" />
          </Routes>
        </MemoryRouter>,
      );

      expect(await screen.findByTestId("home-state")).toHaveTextContent(
        JSON.stringify({
          accessRedirectNotice: ACCESS_REDIRECT_NOTICE.TEACHER_ONLY,
        }),
      );
      expect(screen.queryByText("계정 상태 화면")).not.toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(requestUrl(fetchMock.mock.calls[0]![0])).toBe("/api/v1/bootstrap");
    },
  );
});

describe("student-only access redirect", () => {
  it("requires both an approved student role and the enabled private action", () => {
    expect(
      studentOnlyAccessRedirect({
        allowed_actions: ["VIEW_CLASS", "MANAGE_OWN_ASSESSMENTS"],
        current_membership: studentBootstrap.current_membership,
        destination: "HOME",
      }),
    ).toBeNull();
    expect(
      studentOnlyAccessRedirect({
        allowed_actions: ["VIEW_CLASS"],
        current_membership: studentBootstrap.current_membership,
        destination: "HOME",
      }),
    ).toEqual({ path: "/home" });
    expect(studentOnlyAccessRedirect(teacherAccess)).toEqual({
      path: "/home",
      state: { accessRedirectNotice: ACCESS_REDIRECT_NOTICE.STUDENT_ONLY },
    });
    expect(
      studentOnlyAccessRedirect({
        ...teacherAccess,
        destination: "MEMBERSHIP_PENDING",
      }),
    ).toEqual({ path: "/bootstrap" });
  });
});

function HomeWithNotice(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <AccessRedirectNoticeBanner />
      <span data-testid="location-state">{JSON.stringify(location.state)}</span>
      <button onClick={() => void navigate("/other")} type="button">
        다른 화면
      </button>
    </>
  );
}

function OtherPage(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <button onClick={() => void navigate(-1)} type="button">
      뒤로
    </button>
  );
}

describe("AccessRedirectNoticeBanner", () => {
  it("shows the non-sensitive status once and consumes history state with replace", async () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/home",
            state: { accessRedirectNotice: ACCESS_REDIRECT_NOTICE.TEACHER_ONLY },
          },
        ]}
      >
        <Routes>
          <Route element={<HomeWithNotice />} path="/home" />
          <Route element={<OtherPage />} path="/other" />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(TEACHER_ONLY_ACCESS_MESSAGE);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("location-state")).toHaveTextContent("null"));

    fireEvent.click(screen.getByRole("button", { name: "다른 화면" }));
    fireEvent.click(await screen.findByRole("button", { name: "뒤로" }));

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("shows the student-only denial without exposing record details", () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/home",
            state: { accessRedirectNotice: ACCESS_REDIRECT_NOTICE.STUDENT_ONLY },
          },
        ]}
      >
        <Routes>
          <Route element={<HomeWithNotice />} path="/home" />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(STUDENT_ONLY_ACCESS_MESSAGE);
    expect(screen.getByRole("status")).toHaveAttribute(
      "data-access-redirect-notice",
      "student-only",
    );
  });
});
