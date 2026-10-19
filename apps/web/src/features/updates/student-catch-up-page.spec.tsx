import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearNavigationCapabilities } from "../../lib/navigation-capabilities";
import { StudentCatchUpPage } from "./student-catch-up-page";

const bootstrap = {
  account: { display_name: "학생", email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS"],
  current_class: { id: "1", name: "우리 반", status: "active" },
  current_membership: { class_id: "1", id: "7", role: "student", status: "approved" },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-09-15",
  teacher_profile: null,
};
function Path() {
  const location = useLocation();
  return (
    <output aria-label="현재 주소">
      {location.pathname}
      {location.search}
    </output>
  );
}
function setup(
  options: {
    role?: string;
    fail?: boolean;
    path?: string;
    memberChanges?: boolean;
    bootstrapFailure?: "recover" | "unauthenticated";
  } = {},
) {
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
      if (
        options.bootstrapFailure &&
        (bootstrapCalls === 1 || options.bootstrapFailure === "unauthenticated")
      ) {
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
      data = {
        ...bootstrap,
        current_membership: {
          ...bootstrap.current_membership,
          role: options.role ?? "student",
          id: options.memberChanges && bootstrapCalls > 1 ? "8" : "7",
        },
      };
    } else if (url.startsWith("/api/v1/notices?") || url.startsWith("/api/v1/supplies?")) {
      if (options.fail) throw new Error("연결 실패");
      data = {
        items: url.includes("importance=regular")
          ? [
              {
                id: "10",
                title: "바뀐 체험학습 안내",
                content: "다시 읽어 주세요",
                confirmation_state: "modified_unconfirmed",
                content_revision: "2",
                row_version: "2",
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
    } else throw new Error(`Unexpected request: ${url}`);
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  });
  render(
    <MemoryRouter initialEntries={[options.path ?? "/updates/catch-up"]}>
      <StudentCatchUpPage />
      <Path />
    </MemoryRouter>,
  );
  return requests;
}
afterEach(() => {
  vi.restoreAllMocks();
  clearNavigationCapabilities();
});

describe("student catch up page", () => {
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
        { path: "/updates/catch-up", element: <StudentCatchUpPage /> },
        { path: "/home", element: <p>홈 유지</p> },
        { path: "/login", element: <p>로그인 이동</p> },
      ],
      { initialEntries: ["/updates/catch-up"] },
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
  it("retries a failed initial class check and restores personal unresolved content", async () => {
    setup({ bootstrapFailure: "recover" });
    fireEvent.click(await screen.findByRole("button", { name: "다시 불러오기" }));
    expect(screen.getByText("내 안내를 확인하고 있어요")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "지금 살펴볼 안내 1개" })).toBeVisible();
  });
  it("preserves login redirection when the initial-check retry returns 401", async () => {
    setup({ bootstrapFailure: "unauthenticated" });
    fireEvent.click(await screen.findByRole("button", { name: "다시 불러오기" }));
    await waitFor(() => expect(screen.getByLabelText("현재 주소")).toHaveTextContent("/login"));
  });
  it("loads personal unresolved content, offers the needed action, and saves the selected period in the URL", async () => {
    const requests = setup();
    expect(
      await screen.findByRole("heading", { name: "지금 살펴볼 안내 1개" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "바뀐 체험학습 안내 · 바뀐 내용 확인하기" }),
    ).toHaveAttribute("href", "/notices/10");
    fireEvent.click(screen.getByRole("button", { name: "최근 30일" }));
    await waitFor(() =>
      expect(screen.getByLabelText("현재 주소")).toHaveTextContent("from=2026-08-17&to=2026-09-15"),
    );
    expect(
      await screen.findByRole("heading", { name: "지금 살펴볼 안내 1개" }),
    ).toBeInTheDocument();
    expect(
      requests.every(
        (url) =>
          !url.includes("/confirmations") && !url.includes("/checks") && !url.includes("/members"),
      ),
    ).toBe(true);
  });
  it("restores a bookmarked period and clears results while dates are edited", async () => {
    setup({ path: "/updates/catch-up?from=2026-09-01&to=2026-09-15" });
    await screen.findByRole("heading", { name: "지금 살펴볼 안내 1개" });
    expect(screen.getByLabelText("시작일")).toHaveValue("2026-09-01");
    fireEvent.change(screen.getByLabelText("시작일"), { target: { value: "2026-09-05" } });
    expect(screen.queryByRole("heading", { name: "지금 살펴볼 안내 1개" })).not.toBeInTheDocument();
  });
  it("denies teachers and changed memberships before querying personal content", async () => {
    const requests = setup({ role: "teacher" });
    expect(await screen.findByText("현재 반의 학생 권한을 확인해 주세요.")).toBeInTheDocument();
    expect(requests.every((url) => url === "/api/v1/bootstrap")).toBe(true);
  });
  it("stops when the membership changes between opening and querying", async () => {
    const requests = setup({ memberChanges: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("현재 반의 학생 권한");
    expect(requests.every((url) => url === "/api/v1/bootstrap")).toBe(true);
  });
  it("shows a failed read without claiming there are no remaining tasks", async () => {
    setup({ fail: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("안내를 모두 확인하지 못했어요");
    expect(screen.queryByText(/지금 살펴볼 안내 \d개/u)).not.toBeInTheDocument();
  });
});
