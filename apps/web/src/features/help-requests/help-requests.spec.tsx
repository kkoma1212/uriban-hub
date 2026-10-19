import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HelpRequestItem } from "../../api/help-requests";
import { HelpRequestsPage } from "./help-requests-page";
import { StudentHelpRequest } from "./student-help-request";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
function item(values: Partial<HelpRequestItem>): HelpRequestItem {
  return {
    closed_at: null,
    created_at: "2026-09-24T01:00:00.000Z",
    id: "7",
    kind: "question",
    last_activity_at: "2026-09-24T01:00:00.000Z",
    message: null,
    reply: null,
    status: "open",
    student: null,
    target: { id: "30", kind: "supply", title: "물감" },
    ...values,
  };
}
const teacherBootstrap = {
  allowed_actions: ["VIEW_CLASS", "MANAGE_CLASS", "LOGOUT"],
  current_class: { id: "1", name: "1반", status: "active" },
  current_membership: { class_id: "1", id: "1", role: "teacher", status: "approved" },
  destination: "HOME",
};

function mockApi(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue("__Host-classhub_csrf=synthetic");
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => handler(urlOf(input), init));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StudentHelpRequest", () => {
  it("submits teacher resolution once synchronously and redirects its current 401", async () => {
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    let posts = 0;
    mockApi((url, init) => {
      if (url === "/api/v1/bootstrap") return json(teacherBootstrap);
      if (init?.method === "POST") {
        posts += 1;
        return pending;
      }
      return json({
        items: [
          item({
            student: { member_id: "2", display_name: "학생가", student_number: 1 },
            message: "살 곳이 없어요",
          }),
        ],
      });
    });
    render(
      <MemoryRouter initialEntries={["/help-requests"]}>
        <Routes>
          <Route path="/help-requests" element={<HelpRequestsPage />} />
          <Route path="/login" element={<p>로그인 화면</p>} />
        </Routes>
      </MemoryRouter>,
    );
    const row = (await screen.findByText("1번 학생가")).closest("li")!;
    fireEvent.click(within(row).getByText("요청 처리"));
    const button = within(row).getByRole("button", { name: "처리 완료" });
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(posts).toBe(1));
    await act(async () =>
      finish(json({ error: { code: "UNAUTHENTICATED", message: "로그인 필요" } }, 401)),
    );
    expect(await screen.findByText("로그인 화면")).toBeVisible();
  });
  it("버튼을 고르고 설명을 선택으로 적어 보내면 처리 중 상태와 철회 버튼을 보여 준다", async () => {
    const posts: unknown[] = [];
    mockApi((url, init) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return json(item({ kind: "hard_to_prepare", message: "물감이 없어요" }), 201);
      }
      expect(url).toBe("/api/v1/help-requests?status=all&target_kind=supply&target_id=30");
      return json({ items: [] });
    });
    render(
      <MemoryRouter>
        <StudentHelpRequest target={{ id: "30", kind: "supply" }} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "준비하기 어려워요" }));
    // 처리방침 제10장: 자유 입력 화면에서 민감정보 입력을 경고한다.
    expect(screen.getByLabelText(/준비하기 어려워요/u)).toHaveAccessibleDescription(
      /민감한 내용은 적지 말고/u,
    );
    fireEvent.change(screen.getByLabelText(/준비하기 어려워요/u), {
      target: { value: "  물감이 없어요 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "선생님께 보내기" }));
    expect(await screen.findByRole("heading", { name: "선생님께 요청을 보냈어요" })).toBeVisible();
    expect(posts).toEqual([
      { kind: "hard_to_prepare", message: "물감이 없어요", target_id: "30", target_kind: "supply" },
    ]);
    expect(screen.getByRole("button", { name: "요청 거두기" })).toBeEnabled();
  });

  it("선생님의 답변을 보여 주고 다시 요청할 수 있게 한다", async () => {
    mockApi(() => json({ items: [item({ reply: "교실에 여분이 있어요", status: "resolved" })] }));
    render(
      <MemoryRouter>
        <StudentHelpRequest target={{ id: "30", kind: "supply" }} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("답변: 교실에 여분이 있어요")).toBeVisible();
    expect(screen.getByRole("button", { name: "질문 있어요" })).toBeEnabled();
  });

  it("불러오지 못하면 버튼 대신 조용한 안내를 보여 준다", async () => {
    mockApi(() => json({ error: { code: "INTERNAL_ERROR", message: "x" } }, 500));
    render(
      <MemoryRouter>
        <StudentHelpRequest target={{ id: "30", kind: "supply" }} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/도움 요청 기능을 불러오지 못했어요/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "질문 있어요" })).not.toBeInTheDocument();
  });
});

describe("HelpRequestsPage", () => {
  it("담임은 처리 중 요청을 보고 한 줄 답변과 함께 처리 완료한다", async () => {
    const resolves: unknown[] = [];
    let resolved = false;
    mockApi((url, init) => {
      if (url === "/api/v1/bootstrap") return json(teacherBootstrap);
      if (url === "/api/v1/help-requests/7/resolve") {
        resolves.push(JSON.parse(String(init?.body)));
        resolved = true;
        return json(
          item({
            reply: "내일 가져올게요",
            status: "resolved",
            student: { display_name: "학생가", member_id: "2", student_number: 1 },
          }),
        );
      }
      expect(["/api/v1/help-requests?status=open", "/api/v1/help-requests?status=all"]).toContain(
        url,
      );
      return json({
        items: [
          item({
            message: "살 곳이 없어요",
            status: resolved ? "resolved" : "open",
            reply: resolved ? "내일 가져올게요" : null,
            student: { display_name: "학생가", member_id: "2", student_number: 1 },
          }),
        ],
      });
    });
    render(
      <MemoryRouter>
        <HelpRequestsPage />
      </MemoryRouter>,
    );
    const row = (await screen.findByText("1번 학생가")).closest("li")!;
    expect(within(row).getByRole("link", { name: /물감/u })).toHaveAttribute(
      "href",
      "/supplies/30",
    );
    expect(within(row).getByText("살 곳이 없어요")).toBeVisible();
    fireEvent.click(within(row).getByText("요청 처리"));
    fireEvent.change(within(row).getByLabelText(/한 줄 답변/u), {
      target: { value: "내일 가져올게요" },
    });
    fireEvent.click(within(row).getByRole("button", { name: "처리 완료" }));
    await waitFor(() => expect(screen.queryByText("1번 학생가")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "끝남" }));
    expect(await screen.findByText("남긴 답변: 내일 가져올게요")).toBeVisible();
    expect(resolves).toEqual([{ reply: "내일 가져올게요" }]);
    expect(screen.queryByRole("button", { name: "처리 완료" })).not.toBeInTheDocument();
  });

  it("학생은 목록을 불러오지 않고 자기 질문 화면으로 간다(총검수 B1-07·B2-05)", async () => {
    const fetchMock = mockApi(() =>
      json({
        ...teacherBootstrap,
        allowed_actions: ["VIEW_CLASS"],
        current_membership: { ...teacherBootstrap.current_membership, role: "student" },
      }),
    );
    render(
      <MemoryRouter initialEntries={["/help-requests"]}>
        <Routes>
          <Route element={<HelpRequestsPage />} path="/help-requests" />
          <Route element={<p>선생님께 물어보기 화면</p>} path="/help-requests/ask" />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("선생님께 물어보기 화면")).toBeVisible();
    expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).toEqual(["/api/v1/bootstrap"]);
  });
});
