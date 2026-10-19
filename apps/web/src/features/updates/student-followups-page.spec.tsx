import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearNavigationCapabilities } from "../../lib/navigation-capabilities";
import { StudentFollowupsPage } from "./student-followups-page";

const bootstrap = {
  account: { display_name: "선생님", email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "1", name: "우리 반", status: "active" },
  current_membership: { class_id: "1", id: "1", role: "teacher", status: "approved" },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-09-15",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};
function setup(role = "teacher", fail = false, bootstrapFailure?: "recover" | "unauthenticated") {
  const requests: string[] = [];
  let bootstrapCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push(url);
    expect(init?.method ?? "GET").toBe("GET");
    let data: unknown;
    if (url === "/api/v1/bootstrap") {
      bootstrapCalls += 1;
      if (bootstrapFailure && (bootstrapCalls === 1 || bootstrapFailure === "unauthenticated")) {
        return new Response(
          JSON.stringify({
            error: {
              code: bootstrapCalls === 1 ? "INTERNAL_ERROR" : "UNAUTHENTICATED",
              message: "Unavailable",
            },
          }),
          {
            status: bootstrapCalls === 1 ? 500 : 401,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      data = { ...bootstrap, current_membership: { ...bootstrap.current_membership, role } };
    } else if (url.startsWith("/api/v1/notices?") || url.startsWith("/api/v1/supplies?")) {
      if (fail) throw new Error("연결 실패");
      data = {
        items: url.includes("importance=regular")
          ? [
              {
                id: "10",
                title: "체험학습 동의서",
                content: "안내",
                content_revision: "1",
                row_version: "1",
                published_at: "2026-09-14T00:00:00Z",
                is_important: false,
                category: "general",
                audience_mode: "selected_snapshot",
              },
            ]
          : [],
        next_cursor: null,
        server_today: bootstrap.server_today,
      };
    } else if (url === "/api/v1/notices/10/confirmations?state=unread")
      data = {
        content_revision: "1",
        counts: { confirmed: 2, unread: 1, modified_unconfirmed: 0, excluded_member_count: 1 },
        items: [
          {
            member_id: "7",
            display_name: "김가람",
            student_number: 3,
            confirmation_state: "unread",
          },
        ],
        next_cursor: null,
        server_today: bootstrap.server_today,
        last_reminder_requested_at: null,
      };
    else throw new Error(`Unexpected request: ${url}`);
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  });
  render(
    <MemoryRouter initialEntries={["/updates/followups"]}>
      <Routes>
        <Route element={<StudentFollowupsPage />} path="/updates/followups" />
        <Route element={<p>홈 화면</p>} path="/home" />
        <Route element={<p>로그인 화면</p>} path="/login" />
      </Routes>
    </MemoryRouter>,
  );
  return requests;
}
afterEach(() => {
  vi.restoreAllMocks();
  clearNavigationCapabilities();
});

describe("student followups page", () => {
  it("ignores a late failed bootstrap retry after leaving the page", async () => {
    let finishRetry!: (response: Response) => void;
    const retry = new Promise<Response>((resolve) => {
      finishRetry = resolve;
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Unavailable" } }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockImplementation(() => retry);
    const router = createMemoryRouter(
      [
        { path: "/updates/followups", element: <StudentFollowupsPage /> },
        { path: "/home", element: <p>홈 유지</p> },
        { path: "/login", element: <p>로그인 이동</p> },
      ],
      { initialEntries: ["/updates/followups"] },
    );
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("button", { name: "다시 불러오기" }));
    await act(async () => {
      await router.navigate("/home");
    });
    await act(async () => {
      finishRetry(
        new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Expired" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    expect(screen.getByText("홈 유지")).toBeVisible();
    expect(screen.queryByText("로그인 이동")).not.toBeInTheDocument();
    router.dispose();
  });
  it("retries a failed initial class check and restores the teacher query controls", async () => {
    const requests = setup("teacher", false, "recover");
    fireEvent.click(await screen.findByRole("button", { name: "다시 불러오기" }));
    expect(screen.getByRole("status")).toHaveTextContent("현재 반을 확인하고 있어요");
    expect(await screen.findByRole("button", { name: "조회하기" })).toBeEnabled();
    expect(requests.filter((url) => url === "/api/v1/bootstrap")).toHaveLength(2);
  });
  it("preserves login redirection when the initial-check retry returns 401", async () => {
    setup("teacher", false, "unauthenticated");
    fireEvent.click(await screen.findByRole("button", { name: "다시 불러오기" }));
    expect(await screen.findByText("로그인 화면")).toBeVisible();
  });
  it("queries only on demand, groups the student, searches, and links to the existing status panel", async () => {
    const requests = setup();
    const submit = await screen.findByRole("button", { name: "조회하기" });
    // 조회 전에는 확인 현황을 묻지 않는다(화면 틀의 열린 도움 요청 수는 별개).
    expect(
      requests
        .filter((url) => !url.startsWith("/api/v1/help-requests"))
        .every((url) => url === "/api/v1/bootstrap"),
    ).toBe(true);
    fireEvent.click(submit);
    expect(
      await screen.findByRole("heading", { name: "확인이 남은 학생 1명" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "3번 · 김가람" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "체험학습 동의서" })).toHaveAttribute(
      "href",
      "/notices/10#notice-confirmation-status",
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "없는 이름" } });
    expect(screen.getByText("검색에 맞는 학생이 없어요.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "최근 30일" }));
    expect(screen.queryByRole("heading", { name: "확인이 남은 학생 1명" })).not.toBeInTheDocument();
  });
  it("denies students before requesting any class-wide status", async () => {
    const requests = setup("student");
    // 막다른 오류 대신 공통 교사 전용 처리로 홈에 돌려보낸다(총검수 B2-05).
    expect(await screen.findByText("홈 화면")).toBeInTheDocument();
    // 조회 전에는 확인 현황을 묻지 않는다(화면 틀의 열린 도움 요청 수는 별개).
    expect(
      requests
        .filter((url) => !url.startsWith("/api/v1/help-requests"))
        .every((url) => url === "/api/v1/bootstrap"),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "조회하기" })).not.toBeInTheDocument();
  });
  it("shows a failure without an empty or partial success result", async () => {
    setup("teacher", true);
    fireEvent.click(await screen.findByRole("button", { name: "조회하기" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("조회 결과를 표시할 수 없어요"),
    );
    expect(screen.queryByText(/확인이 남은 학생 \d명/u)).not.toBeInTheDocument();
  });
});
