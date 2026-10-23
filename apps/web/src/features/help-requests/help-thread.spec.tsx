import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HelpRequestItem, HelpThread } from "../../api/help-requests";
import { clearAuthenticatedClientState } from "../../lib/authenticated-client-state";
import { AskTeacherEntry } from "./ask-teacher-entry";
import { HelpRequestsPage } from "./help-requests-page";
import { AskTeacherPage, HelpThreadPage } from "./help-thread-page";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
function mockApi(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue("__Host-classhub_csrf=synthetic");
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => handler(urlOf(input), init));
}
function bootstrap(role: "student" | "teacher") {
  return {
    allowed_actions: role === "teacher" ? ["VIEW_CLASS", "MANAGE_CLASS"] : ["VIEW_CLASS"],
    current_class: { id: "1", name: "1반", status: "active" },
    current_membership: { class_id: "1", id: "1", role, status: "approved" },
    destination: "HOME",
  };
}
function item(values: Partial<HelpRequestItem>): HelpRequestItem {
  return {
    closed_at: null,
    created_at: "2026-09-27T01:00:00.000Z",
    id: "5",
    kind: "question",
    last_activity_at: "2026-09-27T01:00:00.000Z",
    message: null,
    reply: null,
    status: "open",
    student: null,
    target: { id: "30", kind: "supply", title: "물감" },
    ...values,
  };
}
function thread(
  request: Partial<HelpRequestItem>,
  messages: HelpThread["messages"] = [],
): HelpThread {
  return { messages, request: item(request) };
}
const message = (id: string, author: "student" | "teacher", body: string) => ({
  author,
  body,
  created_at: "2026-09-27T02:00:00.000Z",
  id,
});
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LeaveProbe />
      <Routes>
        <Route element={<AskTeacherPage />} path="/help-requests/ask" />
        <Route element={<HelpThreadPage />} path="/help-requests/:helpRequestId" />
        <Route element={<p>로그인 화면</p>} path="/login" />
        <Route element={<p>홈 화면</p>} path="/home" />
      </Routes>
    </MemoryRouter>,
  );
}
function LeaveProbe() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate("/home")}>
      테스트 이탈
    </button>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HelpThreadPage", () => {
  it.each(["thread-success", "thread-401", "ask-success", "ask-401"])(
    "ignores the initial %s response after the session is cleared",
    async (scenario) => {
      let finish!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      let initialCalls = 0;
      const ask = scenario.startsWith("ask");
      mockApi((url) => {
        if (url === "/api/v1/bootstrap") return json(bootstrap("student"));
        if (url.includes(ask ? "?status=open" : "/5/messages")) {
          initialCalls += 1;
          return pending;
        }
        return json({ items: [] });
      });
      renderAt(ask ? "/help-requests/ask" : "/help-requests/5");
      await waitFor(() => expect(initialCalls).toBeGreaterThan(0));
      act(() => clearAuthenticatedClientState());
      await act(async () =>
        finish(
          scenario.endsWith("401")
            ? json({ error: { code: "UNAUTHENTICATED", message: "로그인 필요" } }, 401)
            : json(
                ask
                  ? { items: [item({ kind: "general", target: null })] }
                  : thread({ message: "옛 세션 내용" }),
              ),
        ),
      );
      expect(screen.queryByText("로그인 화면")).not.toBeInTheDocument();
      expect(screen.queryByText("옛 세션 내용")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("선생님께 메시지 쓰기")).not.toBeInTheDocument();
    },
  );
  it.each(["thread", "ask"])(
    "guards synchronous repeated %s submission and handles current 401",
    async (page) => {
      let finish!: (value: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      let posts = 0;
      mockApi((url, init) => {
        if (url === "/api/v1/bootstrap") return json(bootstrap("student"));
        if (init?.method === "POST") {
          posts += 1;
          return pending;
        }
        if (url.includes("/messages")) return json(thread({}));
        return json({ items: [] });
      });
      renderAt(page === "thread" ? "/help-requests/5" : "/help-requests/ask");
      const field = await screen.findByLabelText("선생님께 메시지 쓰기");
      fireEvent.change(field, { target: { value: "질문 있어요" } });
      act(() => {
        fireEvent.submit(field.closest("form")!);
        fireEvent.submit(field.closest("form")!);
      });
      await waitFor(() => expect(posts).toBe(1));
      await act(async () =>
        finish(json({ error: { code: "UNAUTHENTICATED", message: "로그인 필요" } }, 401)),
      );
      expect(await screen.findByText("로그인 화면")).toBeVisible();
    },
  );

  it.each(["success", "401"])(
    "keeps the destination after a late question creation %s",
    async (outcome) => {
      let finish!: (value: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      mockApi((url, init) => {
        if (url === "/api/v1/bootstrap") return json(bootstrap("student"));
        if (init?.method === "POST") return pending;
        return json({ items: [] });
      });
      renderAt("/help-requests/ask");
      const field = await screen.findByLabelText("선생님께 메시지 쓰기");
      fireEvent.change(field, { target: { value: "질문 있어요" } });
      fireEvent.submit(field.closest("form")!);
      fireEvent.click(screen.getByRole("button", { name: "테스트 이탈" }));
      await screen.findByText("홈 화면");
      await act(async () =>
        finish(
          outcome === "success"
            ? json(thread({ id: "11", kind: "general", target: null }))
            : json({ error: { code: "UNAUTHENTICATED", message: "로그인 필요" } }, 401),
        ),
      );
      expect(screen.getByText("홈 화면")).toBeVisible();
      expect(screen.queryByText("로그인 화면")).not.toBeInTheDocument();
    },
  );
  it("학생은 예전 설명·답변과 메시지를 순서대로 보고, 보내면 대화에 붙고 입력칸이 비워진다", async () => {
    const posts: unknown[] = [];
    let current = thread({ message: "물감이 없어요", reply: "교실에 여분이 있어요" }, [
      message("1", "teacher", "내일 가져와도 돼요"),
    ]);
    mockApi((url, init) => {
      if (url === "/api/v1/bootstrap") return json(bootstrap("student"));
      expect(url).toBe("/api/v1/help-requests/5/messages");
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        current = {
          ...current,
          messages: [...current.messages, message("2", "student", "고맙습니다")],
        };
        return json(current, 201);
      }
      return json(current);
    });
    renderAt("/help-requests/5");
    const log = await screen.findByRole("log", { name: "주고받은 메시지" });
    expect(
      Array.from(log.querySelectorAll<HTMLElement>("[data-help-bubble]")).map(
        (row) => row.dataset.helpBubble,
      ),
    ).toEqual(["student", "teacher", "teacher"]);
    expect(within(log).getByText("물감이 없어요")).toBeVisible();
    // 학생 입력칸에는 수업·밤 시간 안내와 민감정보 경고가 붙는다.
    const field = screen.getByLabelText("선생님께 메시지 쓰기");
    expect(field).toHaveAccessibleDescription(/수업·밤 시간엔 답이 늦을 수 있어요/u);
    expect(field).toHaveAccessibleDescription(/민감한 내용은 직접 말해 주세요/u);
    fireEvent.change(field, { target: { value: "  고맙습니다 " } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(await within(log).findByText("고맙습니다")).toBeVisible();
    expect(posts).toEqual([{ body: "고맙습니다" }]);
    await waitFor(() => expect(field).toHaveValue(""));
    // 학생에게는 대화 닫기 버튼이 없다.
    expect(screen.queryByRole("button", { name: "대화 끝내기" })).not.toBeInTheDocument();
  });

  it("보내기 제한(429)이면 서버 안내를 보여 주고 쓴 내용을 지우지 않는다", async () => {
    mockApi((url, init) => {
      if (url === "/api/v1/bootstrap") return json(bootstrap("student"));
      if (init?.method === "POST")
        return json(
          {
            error: {
              code: "RATE_LIMITED",
              message: "조금 천천히 보내 주세요. 1분 뒤에 다시 보낼 수 있어요.",
            },
          },
          429,
        );
      return json(thread({ kind: "general", target: null }));
    });
    renderAt("/help-requests/5");
    const field = await screen.findByLabelText("선생님께 메시지 쓰기");
    fireEvent.change(field, { target: { value: "또 질문" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1분 뒤에 다시 보낼 수 있어요");
    expect(field).toHaveValue("또 질문");
  });

  it("저장은 됐는데 응답만 끊기면 대화를 다시 읽어 보낸 것으로 보고 두 번 보내지 않는다", async () => {
    const posts: unknown[] = [];
    let current = thread({ kind: "general", target: null }, [message("1", "student", "질문")]);
    mockApi((url, init) => {
      if (url === "/api/v1/bootstrap") return json(bootstrap("student"));
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        current = { ...current, messages: [...current.messages, message("2", "student", "질문")] };
        throw new TypeError("Failed to fetch");
      }
      return json(current);
    });
    renderAt("/help-requests/5");
    const field = await screen.findByLabelText("선생님께 메시지 쓰기");
    fireEvent.change(field, { target: { value: "질문" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(field).toHaveValue(""));
    const log = screen.getByRole("log", { name: "주고받은 메시지" });
    expect(within(log).getAllByText("질문")).toHaveLength(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(posts).toHaveLength(1);
  });

  it("연결이 끊겨 저장되지 않았으면 오류를 보여 주고 쓴 내용을 남긴다", async () => {
    mockApi((url, init) => {
      if (url === "/api/v1/bootstrap") return json(bootstrap("student"));
      if (init?.method === "POST") throw new TypeError("Failed to fetch");
      return json(thread({ kind: "general", target: null }, [message("1", "student", "질문")]));
    });
    renderAt("/help-requests/5");
    const field = await screen.findByLabelText("선생님께 메시지 쓰기");
    fireEvent.change(field, { target: { value: "질문" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("서버에 연결하지 못했습니다");
    expect(field).toHaveValue("질문");
  });

  it("501자 이상이면 보내기를 막고, 철회된 대화에는 입력칸이 없다", async () => {
    mockApi((url) => (url === "/api/v1/bootstrap" ? json(bootstrap("student")) : json(thread({}))));
    const view = renderAt("/help-requests/5");
    const field = await screen.findByLabelText("선생님께 메시지 쓰기");
    fireEvent.change(field, { target: { value: "가".repeat(501) } });
    expect(screen.getByRole("button", { name: "보내기" })).toBeDisabled();
    view.unmount();
    vi.restoreAllMocks();
    mockApi((url) =>
      url === "/api/v1/bootstrap"
        ? json(bootstrap("student"))
        : json(thread({ closed_at: "2026-09-27T03:00:00.000Z", status: "withdrawn" })),
    );
    renderAt("/help-requests/5");
    expect(await screen.findByText("학생이 철회한 요청이라 더 보낼 수 없어요.")).toBeVisible();
    expect(screen.queryByLabelText("선생님께 메시지 쓰기")).not.toBeInTheDocument();
  });

  it("학생은 더보기에서 요청을 거두고 같은 대화에 더 보내지 못한다", async () => {
    let withdrawn = false;
    const calls: string[] = [];
    mockApi((url, init) => {
      calls.push((init?.method ?? "GET") + " " + url);
      if (url === "/api/v1/bootstrap") return json(bootstrap("student"));
      if (url === "/api/v1/help-requests/5/withdraw" && init?.method === "POST") {
        withdrawn = true;
        return json(item({ status: "withdrawn" }));
      }
      expect(url).toBe("/api/v1/help-requests/5/messages");
      return json(thread({ status: withdrawn ? "withdrawn" : "open" }));
    });
    renderAt("/help-requests/5");
    fireEvent.click(await screen.findByRole("button", { name: "대화 더보기" }));
    fireEvent.click(screen.getByRole("button", { name: "요청 거두기" }));
    expect(await screen.findByText("학생이 철회한 요청이라 더 보낼 수 없어요.")).toBeVisible();
    expect(screen.queryByLabelText("선생님께 메시지 쓰기")).not.toBeInTheDocument();
    expect(calls).toContain("POST /api/v1/help-requests/5/withdraw");
  });

  // 2026-10-23: 학생 쪽 담임 사진도 같은 방식. 표시가 없는 옛 응답(undefined)은 예전처럼 요청한다.
  it.each([
    [true, ["/api/v1/profile-photos/current-class-teacher?class_id=1"]],
    [false, []],
    [undefined, ["/api/v1/profile-photos/current-class-teacher?class_id=1"]],
  ])(
    "학생은 서버가 담임 사진 있음(%s)이라 할 때만 담임 사진을 요청한다",
    async (hasPhoto, sources) => {
      mockApi((url) => {
        if (url === "/api/v1/bootstrap")
          return json({
            ...bootstrap("student"),
            allowed_actions: ["VIEW_CLASS", "USE_PROFILE_PHOTOS"],
          });
        return json({
          ...thread({ kind: "general", target: null }, [message("1", "teacher", "답변이에요")]),
          ...(hasPhoto === undefined ? {} : { teacher_has_profile_photo: hasPhoto }),
        });
      });
      try {
        renderAt("/help-requests/5");
        expect(await screen.findByText("답변이에요")).toBeVisible();
        await waitFor(() =>
          expect(
            [...document.querySelectorAll("[data-help-group] img")].map((img) =>
              img.getAttribute("src"),
            ),
          ).toEqual(sources),
        );
      } finally {
        clearAuthenticatedClientState();
      }
    },
  );

  // 첫 사용 점검 19번: 사진 없는 학생의 사진을 요청해 404가 생기던 것. true 쪽이 사진 칸이 켜졌음을 보여 준다.
  it.each([
    [true, ["/api/v1/profile-photos/members/2"]],
    [false, []],
  ])("담임은 서버가 학생 사진 있음(%s)이라 할 때만 사진을 요청한다", async (hasPhoto, sources) => {
    mockApi((url) => {
      if (url === "/api/v1/bootstrap")
        return json({
          ...bootstrap("teacher"),
          allowed_actions: ["VIEW_CLASS", "MANAGE_CLASS", "USE_PROFILE_PHOTOS"],
        });
      return json(
        thread(
          {
            kind: "general",
            student: {
              display_name: "학생가",
              has_profile_photo: hasPhoto,
              member_id: "2",
              student_number: 1,
            },
            target: null,
          },
          [message("1", "student", "질문 있어요")],
        ),
      );
    });
    try {
      renderAt("/help-requests/5");
      expect(await screen.findByText("질문 있어요")).toBeVisible();
      await waitFor(() =>
        expect(
          [...document.querySelectorAll("[data-help-group] img")].map((img) =>
            img.getAttribute("src"),
          ),
        ).toEqual(sources),
      );
    } finally {
      clearAuthenticatedClientState();
    }
  });

  it("담임은 학생 이름을 보고 대화를 끝낸 뒤 메시지를 보내 다시 연다", async () => {
    const calls: string[] = [];
    let status: HelpRequestItem["status"] = "open";
    const replies: HelpThread["messages"] = [];
    mockApi((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/v1/bootstrap") return json(bootstrap("teacher"));
      if (url === "/api/v1/help-requests/5/resolve") {
        status = "resolved";
        return json(item({ kind: "general", status, target: null }));
      }
      if (url === "/api/v1/help-requests/5/messages" && init?.method === "POST") {
        status = "open";
        replies.push(message("2", "teacher", "추가 답변"));
      }
      return json(
        thread(
          {
            closed_at: status === "resolved" ? "2026-09-27T03:00:00.000Z" : null,
            kind: "general",
            status,
            student: { display_name: "학생가", member_id: "2", student_number: 1 },
            target: null,
          },
          [message("1", "student", "수행평가 범위가 궁금해요"), ...replies],
        ),
      );
    });
    renderAt("/help-requests/5");
    expect(await screen.findByRole("heading", { name: "학생가" })).toBeVisible();
    expect(screen.getByText(/1번 · 대화 중/u)).toBeVisible();
    expect(screen.getByLabelText("학생에게 답장 쓰기")).toHaveAccessibleDescription(
      /고치거나 지울 수 없어요/u,
    );
    fireEvent.click(screen.getByRole("button", { name: "대화 더보기" }));
    fireEvent.click(screen.getByRole("button", { name: "대화 끝내기" }));
    expect(await screen.findByText("대화가 끝났어요")).toBeVisible();
    expect(screen.getByText("닫힌 대화예요. 메시지를 보내면 다시 열려요.")).toBeVisible();
    expect(calls).toContain("POST /api/v1/help-requests/5/resolve");
    expect(screen.queryByLabelText("학생에게 답장 쓰기")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "메시지 보내 다시 열기" }));
    fireEvent.change(screen.getByLabelText("학생에게 답장 쓰기"), {
      target: { value: "추가 답변" },
    });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(await screen.findByText("추가 답변")).toBeVisible();
    expect(calls).toContain("POST /api/v1/help-requests/5/messages");
  });

  it("대화를 열어 두면 상대가 보낸 메시지가 새로고침 없이 보이고, 숨긴 탭에서는 묻지 않는다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let current = thread({}, [message("1", "student", "물감이 없어요")]);
      let threadReads = 0;
      mockApi((url) => {
        if (url === "/api/v1/bootstrap") return json(bootstrap("student"));
        threadReads += 1;
        return json(current);
      });
      renderAt("/help-requests/5");
      expect(await screen.findByText("물감이 없어요")).toBeVisible();

      current = thread({ last_activity_at: "2026-09-27T02:05:00.000Z" }, [
        message("1", "student", "물감이 없어요"),
        message("2", "teacher", "미술실 물감을 쓰세요"),
      ]);
      await vi.advanceTimersByTimeAsync(4100);
      expect(await screen.findByText("미술실 물감을 쓰세요")).toBeVisible();

      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      const readsWhileVisible = threadReads;
      await vi.advanceTimersByTimeAsync(12_500);
      expect(threadReads).toBe(readsWhileVisible);
      visibility.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AskTeacherPage", () => {
  it("열린 '선생님께 물어보기' 대화가 있으면 그 대화로 바로 간다", async () => {
    mockApi((url) => {
      if (url === "/api/v1/bootstrap") return json(bootstrap("student"));
      if (url === "/api/v1/help-requests?status=open")
        return json({
          items: [item({ id: "3" }), item({ id: "9", kind: "general", target: null })],
        });
      expect(url).toBe("/api/v1/help-requests/9/messages");
      return json(thread({ id: "9", kind: "general", target: null }));
    });
    renderAt("/help-requests/ask");
    expect(await screen.findByRole("heading", { name: "담임 선생님" })).toBeVisible();
    expect(await screen.findByRole("log", { name: "주고받은 메시지" })).toBeVisible();
  });

  it("없으면 첫 메시지를 보내 대화를 시작하고 그 대화 화면으로 간다", async () => {
    const posts: unknown[] = [];
    mockApi((url, init) => {
      if (url === "/api/v1/bootstrap") return json(bootstrap("student"));
      if (url === "/api/v1/notices?importance=all" || url === "/api/v1/supplies?scope=upcoming")
        return json({ items: [] });
      if (url === "/api/v1/help-requests?status=open") return json({ items: [item({ id: "3" })] });
      if (url === "/api/v1/help-requests/general") {
        posts.push(JSON.parse(String(init?.body)));
        return json(
          thread({ id: "11", kind: "general", target: null }, [
            message("1", "student", "질문 있어요"),
          ]),
          201,
        );
      }
      expect(url).toBe("/api/v1/help-requests/11/messages");
      return json(
        thread({ id: "11", kind: "general", target: null }, [
          message("1", "student", "질문 있어요"),
        ]),
      );
    });
    renderAt("/help-requests/ask");
    fireEvent.change(await screen.findByLabelText("선생님께 메시지 쓰기"), {
      target: { value: "질문 있어요" },
    });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    const log = await screen.findByRole("log", { name: "주고받은 메시지" });
    expect(within(log).getByText("질문 있어요")).toBeVisible();
    expect(posts).toEqual([{ body: "질문 있어요" }]);
  });

  it("글에서 시작한 새 질문은 해당 글을 미리 고르고 첫 설명 200자 제한을 지킨다", async () => {
    const posts: unknown[] = [];
    mockApi((url, init) => {
      if (url === "/api/v1/bootstrap") return json(bootstrap("student"));
      if (url === "/api/v1/help-requests?status=open&target_kind=supply&target_id=30")
        return json({ items: [] });
      if (url === "/api/v1/supplies/30")
        return json({ id: "30", title: "물감", category: "general", row_version: "1" });
      if (url === "/api/v1/notices?importance=all" || url === "/api/v1/supplies?scope=upcoming")
        return json({ items: [] });
      if (url === "/api/v1/help-requests" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return json(item({ message: "어떤 색이 필요해요?" }), 201);
      }
      expect(url).toBe("/api/v1/help-requests/5/messages");
      return json(thread({ message: "어떤 색이 필요해요?" }));
    });
    renderAt("/help-requests/ask?target_kind=supply&target_id=30");
    const field = await screen.findByLabelText("선생님께 메시지 쓰기");
    expect(screen.getByRole("radio", { name: /물감/u })).toBeChecked();
    expect(screen.getByRole("button", { name: "질문을 적어 주세요" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "가".repeat(201) } });
    expect(screen.getByRole("button", { name: "보내기" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "어떤 색이 필요해요?" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    const log = await screen.findByRole("log", { name: "주고받은 메시지" });
    expect(within(log).getByText("어떤 색이 필요해요?")).toBeVisible();
    expect(posts).toEqual([
      { kind: "question", message: "어떤 색이 필요해요?", target_id: "30", target_kind: "supply" },
    ]);
  });

  it("선생님이 열면 학생 화면이라고 막는다", async () => {
    mockApi(() => json(bootstrap("teacher")));
    renderAt("/help-requests/ask");
    expect(await screen.findByText("선생님께 물어보기는 학생 화면이에요.")).toBeVisible();
  });

  it("끝난 지난 질문을 최근 순으로 다시 열 수 있게 보여 준다(총검수 B2-02)", async () => {
    mockApi((url) => {
      if (url === "/api/v1/bootstrap") return json(bootstrap("student"));
      if (url === "/api/v1/notices?importance=all" || url === "/api/v1/supplies?scope=upcoming")
        return json({ items: [] });
      if (url === "/api/v1/help-requests?status=open") return json({ items: [] });
      expect(url).toBe("/api/v1/help-requests?status=all");
      return json({
        items: [
          item({
            id: "1",
            status: "open",
            target: { id: "30", kind: "supply", title: "열린 질문" },
          }),
          item({
            id: "2",
            kind: "general",
            last_activity_at: "2026-09-25T01:00:00.000Z",
            reply: "내일 가져오면 돼요",
            status: "resolved",
            target: null,
          }),
          item({
            id: "3",
            last_activity_at: "2026-09-26T01:00:00.000Z",
            status: "withdrawn",
            target: { id: "31", kind: "notice", title: "체육대회 안내" },
          }),
        ],
      });
    });
    renderAt("/help-requests/ask");
    const past = await screen.findByRole("region", { name: "지난 질문" });
    const links = within(past).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/help-requests/3",
      "/help-requests/2",
    ]);
    expect(within(past).getByText("선생님 답: 내일 가져오면 돼요")).toBeVisible();
    expect(within(past).queryByText("열린 질문")).not.toBeInTheDocument();
  });
});

describe("도움 대화 입구", () => {
  it("담임 목록은 글과 무관한 질문도 보여 주고 대화 열기로 잇는다", async () => {
    mockApi((url) =>
      url === "/api/v1/bootstrap"
        ? json(bootstrap("teacher"))
        : json({
            items: [
              item({
                id: "7",
                kind: "general",
                student: { display_name: "학생가", member_id: "2", student_number: 1 },
                target: null,
              }),
            ],
          }),
    );
    render(
      <MemoryRouter>
        <HelpRequestsPage />
      </MemoryRouter>,
    );
    const row = (await screen.findByText("1번 학생가")).closest("li")!;
    expect(within(row).getByText("일반 질문")).toBeVisible();
    expect(within(row).getByRole("link", { name: /대화 열기/u })).toHaveAttribute(
      "href",
      "/help-requests/7",
    );
  });

  it("학생 홈 입구는 선생님께 물어보기 화면으로 간다", () => {
    render(
      <MemoryRouter>
        <AskTeacherEntry />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /선생님께 물어보기/u })).toHaveAttribute(
      "href",
      "/help-requests/ask",
    );
  });
});
