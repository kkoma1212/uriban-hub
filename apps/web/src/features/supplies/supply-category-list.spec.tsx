import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SuppliesPage } from "./supplies-page";

/*
 * 기본은 준비물과 숙제를 함께 보여준다. 2026-09-22 조회 개선 요청에 따라 학생도
 * 필요할 때 종류를 선택할 수 있다.
 * 걸러내기는 서버가 한다. 화면에서 거르면 커서 한 페이지가 통째로 걸러져
 * "더 없음"으로 보이므로, 요청 주소에 종류가 실려 나가는지까지 확인한다.
 */

const teacherBootstrap = {
  account: { display_name: "김선생", email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "1", name: "3학년 2반" },
  current_membership: { id: "1", role: "teacher", status: "approved" },
  destination: "HOME",
  server_today: "2026-07-14",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const homework = {
  category: "homework",
  content_revision: "1",
  description: null,
  id: "18",
  needed_on: "2026-07-16",
  row_version: "1",
  title: "수학 익힘책 12~15쪽",
};

const generalSupply = {
  category: "general",
  content_revision: "1",
  description: null,
  id: "17",
  needed_on: "2026-07-15",
  row_version: "1",
  title: "색연필",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function renderPage(role: "student" | "teacher") {
  const requestedUrls: string[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
    requestedUrls.push(url);
    if (url === "/api/v1/bootstrap") {
      return Promise.resolve(
        jsonResponse(
          role === "teacher"
            ? teacherBootstrap
            : {
                ...teacherBootstrap,
                allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS"],
                current_membership: { ...teacherBootstrap.current_membership, role: "student" },
                teacher_profile: null,
              },
        ),
      );
    }
    if (url.startsWith("/api/v1/supplies?")) {
      const category = new URL(url, "https://classhub.test").searchParams.get("category");
      const items =
        category === "homework"
          ? [homework]
          : category === "general"
            ? [generalSupply]
            : [generalSupply, homework];
      return Promise.resolve(
        jsonResponse({ items, next_cursor: null, server_today: "2026-07-14" }),
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  render(
    <MemoryRouter initialEntries={["/supplies"]}>
      <SuppliesPage />
    </MemoryRouter>,
  );
  return { fetchMock, requestedUrls };
}

describe("supply categories on the list screen", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("gives the teacher a category switch", async () => {
    renderPage("teacher");

    expect(await screen.findByRole("group", { name: "준비물 종류" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "숙제" })).toBeInTheDocument();
  });

  it("lets students find homework without losing the default mixed list", async () => {
    const { requestedUrls } = renderPage("student");

    await screen.findByText("색연필");
    expect(screen.getByRole("group", { name: "준비물 종류" })).toBeVisible();
    expect(screen.getByText("수학 익힘책 12~15쪽")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "숙제" }));
    await waitFor(() => expect(screen.queryByText("색연필")).not.toBeInTheDocument());
    expect(requestedUrls).toContain("/api/v1/supplies?scope=upcoming&category=homework");
  });

  it("marks homework in the mixed list so a student can tell them apart", async () => {
    renderPage("student");

    await screen.findByText("수학 익힘책 12~15쪽");
    expect(screen.getByText("색연필")).toBeInTheDocument();
    // 배지는 숙제에만 붙는다 — 준비물까지 붙으면 구분이 사라진다.
    expect(screen.getAllByText("숙제")).toHaveLength(2);
  });

  it("asks the server for the filtered page instead of filtering on screen", async () => {
    const { requestedUrls } = renderPage("teacher");
    await screen.findByText("색연필");

    fireEvent.click(screen.getByRole("button", { name: "숙제" }));

    await waitFor(() => {
      expect(requestedUrls.some((url) => url.includes("category=homework"))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText("색연필")).not.toBeInTheDocument();
    });
    expect(screen.getByText("수학 익힘책 12~15쪽")).toBeInTheDocument();
  });
});
