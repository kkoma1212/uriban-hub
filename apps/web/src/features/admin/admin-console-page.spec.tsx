import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminConsolePage } from "./admin-console-page";
import { ApprovalPanel } from "./admin-console-account-panels";
import * as authApi from "../../api/auth";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function session(roles: string[]): unknown {
  return {
    server_now: "2026-09-03T00:00:00.000Z",
    account: {
      display_name: "운영 관리자",
      email: "admin@example.com",
      id: "17",
      roles,
    },
    session: {
      absolute_expires_at: "2026-09-03T00:30:00.000Z",
      issued_at: "2026-09-03T00:00:00.000Z",
      last_seen_at: "2026-09-03T00:00:00.000Z",
      mfa_verified_at: "2026-09-03T00:00:00.000Z",
      reauthenticated_at: "2026-09-03T00:00:00.000Z",
    },
  };
}

function renderPage(tab?: string): void {
  render(
    <MemoryRouter initialEntries={[tab === undefined ? "/admin" : "/admin?tab=" + tab]}>
      <Routes>
        <Route element={<AdminConsolePage />} path="/admin" />
        <Route element={<p>관리자 로그인 도착</p>} path="/admin/login" />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdminConsolePage", () => {
  it.each(["account_manager", "support"])(
    "shows and clears the 50-account notice for %s",
    async (role) => {
      let searches = 0;
      const users = Array.from({ length: 50 }, (_, index) => ({
        created_at: "2026-09-03T00:00:00.000Z",
        display_name: "합성 계정 " + index,
        email: "synthetic-" + index + "@example.com",
        email_verified: true,
        id: "synthetic-" + index,
        is_active: true,
        signup_approved: true,
        updated_at: "2026-09-03T00:00:00.000Z",
      }));
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.startsWith("/api/v1/admin/auth/session")) return jsonResponse(session([role]));
        if (url.startsWith("/api/v1/admin/users")) {
          searches += 1;
          return jsonResponse({ users, truncated: searches === 1 });
        }
        if (url.startsWith("/api/v1/admin/members"))
          return jsonResponse({ members: [], truncated: true });
        throw new Error("Unexpected request: " + url);
      });
      renderPage("members");
      const search = await screen.findByLabelText("이름 또는 이메일 · 2자 이상");
      fireEvent.change(search, { target: { value: "합성" } });
      fireEvent.click(screen.getByRole("button", { name: "검색" }));
      const limit = "사용자 계정은 최근 50개만 보여요. 검색어를 더 자세히 넣어 주세요.";
      expect(await screen.findByText(limit)).toBeVisible();
      expect(screen.getByRole("heading", { name: "사용자 계정 50개" })).toBeVisible();
      expect(screen.getAllByText(/^합성 계정 \d+$/u)).toHaveLength(50);
      if (role === "account_manager") {
        const shortcuts = within(screen.getByRole("navigation", { name: "검색 결과 바로가기" }));
        expect(shortcuts.getByRole("link", { name: "사용자 계정 50개 표시 중" })).toHaveAttribute(
          "href",
          "#user-account-results-title",
        );
        expect(shortcuts.getByRole("link", { name: "학급 소속 0개 표시 중" })).toHaveAttribute(
          "href",
          "#membership-results-title",
        );
        expect(screen.getByLabelText("학급 소속 상태")).toBeVisible();
      } else {
        expect(
          screen.queryByRole("navigation", { name: "검색 결과 바로가기" }),
        ).not.toBeInTheDocument();
      }
      expect(
        screen.queryByText("최근 100개만 보여요. 검색어를 더 자세히 넣어 주세요.") !== null,
      ).toBe(role === "account_manager");
      fireEvent.change(search, { target: { value: "합성 계정" } });
      fireEvent.click(screen.getByRole("button", { name: "검색" }));
      await waitFor(() => expect(searches).toBe(2));
      await waitFor(() => expect(screen.queryByText(limit)).not.toBeInTheDocument());
      expect(screen.getByRole("heading", { name: "사용자 계정 50개" })).toBeVisible();
      if (role === "support") {
        expect(
          fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/v1/admin/members")),
        ).toBe(false);
        expect(screen.queryByRole("button", { name: "계정 상태 저장" })).not.toBeInTheDocument();
      }
    },
  );
  it("shows every operations tab to a super administrator and issues a one-time approval code", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "__Host-classhub_admin_csrf=admin-csrf-fixture",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(session(["super_admin", "account_manager", "support", "security_auditor"])),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          account: {
            user_id: "35",
            display_name: "가입 선생님",
            email: "teacher@example.com",
            signup_role: "teacher",
            email_verified: true,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: "384201",
          expiresAt: "2026-09-03T00:10:00.000Z",
          id: "4cf990f0-5f19-4e88-a14b-c0e5ea3fce2f",
        }),
      );

    renderPage("approvals");

    expect(await screen.findByLabelText("관리자 계정 메뉴")).toBeVisible();
    expect(
      screen.getByText("운영 관리자", { selector: ".admin-account-name" }),
    ).toBeInTheDocument();
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      "한눈에 보기",
      "학교·반 목록",
      "선생님·학생 목록",
      "반 활동 현황",
      "재확인 지표",
      "승인번호",
      "계정 관리",
      "관리자 계정",
      "메일 관리",
      "문의",
      "감사·보안",
      "로그인 세션",
      "시스템 상태",
      "운영 상태",
      "요청 제한",
      "약관",
    ]);
    expect(screen.getByRole("tab", { name: "승인번호" })).toHaveAttribute("aria-selected", "true");

    fireEvent.change(screen.getByLabelText("가입 이메일"), {
      target: { value: " TEACHER@example.com " },
    });
    fireEvent.change(screen.getByLabelText("계정 유형"), { target: { value: "teacher" } });
    fireEvent.click(screen.getByRole("button", { name: "계정 검색" }));
    await screen.findByText("가입 선생님 · 선생님 계정");
    fireEvent.click(screen.getByRole("button", { name: "발급" }));

    expect(await screen.findByText("384201")).toBeVisible();
    expect(screen.getByText(/한 번만 표시되는 승인번호/u)).toBeVisible();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/admin/signup-approvals/account?email=teacher%40example.com&role=teacher",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/admin/signup-approvals");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      email: "teacher@example.com",
      role: "teacher",
    });
  });

  it("shows a created administrator password once and removes it from the DOM when dismissed", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "__Host-classhub_admin_csrf=admin-csrf-fixture",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(session(["super_admin"])))
      .mockResolvedValueOnce(
        jsonResponse({
          accounts: [
            {
              created_at: "2026-09-03T00:00:00.000Z",
              display_name: "운영 관리자",
              email: "admin@example.com",
              id: "17",
              last_login_at: "2026-09-03T00:00:00.000Z",
              roles: ["super_admin"],
              status: "active",
              updated_at: "2026-09-03T00:00:00.000Z",
            },
            {
              created_at: "2026-09-03T00:00:00.000Z",
              display_name: "정지 관리자",
              email: "suspended@example.com",
              id: "19",
              last_login_at: null,
              roles: ["support"],
              status: "suspended",
              updated_at: "2026-09-03T00:00:00.000Z",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          account: { id: "18", roles: ["support"], status: "pending_mfa" },
          initial_password: "Only-Once-Password-42!",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          account_id: "17",
          initial_password: "Reset-Only-Password-84!",
          status: "pending_mfa",
        }),
      );

    renderPage("approvals");
    await screen.findByLabelText("관리자 계정 메뉴");
    fireEvent.click(screen.getByRole("tab", { name: "관리자 계정" }));
    expect(await screen.findByRole("heading", { name: "관리자 계정 관리" })).toBeVisible();
    const suspendedAccountCard = screen.getByRole("heading", { name: "정지 관리자" }).closest("li");
    expect(suspendedAccountCard).not.toBeNull();
    const suspendedAccount = within(suspendedAccountCard as HTMLElement);
    expect(suspendedAccount.getByText(/상태를 먼저 활성화한 뒤 자격 증명을 재설정/u)).toBeVisible();
    expect(suspendedAccount.getByRole("button", { name: "비밀번호·MFA 재설정" })).toBeDisabled();
    expect(suspendedAccount.getByRole("button", { name: "MFA만 재설정" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("표시명"), { target: { value: "지원 관리자" } });
    fireEvent.change(screen.getByLabelText("관리자 이메일"), {
      target: { value: " SUPPORT@example.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "관리자 계정 만들기" }));

    expect(await screen.findByText("Only-Once-Password-42!")).toBeVisible();
    expect(document.querySelector("[data-admin-initial-password='visible']")).not.toBeNull();
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      display_name: "지원 관리자",
      email: "support@example.com",
      roles: ["support"],
    });

    fireEvent.click(screen.getByRole("button", { name: "확인하고 닫기" }));
    expect(screen.queryByText("Only-Once-Password-42!")).not.toBeInTheDocument();
    expect(document.querySelector("[data-admin-initial-password='visible']")).toBeNull();

    const currentAccountCard = screen
      .getByRole("heading", { name: "운영 관리자 · 현재 계정" })
      .closest("li");
    expect(currentAccountCard).not.toBeNull();
    const currentAccount = within(currentAccountCard as HTMLElement);
    fireEvent.change(currentAccount.getByLabelText("변경 사유"), {
      target: { value: "자격 증명 분실" },
    });
    fireEvent.click(currentAccount.getByRole("button", { name: "비밀번호·MFA 재설정" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "비밀번호·MFA 재설정",
      }),
    );

    expect(await screen.findByText("Reset-Only-Password-84!")).toBeVisible();
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/v1/admin/accounts/17/reset-credentials");
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      reason: "자격 증명 분실",
    });
    fireEvent.click(screen.getByRole("button", { name: "확인하고 닫기" }));
    expect(screen.queryByText("Reset-Only-Password-84!")).not.toBeInTheDocument();
    expect(document.querySelector("[data-admin-initial-password='visible']")).toBeNull();
  });

  it("keeps an inquiry response record separate from the internal note and supports unassignment", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "__Host-classhub_admin_csrf=admin-csrf-fixture",
    );
    const inquiry = {
      assigned_admin_account_id: "17",
      body: "가입 후 학급이 보이지 않습니다.",
      created_at: "2026-09-03T00:00:00.000Z",
      id: "inquiry-1",
      internal_note: null,
      requester_user_id: "user-1",
      responded_at: null,
      responded_by_admin_account_id: null,
      response: null,
      resolved_at: null,
      status: "open",
      subject: "학급 문의",
      updated_at: "2026-09-03T00:00:00.000Z",
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(session(["support"])))
      .mockResolvedValueOnce(jsonResponse({ inquiries: [inquiry] }))
      .mockResolvedValueOnce(
        jsonResponse({
          inquiry: {
            ...inquiry,
            assigned_admin_account_id: null,
            internal_note: "관리자 확인 완료",
            responded_at: "2026-09-03T02:00:00.000Z",
            responded_by_admin_account_id: "17",
            response: "초대 코드를 다시 확인해 주세요.",
          },
        }),
      );

    renderPage("members");
    await screen.findByLabelText("관리자 계정 메뉴");
    fireEvent.click(screen.getByRole("tab", { name: "문의" }));
    expect(await screen.findByText("학급 문의")).toBeVisible();

    fireEvent.change(screen.getByLabelText("답변 기록 (관리자용)"), {
      target: { value: "초대 코드를 다시 확인해 주세요." },
    });
    fireEvent.change(screen.getByLabelText("내부 메모 · 사용자에게 보이지 않음"), {
      target: { value: "관리자 확인 완료" },
    });
    fireEvent.change(screen.getByLabelText("담당 관리자 ID"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "처리 내용 저장" }));

    expect(await screen.findByText("저장했습니다.")).toBeVisible();
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      assigned_admin_account_id: null,
      internal_note: "관리자 확인 완료",
      response: "초대 코드를 다시 확인해 주세요.",
      status: "open",
    });
  });

  it("separates security, administrator authentication, and operation audit ledgers", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(session(["security_auditor"])))
      .mockResolvedValueOnce(
        jsonResponse({
          logs: [
            {
              action: "admin.login.denied",
              created_at: "2026-09-03T00:00:00.000Z",
              deny_reason: "invalid_totp",
              event_id: "security-event-1",
              failure_code: "ADMIN_MFA_INVALID",
              id: "security-1",
              method: "POST",
              request_id: "request-1",
              resource: "admin_session",
              sanitized_path: "/api/v1/admin/auth/login",
              target_class_id: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          logs: [
            {
              action: "admin.auth.step_up_succeeded",
              admin_account_id: "17",
              created_at: "2026-09-03T00:30:00.000Z",
              deny_reason: null,
              event_id: "auth-event-1",
              id: "auth-1",
              request_id: "auth-request-1",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          logs: [
            {
              action: "admin.account.roles.updated",
              actor_admin_account_id: "17",
              after_json: null,
              before_json: null,
              created_at: "2026-09-03T01:00:00.000Z",
              event_id: "operation-event-1",
              id: "operation-1",
              reason: "감사 업무 추가",
              request_id: "request-2",
              target_id: "18",
              target_type: "admin_account",
            },
          ],
        }),
      );

    renderPage("audit");
    expect(await screen.findByText("admin.login.denied")).toBeVisible();
    expect(screen.getByRole("tab", { name: "감사·보안" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "요청 제한" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "관리자 인증 기록" }));

    // 작업 코드는 한국어 이름과 함께 보인다(총검수 C3-12).
    expect(
      await screen.findByText("중요 작업 보안 확인 (admin.auth.step_up_succeeded)"),
    ).toBeVisible();
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/admin/auth-audit-logs");
    fireEvent.click(screen.getByRole("button", { name: "관리자 운영 기록" }));

    expect(await screen.findByText("admin.account.roles.updated")).toBeVisible();
    expect(screen.getByText("감사 업무 추가")).toBeVisible();
    expect(screen.queryByLabelText("자원")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/v1/admin/operation-audit-logs");
  });

  it("filters operation audits by actor and period, names the actor and loads 50 more (C2-07)", async () => {
    const operation = (id: number) => ({
      action: "admin.account.roles.updated",
      actor_admin_account_id: "17",
      actor_display_name: "운영 관리자",
      after_json: null,
      before_json: null,
      created_at: "2026-10-02T01:00:00.000Z",
      event_id: `operation-event-${id}`,
      id: `operation-${id}`,
      reason: null,
      request_id: `request-${id}`,
      target_id: "18",
      target_type: "admin_account",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(session(["security_auditor"])))
      .mockResolvedValueOnce(jsonResponse({ has_more: false, logs: [] }))
      .mockResolvedValueOnce(jsonResponse({ has_more: false, logs: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          has_more: true,
          logs: Array.from({ length: 50 }, (_, index) => operation(index + 1)),
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ has_more: false, logs: [operation(51)] }));

    renderPage("audit");
    await screen.findByText("조건에 맞는 기록이 없습니다.");
    fireEvent.click(screen.getByRole("button", { name: "관리자 운영 기록" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/admin/operation-audit-logs"),
    );
    fireEvent.change(screen.getByLabelText("관리자 번호"), { target: { value: "17번" } });
    expect(screen.getByLabelText("관리자 번호")).toHaveValue("17");
    fireEvent.change(screen.getByLabelText("시작일"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("종료일"), { target: { value: "2026-10-03" } });
    fireEvent.click(screen.getByRole("button", { name: "조회" }));

    expect(await screen.findByText("관리자 운영 기록 50건 · 더 있음")).toBeVisible();
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "/api/v1/admin/operation-audit-logs?from=2026-10-01&to=2026-10-03&actor=17",
    );
    expect(screen.getAllByText("운영 관리자 · 번호 17")).toHaveLength(50);

    fireEvent.click(screen.getByRole("button", { name: "50건 더 보기" }));
    expect(await screen.findByText("관리자 운영 기록 51건")).toBeVisible();
    expect(fetchMock.mock.calls[4]?.[0]).toBe(
      "/api/v1/admin/operation-audit-logs?from=2026-10-01&to=2026-10-03&offset=50&actor=17",
    );
    expect(screen.queryByRole("button", { name: "50건 더 보기" })).not.toBeInTheDocument();
  });

  it("publishes a terms draft with a required audited reason", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "__Host-classhub_admin_csrf=admin-csrf-fixture",
    );
    const draft = {
      content: "약관 본문",
      created_at: "2026-09-03T00:00:00.000Z",
      created_by_admin_account_id: "17",
      document_type: "terms",
      effective_at: null,
      id: "terms-1",
      policy_version: "2026-09-03",
      published_at: null,
      status: "draft",
      title: "이용약관 2026-09-03",
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(session(["super_admin"])))
      .mockResolvedValueOnce(jsonResponse({ versions: [draft] }))
      .mockResolvedValueOnce(
        jsonResponse({
          version: {
            ...draft,
            published_at: "2026-09-03T02:00:00.000Z",
            status: "published",
          },
        }),
      );

    renderPage("approvals");
    await screen.findByLabelText("관리자 계정 메뉴");
    fireEvent.click(screen.getByRole("tab", { name: "약관" }));
    expect(await screen.findByText("이용약관 2026-09-03")).toBeVisible();
    expect(
      within(screen.getByLabelText("문서 유형"))
        .getAllByRole("option")
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(["terms", "privacy_consent", "privacy_policy", "guardian_consent"]);

    fireEvent.change(screen.getByLabelText("게시 사유"), {
      target: { value: "법무 검토 완료" },
    });
    expect(screen.getByRole("button", { name: "게시" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("시행 일시"), {
      target: { value: "2026-09-03T01:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "게시" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "게시" }),
    );

    expect(await screen.findByText("상태를 변경했습니다.")).toBeVisible();
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/admin/terms/versions/terms-1/status");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      effective_at: new Date("2026-09-03T01:00").toISOString(),
      reason: "법무 검토 완료",
      status: "published",
    });
  });

  it("searches members from the top bar and opens account management with that search", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/v1/admin/auth/session")) return jsonResponse(session(["support"]));
      if (url.startsWith("/api/v1/admin/users"))
        return jsonResponse({
          users: [
            {
              created_at: "2026-09-03T00:00:00.000Z",
              display_name: "김학생",
              email: "student@example.com",
              email_verified: true,
              id: "user-1",
              is_active: true,
              signup_approved: true,
              updated_at: "2026-09-03T01:00:00.000Z",
            },
          ],
        });
      return jsonResponse({ error: { code: "NOT_FOUND", message: "합성 응답 없음" } }, 404);
    });

    renderPage();

    await screen.findByLabelText("관리자 계정 메뉴");
    expect(screen.getByRole("heading", { level: 1, name: "한눈에 보기" })).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "회원 검색" }), {
      target: { value: "김학생" },
    });
    fireEvent.submit(screen.getByRole("search"));

    expect(await screen.findByText("김학생")).toBeVisible();
    expect(screen.getAllByText(/지원 담당자는 계정 정보를 읽기 전용으로 확인/u)).toHaveLength(1);
    expect(
      screen.queryByText("지원 담당자는 문의 처리에 필요한 계정 정보만 조회할 수 있습니다."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "계정 관리" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { level: 1, name: "계정 관리" })).toBeVisible();
    expect(screen.getByLabelText("이름 또는 이메일 · 2자 이상")).toHaveValue("김학생");
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === "/api/v1/admin/users?search=%EA%B9%80%ED%95%99%EC%83%9D",
      ),
    ).toBe(true);
  });

  it("opens the menu drawer from the top bar and closes it with Escape or a menu choice", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).startsWith("/api/v1/admin/auth/session")
        ? jsonResponse(session(["support"]))
        : jsonResponse({ error: { code: "NOT_FOUND", message: "합성 응답 없음" } }, 404),
    );
    renderPage();
    await screen.findByLabelText("관리자 계정 메뉴");
    const workspace = document.querySelector(".admin-workspace");
    const toggle = screen.getByRole("button", { name: "메뉴 열기" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(workspace).toHaveAttribute("data-drawer-open", "true");
    expect(screen.getByRole("button", { name: "관리자 메뉴 닫기" })).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(workspace).toHaveAttribute("data-drawer-open", "false");

    fireEvent.click(screen.getByRole("button", { name: "메뉴 열기" }));
    fireEvent.click(screen.getByRole("tab", { name: "문의" }));
    expect(workspace).toHaveAttribute("data-drawer-open", "false");
    expect(screen.getByRole("heading", { level: 1, name: "문의" })).toBeVisible();
  });

  it("limits a support account to its read and inquiry capabilities", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(session(["support"])))
      .mockResolvedValueOnce(
        jsonResponse({
          users: [
            {
              created_at: "2026-09-03T00:00:00.000Z",
              display_name: "김학생",
              email: "student@example.com",
              email_verified: true,
              id: "user-1",
              is_active: true,
              signup_approved: true,
              updated_at: "2026-09-03T01:00:00.000Z",
            },
          ],
        }),
      );

    renderPage("members");

    expect(await screen.findByLabelText("관리자 계정 메뉴")).toBeVisible();
    expect(
      screen.getByText("운영 관리자", { selector: ".admin-account-name" }),
    ).toBeInTheDocument();
    const tablist = screen.getByRole("tablist");
    expect(within(tablist).getAllByRole("tab")).toHaveLength(7);
    expect(within(tablist).getByRole("tab", { name: "반 활동 현황" })).toBeVisible();
    // 재확인 지표는 숫자만이라 반 활동 현황과 같은 역할이 본다(2026-10-22).
    expect(within(tablist).getByRole("tab", { name: "재확인 지표" })).toBeVisible();
    expect(within(tablist).getByRole("tab", { name: "학교·반 목록" })).toBeVisible();
    expect(within(tablist).getByRole("tab", { name: "한눈에 보기" })).toBeVisible();
    expect(within(tablist).getByRole("tab", { name: "계정 관리" })).toBeVisible();
    expect(within(tablist).getByRole("tab", { name: "문의" })).toBeVisible();
    expect(within(tablist).queryByRole("tab", { name: "약관" })).not.toBeInTheDocument();
    expect(within(tablist).queryByRole("tab", { name: "승인번호" })).not.toBeInTheDocument();
    expect(screen.getByText(/지원 담당자는 계정 정보를 읽기 전용으로 확인/u)).toBeVisible();
    fireEvent.change(screen.getByLabelText("이름 또는 이메일 · 2자 이상"), {
      target: { value: "김학생" },
    });
    fireEvent.click(screen.getByRole("button", { name: "검색" }));

    expect(await screen.findByText("김학생")).toBeVisible();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/admin/users?search=%EA%B9%80%ED%95%99%EC%83%9D",
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/v1/admin/members")),
    ).toBe(false);
    expect(screen.queryByLabelText("학급 소속 상태")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "계정 상태 저장" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "적용" })).not.toBeInTheDocument();
  });

  it("only offers valid student membership transitions and hides teacher mutations", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "__Host-classhub_admin_csrf=admin-csrf-fixture",
    );
    const pendingStudent = {
      account_active: true,
      class_id: "class-1",
      display_name: "김학생",
      email: "student@example.com",
      id: "student-member-1",
      role: "student",
      status: "pending",
      status_changed_at: "2026-09-03T01:00:00.000Z",
      student_number: 7,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(session(["super_admin"])))
      .mockResolvedValueOnce(jsonResponse({ users: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          members: [
            pendingStudent,
            {
              account_active: true,
              class_id: "class-1",
              display_name: "김교사",
              email: "teacher@example.com",
              id: "teacher-member-1",
              role: "teacher",
              status: "approved",
              status_changed_at: "2026-09-03T01:00:00.000Z",
              student_number: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          member: {
            id: "student-member-1",
            status: "rejected",
            status_changed_at: "2026-09-03T02:00:00.000Z",
          },
        }),
      );

    renderPage("approvals");
    await screen.findByLabelText("관리자 계정 메뉴");
    fireEvent.click(screen.getByRole("tab", { name: "계정 관리" }));
    fireEvent.change(screen.getByLabelText("이름 또는 이메일 · 2자 이상"), {
      target: { value: "김학생" },
    });
    fireEvent.click(screen.getByRole("button", { name: "검색" }));
    expect(await screen.findByText("김학생")).toBeVisible();

    const studentCard = screen.getByText("김학생").closest("li");
    const teacherCard = screen.getByText("김교사").closest("li");
    expect(studentCard).not.toBeNull();
    expect(teacherCard).not.toBeNull();
    const studentControls = within(studentCard as HTMLElement);
    const studentActions = studentCard!.querySelector("details")!;
    expect(studentActions).not.toHaveAttribute("open");
    fireEvent.click(studentControls.getByText("소속 상태 변경"));
    expect(studentActions).toHaveAttribute("open");
    expect(
      studentControls.getAllByRole("option").map((option) => (option as HTMLOptionElement).value),
    ).toEqual(["approved", "rejected"]);
    expect(within(teacherCard as HTMLElement).queryByRole("button", { name: "적용" })).toBeNull();
    expect(
      within(teacherCard as HTMLElement).getByText(
        "선생님 소속 상태는 이 콘솔에서 변경하지 않습니다.",
      ),
    ).toBeVisible();

    fireEvent.change(studentControls.getByLabelText("변경할 상태"), {
      target: { value: "rejected" },
    });
    expect(studentControls.getByRole("button", { name: "적용" })).toBeDisabled();
    fireEvent.change(studentControls.getByLabelText("사유 (필수)"), {
      target: { value: "가입 정보 불일치" },
    });
    fireEvent.click(studentControls.getByRole("button", { name: "적용" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "적용" }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      reason: "가입 정보 불일치",
      status: "rejected",
    });
  });

  it("lists every class without a search term and pages through them with filters", async () => {
    const row = {
      academic_year: 2026,
      created_at: "2026-09-28T03:00:00.000Z",
      grade: 3,
      id: "41",
      name: "3학년 2반",
      pending_members: 2,
      region_name: "서울",
      school_name: "한빛중학교",
      status: "active",
      students: 24,
      teacher_name: "박선생",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/v1/admin/auth/session")) return jsonResponse(session(["support"]));
      if (url.startsWith("/api/v1/admin/classes"))
        return jsonResponse({ classes: [row], page: 1, page_size: 20, total: 41 });
      throw new Error("Unexpected URL: " + url);
    });
    const classCalls = () =>
      fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.startsWith("/api/v1/admin/classes"));

    renderPage("classes");

    expect(await screen.findByText("한빛중학교")).toBeVisible();
    expect(classCalls()).toEqual(["/api/v1/admin/classes?page=1"]);
    const cells = within(screen.getByText("한빛중학교").closest("tr")!);
    expect(cells.getByText("박선생")).toBeVisible();
    expect(cells.getByText("24")).toBeVisible();
    expect(cells.getByText("운영 중")).toBeVisible();
    expect(screen.getByText("41개 반 · 1/3쪽")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await waitFor(() => expect(classCalls()).toContain("/api/v1/admin/classes?page=2"));

    fireEvent.change(screen.getByLabelText("상태"), { target: { value: "suspended" } });
    await waitFor(() =>
      expect(classCalls()).toContain("/api/v1/admin/classes?page=1&status=suspended"),
    );
    fireEvent.change(screen.getByLabelText(/학교 이름 또는 반 이름/u), {
      target: { value: "한빛" },
    });
    fireEvent.click(screen.getByRole("button", { name: "검색" }));
    await waitFor(() =>
      expect(classCalls()).toContain(
        "/api/v1/admin/classes?page=1&search=%ED%95%9C%EB%B9%9B&status=suspended",
      ),
    );
  });

  it("lists every teacher and student with masked emails and filters by role and status", async () => {
    const person = {
      class_name: "3학년 2반",
      created_at: "2026-09-20T03:00:00.000Z",
      display_name: "김학생",
      email_masked: "ki***@example.com",
      id: "7",
      last_login_at: null,
      role: "student",
      school_name: "한빛중학교",
      status: "pending",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/v1/admin/auth/session")) return jsonResponse(session(["support"]));
      if (url.startsWith("/api/v1/admin/people"))
        return jsonResponse({ page: 1, page_size: 30, people: [person], total: 1 });
      throw new Error("Unexpected URL: " + url);
    });
    const peopleCalls = () =>
      fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.startsWith("/api/v1/admin/people"));

    renderPage("people");

    expect(await screen.findByText("김학생")).toBeVisible();
    expect(peopleCalls()).toEqual(["/api/v1/admin/people?page=1"]);
    const cells = within(screen.getByText("김학생").closest("tr")!);
    expect(cells.getByText("ki***@example.com")).toBeVisible();
    expect(cells.getByText("학생")).toBeVisible();
    expect(cells.getByText("승인 대기")).toBeVisible();
    expect(cells.getByText("기록 없음")).toBeVisible();
    expect(screen.getByText("1명 · 1/1쪽")).toBeVisible();

    fireEvent.change(screen.getByLabelText("구분"), { target: { value: "teacher" } });
    await waitFor(() =>
      expect(peopleCalls()).toContain("/api/v1/admin/people?page=1&role=teacher"),
    );
    fireEvent.change(screen.getByLabelText("상태"), { target: { value: "inactive" } });
    await waitFor(() =>
      expect(peopleCalls()).toContain("/api/v1/admin/people?page=1&role=teacher&status=inactive"),
    );
  });

  it("opens on the overview with counts only and offers shortcuts just to the tabs the role has", async () => {
    const overview = {
      generated_at: "2026-09-28T03:00:00.000Z",
      scale: { active_classes: 7, active_users: 210, schools: 3, students: 190, teachers: 9 },
      server: {
        database_ms: 4,
        errors_last_hour: 2,
        maintenance_mode: false,
        memory_mb: 180,
        redis_ok: true,
        started_at: "2026-09-28T01:00:00.000Z",
      },
      signups: { new_last_7_days: 12, pending_students: 3, pending_teachers: 1 },
      support: { class_chat_reports_open: null, inquiries_in_progress: 0, inquiries_open: 4 },
    };
    // 요청 순서가 아니라 주소로 답한다.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/v1/admin/auth/session")) return jsonResponse(session(["support"]));
      if (url === "/api/v1/admin/overview") return jsonResponse(overview);
      if (url.startsWith("/api/v1/admin/inquiries")) return jsonResponse({ inquiries: [] });
      throw new Error("Unexpected URL: " + url);
    });

    renderPage();

    // 제목은 숫자보다 먼저 보이므로 숫자 칸이 뜰 때까지 기다린다.
    await screen.findByText("승인 기다리는 선생님");
    expect(screen.getByRole("tab", { name: "한눈에 보기" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
      "/api/v1/admin/overview",
    );
    const stat = (label: string) => screen.getByText(label).closest("[data-admin-stat]");
    expect(stat("승인 기다리는 선생님")).toHaveTextContent("1");
    expect(stat("운영 중인 반")).toHaveTextContent("7");
    expect(stat("최근 1시간 서버 오류")).toHaveTextContent("2건");
    expect(stat("켜진 지")).toHaveTextContent("2시간");
    expect(stat("반 대화 열린 신고")).toHaveTextContent("꺼짐");
    // 지원 담당자는 승인번호·시스템 상태 탭이 없으므로 그 바로가기도 없다.
    expect(screen.queryByRole("button", { name: "승인번호" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "시스템 상태" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "문의" }));
    expect(screen.getByRole("tab", { name: "문의" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/v1/admin/inquiries")),
      ).toBe(true),
    );
  });

  it("returns an expired administrator session to the isolated login route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: { code: "ADMIN_SESSION_REQUIRED", message: "Unauthorized" } }, 401),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText("관리자 로그인 도착")).toBeVisible());
  });
});
it("recovers an existing account after a lost create response without duplicate row or empty secret", async () => {
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-classhub_admin_csrf=admin-csrf-fixture",
  );
  const row = {
    created_at: "2026-09-03T00:00:00.000Z",
    updated_at: "2026-09-03T00:00:00.000Z",
    display_name: "원래 표시명",
    email: "support@example.com",
    id: "18",
    roles: ["support"],
    status: "pending_mfa",
    last_login_at: null,
  };
  let reads = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("auth/session")) return jsonResponse(session(["super_admin"]));
    if (url === "/api/v1/admin/accounts" && init?.method === "POST")
      return jsonResponse({
        account: { id: "18", roles: ["support"], status: "pending_mfa" },
        created: false,
        initial_password: null,
      });
    if (url === "/api/v1/admin/accounts") {
      reads++;
      return jsonResponse({ accounts: reads === 1 ? [] : [row] });
    }
    throw Error(url);
  });
  renderPage("accounts");
  await screen.findByLabelText("표시명");
  fireEvent.change(screen.getByLabelText("표시명"), { target: { value: "재시도 표시명" } });
  fireEvent.change(screen.getByLabelText("관리자 이메일"), {
    target: { value: "support@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "관리자 계정 만들기" }));
  await screen.findByText(
    "동일한 이메일과 역할의 기존 관리자 계정을 확인했습니다. 초기 비밀번호는 다시 표시하지 않습니다.",
  );
  expect(screen.getAllByRole("heading", { name: "원래 표시명" })).toHaveLength(1);
  expect(screen.queryByRole("heading", { name: "재시도 표시명" })).not.toBeInTheDocument();
  expect(document.querySelector("[data-admin-initial-password]")).toBeNull();
  expect(screen.getByLabelText("표시명")).toHaveValue("재시도 표시명");
  expect(reads).toBe(2);
});

it("preserves a later draft typed while account creation is pending", async () => {
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-classhub_admin_csrf=admin-csrf-fixture",
  );
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>((r) => {
    finish = r;
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).includes("auth/session")) return jsonResponse(session(["super_admin"]));
    if (init?.method === "POST") return pending;
    return jsonResponse({ accounts: [] });
  });
  renderPage("accounts");
  await screen.findByLabelText("표시명");
  fireEvent.change(screen.getByLabelText("표시명"), { target: { value: "첫 관리자" } });
  fireEvent.change(screen.getByLabelText("관리자 이메일"), {
    target: { value: "first@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "관리자 계정 만들기" }));
  fireEvent.change(screen.getByLabelText("표시명"), { target: { value: "다음 관리자" } });
  fireEvent.change(screen.getByLabelText("관리자 이메일"), {
    target: { value: "next@example.com" },
  });
  fireEvent.click(document.getElementById("new-admin-role-account_manager")!);
  finish(
    jsonResponse({
      created: true,
      account: { id: "18", roles: ["support"], status: "pending_mfa" },
      initial_password: "Synthetic-Only",
    }),
  );
  await screen.findByText("Synthetic-Only");
  expect(screen.getByLabelText("표시명")).toHaveValue("다음 관리자");
  expect(screen.getByLabelText("관리자 이메일")).toHaveValue("next@example.com");
  expect(document.getElementById("new-admin-role-account_manager")).toBeChecked();
});

it.each(
  ["상태 저장", "역할 저장", "비밀번호·MFA 재설정", "MFA만 재설정"].flatMap((action) =>
    ["changed", "unchanged", "denied"].map((outcome) => ({ action, outcome })),
  ),
)("preserves submitted reason semantics for $action / $outcome", async ({ action, outcome }) => {
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-classhub_admin_csrf=admin-csrf-fixture",
  );
  let finish!: (r: Response) => void;
  const pending = new Promise<Response>((r) => {
    finish = r;
  });
  const row = {
    created_at: "2026-09-03T00:00:00.000Z",
    updated_at: "2026-09-03T00:00:00.000Z",
    display_name: "대상 관리자",
    email: "target@example.com",
    id: "18",
    roles: ["support"],
    status: "active",
    last_login_at: null,
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).includes("auth/session")) return jsonResponse(session(["super_admin"]));
    if (init?.method && init.method !== "GET") return pending;
    return jsonResponse({ accounts: [row] });
  });
  renderPage("accounts");
  const heading = await screen.findByRole("heading", { name: "대상 관리자" });
  const card = within(heading.closest("li")!);
  const reason = card.getByLabelText("변경 사유");
  fireEvent.change(reason, { target: { value: " 제출 사유 " } });
  if (action === "상태 저장")
    fireEvent.change(card.getByLabelText("계정 상태"), { target: { value: "suspended" } });
  if (action === "역할 저장")
    fireEvent.click(document.getElementById("admin-account-role-18-account_manager")!);
  fireEvent.click(card.getByRole("button", { name: action }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: action }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some((c) => c[1]?.method && c[1]?.method !== "GET")).toBe(true),
  );
  const mutation = fetchMock.mock.calls.find((c) => c[1]?.method && c[1]?.method !== "GET")!;
  expect(JSON.parse(String(mutation[1]?.body)).reason).toBe("제출 사유");
  expect(reason).toBeEnabled();
  if (outcome === "changed") fireEvent.change(reason, { target: { value: "다음 작업 사유" } });
  finish(
    outcome === "denied"
      ? jsonResponse({ error: { code: "ADMIN_FORBIDDEN", message: "권한이 없습니다." } }, 403)
      : jsonResponse({
          account: { id: "18", status: "suspended", roles: ["support", "account_manager"] },
          account_id: "18",
          status: "pending_mfa",
          initial_password: "Synthetic-Reset-Only",
        }),
  );
  await waitFor(() =>
    expect(card.getByRole("button", { name: action })).toHaveAttribute("aria-busy", "false"),
  );
  expect(reason).toHaveValue(
    outcome === "changed" ? "다음 작업 사유" : outcome === "denied" ? " 제출 사유 " : "",
  );
  if (outcome === "denied") expect(card.getByRole("alert")).toBeVisible();
});

function approvalFixture() {
  return {
    account: {
      user_id: "35",
      display_name: "가입 선생님",
      email: "teacher@example.com",
      signup_role: "teacher",
      email_verified: true,
    },
  };
}
function renderApprovalPanel() {
  render(
    <MemoryRouter>
      <ApprovalPanel />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("가입 이메일"), {
    target: { value: "teacher@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "계정 검색" }));
}
it.each(["sent", "failed"])(
  "separates code issuance from email delivery %s without automatic reissue",
  async (delivery) => {
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "__Host-classhub_admin_csrf=admin-csrf-fixture",
    );
    let posts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "POST") {
        posts++;
        return jsonResponse({
          id: "approval-1",
          code: "384201",
          expiresAt: "2026-12-01T00:10:00.000Z",
          email_delivery_status: delivery,
        });
      }
      expect(String(input)).toBe(
        "/api/v1/admin/signup-approvals/account?email=teacher%40example.com&role=teacher",
      );
      return jsonResponse(approvalFixture());
    });
    renderApprovalPanel();
    fireEvent.click(await screen.findByRole("button", { name: "발급" }));
    expect(await screen.findByText("384201")).toBeVisible();
    if (delivery === "failed") {
      expect(screen.getByText(/승인번호는 발급됐지만 이메일 전송에 실패/)).toBeVisible();
      expect(screen.queryByText(/이메일을 전송했습니다/)).toBeNull();
    } else expect(screen.getByText(/이메일을 전송했습니다/)).toBeVisible();
    expect(posts).toBe(1);
  },
);
it.each(["success", "denied", "unknown"])(
  "requires explicit reissue confirmation and isolates the old code after %s",
  async (outcome) => {
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "__Host-classhub_admin_csrf=admin-csrf-fixture",
    );
    let posts = 0;
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "POST") {
        posts++;
        expect(String(input)).toBe("/api/v1/admin/signup-approvals");
        expect(JSON.parse(String(init.body))).toEqual({
          email: "teacher@example.com",
          role: "teacher",
        });
        if (posts === 1)
          return jsonResponse({
            id: "approval-1",
            code: "384201",
            expiresAt: "2026-12-01T00:10:00.000Z",
            email_delivery_status: "sent",
          });
        return pending;
      }
      return jsonResponse(approvalFixture());
    });
    renderApprovalPanel();
    fireEvent.click(await screen.findByRole("button", { name: "발급" }));
    await screen.findByText("384201");
    const reissue = screen.getByRole("button", { name: "재발급" });
    fireEvent.click(reissue);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("기존에 사용하지 않은 승인번호가 즉시 폐기");
    expect(posts).toBe(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(reissue).toHaveFocus());
    expect(screen.getByText("384201")).toBeVisible();
    expect(posts).toBe(1);
    fireEvent.click(reissue);
    const confirm = within(await screen.findByRole("dialog")).getByRole("button", {
      name: "재발급",
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts).toBe(2));
    expect(screen.queryByText("384201")).toBeNull();
    expect(screen.queryByText(/새 승인번호를 발급하고 이메일을 전송했습니다/)).toBeNull();
    finish(
      outcome === "success"
        ? jsonResponse({
            id: "approval-2",
            code: "999222",
            expiresAt: "2026-12-01T00:20:00.000Z",
            email_delivery_status: "failed",
          })
        : jsonResponse(
            {
              error: {
                code: outcome === "denied" ? "ADMIN_FORBIDDEN" : "UNEXPECTED_RESPONSE",
                message: "합성 발급 실패",
              },
            },
            outcome === "denied" ? 403 : 503,
          ),
    );
    if (outcome === "success") {
      expect(await screen.findByText("999222")).toBeVisible();
      expect(screen.getByText(/이메일 전송에 실패/)).toBeVisible();
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        outcome === "denied" ? "관리자 권한이 없습니다" : "이전 번호는 다시 전달하지 말고",
      );
      expect(screen.queryByText("384201")).toBeNull();
      expect(screen.queryByText("999222")).toBeNull();
      expect(screen.queryByText(/새 승인번호를 발급하고/)).toBeNull();
    }
    expect(posts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  },
);

it.each(
  [false, true].flatMap((replacing) =>
    ["503", "network", "timeout", "parse", "contract", "403"].map((failure) => ({
      replacing,
      failure,
    })),
  ),
)(
  "separates uncertain approval outcomes from confirmed denial: existing=$replacing / $failure",
  async ({ replacing, failure }) => {
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "__Host-classhub_admin_csrf=admin-csrf-fixture",
    );
    let posts = 0;
    const apiFetch = vi.spyOn(authApi, "apiFetch").mockImplementation(async (input, init) => {
      if (init?.method !== "POST") return jsonResponse(approvalFixture());
      posts++;
      expect(String(input)).toBe("/api/v1/admin/signup-approvals");
      if (replacing && posts === 1)
        return jsonResponse({
          id: "approval-1",
          code: "384201",
          expiresAt: "2026-12-01T00:10:00.000Z",
          email_delivery_status: "sent",
        });
      if (failure === "network")
        throw new authApi.ApiRequestError("NETWORK_ERROR", "합성 네트워크 응답 유실", 0);
      if (failure === "timeout")
        throw new authApi.ApiRequestError("REQUEST_TIMEOUT", "합성 시간 초과", 0);
      if (failure === "parse")
        return new Response("{broken", {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      if (failure === "contract") return jsonResponse({ code: "999222", id: "approval-2" }, 201);
      return jsonResponse(
        {
          error: {
            code: failure === "403" ? "ADMIN_FORBIDDEN" : "SERVER_ERROR",
            message: "잠시 후 다시 시도해 주세요.",
          },
        },
        failure === "403" ? 403 : 503,
      );
    });
    renderApprovalPanel();
    fireEvent.click(await screen.findByRole("button", { name: "발급" }));
    if (replacing) {
      await screen.findByText("384201");
      fireEvent.click(screen.getByRole("button", { name: "재발급" }));
      fireEvent.click(
        within(await screen.findByRole("dialog")).getByRole("button", { name: "재발급" }),
      );
    }
    const alert = await screen.findByRole("alert");
    if (failure === "403") {
      expect(alert).toHaveTextContent("관리자 권한이 없습니다");
      expect(alert).not.toHaveTextContent("이미 승인번호가 발급됐을 수");
      expect(alert).not.toHaveTextContent("발급 결과를 확인하지 못했습니다");
      expect(alert).not.toHaveTextContent("새 번호 발급 결과");
    } else {
      expect(alert).toHaveTextContent("이미 승인번호가 발급됐을 수 있어요");
      expect(alert).toHaveTextContent("다시 발급하기 전에 현재 발급 상태를 확인");
      expect(alert).not.toHaveTextContent("잠시 후 다시 시도해 주세요");
    }
    expect(screen.queryByText("384201")).toBeNull();
    expect(screen.queryByText("999222")).toBeNull();
    expect(screen.queryByText(/새 승인번호를 발급하고 이메일을 전송했습니다/)).toBeNull();
    expect(screen.getByLabelText("가입 이메일")).toHaveValue("teacher@example.com");
    expect(posts).toBe(replacing ? 2 : 1);
    expect(apiFetch).toHaveBeenCalledTimes(replacing ? 3 : 2);
  },
);
