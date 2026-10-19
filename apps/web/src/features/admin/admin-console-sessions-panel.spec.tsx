import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionsPanel } from "./admin-console-sessions-panel";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SessionsPanel", () => {
  it("lists admin and user sessions read-only, marks the current one and pages users", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({
        admin_sessions: [
          {
            absolute_expires_at: "2026-09-30T19:00:00.000Z",
            device: "Chrome · Windows",
            display_name: "운영 관리자",
            id: "5",
            is_current: true,
            issued_at: "2026-09-30T11:00:00.000Z",
            last_seen_at: "2026-09-30T11:05:00.000Z",
          },
        ],
        page: 1,
        page_size: 30,
        user_sessions: [
          {
            device: "Safari · iOS",
            display_name: "김학생",
            email_masked: "ki***@example.com",
            expires_at: "2026-10-07T11:00:00.000Z",
            id: "71",
            issued_at: "2026-09-30T10:00:00.000Z",
          },
        ],
        user_total: 31,
      }),
    );
    const calls = () => fetchMock.mock.calls.map(([input]) => String(input));

    render(<SessionsPanel />);

    const admins = within(await screen.findByRole("region", { name: "관리자 세션" }));
    expect(admins.getByText("지금 이 세션")).toBeVisible();
    expect(admins.getByText("Chrome · Windows")).toBeVisible();
    const users = within(screen.getByRole("region", { name: "사용자 세션" }));
    expect(users.getByText("ki***@example.com")).toBeVisible();
    expect(users.getByText("선생님·학생 31개 · 1/2쪽")).toBeVisible();
    // 읽기 전용: 세션을 끝내는 버튼은 없다.
    expect(screen.queryByRole("button", { name: /종료|끝내기/u })).not.toBeInTheDocument();
    expect(calls()).toEqual(["/api/v1/admin/sessions?page=1"]);

    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await waitFor(() => expect(calls()).toContain("/api/v1/admin/sessions?page=2"));
  });

  it("lets a super administrator end another session with a reason once the database is ready", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-classhub_admin_csrf=csrf-fixture");
    const list = (userSessions: unknown[]) =>
      jsonResponse({
        admin_sessions: [
          {
            absolute_expires_at: "2026-09-30T19:00:00.000Z",
            device: "Chrome · Windows",
            display_name: "운영 관리자",
            id: "5",
            is_current: true,
            issued_at: "2026-09-30T11:00:00.000Z",
            last_seen_at: "2026-09-30T11:05:00.000Z",
          },
        ],
        page: 1,
        page_size: 30,
        revoke_enabled: true,
        user_sessions: userSessions,
        user_total: userSessions.length,
      });
    const student = {
      device: "Safari · iOS",
      display_name: "김학생",
      email_masked: "ki***@example.com",
      expires_at: "2026-10-07T11:00:00.000Z",
      id: "71",
      issued_at: "2026-09-30T10:00:00.000Z",
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(list([student]))
      .mockResolvedValueOnce(jsonResponse({ id: "71", kind: "user", revoked: true }))
      .mockResolvedValueOnce(list([]));

    // 보안 확인 안내에 관리자 계정 링크가 있어 라우터 안에서 그린다.
    render(
      <MemoryRouter>
        <SessionsPanel canRevoke />
      </MemoryRouter>,
    );

    // 지금 이 세션에는 종료 버튼이 없다.
    const admins = within(await screen.findByRole("region", { name: "관리자 세션" }));
    expect(admins.queryByRole("button", { name: /세션 종료/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "김학생 세션 종료" }));
    const form = within(screen.getByRole("form", { name: "세션 종료 확인" }));
    const submit = form.getByRole("button", { name: "세션 끝내기" });
    expect(submit).toBeDisabled();
    fireEvent.change(form.getByLabelText(/사유/u), { target: { value: " 분실한 기기 " } });
    fireEvent.click(submit);

    expect(await screen.findByText(/김학생 세션을 끝냈습니다/u)).toBeVisible();
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe("/api/v1/admin/sessions/71/revoke");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toEqual({ kind: "user", reason: "분실한 기기" });
    expect(new Headers(init?.headers).get("X-Admin-CSRF")).toBe("csrf-fixture");
    await waitFor(() =>
      expect(screen.getByText("지금 로그인 중인 선생님·학생이 없습니다.")).toBeVisible(),
    );
  });

  it("hides ending sessions for other roles or before the database is ready", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        admin_sessions: [],
        page: 1,
        page_size: 30,
        revoke_enabled: false,
        user_sessions: [
          {
            device: "Safari · iOS",
            display_name: "김학생",
            email_masked: "ki***@example.com",
            expires_at: "2026-10-07T11:00:00.000Z",
            id: "71",
            issued_at: "2026-09-30T10:00:00.000Z",
          },
        ],
        user_total: 1,
      }),
    );
    render(<SessionsPanel canRevoke />);
    expect(await screen.findByText("김학생")).toBeVisible();
    expect(screen.queryByRole("button", { name: /세션 종료/u })).not.toBeInTheDocument();
  });
});
