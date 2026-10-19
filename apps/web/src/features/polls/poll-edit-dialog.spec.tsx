import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PollDetailPage } from "./poll-detail-page";

// 진행 중 투표 수정(2026-10-04 사용자 결정, 제한형) — 상세 화면에서 여는 수정 창.
const now = Date.now();
const openPoll = {
  ballot_visibility: "private",
  closed_at: null as string | null,
  closes_at: new Date(now + 24 * 60 * 60 * 1_000).toISOString(),
  created_at: new Date(now - 60 * 60 * 1_000).toISOString(),
  description: "학급 운영을 위해 한 가지를 골라 주세요.",
  has_voted: false,
  id: "poll-17",
  my_option_id: null,
  options: [
    { id: "option-1", label: "첫 번째", position: 1, vote_count: null },
    { id: "option-2", label: "두 번째", position: 2, vote_count: null },
  ],
  results_policy: "after_close",
  results_visible: false,
  row_version: "1",
  status: "open",
  title: "학급 운영 투표",
  total_vote_count: null,
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function teacherBootstrap(actions: string[]) {
  return {
    account: { display_name: "테스트", email_verified: true, is_active: true },
    allowed_actions: ["VIEW_CLASS", "MANAGE_CLASS", "MANAGE_POLLS", ...actions],
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
    server_today: "2026-10-04",
    teacher_profile: { status: "active", temporary_password_must_change: false },
  };
}

function participation(votedCount: number) {
  return {
    ballot_visibility: "private",
    poll_id: "poll-17",
    total_students: 3,
    voted_count: votedCount,
    unvoted_count: 3 - votedCount,
    voted_students: [],
    unvoted_students: [],
  };
}

function mockServer({
  actions = ["EDIT_POLLS"],
  poll = openPoll,
  votedCount = 0,
  patch,
}: {
  actions?: string[];
  poll?: typeof openPoll;
  votedCount?: number;
  patch?: (body: Record<string, unknown>) => Response;
} = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap")
      return Promise.resolve(jsonResponse(teacherBootstrap(actions)));
    if (url.endsWith("/participation"))
      return Promise.resolve(jsonResponse(participation(votedCount)));
    if (url === "/api/v1/polls/poll-17" && init?.method === "PATCH" && patch)
      return Promise.resolve(patch(JSON.parse(String(init.body)) as Record<string, unknown>));
    if (url === "/api/v1/polls/poll-17")
      return Promise.resolve(jsonResponse(poll, 200, { ETag: '"1"' }));
    throw new Error(`Unexpected URL: ${url}`);
  });
}

function renderDetail(): void {
  render(
    <MemoryRouter initialEntries={["/polls/poll-17"]}>
      <Routes>
        <Route element={<PollDetailPage />} path="/polls/:pollId" />
        <Route element={<p>투표 목록 화면</p>} path="/polls" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PollEditDialog", () => {
  beforeEach(() => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the edit button only when EDIT_POLLS is offered and the poll is open", async () => {
    mockServer({ actions: [] });
    renderDetail();
    await screen.findByRole("heading", { name: "학급 운영 투표" });
    expect(screen.queryByRole("button", { name: "내용 고치기" })).not.toBeInTheDocument();
  });

  it("hides the edit button on a closed poll", async () => {
    mockServer({ poll: { ...openPoll, status: "closed", closed_at: openPoll.created_at } });
    renderDetail();
    await screen.findByRole("heading", { name: "학급 운영 투표" });
    expect(screen.queryByRole("button", { name: "내용 고치기" })).not.toBeInTheDocument();
  });

  it("saves title, options and deadline with If-Match and never sends the poll settings", async () => {
    const fetchMock = mockServer({
      patch: (body) =>
        jsonResponse(
          {
            ...openPoll,
            closes_at: body.closes_at,
            options: (body.options as string[]).map((label, index) => ({
              id: `new-${index}`,
              label,
              position: index + 1,
              vote_count: null,
            })),
            row_version: "2",
            title: body.title,
          },
          200,
          { ETag: '"2"' },
        ),
    });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "내용 고치기" }));
    const dialog = await screen.findByRole("dialog", { name: "투표 내용 고치기" });
    fireEvent.change(within(dialog).getByLabelText("투표 제목"), {
      target: { value: "고친 투표 제목" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "선택지 추가" }));
    fireEvent.change(within(dialog).getByLabelText("선택지 3"), { target: { value: "세 번째" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "저장하기" }));
    expect(await screen.findByText("투표 내용을 고쳤어요.")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "투표 내용 고치기" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "고친 투표 제목" })).toBeVisible();
    const patches = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]![1]!.headers).toMatchObject({
      "If-Match": '"1"',
      "X-CSRF-Token": "test-csrf-token",
    });
    const body = JSON.parse(String(patches[0]![1]!.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["closes_at", "description", "options", "title"]);
    expect(body.options).toEqual(["첫 번째", "두 번째", "세 번째"]);
  });

  it("locks options after a vote and submits the original options", async () => {
    const fetchMock = mockServer({
      votedCount: 1,
      patch: () => jsonResponse({ ...openPoll, row_version: "2" }, 200, { ETag: '"2"' }),
    });
    renderDetail();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith("/participation")),
      ).toBe(true),
    );
    fireEvent.click(await screen.findByRole("button", { name: "내용 고치기" }));
    const dialog = await screen.findByRole("dialog", { name: "투표 내용 고치기" });
    expect(
      within(dialog).getByText("이미 참여한 학생이 있어 선택지는 바꿀 수 없어요."),
    ).toBeVisible();
    expect(within(dialog).queryByLabelText("선택지 1")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "저장하기" }));
    await screen.findByText("투표 내용을 고쳤어요.");
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect((JSON.parse(String(patch[1]!.body)) as { options: string[] }).options).toEqual([
      "첫 번째",
      "두 번째",
    ]);
  });

  it("locks the options in place when the first vote arrives while the dialog is open", async () => {
    mockServer({
      patch: () =>
        jsonResponse(
          {
            error: {
              code: "POLL_OPTIONS_LOCKED",
              message:
                "이미 참여한 학생이 있어 선택지는 바꿀 수 없어요. 제목·설명·마감 시간만 고칠 수 있어요.",
              request_id: "edit-race",
            },
          },
          409,
        ),
    });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "내용 고치기" }));
    const dialog = await screen.findByRole("dialog", { name: "투표 내용 고치기" });
    fireEvent.change(within(dialog).getByLabelText("선택지 2"), { target: { value: "바꾼 선택" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "저장하기" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("제목·설명·마감 시간만");
    expect(within(dialog).queryByLabelText("선택지 2")).not.toBeInTheDocument();
    expect(within(dialog).getByText("두 번째")).toBeVisible();
  });

  it("rejects a deadline beyond 30 days from creation without calling the server", async () => {
    const fetchMock = mockServer({ patch: () => jsonResponse(openPoll) });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "내용 고치기" }));
    const dialog = await screen.findByRole("dialog", { name: "투표 내용 고치기" });
    const far = new Date(now + 40 * 24 * 60 * 60 * 1_000);
    const offset = far.getTimezoneOffset() * 60 * 1_000;
    fireEvent.change(within(dialog).getByLabelText(/^마감 시각/u), {
      target: { value: new Date(far.getTime() - offset).toISOString().slice(0, 16) },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "저장하기" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("30일 이내");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });
});
