import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./app";
// 가입 설정(생년월일을 받는지)만 흉내 낸다. 나머지 API는 실제 모듈 그대로다.
vi.mock("./api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/auth")>()),
  getSignUpOptions: () => Promise.resolve({ birth_date_required: false }),
}));
import { LoginPage } from "./features/auth/login-page";
import { LocalTestAdminPage } from "./features/local-test-admin/local-test-admin-page";
import { BootstrapPage } from "./features/bootstrap/bootstrap-page";
import { TeacherClassManagementPage } from "./features/classes/teacher-class-management-page";
import { TeacherClassCreatePage } from "./features/classes/teacher-class-create-page";
import { HomePage } from "./features/home/home-page";
import { MemberManagementPage } from "./features/members/member-management-page";
import { StudentSettingsPage } from "./features/settings/student-settings-page";
import { readAndClearVerificationToken } from "./features/auth/verify-email-page";

function confirmDialog(title: string, action: string): void {
  fireEvent.click(
    within(screen.getByRole("dialog", { name: title })).getByRole("button", { name: action }),
  );
}

describe("App", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("renders one sign-up step at a time with unselected age routes", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "가입" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "학생" })).not.toBeChecked();
    expect(screen.queryByLabelText("이메일")).not.toBeInTheDocument();
    const loginLink = screen.getByRole("link", { name: "로그인" });
    expect(loginLink).toHaveAttribute("href", "/login");
    expect(loginLink).toHaveClass("min-h-11");

    fireEvent.click(screen.getByRole("radio", { name: "학생" }));
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    const over14 = await screen.findByRole("radio", { name: "만 14세 이상입니다" });
    const guardianConsent = screen.getByRole("radio", {
      name: "만 14세 미만이며 보호자 동의로 가입합니다",
    });
    expect(over14).not.toBeChecked();
    expect(guardianConsent).not.toBeChecked();

    fireEvent.click(over14);
    expect(over14).toBeChecked();
    expect(guardianConsent).not.toBeChecked();
    expect(screen.queryByLabelText(/^\(필수\) 만 14세 이상입니다$/u)).not.toBeInTheDocument();
  });

  it("copies the verification token and immediately removes the URL fragment", () => {
    const token = "A".repeat(43);
    window.history.replaceState(null, "", `/verify-email#token=${token}`);

    expect(readAndClearVerificationToken()).toBe(token);
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/verify-email");
  });

  it("renders the real login form", () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "로그인" })).toBeInTheDocument();
    expect(screen.getByLabelText("이메일")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("비밀번호")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByRole("button", { name: "로그인" })).toBeInTheDocument();
  });

  it("renders the development-only local test admin login", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "LOCAL_ADMIN_SESSION_REQUIRED", message: "로그인이 필요합니다." },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<LocalTestAdminPage />);

    expect(screen.getByRole("heading", { name: "테스트 계정 관리" })).toBeInTheDocument();
    const loginButton = screen.getByRole("button", { name: "관리자 로그인" });
    expect(loginButton).toBeInTheDocument();
    await waitFor(() => expect(loginButton).toBeEnabled());
    expect(screen.getByText("로컬 테스트 전용 · 배포 금지")).toBeInTheDocument();
  });

  it("renders the invite-code destination selected by bootstrap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          account: { email_verified: true, is_active: true },
          allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "ENTER_INVITE_CODE"],
          current_class: null,
          current_membership: null,
          destination: "ENTER_INVITE_CODE",
          last_membership_status: null,
          last_status_reason: null,
          server_today: "2026-07-11",
          teacher_profile: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <BootstrapPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "반에 참여해 주세요" })).toBeInTheDocument();
    });
    expect(screen.getByRole("main")).toHaveAttribute("data-app-shell", "true");
    expect(screen.getByRole("main").firstElementChild).toHaveAttribute(
      "data-app-shell-width",
      "narrow",
    );
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/v1/bootstrap", {
      cache: "no-store",
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
    expect(screen.getByLabelText("반 초대 코드")).toHaveAttribute("maxlength", "8");
    // 처음 온 학생의 할 일(코드 입력)이 보조 동작(이름 변경)보다 먼저 보여야 한다.
    const nameChange = screen.queryByRole("link", { name: "내 이름 변경" });
    if (nameChange !== null)
      expect(
        screen.getByLabelText("반 초대 코드").compareDocumentPosition(nameChange) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    expect(screen.getByRole("button", { name: "반 참여 요청 보내기" })).toBeInTheDocument();
  });

  it("redirects a teacher HOME bootstrap result to the real home route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          account: { email_verified: true, is_active: true },
          allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "MANAGE_CLASS"],
          current_class: { id: "1", name: "테스트 1반", status: "active" },
          current_membership: { class_id: "1", id: "1", role: "teacher", status: "approved" },
          destination: "HOME",
          last_membership_status: null,
          last_status_reason: null,
          server_today: "2026-07-11",
          teacher_profile: { status: "active", temporary_password_must_change: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <Routes>
          <Route element={<BootstrapPage />} path="/bootstrap" />
          <Route element={<p>실제 홈 경로</p>} path="/home" />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("실제 홈 경로")).toBeInTheDocument();
    });
  });

  it("renders the compact teacher home with its normal empty states", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              account: { email_verified: true, is_active: true },
              allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "MANAGE_CLASS"],
              current_class: { id: "1", name: "테스트 1반", status: "active" },
              current_membership: {
                class_id: "1",
                id: "1",
                role: "teacher",
                status: "approved",
              },
              destination: "HOME",
              last_membership_status: null,
              last_status_reason: null,
              server_today: "2026-07-11",
              teacher_profile: { status: "active", temporary_password_must_change: false },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === "/api/v1/home") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              meal: { data: null, status: "empty" },
              notices: { data: [], status: "empty" },
              pending_member_count: 0,
              reminders: { data: [], status: "empty" },
              schedules: { data: [], status: "empty" },
              server_today: "2026-07-11",
              supplies: { data: [], status: "empty" },
              teacher_followups: { data: [], status: "empty" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === "/api/v1/help-requests?status=open") {
        return Promise.resolve(
          new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/home"]}>
        <HomePage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "우리반 허브" })).toBeInTheDocument();
    });
    expect(screen.getByRole("main").firstElementChild).toHaveAttribute(
      "data-app-shell-width",
      "wide",
    );
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "처리할 일" })).toHaveTextContent(
        "처리할 일이 없어요.",
      );
    });
    expect(screen.getByText("새 소식이 없어요.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "소식 작성" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "공지 작성" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "준비물 작성" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "반 관리" })).toHaveAttribute("href", "/class/manage");
    expect(screen.getByRole("link", { name: "더보기" })).toHaveAttribute("href", "/more");
    expect(screen.getByText("오늘 등록된 급식이 없어요.")).toBeInTheDocument();
    expect(screen.getByText("아직 공지가 없어요.")).toBeInTheDocument();
    expect(screen.getByText("다가오는 일정이 없어요.")).toBeInTheDocument();
  });

  it("renders a masked pending member on the teacher management screen", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              account: { email_verified: true, is_active: true },
              allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "MANAGE_CLASS"],
              current_class: { id: "1", name: "테스트 1반", status: "active" },
              current_membership: {
                class_id: "1",
                id: "1",
                role: "teacher",
                status: "approved",
              },
              destination: "HOME",
              last_membership_status: null,
              last_status_reason: null,
              server_today: "2026-07-11",
              teacher_profile: { status: "active", temporary_password_must_change: false },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      // 학생 화면은 대기·승인·제외 학생을 한 번에 받는다(8개 탭 통일 이후).
      if (url === "/api/v1/members?status=pending%2Capproved%2Cremoved%2Crejoin_allowed") {
        const parts = [
          "/api/v1/members?status=pending",
          "/api/v1/members?status=approved",
          "/api/v1/members?status=removed%2Crejoin_allowed",
        ];
        return Promise.all(
          parts.map(
            async (part) =>
              (
                await (globalThis.fetch as (input: string) => Promise<Response>)(part)
              ).json() as Promise<{
                members: unknown[];
              }>,
          ),
        ).then(
          (lists) =>
            new Response(JSON.stringify({ members: lists.flatMap((list) => list.members) }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        );
      }
      if (url === "/api/v1/members?status=pending") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              members: [
                {
                  account_state: "active",
                  display_name: "테스트 학생",
                  email_masked: "1***@example.com",
                  id: "2",
                  requested_at: "2026-07-11T10:50:16.180Z",
                  row_version: "1",
                  status: "pending",
                  status_changed_at: "2026-07-11T10:50:16.180Z",
                  student_number: null,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === "/api/v1/members?status=approved") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              members: [
                {
                  account_state: "active",
                  display_name: "승인 학생",
                  id: "3",
                  requested_at: null,
                  row_version: "2",
                  status: "approved",
                  status_changed_at: "2026-07-11T11:03:26.549Z",
                  student_number: 7,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === "/api/v1/members?status=removed%2Crejoin_allowed") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              members: [
                {
                  account_state: "active",
                  display_name: "제외된 학생",
                  id: "4",
                  requested_at: null,
                  row_version: "3",
                  status: "removed",
                  status_changed_at: "2026-07-11T11:10:00.000Z",
                  student_number: null,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/members/manage"]}>
        <MemberManagementPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      // 8개 탭 통일(2026-09-28)로 화면 제목이 탭 이름 "학생"과 같아졌다.
      expect(screen.getByRole("heading", { level: 1, name: "학생" })).toBeInTheDocument();
      expect(screen.getByText("테스트 학생")).toBeInTheDocument();
      expect(screen.getByText("1***@example.com")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: / 학생 승인$/u })).toBeEnabled();

    // 확정 시안 탭: 대기 · 참여 · 제외(뒤에 인원 수)
    fireEvent.click(screen.getByRole("tab", { name: /^참여/u }));
    // 참여 학생은 번호 칸 + 이름 줄(학생 정보 보기)로 보인다.
    await waitFor(() => {
      const approved = screen.getByRole("tabpanel", { name: /^참여/u });
      expect(approved).toBeVisible();
      const row = within(approved).getByRole("link", { name: "승인 학생 학생 정보 보기" });
      expect(row).toHaveTextContent("7");
      expect(within(approved).getByRole("button", { name: "반에서 제외" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("tab", { name: /^제외/u }));
    await waitFor(() => {
      const removed = screen.getByRole("tabpanel", { name: /^제외/u });
      expect(within(removed).getByText("제외된 학생")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "다시 참여 허용" })).not.toBeInTheDocument();
      // 확정 시안은 제외 목록이 있을 때 안내 문장을 두지 않는다(빈 목록일 때만 안내).
      expect(within(removed).getByText("제외")).toBeInTheDocument();
    });
  });

  it("lets a pending student cancel the current membership request", async () => {
    const bootstrapResponses = [
      {
        account: { email_verified: true, is_active: true },
        allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "CANCEL_MEMBERSHIP_REQUEST"],
        current_class: { id: "1", name: "테스트 1반", status: "active" },
        current_membership: { class_id: "1", id: "2", role: "student", status: "pending" },
        destination: "MEMBERSHIP_PENDING",
        last_membership_status: null,
        last_status_reason: null,
        server_today: "2026-07-11",
        teacher_profile: null,
      },
      {
        account: { email_verified: true, is_active: true },
        allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "ENTER_INVITE_CODE"],
        current_class: null,
        current_membership: null,
        destination: "ENTER_INVITE_CODE",
        last_membership_status: "canceled",
        last_status_reason: null,
        server_today: "2026-07-11",
        teacher_profile: null,
      },
    ];
    let bootstrapIndex = 0;
    let csrfToken: string | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/v1/bootstrap") {
        const body = bootstrapResponses[Math.min(bootstrapIndex, bootstrapResponses.length - 1)];
        bootstrapIndex += 1;
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url === "/api/v1/auth/csrf-token") {
        expect(init).toEqual({
          body: "{}",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: expect.any(AbortSignal),
        });
        csrfToken = "test-csrf-token";
        return Promise.resolve(
          new Response(JSON.stringify({ csrf_refreshed: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url === "/api/v1/membership-requests/current/cancel") {
        expect(init).toMatchObject({ method: "POST", credentials: "include" });
        expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("test-csrf-token");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              class_id: "1",
              membership_id: "2",
              next_action: "BOOTSTRAP",
              row_version: "2",
              status: "canceled",
              status_changed_at: "2026-07-11T12:00:00.000Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.spyOn(Document.prototype, "cookie", "get").mockImplementation(() =>
      csrfToken === undefined ? "" : `__Host-classhub_csrf=${csrfToken}`,
    );
    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <BootstrapPage />
      </MemoryRouter>,
    );

    const cancelButton = await screen.findByRole("button", { name: "반 참여 요청 취소" });
    fireEvent.click(cancelButton);
    confirmDialog("반 참여 요청을 취소할까요?", "반 참여 요청 취소");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "반에 참여해 주세요" })).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/membership-requests/current/cancel", {
      body: "{}",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "test-csrf-token" },
      method: "POST",
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/csrf-token", {
      body: "{}",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: expect.any(AbortSignal),
    });
  });

  it("lets an approved student leave the current class from settings", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              account: { email_verified: true, is_active: true },
              allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "LEAVE_CLASS"],
              current_class: {
                id: "1",
                name: "테스트 1반",
                school_address: "경기도 안양시 동안구 부림로 71 (평촌동,동안고등학교)",
                school_homepage_url: "https://dongan-h.goeay.kr/",
                school_name: "동안고등학교",
                school_phone_number: "031-387-6105",
                status: "active",
              },
              current_membership: {
                class_id: "1",
                id: "2",
                role: "student",
                status: "approved",
              },
              destination: "HOME",
              last_membership_status: null,
              last_status_reason: null,
              server_today: "2026-07-11",
              teacher_profile: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === "/api/v1/memberships/current/leave") {
        expect(init).toMatchObject({ method: "POST", credentials: "include" });
        expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("test-csrf-token");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              class_id: "1",
              membership_id: "2",
              next_action: "BOOTSTRAP",
              row_version: "3",
              status: "left",
              status_changed_at: "2026-07-11T12:00:00.000Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route element={<StudentSettingsPage />} path="/settings" />
          <Route element={<p>반 나가기 완료</p>} path="/bootstrap" />
        </Routes>
      </MemoryRouter>,
    );

    // 2026-09-27 확정 시안: 설정은 화면 이름 한 줄(경로 표시 없음) + 프로필 줄 목록.
    expect(await screen.findByRole("heading", { level: 1, name: "설정" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "프로필" })).toBeInTheDocument();
    // 2026-09-30 사용자 지적: 다른 탭과 같은 정렬 틀·폭(좁은 가운데 칸이면 시작선이 달랐다).
    expect(screen.getByRole("main").firstElementChild).toHaveAttribute(
      "data-app-shell-width",
      "wide",
    );
    expect(screen.getByRole("link", { name: /전화 앱 열기/u })).toHaveAttribute(
      "href",
      "tel:0313876105",
    );
    expect(screen.getByRole("link", { name: "학교 홈페이지 열기" })).toHaveAttribute(
      "href",
      "https://dongan-h.goeay.kr/",
    );
    fireEvent.click(screen.getByRole("button", { name: "현재 반 나가기" }));
    confirmDialog("현재 반에서 나갈까요?", "반 나가기");

    await waitFor(() => {
      expect(screen.getByText("반 나가기 완료")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/memberships/current/leave", {
      body: "{}",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "test-csrf-token" },
      method: "POST",
      signal: expect.any(AbortSignal),
    });
  });

  it("shows teacher class details and replaces the invite code after confirmation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              account: { email_verified: true, is_active: true },
              allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
              current_class: { id: "1", name: "테스트 1반", status: "active" },
              current_membership: {
                class_id: "1",
                id: "1",
                role: "teacher",
                status: "approved",
              },
              destination: "HOME",
              last_membership_status: null,
              last_status_reason: null,
              server_today: "2026-07-11",
              teacher_profile: { status: "active", temporary_password_must_change: false },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === "/api/v1/classes/current" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              academic_year: 2026,
              active_student_count: 1,
              expected_student_count: 30,
              grade: 1,
              id: "1",
              name: "테스트 1반",
              role: "teacher",
              row_version: "1",
              school_address: "경기도 안양시 동안구 부림로 71 (평촌동,동안고등학교)",
              school_homepage_url: "https://dongan-h.goeay.kr/",
              school_name: "테스트 중학교",
              school_phone_number: "031-387-6105",
              status: "active",
              teacher_display_name: "테스트 선생님",
            }),
            { status: 200, headers: { "Content-Type": "application/json", ETag: '"1"' } },
          ),
        );
      }
      if (url === "/api/v1/classes/current" && init?.method === "PATCH") {
        expect(init).toMatchObject({ method: "PATCH", credentials: "include" });
        const headers = new Headers(init.headers);
        expect(headers.get("X-CSRF-Token")).toBe("test-csrf-token");
        expect(headers.get("If-Match")).toBe('"1"');
        expect(JSON.parse(String(init.body))).toEqual({
          expected_student_count: 28,
          name: "수정된 테스트 1반",
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              academic_year: 2026,
              active_student_count: 1,
              expected_student_count: 28,
              grade: 1,
              id: "1",
              name: "수정된 테스트 1반",
              role: "teacher",
              row_version: "2",
              school_address: "경기도 안양시 동안구 부림로 71 (평촌동,동안고등학교)",
              school_homepage_url: "https://dongan-h.goeay.kr/",
              school_name: "테스트 중학교",
              school_phone_number: "031-387-6105",
              status: "active",
              teacher_display_name: "테스트 선생님",
            }),
            { status: 200, headers: { "Content-Type": "application/json", ETag: '"2"' } },
          ),
        );
      }
      if (url === "/api/v1/classes/current/invite-code") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              class_id: "1",
              invite_code: {
                code: "ABCDEFGH",
                created_at: "2026-07-11T00:00:00.000Z",
                expires_at: "2026-07-25T00:00:00.000Z",
                id: "1",
                status: "active",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === "/api/v1/classes/current/invite-code/rotate") {
        expect(init).toMatchObject({ method: "POST", credentials: "include" });
        const headers = new Headers(init?.headers);
        expect(headers.get("X-CSRF-Token")).toBe("test-csrf-token");
        expect(headers.get("Idempotency-Key")).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
        );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              class_id: "1",
              invite_code: {
                code: "JKMNPQRS",
                created_at: "2026-07-11T12:00:00.000Z",
                expires_at: "2026-07-25T12:00:00.000Z",
                id: "2",
                status: "active",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
    render(
      <MemoryRouter initialEntries={["/class/manage"]}>
        <TeacherClassManagementPage />
      </MemoryRouter>,
    );

    // 학교 이름은 반 요약과 학교 설정 줄 두 곳에 보인다.
    expect((await screen.findAllByText("테스트 중학교")).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 1, name: "반 관리" })).toBeInTheDocument();
    // 8개 탭 공통 틀(2026-09-28): 제목은 틀 머리에, 폭은 넓게, 윗줄 경로 표시는 없다.
    expect(document.querySelector(".content-frame-header")).toContainElement(
      screen.getByRole("heading", { level: 1, name: "반 관리" }),
    );
    expect(screen.getByRole("main").firstElementChild).toHaveAttribute(
      "data-app-shell-width",
      "wide",
    );
    expect(screen.getByText("ABCDEFGH")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "반 운영 종료 알아보기" })).toHaveAttribute(
      "href",
      "/class/archive",
    );

    // 승인·예상 학생 수는 반 정보 편집을 열면 보인다(확정 시안).
    fireEvent.click(screen.getByRole("button", { name: "반 이름 · 예상 학생 수 수정" }));
    expect(screen.getByText("1명 / 예상 30명")).toBeInTheDocument();
    expect(screen.getByLabelText("반 이름")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("반 이름"), {
      target: { value: "수정된 테스트 1반" },
    });
    fireEvent.change(screen.getByLabelText("예상 학생 수"), { target: { value: "28" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findAllByText(/수정된 테스트 1반/u)).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "반 이름 · 예상 학생 수 수정" })).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole("button", { name: "반 이름 · 예상 학생 수 수정" }));
    expect(screen.getByText("1명 / 예상 28명")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));

    fireEvent.click(screen.getByRole("button", { name: "새 코드 (반 초대 코드 재발급)" }));
    confirmDialog("반 초대 코드를 재발급할까요?", "반 초대 코드 재발급");
    expect(await screen.findByText("JKMNPQRS")).toBeInTheDocument();
    expect(screen.queryByText("ABCDEFGH")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/classes/current/invite-code/rotate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("connects CREATE_CLASS bootstrap to school search and atomic class creation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              account: { email_verified: true, is_active: true },
              allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "CREATE_CLASS"],
              current_class: null,
              current_membership: null,
              destination: "CREATE_CLASS",
              last_membership_status: null,
              last_status_reason: null,
              server_today: "2026-07-11",
              teacher_profile: { status: "active", temporary_password_must_change: false },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === `/api/v1/schools?q=${encodeURIComponent("테스트")}`) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              schools: [
                {
                  edu_office_code: "B10",
                  edu_office_name: "테스트 교육청",
                  region_name: "서울",
                  school_code: "1234567",
                  school_kind: "middle",
                  school_name: "테스트 중학교",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url === "/api/v1/classes") {
        expect(init).toMatchObject({ method: "POST", credentials: "include" });
        const headers = new Headers(init?.headers);
        expect(headers.get("X-CSRF-Token")).toBe("test-csrf-token");
        expect(headers.get("Idempotency-Key")).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          academic_year: 2026,
          edu_office_code: "B10",
          expected_student_count: 28,
          grade: 2,
          name: "새 테스트 반",
          school_code: "1234567",
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              class: {
                academic_year: 2026,
                expected_student_count: 28,
                grade: 2,
                id: "2",
                name: "새 테스트 반",
                row_version: "1",
                school_name: "테스트 중학교",
                status: "active",
              },
              invite_code: {
                code: "JKMNPQRS",
                created_at: "2026-07-11T12:00:00.000Z",
                expires_at: "2026-07-25T12:00:00.000Z",
                id: "2",
                status: "active",
              },
              next_action: "HOME",
              teacher_membership_id: "3",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );

    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <Routes>
          <Route element={<BootstrapPage />} path="/bootstrap" />
          <Route element={<TeacherClassCreatePage />} path="/class/create" />
          <Route element={<p>생성 후 반 관리</p>} path="/class/manage" />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "반을 만들어 주세요" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "반 만들기" }));
    expect(await screen.findByRole("heading", { name: "반 만들기" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "페이지 이동" })).toBeInTheDocument();
    expect(screen.getByRole("main").firstElementChild).toHaveAttribute(
      "data-app-shell-width",
      "medium",
    );

    fireEvent.change(screen.getByLabelText("학교 이름"), { target: { value: "테스트" } });
    fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
    const school = await screen.findByRole("button", { name: /테스트 중학교/u });
    fireEvent.click(school);

    fireEvent.change(screen.getByLabelText("학년"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("반 이름"), { target: { value: "새 테스트 반" } });
    fireEvent.change(screen.getByLabelText("예상 학생 수"), { target: { value: "28" } });
    fireEvent.click(screen.getByRole("button", { name: "반 만들기" }));

    expect(await screen.findByText("생성 후 반 관리")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/classes",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
