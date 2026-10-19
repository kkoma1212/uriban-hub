import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BootstrapResponse } from "../../api/auth";
import { TeacherClassManagementPage } from "./teacher-class-management-page";

const bootstrapFixture: BootstrapResponse = {
  account: {
    display_name: "상태 검수 교사",
    email_verified: true,
    is_active: true,
  },
  allowed_actions: ["CHANGE_PASSWORD", "DELETE_ACCOUNT", "LOGOUT", "MANAGE_CLASS", "VIEW_CLASS"],
  current_class: { id: "41", name: "상태 검수 1반", status: "active" },
  current_membership: {
    class_id: "41",
    display_name_in_class: null,
    id: "51",
    role: "teacher",
    status: "approved",
    student_number: null,
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-28",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe("TeacherClassManagementPage loading shell", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the teacher shell and page heading while class data waits and fails", async () => {
    let resolveClass!: (response: Response) => void;
    const pendingClass = new Promise<Response>((resolve) => {
      resolveClass = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(bootstrapFixture));
      }
      if (url === "/api/v1/classes/current") return pendingClass;
      if (url === "/api/v1/classes/current/invite-code") {
        return Promise.resolve(jsonResponse({}));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/class/manage"]}>
        <Routes>
          <Route element={<TeacherClassManagementPage />} path="/class/manage" />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getAllByRole("navigation", { name: "주요 메뉴" })).toHaveLength(2),
    );
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "반 관리",
      }),
    ).toBeVisible();
    expect(
      screen.getByText("반 정보를 준비하고 있어요.").closest('[role="status"]'),
    ).toBeInTheDocument();

    await act(async () => {
      resolveClass(
        jsonResponse(
          {
            error: {
              code: "QA_FORCED_503",
              message: "INTERNAL_QA_DIAGNOSTIC private_class_table",
              request_id: "qa-class-management-load",
            },
          },
          503,
        ),
      );
    });

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "반 관리",
      }),
    ).toBeVisible();
    expect(
      screen.getByText("반 정보를 불러오지 못했어요.").closest('[role="alert"]'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: "주요 메뉴" })).toHaveLength(2);
    expect(screen.queryByText(/private_class_table/u)).not.toBeInTheDocument();
  });

  it("hides retired tools even when bootstrap still supplies legacy capabilities", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(
          jsonResponse({
            ...bootstrapFixture,
            allowed_actions: [
              ...bootstrapFixture.allowed_actions,
              "MANAGE_SEAT_DRAWS",
              "MANAGE_TEAM_DRAWS",
              "MANAGE_DUTY_ROSTERS",
            ],
          }),
        );
      }
      if (url === "/api/v1/classes/current") {
        return Promise.resolve(
          jsonResponse({
            academic_year: 2026,
            active_student_count: 28,
            expected_student_count: 30,
            grade: 2,
            id: "41",
            name: "긴 반 이름 검수 — 2026학년도 함께 배우는 우리 반",
            role: "teacher",
            row_version: "1",
            school_address: "경기도 검수시",
            school_homepage_url: null,
            school_name: "검수고등학교",
            school_phone_number: null,
            status: "active",
            teacher_display_name: "검수 교사",
          }),
        );
      }
      if (url === "/api/v1/classes/current/invite-code") {
        return Promise.resolve(
          jsonResponse({
            class_id: "41",
            invite_code: {
              code: "ABCDEFGH",
              created_at: "2026-07-28T00:00:00.000Z",
              expires_at: "2026-08-11T00:00:00.000Z",
              id: "71",
              status: "active",
            },
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/class/manage"]}>
        <Routes>
          <Route element={<TeacherClassManagementPage />} path="/class/manage" />
        </Routes>
      </MemoryRouter>,
    );

    const inviteHeading = await screen.findByRole("heading", { level: 2, name: "학생 초대" });
    expect(inviteHeading).toBeVisible();
    const overview = inviteHeading.closest("[data-class-management-overview]");
    expect(overview).toHaveClass("xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]", "items-start");
    expect(screen.getByRole("region", { name: "학생 초대" }).parentElement?.parentElement).toBe(
      overview,
    );
    expect(screen.getByRole("region", { name: "반 정보" }).parentElement?.parentElement).toBe(
      overview,
    );
    const classStatus = screen.getByLabelText("현재 반 상태");
    expect(classStatus).toHaveTextContent("긴 반 이름 검수 — 2026학년도 함께 배우는 우리 반");
    expect(classStatus).toHaveTextContent("승인 학생 28명");
    const className = screen.getByText("긴 반 이름 검수 — 2026학년도 함께 배우는 우리 반", {
      selector: "span[title]",
    });
    expect(className).not.toHaveClass("truncate");
    expect(className).toHaveClass("break-words", "sm:truncate");
    expect(classStatus).toHaveClass("flex-col", "sm:flex-row");
    const requests = screen.getAllByRole("link", { name: "학생 참여 요청 확인" });
    expect(requests).toHaveLength(1);
    const requestLink = screen.getByRole("link", { name: "학생 참여 요청 확인" });
    expect(requestLink).toHaveAttribute("href", "/members/manage");
    expect(requestLink).toHaveClass("min-h-11");
    expect(requestLink.closest("details")).toBeNull();
    expect(screen.getByRole("region", { name: "학생 초대" })).toContainElement(requestLink);
    expect(screen.getByLabelText("현재 반 상태").closest("header")).toContainElement(
      screen.getByRole("heading", { level: 1, name: "반 관리" }),
    );
    const qr = screen.getByRole("img", { name: "반 참여 QR 코드" });
    expect(qr).toHaveAttribute("width", "96");
    expect(qr.parentElement).toHaveClass("p-1.5");
    expect(screen.getByRole("region", { name: "학생 초대" })).toHaveClass("p-3.5", "sm:p-[18px]");
    expect(qr.closest("figure")?.parentElement).toHaveClass("gap-2", "sm:gap-4");
    for (const name of ["코드 복사", "새 코드 (반 초대 코드 재발급)"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-11", "px-2", "sm:px-3");
    }
    expect(
      screen.getByText("계정 관리").closest("details")?.closest("[data-class-management-overview]"),
    ).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "반 운영 종료 알아보기" })
        .closest("[data-class-management-overview]"),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: /자리|모둠|당번/u })).not.toBeInTheDocument();
    for (const link of screen.getAllByRole("link"))
      expect(link.getAttribute("href")).not.toMatch(/^\/(seating|grouping|duty)(?:\/|$)/u);
  });
});
