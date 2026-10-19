import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BootstrapResponse } from "../../api/auth";
import { LoginPage } from "../auth/login-page";
import { BootstrapPage } from "../bootstrap/bootstrap-page";
import { TeacherClassManagementPage } from "../classes/teacher-class-management-page";
import { StudentSettingsPage } from "../settings/student-settings-page";
import { AccountDeletionPage } from "./account-deletion-page";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const homeStudentBootstrap: BootstrapResponse = {
  account: { display_name: "테스트 학생", email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "LEAVE_CLASS", "VIEW_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "1",
    display_name_in_class: null,
    id: "2",
    role: "student",
    student_number: 17,
    status: "approved",
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-18",
  teacher_profile: null,
};

const liveTeacherBootstrap: BootstrapResponse = {
  account: { display_name: "테스트 교사", email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "1",
    display_name_in_class: null,
    id: "1",
    role: "teacher",
    student_number: null,
    status: "approved",
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-18",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const noClassTeacherBootstrap: BootstrapResponse = {
  account: { display_name: "테스트 교사", email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "CREATE_CLASS"],
  current_class: null,
  current_membership: null,
  destination: "CREATE_CLASS",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-18",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

function renderDeletionPage(): void {
  render(
    <MemoryRouter initialEntries={["/account/deletion"]}>
      <Routes>
        <Route element={<AccountDeletionPage />} path="/account/deletion" />
        <Route element={<LoginPage />} path="/login" />
        <Route element={<p>계정 안내 도착</p>} path="/bootstrap" />
        <Route element={<p>반 관리 도착</p>} path="/class/manage" />
        <Route element={<p>학생 설정 도착</p>} path="/settings" />
      </Routes>
    </MemoryRouter>,
  );
}

async function completeDeletionForm(password = "correctPassword1"): Promise<void> {
  fireEvent.change(screen.getByLabelText("현재 비밀번호"), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText("확인 문구"), {
    target: { value: "탈퇴" },
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "계정 영구 삭제" })).toBeEnabled());
}

describe("AccountDeletionPage", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("requires exact confirmation, clears private cache, and completes one accessible deletion", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=delete-account-token",
    );
    let resolveDeletion!: (response: Response) => void;
    const deletionResponse = new Promise<Response>((resolve) => {
      resolveDeletion = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(homeStudentBootstrap));
      }
      if (url === "/api/v1/account/deletion") return deletionResponse;
      throw new Error(`Unexpected URL: ${url}`);
    });
    window.sessionStorage.setItem(
      "classhub:idempotent-create:schedules:membership-1",
      "pending-private-draft",
    );

    renderDeletionPage();

    const passwordInput = await screen.findByLabelText("현재 비밀번호");
    expect(screen.getByRole("heading", { level: 1, name: "계정 삭제" })).toBeVisible();
    const confirmationInput = screen.getByLabelText("확인 문구");
    expect(passwordInput).toBeRequired();
    expect(passwordInput).toHaveAttribute("aria-required", "true");
    expect(confirmationInput).toBeRequired();
    expect(confirmationInput).toHaveAttribute("aria-required", "true");

    fireEvent.change(passwordInput, { target: { value: "firstPassword1" } });
    fireEvent.change(confirmationInput, { target: { value: "탈퇴 " } });
    expect(await screen.findByText("확인 문구로 ‘탈퇴’를 정확히 입력해 주세요.")).toHaveAttribute(
      "role",
      "alert",
    );
    expect(screen.getByRole("button", { name: "계정 영구 삭제" })).toBeDisabled();

    fireEvent.change(confirmationInput, { target: { value: "탈퇴" } });
    const deletionTrigger = screen.getByRole("button", { name: "계정 영구 삭제" });
    await waitFor(() => expect(deletionTrigger).toBeEnabled());
    fireEvent.click(deletionTrigger);

    const firstDialog = await screen.findByRole("dialog", {
      name: "계정을 영구 삭제할까요?",
    });
    expect(firstDialog).toHaveAccessibleDescription(
      "계정과 현재 반 접근이 즉시 종료되고 모든 기기에서 로그아웃됩니다. 이 작업은 되돌릴 수 없습니다.",
    );
    const keepAccount = within(firstDialog).getByRole("button", { name: "계정 유지" });
    await waitFor(() => expect(keepAccount).toHaveFocus());
    fireEvent.click(keepAccount);
    await waitFor(() => expect(deletionTrigger).toHaveFocus());
    expect(passwordInput).toHaveValue("firstPassword1");

    fireEvent.change(passwordInput, { target: { value: "secondPassword2" } });
    fireEvent.click(deletionTrigger);
    const secondDialog = await screen.findByRole("dialog", {
      name: "계정을 영구 삭제할까요?",
    });
    const finalConfirm = within(secondDialog).getByRole("button", { name: "계정 영구 삭제" });
    fireEvent.click(finalConfirm);
    fireEvent.click(finalConfirm);

    const busyButton = await screen.findByRole("button", { name: "삭제하는 중" });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute("aria-busy", "true");
    const deletionCalls = fetchMock.mock.calls.filter(
      ([input]) => requestUrl(input) === "/api/v1/account/deletion",
    );
    expect(deletionCalls).toHaveLength(1);
    const deletionInit = deletionCalls[0]?.[1];
    expect(deletionInit).toMatchObject({ method: "POST", credentials: "include" });
    expect(new Headers(deletionInit?.headers).get("X-CSRF-Token")).toBe("delete-account-token");
    expect(JSON.parse(String(deletionInit?.body))).toEqual({
      confirmation: "탈퇴",
      current_password: "secondPassword2",
    });

    await act(async () => {
      resolveDeletion(jsonResponse({ account_deleted: true, next_action: "LOGIN" }));
    });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "계정 삭제가 완료됐어요. 다시 이용하려면 새 계정을 만들어 주세요.",
    );
    expect(screen.getByLabelText("비밀번호")).toHaveValue("");
    expect(screen.queryByLabelText("현재 비밀번호")).not.toBeInTheDocument();
    expect(
      window.sessionStorage.getItem("classhub:idempotent-create:schedules:membership-1"),
    ).toBeNull();
  });

  it("associates an invalid current password with the emptied password field", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=delete-account-token",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(homeStudentBootstrap));
      }
      if (url === "/api/v1/account/deletion") {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "INVALID_CREDENTIALS",
                message: "현재 비밀번호가 올바르지 않습니다.",
              },
            },
            401,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderDeletionPage();
    await screen.findByLabelText("현재 비밀번호");
    await completeDeletionForm("wrongPassword1");
    fireEvent.click(screen.getByRole("button", { name: "계정 영구 삭제" }));
    const dialog = await screen.findByRole("dialog", { name: "계정을 영구 삭제할까요?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "계정 영구 삭제" }));

    const currentPassword = screen.getByLabelText("현재 비밀번호");
    await waitFor(() => expect(currentPassword).toHaveFocus());
    expect(currentPassword).toHaveValue("");
    expect(currentPassword).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("현재 비밀번호가 올바르지 않아요.")).toHaveAttribute("role", "alert");
  });

  it("shows the live-class teacher prerequisite without exposing the deletion form", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(liveTeacherBootstrap));

    renderDeletionPage();

    expect(await screen.findByText(/반 운영을 종료하거나 관리자에게 이관/u)).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "계정 삭제" })).toBeVisible();
    expect(screen.getByRole("link", { name: "반 관리로 돌아가기" })).toHaveAttribute(
      "href",
      "/class/manage",
    );
    expect(screen.queryByLabelText("현재 비밀번호")).not.toBeInTheDocument();
    // 담임 확인 뒤 화면 틀이 묻는 열린 도움 요청 수는 계정 삭제 요청이 아니다.
    const pageRequests = fetchMock.mock.calls.filter(
      ([input]) => !String(input instanceof Request ? input.url : input).includes("/help-requests"),
    );
    expect(pageRequests).toHaveLength(1);
  });

  it("keeps the server 409 as a race-safe fallback and clears the submitted password", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=delete-account-token",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(noClassTeacherBootstrap));
      }
      if (url === "/api/v1/account/deletion") {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "CONFLICT",
                message: "담당 중인 반 운영을 먼저 종료하거나 관리자에게 이관해 주세요.",
              },
            },
            409,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderDeletionPage();
    await screen.findByLabelText("현재 비밀번호");
    await completeDeletionForm();
    fireEvent.click(screen.getByRole("button", { name: "계정 영구 삭제" }));
    const dialog = await screen.findByRole("dialog", {
      name: "계정을 영구 삭제할까요?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "계정 영구 삭제" }));

    const alert = await screen.findByRole("alert", { name: "계정 삭제 요청 오류" });
    await waitFor(() => expect(alert).toHaveFocus());
    expect(alert).toHaveTextContent("반 운영을 먼저 종료하거나 관리자에게 이관");
    expect(screen.getByRole("link", { name: "반 관리로 이동" })).toHaveAttribute(
      "href",
      "/class/manage",
    );
    expect(screen.getByLabelText("현재 비밀번호")).toHaveValue("");
  });

  it("explains a fail-closed security dependency error and leaves no password in the DOM", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=delete-account-token",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(homeStudentBootstrap));
      }
      if (url === "/api/v1/account/deletion") {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "RATE_LIMIT_SERVICE_UNAVAILABLE",
                message: "요청 보호 서비스를 사용할 수 없습니다.",
              },
            },
            503,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderDeletionPage();
    await screen.findByLabelText("현재 비밀번호");
    await completeDeletionForm();
    fireEvent.click(screen.getByRole("button", { name: "계정 영구 삭제" }));
    const dialog = await screen.findByRole("dialog", {
      name: "계정을 영구 삭제할까요?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "계정 영구 삭제" }));

    expect(await screen.findByRole("alert", { name: "계정 삭제 요청 오류" })).toHaveTextContent(
      "계정은 변경되지 않았습니다. 잠시 후 다시 시도해 주세요.",
    );
    expect(screen.getByLabelText("현재 비밀번호")).toHaveValue("");
  });
});

describe("account deletion discoverability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      destination: "VERIFY_EMAIL",
      bootstrap: {
        ...homeStudentBootstrap,
        account: { display_name: "미인증 학생", email_verified: false, is_active: true },
        allowed_actions: ["RESEND_EMAIL", "LOGOUT", "DELETE_ACCOUNT"],
        current_class: null,
        current_membership: null,
        destination: "VERIFY_EMAIL",
      } satisfies BootstrapResponse,
    },
    {
      destination: "MEMBERSHIP_PENDING",
      bootstrap: {
        ...homeStudentBootstrap,
        allowed_actions: [
          "CHANGE_PASSWORD",
          "LOGOUT",
          "DELETE_ACCOUNT",
          "CANCEL_MEMBERSHIP_REQUEST",
        ],
        current_membership: {
          class_id: "1",
          display_name_in_class: null,
          id: "2",
          role: "student",
          student_number: null,
          status: "pending",
        },
        destination: "MEMBERSHIP_PENDING",
      } satisfies BootstrapResponse,
    },
    {
      destination: "CLASS_SUSPENDED",
      bootstrap: {
        ...homeStudentBootstrap,
        allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "LEAVE_CLASS"],
        current_class: { id: "1", name: "테스트 1반", status: "suspended" },
        destination: "CLASS_SUSPENDED",
      } satisfies BootstrapResponse,
    },
    {
      destination: "CREATE_CLASS",
      bootstrap: noClassTeacherBootstrap,
    },
    {
      destination: "TEACHER_REVOKED",
      bootstrap: {
        ...noClassTeacherBootstrap,
        allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT"],
        destination: "TEACHER_REVOKED",
        teacher_profile: { status: "revoked", temporary_password_must_change: false },
      } satisfies BootstrapResponse,
    },
    {
      destination: "CHANGE_TEMPORARY_PASSWORD",
      bootstrap: {
        ...noClassTeacherBootstrap,
        allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT"],
        destination: "CHANGE_TEMPORARY_PASSWORD",
        teacher_profile: { status: "active", temporary_password_must_change: true },
      } satisfies BootstrapResponse,
    },
    {
      destination: "ENTER_INVITE_CODE",
      bootstrap: {
        ...homeStudentBootstrap,
        allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "ENTER_INVITE_CODE"],
        current_class: null,
        current_membership: null,
        destination: "ENTER_INVITE_CODE",
      } satisfies BootstrapResponse,
    },
  ] as const)("offers the deletion details from $destination", async ({ bootstrap }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(bootstrap));

    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <BootstrapPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: "계정 삭제 알아보기" })).toHaveAttribute(
      "href",
      "/account/deletion",
    );
  });

  it("offers the capability-gated deletion details from student settings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(homeStudentBootstrap));

    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <StudentSettingsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: "계정 삭제 알아보기" })).toHaveAttribute(
      "href",
      "/account/deletion",
    );
  });

  it("lets a live teacher discover the prerequisite without exposing a deletion action", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(liveTeacherBootstrap));
      }
      if (url === "/api/v1/classes/current") {
        return Promise.resolve(
          jsonResponse({
            academic_year: 2026,
            active_student_count: 28,
            expected_student_count: 30,
            grade: 1,
            id: "1",
            name: "테스트 1반",
            role: "teacher",
            row_version: "1",
            school_name: "테스트 중학교",
            status: "active",
            teacher_display_name: "테스트 교사",
          }),
        );
      }
      if (url === "/api/v1/classes/current/invite-code") {
        return Promise.resolve(
          jsonResponse({
            class_id: "1",
            invite_code: {
              code: "ABCDEFGH",
              created_at: "2026-07-18T00:00:00.000Z",
              expires_at: "2026-08-01T00:00:00.000Z",
              id: "1",
              status: "active",
            },
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/class/manage"]}>
        <TeacherClassManagementPage />
      </MemoryRouter>,
    );

    // 2026-09-27 확정 시안: 계정 삭제 안내는 반 관리의 접힌 "계정 관리" 줄 안에 있다.
    fireEvent.click(await screen.findByText("계정 관리", { selector: "summary span" }));
    expect(await screen.findByText(/운영 중이거나 일시 중지된 담당 반/u)).toBeVisible();
    expect(screen.getByRole("link", { name: "계정 삭제 조건 확인" })).toHaveAttribute(
      "href",
      "/account/deletion",
    );
    expect(screen.queryByRole("link", { name: "계정 삭제 알아보기" })).not.toBeInTheDocument();
  });
});
