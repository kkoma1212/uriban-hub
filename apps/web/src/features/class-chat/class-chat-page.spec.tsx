import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClassChatMessage, ClassChatReport, ClassChatState } from "../../api/class-chat";
import { clearAuthenticatedClientState } from "../../lib/authenticated-client-state";
import { ClassChatPage } from "./class-chat-page";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function empty(): Response {
  return new Response(null, { status: 204 });
}
function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
interface Call {
  body: unknown;
  method: string;
  url: string;
}
function mockApi(
  role: "student" | "teacher",
  handler: (call: Call) => Response | Promise<Response> | undefined,
) {
  const calls: Call[] = [];
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue("__Host-classhub_csrf=synthetic");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call = {
      url: urlOf(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    if (call.url.startsWith("/api/v1/class-chat")) calls.push(call);
    const handled = handler(call);
    if (handled) return handled;
    if (call.url === "/api/v1/bootstrap")
      return json({
        allowed_actions: ["VIEW_CLASS", "USE_CLASS_CHAT"],
        current_class: { id: "1", name: "1반", status: "active" },
        current_membership: { class_id: "1", id: "1", role, status: "approved" },
        destination: "HOME",
      });
    return json({ items: [] });
  });
  return calls;
}
const author = (memberId: string, name: string, role: "student" | "teacher" = "student") => ({
  member_id: memberId,
  name,
  role,
  student_number: role === "student" ? Number(memberId) : null,
});
function message(id: string, values: Partial<ClassChatMessage> = {}): ClassChatMessage {
  return {
    author: author("2", "학생가"),
    body: "메시지 " + id,
    created_at: "2026-09-28T03:00:00.000Z",
    hidden: false,
    id,
    mine: false,
    ...values,
  };
}
function state(
  role: "student" | "teacher",
  messages: ClassChatMessage[],
  values: Partial<ClassChatState> = {},
): ClassChatState {
  return {
    has_more_before: false,
    me: {
      blocked_reason: null,
      can_send: true,
      member_id: role === "teacher" ? "1" : "3",
      muted_until: null,
      role,
    },
    messages,
    open_report_count: role === "teacher" ? 0 : null,
    room: { is_open: true },
    ...values,
  };
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/class-chat"]}>
      <LeaveProbe />
      <Routes>
        <Route element={<ClassChatPage />} path="/class-chat" />
        <Route element={<p>더보기 화면</p>} path="/more" />
        <Route element={<p>로그인 화면</p>} path="/login" />
      </Routes>
    </MemoryRouter>,
  );
}
function LeaveProbe() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate("/more")}>
      테스트 이탈
    </button>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClassChatPage", () => {
  it.each([
    "bootstrap-success",
    "bootstrap-401",
    "chat-success",
    "chat-401",
    "reports-success",
    "reports-401",
  ])("ignores initial %s after session clear", async (scenario) => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    let initialCalls = 0;
    const reports = scenario.startsWith("reports");
    const bootstrapPending = scenario.startsWith("bootstrap");
    mockApi("teacher", (call) => {
      if (
        call.url ===
        (bootstrapPending
          ? "/api/v1/bootstrap"
          : reports
            ? "/api/v1/class-chat/reports"
            : "/api/v1/class-chat")
      ) {
        initialCalls += 1;
        return pending;
      }
      if (call.url === "/api/v1/class-chat")
        return json(state("teacher", [], { open_report_count: 1 }));
    });
    renderPage();
    if (reports) fireEvent.click(await screen.findByRole("button", { name: /신고/u }));
    await waitFor(() => expect(initialCalls).toBeGreaterThan(0));
    act(() => clearAuthenticatedClientState());
    await act(async () =>
      finish(
        scenario.endsWith("401")
          ? json({ error: { code: "UNAUTHENTICATED", message: "로그인 필요" } }, 401)
          : json(
              bootstrapPending
                ? {
                    destination: "HOME",
                    allowed_actions: ["VIEW_CLASS", "USE_CLASS_CHAT"],
                    current_class: { id: "1" },
                    current_membership: {
                      class_id: "1",
                      id: "1",
                      role: "teacher",
                      status: "approved",
                    },
                  }
                : reports
                  ? {
                      items: [
                        {
                          id: "7",
                          message: message("1", { body: "옛 세션 내용" }),
                          reason: "이전 신고",
                          reporter: author("3", "학생나"),
                          created_at: "2026-09-28T03:01:00.000Z",
                        },
                      ],
                    }
                  : state("teacher", [message("1", { body: "옛 세션 내용" })]),
            ),
      ),
    );
    expect(screen.queryByText("로그인 화면")).not.toBeInTheDocument();
    expect(screen.queryByText("옛 세션 내용")).not.toBeInTheDocument();
    expect(screen.queryByText(/이전 신고/u)).not.toBeInTheDocument();
  });
  it.each([false, true])(
    "guards repeated report handling and stops its continuation after leaving=%s",
    async (leave) => {
      let finish!: (value: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      let hides = 0;
      let resolves = 0;
      mockApi("teacher", (call) => {
        if (call.url === "/api/v1/class-chat")
          return json(state("teacher", [message("1")], { open_report_count: 1 }));
        if (call.url === "/api/v1/class-chat/reports")
          return json({
            items: [
              {
                id: "7",
                message: message("1"),
                reason: "욕이에요",
                reporter: author("3", "학생나"),
                created_at: "2026-09-28T03:01:00.000Z",
              },
            ],
          });
        if (call.url.endsWith("/hide")) {
          hides += 1;
          return pending;
        }
        if (call.url.endsWith("/resolve")) {
          resolves += 1;
          return empty();
        }
      });
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /신고/u }));
      const handle = await screen.findByRole("button", { name: "가리고 처리" });
      act(() => {
        handle.click();
        handle.click();
      });
      await waitFor(() => expect(hides).toBe(1));
      if (leave) {
        fireEvent.click(screen.getByRole("button", { name: "테스트 이탈" }));
        await screen.findByText("더보기 화면");
      }
      await act(async () =>
        finish(
          leave
            ? empty()
            : json({ error: { code: "UNAUTHENTICATED", message: "로그인 필요" } }, 401),
        ),
      );
      expect(resolves).toBe(0);
      expect(await screen.findByText(leave ? "더보기 화면" : "로그인 화면")).toBeVisible();
    },
  );
  it.each([false, true])(
    "sends once for synchronous repeated submission and guards 401, leave=%s",
    async (leave) => {
      let finish!: (value: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      let posts = 0;
      mockApi("student", (call) => {
        if (call.method === "POST") {
          posts += 1;
          return pending;
        }
        if (call.url === "/api/v1/class-chat") return json(state("student", []));
      });
      renderPage();
      const field = await screen.findByLabelText("반 대화에 메시지 쓰기");
      fireEvent.change(field, { target: { value: "안녕하세요" } });
      act(() => {
        fireEvent.submit(field.closest("form")!);
        fireEvent.submit(field.closest("form")!);
      });
      await waitFor(() => expect(posts).toBe(1));
      if (leave) {
        fireEvent.click(screen.getByRole("button", { name: "테스트 이탈" }));
        await screen.findByText("더보기 화면");
      }
      await act(async () =>
        finish(json({ error: { code: "UNAUTHENTICATED", message: "로그인 필요" } }, 401)),
      );
      expect(await screen.findByText(leave ? "더보기 화면" : "로그인 화면")).toBeVisible();
    },
  );
  it("반 대화가 꺼져 있으면 서버 영문 오류 대신 더보기로 돌려보낸다(총검수 B2-04)", async () => {
    const calls = mockApi("student", (call) =>
      call.url === "/api/v1/bootstrap"
        ? json({
            allowed_actions: ["VIEW_CLASS"],
            current_class: { id: "1", name: "1반", status: "active" },
            current_membership: { class_id: "1", id: "1", role: "student", status: "approved" },
            destination: "HOME",
          })
        : undefined,
    );
    renderPage();
    expect(await screen.findByText("더보기 화면")).toBeVisible();
    expect(calls).toHaveLength(0);
  });
  it("학생: 새 메시지는 마지막 번호 뒤만 이어 받고, 가린 메시지는 내용 없이 보인다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let next: ClassChatState = state("student", []);
      const calls = mockApi("student", (call) => {
        if (call.url === "/api/v1/class-chat")
          return json(state("student", [message("1"), message("2", { body: null, hidden: true })]));
        if (call.url === "/api/v1/class-chat?after=2") return json(next);
        return undefined;
      });
      renderPage();
      expect(await screen.findByText("메시지 1")).toBeVisible();
      expect(screen.getByText("선생님이 가린 메시지예요.")).toBeVisible();
      expect(screen.getByText("2번 학생가")).toBeVisible();

      next = state("student", [
        message("3", { author: author("1", "김담임", "teacher"), body: "내일 봐요" }),
      ]);
      await vi.advanceTimersByTimeAsync(4100);
      expect(await screen.findByText("내일 봐요")).toBeVisible();
      expect(screen.getByText("김담임 선생님")).toBeVisible();
      expect(screen.getByText("메시지 1")).toBeVisible();
      expect(calls.some((call) => call.url === "/api/v1/class-chat?after=2")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("학생: 닫힌 방·밤에는 이유를 보여 주고 입력칸이 없다", async () => {
    mockApi("student", (call) =>
      call.url === "/api/v1/class-chat"
        ? json(
            state("student", [], {
              me: {
                blocked_reason: "night",
                can_send: false,
                member_id: "3",
                muted_until: null,
                role: "student",
              },
            }),
          )
        : undefined,
    );
    renderPage();
    expect(await screen.findByText("밤 10시부터 아침 7시까지는 보낼 수 없어요.")).toBeVisible();
    expect(screen.queryByLabelText("반 대화에 메시지 쓰기")).toBeNull();
  });

  it("학생: 보내면 입력칸이 비고, 다른 친구 메시지를 사유와 함께 신고한다", async () => {
    const calls = mockApi("student", (call) => {
      if (call.url === "/api/v1/class-chat" && call.method === "GET")
        return json(state("student", [message("1")]));
      if (call.url === "/api/v1/class-chat/messages")
        return json(state("student", [message("1"), message("2", { body: "안녕", mine: true })]));
      if (call.url === "/api/v1/class-chat/messages/1/report") return empty();
      return undefined;
    });
    renderPage();
    const field = await screen.findByLabelText("반 대화에 메시지 쓰기");
    fireEvent.change(field, { target: { value: "  안녕  " } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(await screen.findByText("안녕")).toBeVisible();
    expect(field).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "2번 학생가 메시지 더보기" }));
    fireEvent.click(screen.getByRole("button", { name: "선생님께 신고하기" }));
    fireEvent.change(screen.getByLabelText("무엇이 문제인가요?"), {
      target: { value: "놀리는 말" },
    });
    fireEvent.click(screen.getByRole("button", { name: "선생님께 신고" }));
    expect(await screen.findByText("신고했어요. 선생님이 확인해요.")).toBeVisible();
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      { body: { body: "안녕" }, method: "POST", url: "/api/v1/class-chat/messages" },
      {
        body: { reason: "놀리는 말" },
        method: "POST",
        url: "/api/v1/class-chat/messages/1/report",
      },
    ]);
  });

  it("학생: 저장은 됐는데 응답만 끊기면 다시 읽어 보낸 것으로 보고 두 번 보내지 않는다(총검수 F02)", async () => {
    let current = state("student", [message("1", { body: "안녕", mine: true })]);
    const calls = mockApi("student", (call) => {
      if (call.url === "/api/v1/class-chat" && call.method === "GET") return json(current);
      if (call.url === "/api/v1/class-chat/messages") {
        current = state("student", [
          ...current.messages,
          message("2", { body: "안녕", mine: true }),
        ]);
        throw new TypeError("Failed to fetch");
      }
      return undefined;
    });
    renderPage();
    const field = await screen.findByLabelText("반 대화에 메시지 쓰기");
    // 같은 말(안녕)을 일부러 다시 보내는 상황 — 예전 '안녕'(1번)은 새 글로 세지 않는다.
    fireEvent.change(field, { target: { value: "안녕" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(field).toHaveValue(""));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("학생: 연결이 끊겨 저장되지 않았으면 오류를 보여 주고 쓴 내용을 남긴다", async () => {
    mockApi("student", (call) => {
      if (call.url === "/api/v1/class-chat" && call.method === "GET")
        return json(state("student", [message("1", { body: "안녕", mine: true })]));
      if (call.url === "/api/v1/class-chat/messages") throw new TypeError("Failed to fetch");
      return undefined;
    });
    renderPage();
    const field = await screen.findByLabelText("반 대화에 메시지 쓰기");
    fireEvent.change(field, { target: { value: "안녕" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("서버에 연결하지 못했습니다");
    expect(field).toHaveValue("안녕");
  });

  it("담임: 방을 연 뒤 늦게 도착한 이전 새로고침이 방을 닫힘으로 되돌리지 않는다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let current = state("teacher", [message("1")], { room: { is_open: false } });
      let releasePoll: (() => void) | undefined;
      mockApi("teacher", (call) => {
        if (call.url === "/api/v1/class-chat" && call.method === "GET") return json(current);
        if (call.url === "/api/v1/class-chat?after=1")
          // 보내기 전에 출발해 늦게 도착하는 새로고침 — 방이 아직 닫혀 있던 때의 응답이다.
          return new Promise<Response>((resolve) => {
            releasePoll = () => resolve(json(state("teacher", [], { room: { is_open: false } })));
          }) as unknown as Response;
        if (call.url === "/api/v1/class-chat/room") {
          current = { ...current, room: { is_open: true } };
          return json(current);
        }
        return undefined;
      });
      renderPage();
      const open = await screen.findByRole("button", { name: "방 열기" });
      await vi.advanceTimersByTimeAsync(4100);
      await waitFor(() => expect(releasePoll).toBeDefined());
      fireEvent.click(open);
      expect(await screen.findByRole("button", { name: "방 닫기" })).toBeVisible();
      await act(async () => {
        releasePoll?.();
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.getByRole("button", { name: "방 닫기" })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("담임: 방을 열고, 학생 메시지를 가리거나 멈추고, 신고를 가리고 처리한다", async () => {
    let current = state("teacher", [message("1")], {
      open_report_count: 1,
      room: { is_open: false },
    });
    const report: ClassChatReport = {
      created_at: "2026-09-28T03:01:00.000Z",
      id: "7",
      message: message("1"),
      reason: "욕이에요",
      reporter: author("3", "학생나"),
    };
    let reports = [report];
    const calls = mockApi("teacher", (call) => {
      if (call.url === "/api/v1/class-chat" && call.method === "GET") return json(current);
      if (call.url === "/api/v1/class-chat/room") {
        current = { ...current, room: { is_open: (call.body as { is_open: boolean }).is_open } };
        return json(current);
      }
      if (call.url === "/api/v1/class-chat/messages/1/hide") {
        current = { ...current, messages: [message("1", { hidden: true })] };
        return json(current);
      }
      if (call.url === "/api/v1/class-chat/mutes/2") return empty();
      if (call.url === "/api/v1/class-chat/reports") return json({ items: reports });
      if (call.url === "/api/v1/class-chat/reports/7/resolve") {
        reports = [];
        current = { ...current, open_report_count: 0 };
        return empty();
      }
      return undefined;
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "방 열기" }));
    expect(await screen.findByRole("button", { name: "방 닫기" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "2번 학생가 메시지 더보기" }));
    fireEvent.click(screen.getByRole("button", { name: "10분 멈추기" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        body: { duration: "10m" },
        method: "PUT",
        url: "/api/v1/class-chat/mutes/2",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /신고/u }));
    const panel = await screen.findByRole("region", { name: "신고된 메시지" });
    expect(await within(panel).findByText(/학생나님이 신고 · 욕이에요/u)).toBeVisible();
    fireEvent.click(within(panel).getByRole("button", { name: "가리고 처리" }));
    expect(await within(panel).findByText("처리할 신고가 없어요.")).toBeVisible();
    expect(screen.getByText("학생에게 가려진 메시지")).toBeVisible();
    expect(calls.filter((call) => call.method !== "GET").map((call) => call.url)).toEqual([
      "/api/v1/class-chat/room",
      "/api/v1/class-chat/mutes/2",
      "/api/v1/class-chat/messages/1/hide",
      "/api/v1/class-chat/reports/7/resolve",
    ]);
  });

  it("학생: 사진이 있다고 표시된 친구만 사진을 요청한다(첫 사용 점검 19번)", async () => {
    mockApi("student", (call) => {
      if (call.url === "/api/v1/bootstrap")
        return json({
          allowed_actions: ["VIEW_CLASS", "USE_CLASS_CHAT", "USE_PROFILE_PHOTOS"],
          current_class: { id: "1", name: "1반", status: "active" },
          current_membership: { class_id: "1", id: "3", role: "student", status: "approved" },
          destination: "HOME",
        });
      if (call.url === "/api/v1/class-chat")
        return json(
          state("student", [
            message("1", { author: { ...author("2", "학생가"), has_profile_photo: true } }),
            message("2", { author: { ...author("4", "학생라"), has_profile_photo: false } }),
            // 표시가 없는 옛 응답은 예전처럼 요청한다.
            message("3", { author: author("5", "학생마") }),
          ]),
        );
      return undefined;
    });
    try {
      renderPage();
      expect(await screen.findByText("메시지 3")).toBeVisible();
      await waitFor(() =>
        expect(
          [...document.querySelectorAll("[data-class-chat-group] img")].map((img) =>
            img.getAttribute("src"),
          ),
        ).toEqual(["/api/v1/profile-photos/members/2", "/api/v1/profile-photos/members/5"]),
      );
    } finally {
      clearAuthenticatedClientState();
    }
  });
});
