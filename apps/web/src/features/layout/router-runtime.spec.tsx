import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { routes } from "../../router";
import {
  beginRouteRetry,
  clearRouteRetryMarker,
  routeDocumentTitle,
  RouteErrorBoundary,
  RouteHydrationFallback,
  RouteRuntime,
} from "./router-runtime";

const expectedPaths = [
  "/",
  "/sign-up",
  "/login",
  "/demo",
  "/join",
  "/bootstrap",
  "/legal/terms",
  "/legal/privacy-consent",
  "/legal/privacy-policy",
  "/legal/guardian-consent",
  "/account/profile",
  "/account/social",
  "/account/password",
  "/account/deletion",
  "/home",
  "/members/manage",
  "/members/manage/:memberId",
  "/class/archive",
  "/class/manage/audit-logs",
  "/class/manage",
  "/class/create",
  "/settings",
  "/updates/catch-up",
  "/updates/followups",
  "/updates/reuse/:kind/:sourceId",
  "/updates",
  "/attendance",
  "/activities",
  "/past-classes",
  "/past-classes/:classId",
  "/more",
  "/polls",
  "/polls/:pollId",
  "/elections",
  "/supplies",
  "/supplies/:supplyId",
  "/notices",
  "/notices/:noticeId",
  "/help-requests",
  "/help-requests/ask",
  "/help-requests/:helpRequestId",
  "/class-chat",
  "/schedules",
  "/schedules/:scheduleId/change-review",
  "/schedules/:scheduleId",
  "/assessments",
  "/meals",
  "/verify-email",
  "/guardian-consent",
  "/forgot-account",
  "/forgot-password",
  "/reset-password",
  "*",
];

afterEach(() => {
  clearRouteRetryMarker("/broken");
  vi.restoreAllMocks();
});

describe("route runtime", () => {
  it("maps list, detail, and fallback paths to stable browser titles", () => {
    expect(routeDocumentTitle("/supplies")).toBe("준비물·숙제 | 우리반 허브");
    expect(routeDocumentTitle("/updates")).toBe("우리반 소식 | 우리반 허브");
    expect(routeDocumentTitle("/updates/followups")).toBe("학생별 미해결 | 우리반 허브");
    expect(routeDocumentTitle("/updates/catch-up")).toBe("놓친 안내 따라잡기 | 우리반 허브");
    expect(routeDocumentTitle("/attendance")).toBe("출결 연락 | 우리반 허브");
    expect(routeDocumentTitle("/activities")).toBe("반 활동 | 우리반 허브");
    expect(routeDocumentTitle("/more")).toBe("더보기 | 우리반 허브");
    expect(routeDocumentTitle("/assessments")).toBe("평가 기록 | 우리반 허브");
    expect(routeDocumentTitle("/supplies/17")).toBe("준비물·숙제 | 우리반 허브");
    expect(routeDocumentTitle("/members/manage/17")).toBe("학생 정보 | 우리반 허브");
    expect(routeDocumentTitle("/class/manage/audit-logs")).toBe("반 관리 기록 | 우리반 허브");
    expect(routeDocumentTitle("/polls")).toBe("투표 | 우리반 허브");
    expect(routeDocumentTitle("/elections")).toBe("대표 선거 | 우리반 허브");
    expect(routeDocumentTitle("/local-test-admin")).toBe("로컬 테스트 관리 | 우리반 허브");
    // 2026-08-04 owner 결정으로 비밀번호 재설정 흐름이 휴면에서 해제됐다.
    expect(routeDocumentTitle("/forgot-password")).toBe("비밀번호 찾기 | 우리반 허브");
    expect(routeDocumentTitle("/forgot-account")).toBe("아이디 찾기 | 우리반 허브");
    expect(routeDocumentTitle("/guardian-consent")).toBe("보호자 동의 | 우리반 허브");
    expect(routeDocumentTitle("/reset-password")).toBe("새 비밀번호 설정 | 우리반 허브");
    expect(routeDocumentTitle("/unknown")).toBe("페이지를 찾을 수 없음 | 우리반 허브");
  });

  /*
   * 첫 진입은 로그인이다(2026-08-10 Hex 결정). 이 서비스는 이미 반에 들어와 있는
   * 사람이 매일 다시 오는 곳이라, 주소만 치고 들어왔을 때 가입 화면이 먼저 뜨면
   * 매번 로그인을 찾아 눌러야 한다. 되돌아가기 쉬운 변경이라 여기서 못박는다.
   */
  it("opens on the login screen, not sign-up", async () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { level: 1, name: "로그인" })).toBeVisible();
    expect(routeDocumentTitle("/")).toBe("로그인 | 우리반 허브");
  });

  it("keeps the browser title aligned with client-side navigation", async () => {
    const router = createMemoryRouter(
      [
        {
          element: <RouteRuntime />,
          children: [
            { path: "/home", element: <Link to="/schedules/17">일정 열기</Link> },
            { path: "/schedules/:scheduleId", element: <h1>긴 일정 제목</h1> },
          ],
        },
      ],
      { initialEntries: ["/home"] },
    );
    render(<RouterProvider router={router} />);

    await waitFor(() => expect(document.title).toBe("홈 | 우리반 허브"));
    fireEvent.click(screen.getByRole("link", { name: "일정 열기" }));
    await waitFor(() => expect(document.title).toBe("일정 | 우리반 허브"));
  });

  it("keeps every product path lazy", () => {
    const children = routes[0]?.children ?? [];
    const productRoutes = children.filter((route) => route.path !== "/local-test-admin");
    const registeredPaths = children.map((route) => route.path);

    expect(productRoutes.map((route) => route.path)).toEqual(expectedPaths);
    expect(productRoutes).toHaveLength(expectedPaths.length);
    expect(registeredPaths).toContain("/forgot-password");
    expect(registeredPaths).toContain("/reset-password");
    expect(productRoutes.filter((route) => route.path !== "*")).toHaveLength(52);
    productRoutes.forEach((route) => {
      expect(route.lazy).toBeTypeOf("function");
      expect(route.element).toBeUndefined();
      expect(route.Component).toBeUndefined();
      if (route.path !== "*") {
        expect(route.handle).toMatchObject({
          routeMetadata: { pattern: route.path },
        });
      }
    });
  });

  it("renders an accessible Korean initial loading state", () => {
    render(<RouteHydrationFallback />);
    expect(screen.getByRole("status")).toHaveTextContent("화면을 불러오고 있어요.");
  });

  it.each([
    "/not-a-real-route",
    "/seating",
    "/seating/17?create=1",
    "/grouping",
    "/grouping/18",
    "/duty",
    "/duty/19",
  ])("renders the wildcard page for %s without loading retired features", async (path) => {
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    render(<RouterProvider router={router} />);

    const heading = await screen.findByRole("heading", { name: "페이지를 찾을 수 없어요." });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(/입력한 주소가 잘못됐거나 페이지가 이동됐을 수 있어요/u)).toBeVisible();
    expect(screen.queryByText(/인터넷 연결을 확인/u)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "홈으로 이동" })).toHaveAttribute("href", "/home");
    expect(screen.getByRole("link", { name: "로그인 화면으로 이동" })).toHaveAttribute(
      "href",
      "/login",
    );
    await waitFor(() => expect(document.title).toBe("페이지를 찾을 수 없음 | 우리반 허브"));
  });

  it("announces a lazy navigation without moving focus", async () => {
    type LazyRouteModule = { Component: () => React.JSX.Element };
    let resolveRoute: ((route: LazyRouteModule) => void) | undefined;
    const lazyRoute = new Promise<LazyRouteModule>((resolve) => {
      resolveRoute = resolve;
    });
    const router = createMemoryRouter(
      [
        {
          element: <RouteRuntime />,
          children: [
            {
              path: "/",
              Component: () => <Link to="/slow">느린 화면 열기</Link>,
            },
            { path: "/slow", lazy: () => lazyRoute },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    const link = screen.getByRole("link", { name: "느린 화면 열기" });
    link.focus();
    fireEvent.click(link);

    expect(await screen.findByRole("status")).toHaveTextContent("다음 화면을 불러오고 있어요.");
    expect(link).toHaveFocus();

    await act(async () => {
      resolveRoute?.({ Component: () => <h1>느린 화면 완료</h1> });
      await lazyRoute;
    });
    expect(await screen.findByRole("heading", { name: "느린 화면 완료" })).toBeInTheDocument();
  });

  it("moves orphaned focus to the main region after a completed navigation", async () => {
    const router = createMemoryRouter(
      [
        {
          element: <RouteRuntime />,
          children: [
            {
              path: "/",
              Component: () => (
                <main id="app-main-content" tabIndex={-1}>
                  <Link to="/next">다음 화면 열기</Link>
                </main>
              ),
            },
            {
              path: "/next",
              Component: () => (
                <main id="app-main-content" tabIndex={-1}>
                  <h1>다음 화면 본문</h1>
                </main>
              ),
            },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);

    // Initial load must not steal focus.
    expect(document.getElementById("app-main-content")).not.toHaveFocus();

    const link = screen.getByRole("link", { name: "다음 화면 열기" });
    link.focus();
    fireEvent.click(link);

    await screen.findByRole("heading", { name: "다음 화면 본문" });
    await waitFor(() => expect(document.getElementById("app-main-content")).toHaveFocus());
  });

  it("never overrides focus a destination page manages itself", async () => {
    function SelfFocusingPage(): React.JSX.Element {
      const headingRef = useRef<HTMLHeadingElement>(null);
      useEffect(() => {
        headingRef.current?.focus();
      }, []);
      return (
        <main id="app-main-content" tabIndex={-1}>
          <h1 ref={headingRef} tabIndex={-1}>
            자체 초점 본문
          </h1>
        </main>
      );
    }
    const router = createMemoryRouter(
      [
        {
          element: <RouteRuntime />,
          children: [
            {
              path: "/",
              Component: () => (
                <main id="app-main-content" tabIndex={-1}>
                  <Link to="/self">자체 초점 화면 열기</Link>
                </main>
              ),
            },
            { path: "/self", Component: SelfFocusingPage },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);

    const link = screen.getByRole("link", { name: "자체 초점 화면 열기" });
    link.focus();
    fireEvent.click(link);

    const heading = await screen.findByRole("heading", { name: "자체 초점 본문" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(document.getElementById("app-main-content")).not.toHaveFocus();
  });

  it("catches a lazy route failure and offers safe recovery destinations", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const router = createMemoryRouter(
      [
        {
          element: <RouteRuntime />,
          errorElement: <RouteErrorBoundary />,
          hydrateFallbackElement: <RouteHydrationFallback />,
          children: [
            {
              path: "/broken",
              lazy: async () => {
                throw new Error("fixture chunk failure");
              },
            },
          ],
        },
      ],
      { initialEntries: ["/broken"] },
    );
    render(<RouterProvider router={router} />);

    const heading = await screen.findByRole("heading", { name: "화면을 불러오지 못했어요." });
    expect(heading).toBeInTheDocument();
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole("button", { name: "다시 불러오기" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "홈으로 이동" })).toHaveAttribute("href", "/home");
    expect(screen.getByRole("link", { name: "로그인 화면으로 이동" })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it("allows only one reload retry until the route loads successfully", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(beginRouteRetry("/broken", storage)).toBe(true);
    expect(beginRouteRetry("/broken", storage)).toBe(false);
    clearRouteRetryMarker("/broken", storage);
    expect(beginRouteRetry("/broken", storage)).toBe(true);
  });
});
