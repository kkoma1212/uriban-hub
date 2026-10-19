import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PollsPage } from "./polls-page";

const teacherBootstrap = {
  account: { display_name: "선생님", email_verified: true, is_active: true },
  allowed_actions: ["VIEW_CLASS", "MANAGE_CLASS", "MANAGE_POLLS"],
  current_class: { id: "class-1", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "class-1",
    display_name_in_class: "선생님",
    id: "teacher-1",
    role: "teacher",
    status: "approved",
    student_number: null,
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-30",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const createdPoll = {
  ballot_visibility: "teacher_visible",
  closes_at: "2026-07-31T03:00:00.000Z",
  created_at: "2026-07-30T03:00:00.000Z",
  description: "작성 맥락을 유지합니다.",
  has_voted: false,
  id: "poll-created",
  my_option_id: null,
  options: [
    { id: "option-1", label: "첫 번째", position: 1, vote_count: 0 },
    { id: "option-2", label: "두 번째", position: 2, vote_count: 0 },
  ],
  results_policy: "after_close",
  results_visible: true,
  row_version: "1",
  status: "open",
  title: "자리 이동 순서",
  total_vote_count: 0,
};

function listedPoll(id: string, title: string): Record<string, unknown> {
  return {
    ...createdPoll,
    ballot_visibility: "private",
    id,
    results_visible: false,
    title,
  };
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function futureLocalDateTime(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  const offset = date.getTimezoneOffset() * 60 * 1_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

describe("PollsPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends the next page instead of losing polls past the first page", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(teacherBootstrap));
      }
      if (url === "/api/v1/polls?scope=open") {
        return Promise.resolve(
          jsonResponse({
            items: [listedPoll("poll-1", "첫 쪽 투표")],
            next_cursor: "CURSOR-1",
            scope: "open",
            server_now: "2026-07-30T03:00:00Z",
          }),
        );
      }
      if (url === "/api/v1/polls?scope=open&cursor=CURSOR-1") {
        return Promise.resolve(
          jsonResponse({
            items: [listedPoll("poll-2", "둘째 쪽 투표")],
            next_cursor: null,
            scope: "open",
            server_now: "2026-07-30T03:00:00Z",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/polls"]}>
        <Routes>
          <Route element={<PollsPage />} path="/polls" />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("첫 쪽 투표")).toBeVisible();
    expect(screen.queryByText("둘째 쪽 투표")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /투표 더 보기/u }));

    // 두 번째 쪽이 첫 쪽을 대체하지 않고 뒤에 붙어야 한다 — 이게 T-HUB-09의 본론이다.
    expect(await screen.findByText("둘째 쪽 투표")).toBeVisible();
    expect(screen.getByText("첫 쪽 투표")).toBeVisible();

    // 마지막 쪽에 닿으면 버튼이 사라져야 한다.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /투표 더 보기/u })).not.toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/polls?scope=open&cursor=CURSOR-1",
      expect.anything(),
    );
  });

  it("preserves a teacher draft and creates only after validating the explicit form", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(teacherBootstrap));
      }
      if (url === "/api/v1/polls?scope=open") {
        return Promise.resolve(
          jsonResponse({
            items: [],
            next_cursor: null,
            scope: "open",
            server_now: "2026-07-30T03:00:00Z",
          }),
        );
      }
      if (url === "/api/v1/polls" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(createdPoll, 201, { ETag: '"1"' }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/polls"]}>
        <Routes>
          <Route element={<PollsPage />} path="/polls" />
          <Route element={<p>생성된 투표 상세</p>} path="/polls/:pollId" />
        </Routes>
      </MemoryRouter>,
    );

    const createButton = await screen.findByRole("button", { name: "투표 만들기" });
    expect(screen.getByRole("heading", { level: 1, name: "투표" })).toBeVisible();
    fireEvent.click(createButton);
    expect(screen.getByRole("radio", { name: /마감 후/u })).toBeChecked();
    expect(screen.queryByRole("radio", { name: /참여 후/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /기명 · 선생님만/u }));
    fireEvent.click(screen.getByRole("radio", { name: /참여 후/u }));
    fireEvent.click(screen.getByRole("radio", { name: /선택 비공개/u }));
    expect(screen.getByRole("radio", { name: /마감 후/u })).toBeChecked();
    expect(screen.queryByRole("radio", { name: /참여 후/u })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "학생 관계·호감도·인기·서열·외모처럼 사람을 평가하는 투표는 만들 수 없습니다.",
      ),
    ).toBeVisible();

    fireEvent.change(screen.getByRole("textbox", { name: "투표 제목" }), {
      target: { value: "자리 이동 순서" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /설명/u }), {
      target: { value: "작성 맥락을 유지합니다." },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "선택지 1" }), {
      target: { value: "첫 번째" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "선택지 2" }), {
      target: { value: "두 번째" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /기명 · 선생님만/u }));
    fireEvent.click(screen.getByRole("radio", { name: /마감 후/u }));

    fireEvent.click(screen.getByRole("button", { name: "작성 닫기" }));
    expect(screen.queryByRole("textbox", { name: "투표 제목" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "투표 만들기" }));
    expect(screen.getByRole("textbox", { name: "투표 제목" })).toHaveValue("자리 이동 순서");
    expect(screen.getByRole("textbox", { name: /설명/u })).toHaveValue("작성 맥락을 유지합니다.");
    expect(screen.getByRole("radio", { name: /기명 · 선생님만/u })).toBeChecked();
    expect(screen.getByRole("radio", { name: /마감 후/u })).toBeChecked();

    fireEvent.change(screen.getByLabelText(/마감 시각/u), {
      target: { value: futureLocalDateTime() },
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "투표 만들기" }));

    expect(await screen.findByText("생성된 투표 상세")).toBeVisible();
    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
        ballot_visibility: "teacher_visible",
        description: "작성 맥락을 유지합니다.",
        options: ["첫 번째", "두 번째"],
        results_policy: "after_close",
        title: "자리 이동 순서",
      });
      expect(new Headers(createCall?.[1]?.headers).get("Idempotency-Key")).toBeTruthy();
      expect(new Headers(createCall?.[1]?.headers).get("X-CSRF-Token")).toBe("test-csrf-token");
    });
  });

  it("keeps each option row tied to its own input when another option is removed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(teacherBootstrap));
      }
      if (url === "/api/v1/polls?scope=open") {
        return Promise.resolve(
          jsonResponse({
            items: [],
            next_cursor: null,
            scope: "open",
            server_now: "2026-07-30T03:00:00Z",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/polls"]}>
        <Routes>
          <Route element={<PollsPage />} path="/polls" />
        </Routes>
      </MemoryRouter>,
    );

    const createButton = await screen.findByRole("button", { name: "투표 만들기" });
    expect(screen.getByRole("heading", { level: 1, name: "투표" })).toBeVisible();
    fireEvent.click(createButton);
    fireEvent.click(screen.getByRole("button", { name: "선택지 추가" }));

    fireEvent.change(screen.getByRole("textbox", { name: "선택지 1" }), {
      target: { value: "첫 번째" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "선택지 2" }), {
      target: { value: "두 번째" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "선택지 3" }), {
      target: { value: "세 번째" },
    });

    const thirdOptionInput = screen.getByRole("textbox", { name: "선택지 3" });
    thirdOptionInput.focus();
    expect(document.activeElement).toBe(thirdOptionInput);

    fireEvent.click(screen.getByRole("button", { name: "선택지 2 삭제" }));

    expect(screen.getByRole("textbox", { name: "선택지 1" })).toHaveValue("첫 번째");
    expect(screen.getByRole("textbox", { name: "선택지 2" })).toHaveValue("세 번째");
    expect(screen.queryByRole("textbox", { name: "선택지 3" })).not.toBeInTheDocument();
    // The surviving row keeps its own DOM node, so the caret stays in the option being edited.
    expect(screen.getByRole("textbox", { name: "선택지 2" })).toBe(thirdOptionInput);
    expect(document.activeElement).toBe(thirdOptionInput);
  });

  it("keeps poll creation without exposing retired layout tabs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(
          jsonResponse({
            ...teacherBootstrap,
            allowed_actions: [
              ...teacherBootstrap.allowed_actions,
              "MANAGE_SEAT_DRAWS",
              "MANAGE_TEAM_DRAWS",
            ],
          }),
        );
      }
      if (url.startsWith("/api/v1/polls")) {
        return Promise.resolve(
          jsonResponse({
            items: [],
            next_cursor: null,
            scope: "open",
            server_now: "2026-07-30T03:00:00Z",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/polls"]}>
        <Routes>
          <Route element={<PollsPage />} path="/polls" />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("button", { name: "투표 만들기" })).toBeVisible();
    expect(screen.getByRole("banner")).toHaveTextContent("투표");
    expect(screen.queryByRole("navigation", { name: "정하기 종류" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /자리|모둠|당번/u })).not.toBeInTheDocument();
  });
});
