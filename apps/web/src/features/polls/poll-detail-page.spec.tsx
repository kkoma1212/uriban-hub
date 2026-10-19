import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PollDetailPage } from "./poll-detail-page";

const baseBootstrap = {
  account: { display_name: "테스트", email_verified: true, is_active: true },
  current_class: { id: "class-1", name: "테스트 1반", status: "active" },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-30",
};

const basePoll = {
  ballot_visibility: "private",
  closed_at: null,
  closes_at: "2026-07-31T03:00:00.000Z",
  created_at: "2026-07-30T03:00:00.000Z",
  description: "학급 운영을 위해 한 가지를 골라 주세요.",
  has_voted: false,
  id: "poll-17",
  my_option_id: null,
  options: [
    { id: "option-1", label: "첫 번째", position: 1, vote_count: null },
    { id: "option-2", label: "두 번째", position: 2, vote_count: null },
  ],
  results_policy: "after_vote",
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

function bootstrapFor(role: "student" | "teacher") {
  return role === "teacher"
    ? {
        ...baseBootstrap,
        allowed_actions: ["VIEW_CLASS", "MANAGE_CLASS", "MANAGE_POLLS"],
        current_membership: {
          class_id: "class-1",
          display_name_in_class: "선생님",
          id: "teacher-1",
          role: "teacher",
          status: "approved",
          student_number: null,
        },
        teacher_profile: { status: "active", temporary_password_must_change: false },
      }
    : {
        ...baseBootstrap,
        allowed_actions: ["VIEW_CLASS", "VOTE_IN_POLLS"],
        current_membership: {
          class_id: "class-1",
          display_name_in_class: "학생 하나",
          id: "student-1",
          role: "student",
          status: "approved",
          student_number: 1,
        },
        teacher_profile: null,
      };
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

describe("PollDetailPage", () => {
  it("lets a teacher cancel or confirm closure once and keeps the results visible", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
    const poll = {
      ...basePoll,
      results_visible: true,
      total_vote_count: 1,
      options: basePoll.options.map((option, i) => ({ ...option, vote_count: i === 0 ? 1 : 0 })),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap")
        return Promise.resolve(jsonResponse(bootstrapFor("teacher")));
      if (url.endsWith("/participation"))
        return Promise.resolve(
          jsonResponse({
            ballot_visibility: "private",
            poll_id: "poll-17",
            total_students: 1,
            voted_count: 1,
            unvoted_count: 0,
            voted_students: [],
            unvoted_students: [],
          }),
        );
      if (url.endsWith("/close") && init?.method === "POST")
        return Promise.resolve(
          jsonResponse(
            { ...poll, status: "closed", closed_at: "2026-07-30T03:01:00.000Z", row_version: "2" },
            200,
            { ETag: '"2"' },
          ),
        );
      if (url === "/api/v1/polls/poll-17")
        return Promise.resolve(jsonResponse(basePoll, 200, { ETag: '"1"' }));
      throw new Error(`Unexpected URL: ${url}`);
    });
    renderDetail();
    const close = await screen.findByRole("button", { name: "지금 마감하기" });
    expect(screen.queryByText("1명 · 100%")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    fireEvent.click(close);
    expect(screen.getByRole("dialog", { name: "투표를 마감할까요?" })).toBeVisible();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "취소" }));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(close).toHaveFocus();
    fireEvent.click(close);
    const finalDialog = screen.getByRole("dialog", { name: "투표를 마감할까요?" });
    expect(within(finalDialog).getAllByRole("button")).toHaveLength(2);
    expect(within(finalDialog).getByText(/다시 열 수 없습니다/u)).toBeVisible();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    const confirm = within(finalDialog).getByRole("button", { name: "마감하기" });
    act(() => {
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      await screen.findByText("투표를 마감했습니다. 지금까지의 응답과 결과는 보관됩니다."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "지금 마감하기" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(screen.getByText("1명 · 100%")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "첫 번째 1명, 100%" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    expect(screen.getByText("마감됨")).toBeVisible();
    const mutations = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]![1]!.headers).toMatchObject({
      "If-Match": '"1"',
      "X-CSRF-Token": "test-csrf-token",
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("refreshes a stale close response without retrying the mutation", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
    let closed = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap")
        return Promise.resolve(jsonResponse(bootstrapFor("teacher")));
      if (url.endsWith("/participation"))
        return Promise.resolve(
          jsonResponse({
            ballot_visibility: "private",
            poll_id: "poll-17",
            total_students: 0,
            voted_count: 0,
            unvoted_count: 0,
            voted_students: [],
            unvoted_students: [],
          }),
        );
      if (url.endsWith("/close") && init?.method === "POST") {
        closed = true;
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "RESOURCE_VERSION_CHANGED",
                message: "최신 정보를 다시 확인해 주세요.",
              },
            },
            409,
          ),
        );
      }
      return Promise.resolve(
        jsonResponse({
          ...basePoll,
          row_version: closed ? "2" : "1",
          status: closed ? "closed" : "open",
          closed_at: closed ? "2026-07-30T03:01:00.000Z" : null,
        }),
      );
    });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "지금 마감하기" }));
    const finalDialog = screen.getByRole("dialog", { name: "투표를 마감할까요?" });
    expect(within(finalDialog).getAllByRole("button")).toHaveLength(2);
    expect(within(finalDialog).getByText(/다시 열 수 없습니다/u)).toBeVisible();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    const confirm = within(finalDialog).getByRole("button", { name: "마감하기" });
    act(() => {
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(await screen.findByText("최신 정보를 다시 확인해 주세요.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "지금 마감하기" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each(["student", "teacher"] as const)(
    "hides closure from %s on an already closed poll",
    async (role) => {
      vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = requestUrl(input);
        if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFor(role)));
        if (url.endsWith("/participation"))
          return Promise.resolve(
            jsonResponse({
              voted_count: 0,
              unvoted_count: 0,
              voted_students: [],
              unvoted_students: [],
            }),
          );
        return Promise.resolve(
          jsonResponse({ ...basePoll, status: "closed", closed_at: "2026-07-30T03:01:00.000Z" }),
        );
      });
      renderDetail();
      await screen.findByRole("heading", { name: basePoll.title });
      expect(screen.queryByRole("button", { name: "지금 마감하기" })).not.toBeInTheDocument();
    },
  );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps private results hidden after an irreversible vote while preserving the student's choice", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
    const votedPoll = {
      ...basePoll,
      has_voted: true,
      my_option_id: "option-2",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(bootstrapFor("student")));
      }
      if (url === "/api/v1/polls/poll-17" && init?.method === undefined) {
        return Promise.resolve(jsonResponse(basePoll, 200, { ETag: '"1"' }));
      }
      if (url === "/api/v1/polls/poll-17/votes" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(votedPoll, 201, { ETag: '"1"' }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderDetail();

    expect(await screen.findByRole("heading", { name: basePoll.title })).toBeVisible();
    expect(
      screen.getAllByText("비공개 투표는 선생님도 마감 후에 집계를 확인할 수 있어요."),
    ).toHaveLength(1);
    expect(screen.queryByText("1명 · 100%")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "두 번째" }));
    fireEvent.click(screen.getByRole("button", { name: "이 선택으로 제출" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "이 선택으로 제출할까요?" })).toBeVisible();
    expect(
      within(dialog).getByText(/제출 후에는 선택을 바꾸거나 취소할 수 없습니다/u),
    ).toBeVisible();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "제출하기" }));

    expect(
      await screen.findByText("투표를 제출했습니다. 제출한 선택은 바꿀 수 없어요."),
    ).toBeVisible();
    expect(screen.queryByText("1명 · 100%")).not.toBeInTheDocument();
    expect(
      screen.getAllByText("비공개 투표는 선생님도 마감 후에 집계를 확인할 수 있어요."),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "이 선택으로 제출" })).not.toBeInTheDocument();
    expect(screen.getByText("내 선택: 두 번째")).toBeVisible();

    const voteCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(voteCall?.[1]?.body).toBe(JSON.stringify({ option_id: "option-2" }));
    expect(new Headers(voteCall?.[1]?.headers).get("Idempotency-Key")).toBeTruthy();
    expect(new Headers(voteCall?.[1]?.headers).get("X-CSRF-Token")).toBe("test-csrf-token");
  });

  it("shows teachers only participation presence and requires hard-delete confirmation", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
    const teacherPoll = {
      ...basePoll,
      options: [
        { ...basePoll.options[0], vote_count: 1 },
        { ...basePoll.options[1], vote_count: 0 },
      ],
      results_visible: true,
      total_vote_count: 1,
    };
    const participation = {
      ballot_visibility: "private",
      poll_id: "poll-17",
      total_students: 2,
      unvoted_count: 1,
      unvoted_students: [{ display_name: "학생 둘", member_id: "student-2", student_number: 2 }],
      voted_count: 1,
      voted_students: [{ display_name: "학생 하나", member_id: "student-1", student_number: 1 }],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(bootstrapFor("teacher")));
      }
      if (url === "/api/v1/polls/poll-17" && init?.method === undefined) {
        return Promise.resolve(jsonResponse(teacherPoll, 200, { ETag: '"1-from-server"' }));
      }
      if (url === "/api/v1/polls/poll-17/participation") {
        return Promise.resolve(jsonResponse(participation));
      }
      if (url === "/api/v1/polls/poll-17" && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderDetail();

    const participationRegion = await screen.findByRole("region", { name: "참여 상태" });
    const summaryLayout = document.querySelector('[data-poll-summary-layout="teacher-side-panel"]');
    expect(summaryLayout).toBeVisible();
    expect(screen.getByRole("img", { name: /투표 참여 요약/u })).toBeVisible();
    expect(
      within(participationRegion).getByText(
        "참여 여부만 표시하며, 학생별 선택은 직접 표시하지 않습니다. 마감 후 참여 인원이 적거나 결과가 한쪽에 몰리면 선택을 짐작할 수 있습니다.",
      ),
    ).toBeVisible();
    const participationSummary = screen.getByRole("region", { name: "투표 참여 요약" });
    expect(within(participationSummary).getByText("참여 1명")).toBeVisible();
    expect(within(participationSummary).getByText("남음 1명")).toBeVisible();
    expect(within(participationRegion).getByText("1번 학생 하나")).toBeVisible();
    expect(within(participationRegion).getByText("2번 학생 둘")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "투표 영구 삭제" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText("투표·선택지·모든 응답이 즉시 영구 삭제되며 복구할 수 없습니다."),
    ).toBeVisible();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "영구 삭제" }));
    expect(await screen.findByText("투표 목록 화면")).toBeVisible();

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
      expect(new Headers(deleteCall?.[1]?.headers).get("If-Match")).toBe('"1-from-server"');
    });
  });

  it("shows named choices only in the teacher participation view", async () => {
    const teacherPoll = {
      ...basePoll,
      ballot_visibility: "teacher_visible",
      options: [
        { ...basePoll.options[0], vote_count: 1 },
        { ...basePoll.options[1], vote_count: 0 },
      ],
      results_visible: true,
      total_vote_count: 1,
    };
    const participation = {
      ballot_visibility: "teacher_visible",
      poll_id: "poll-17",
      total_students: 2,
      unvoted_count: 1,
      unvoted_students: [{ display_name: "학생 둘", member_id: "student-2", student_number: 2 }],
      voted_count: 1,
      voted_students: [
        {
          display_name: "학생 하나",
          member_id: "student-1",
          selected_option_id: "option-1",
          selected_option_label: "첫 번째",
          student_number: 1,
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(bootstrapFor("teacher")));
      }
      if (url === "/api/v1/polls/poll-17" && init?.method === undefined) {
        return Promise.resolve(jsonResponse(teacherPoll, 200, { ETag: '"1"' }));
      }
      if (url === "/api/v1/polls/poll-17/participation") {
        return Promise.resolve(jsonResponse(participation));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderDetail();

    const participationRegion = await screen.findByRole("region", { name: "참여 상태" });
    expect(
      within(participationRegion).getByText("담임 선생님만 참여 학생의 선택을 확인할 수 있습니다."),
    ).toBeVisible();
    const namedStudent = within(participationRegion)
      .getAllByRole("listitem")
      .find((item) => item.textContent?.includes("학생 하나"));
    expect(namedStudent).toHaveTextContent("1번 학생 하나· 첫 번째");
    expect(within(participationRegion).getByText("2번 학생 둘")).toBeVisible();
  });

  it("explains when a student cannot see teacher-only aggregate results", async () => {
    const teacherOnlyPoll = {
      ...basePoll,
      results_policy: "teacher_only",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(bootstrapFor("student")));
      }
      if (url === "/api/v1/polls/poll-17" && init?.method === undefined) {
        return Promise.resolve(jsonResponse(teacherOnlyPoll, 200, { ETag: '"1"' }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderDetail();

    expect(
      await screen.findAllByText("비공개 투표의 집계는 마감 후 선생님에게만 공개됩니다."),
    ).toHaveLength(1);
    expect(screen.queryByText(/명 ·/u)).not.toBeInTheDocument();
  });
});
