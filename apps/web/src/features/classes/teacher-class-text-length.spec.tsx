import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeacherClassCreatePage } from "./teacher-class-create-page";
import { TeacherClassManagementPage } from "./teacher-class-management-page";

const TEST_SCHOOL = {
  edu_office_code: "B10",
  edu_office_name: "테스트 교육청",
  region_name: "서울",
  school_code: "1234567",
  school_kind: "middle",
  school_name: "테스트 중학교",
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function createClassBootstrap(): object {
  return {
    account: { email_verified: true, is_active: true },
    allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "CREATE_CLASS"],
    current_class: null,
    current_membership: null,
    destination: "CREATE_CLASS",
    last_membership_status: null,
    last_status_reason: null,
    server_today: "2026-07-13",
    teacher_profile: { status: "active", temporary_password_must_change: false },
  };
}

function installCreatePageApi(): {
  createBodies: Array<Record<string, unknown>>;
  createHeaders: Headers[];
  csrfRefreshCalls: { count: number };
  schoolQueries: string[];
} {
  const createBodies: Array<Record<string, unknown>> = [];
  const createHeaders: Headers[] = [];
  const csrfRefreshCalls = { count: 0 };
  const schoolQueries: string[] = [];
  let csrfCookie = "";

  vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(() => csrfCookie);
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "/api/v1/bootstrap") {
      return Promise.resolve(jsonResponse(createClassBootstrap()));
    }
    if (url.startsWith("/api/v1/schools?q=")) {
      schoolQueries.push(decodeURIComponent(url.slice("/api/v1/schools?q=".length)));
      return Promise.resolve(jsonResponse({ schools: [TEST_SCHOOL] }));
    }
    if (url === "/api/v1/auth/csrf-token") {
      csrfRefreshCalls.count += 1;
      csrfCookie = "__Host-classhub_csrf=fresh-csrf-token";
      return Promise.resolve(jsonResponse({ csrf_refreshed: true }));
    }
    if (url === "/api/v1/classes") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      createBodies.push(body);
      createHeaders.push(new Headers(init?.headers));
      return Promise.resolve(
        jsonResponse(
          {
            class: {
              academic_year: body.academic_year,
              expected_student_count: body.expected_student_count,
              grade: body.grade,
              id: "2",
              name: body.name,
              row_version: "1",
              school_name: TEST_SCHOOL.school_name,
              status: "active",
            },
            invite_code: {
              code: "JKMNPQRS",
              created_at: "2026-07-13T09:00:00.000Z",
              expires_at: "2026-07-27T09:00:00.000Z",
              id: "2",
              status: "active",
            },
            next_action: "HOME",
            teacher_membership_id: "3",
          },
          201,
        ),
      );
    }

    throw new Error(`Unexpected URL: ${url}`);
  });

  return { createBodies, createHeaders, csrfRefreshCalls, schoolQueries };
}

function renderCreatePage(): void {
  render(
    <MemoryRouter initialEntries={["/class/create"]}>
      <Routes>
        <Route element={<TeacherClassCreatePage />} path="/class/create" />
        <Route element={<p>생성 후 반 관리</p>} path="/class/manage" />
      </Routes>
    </MemoryRouter>,
  );
}

function managementBootstrap(): object {
  return {
    account: { email_verified: true, is_active: true },
    allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "MANAGE_CLASS"],
    current_class: { id: "1", name: "테스트 1반", status: "active" },
    current_membership: { class_id: "1", id: "1", role: "teacher", status: "approved" },
    destination: "HOME",
    last_membership_status: null,
    last_status_reason: null,
    server_today: "2026-07-13",
    teacher_profile: { status: "active", temporary_password_must_change: false },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("teacher class Unicode code-point length boundaries", () => {
  it("allows a 100-code-point school query and blocks 101 before fetch", async () => {
    const api = installCreatePageApi();
    renderCreatePage();

    const schoolInput = await screen.findByLabelText("학교 이름");
    expect(schoolInput).not.toHaveAttribute("maxlength");

    const overLimit = "😀".repeat(101);
    fireEvent.change(schoolInput, { target: { value: overLimit } });
    fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));

    expect(
      await screen.findByText("학교 이름은 2자 이상 100자 이하로 입력해 주세요."),
    ).toBeInTheDocument();
    expect(api.schoolQueries).toEqual([]);

    const atLimit = "😀".repeat(100);
    fireEvent.change(schoolInput, { target: { value: atLimit } });
    fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));

    expect(await screen.findByRole("button", { name: /테스트 중학교/u })).toBeInTheDocument();
    expect(api.schoolQueries).toEqual([atLimit]);
  });

  it("preserves a 40-code-point class name and blocks 41 before CSRF or creation", async () => {
    const api = installCreatePageApi();
    renderCreatePage();

    fireEvent.change(await screen.findByLabelText("학교 이름"), {
      target: { value: "테스트" },
    });
    fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
    fireEvent.click(await screen.findByRole("button", { name: /테스트 중학교/u }));

    const classNameInput = screen.getByLabelText("반 이름");
    expect(classNameInput).not.toHaveAttribute("maxlength");

    fireEvent.change(classNameInput, { target: { value: "😀".repeat(41) } });
    fireEvent.click(screen.getByRole("button", { name: "반 만들기" }));

    expect(
      await screen.findByText("반 이름은 1자 이상 40자 이하로 입력해 주세요."),
    ).toBeInTheDocument();
    expect(api.csrfRefreshCalls.count).toBe(0);
    expect(api.createBodies).toEqual([]);

    const atLimit = "😀".repeat(40);
    fireEvent.change(classNameInput, { target: { value: atLimit } });
    fireEvent.click(screen.getByRole("button", { name: "반 만들기" }));

    expect(await screen.findByText("생성 후 반 관리")).toBeInTheDocument();
    expect(api.csrfRefreshCalls.count).toBe(1);
    expect(api.createBodies).toHaveLength(1);
    expect(api.createBodies[0]).toMatchObject({ name: atLimit });
    expect(api.createHeaders[0]?.get("X-CSRF-Token")).toBe("fresh-csrf-token");
  });

  it("keeps the management editor uncapped and blocks 41 code points before PATCH", async () => {
    let updateCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(managementBootstrap()));
      }
      if (url === "/api/v1/classes/current" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          jsonResponse({
            academic_year: 2026,
            active_student_count: 1,
            expected_student_count: 30,
            grade: 1,
            id: "1",
            name: "테스트 1반",
            role: "teacher",
            row_version: "1",
            school_name: TEST_SCHOOL.school_name,
            status: "active",
            teacher_display_name: "테스트 선생님",
          }),
        );
      }
      if (url === "/api/v1/classes/current/invite-code") {
        return Promise.resolve(
          jsonResponse({
            class_id: "1",
            invite_code: {
              code: "ABCDEFGH",
              created_at: "2026-07-13T09:00:00.000Z",
              expires_at: "2026-07-27T09:00:00.000Z",
              id: "1",
              status: "active",
            },
          }),
        );
      }
      if (url === "/api/v1/classes/current" && init?.method === "PATCH") {
        updateCalls += 1;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter>
        <TeacherClassManagementPage />
      </MemoryRouter>,
    );

    await screen.findByRole("button", { name: "반 이름 · 예상 학생 수 수정" });
    const pageHeading = screen.getByRole("heading", { level: 1, name: "반 관리" });
    expect(pageHeading).toBeVisible();
    expect(pageHeading.closest("header")).toHaveClass("content-frame-header");
    fireEvent.click(screen.getByRole("button", { name: "반 이름 · 예상 학생 수 수정" }));
    const classNameInput = screen.getByLabelText("반 이름");
    expect(classNameInput).not.toHaveAttribute("maxlength");

    fireEvent.change(classNameInput, { target: { value: "😀".repeat(41) } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(
      await screen.findByText("반 이름은 1자 이상 40자 이하로 입력해 주세요."),
    ).toBeInTheDocument();
    await waitFor(() => expect(updateCalls).toBe(0));
  });
});
