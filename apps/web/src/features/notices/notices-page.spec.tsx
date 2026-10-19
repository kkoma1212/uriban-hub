import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NoticeDetailPage } from "./notice-detail-page";
import { NoticesPage } from "./notices-page";

const teacherBootstrap = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: { class_id: "1", id: "1", role: "teacher", status: "approved" },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-14",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const studentBootstrap = {
  ...teacherBootstrap,
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "LEAVE_CLASS", "VIEW_CLASS"],
  current_membership: { ...teacherBootstrap.current_membership, role: "student" },
  teacher_profile: null,
};

const importantNotice = {
  content: "금요일까지 수행평가를 제출해 주세요.",
  content_revision: "1",
  id: "17",
  is_important: true,
  published_at: "2026-07-14T03:00:00.000Z",
  row_version: "1",
  title: "수행평가 안내",
};

const regularNotice = {
  ...importantNotice,
  id: "18",
  is_important: false,
  title: "이번 주 청소구역 안내",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function noticeProgressFixture(url: string): Response | undefined {
  if (!/^\/api\/v1\/notices\/[^/]+\/confirmations[?]/u.test(url)) return undefined;
  return jsonResponse({
    content_revision: "1",
    counts: { confirmed: 1, modified_unconfirmed: 1, unread: 2, excluded_member_count: 0 },
    items: [],
    last_reminder_requested_at: null,
    next_cursor: null,
    server_today: "2026-07-14",
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function renderList(role: "student" | "teacher" = "teacher", initialEntry = "/notices") {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
    const progressResponse = noticeProgressFixture(url);
    if (progressResponse !== undefined) return Promise.resolve(progressResponse);
    if (url === "/api/v1/bootstrap") {
      return Promise.resolve(
        jsonResponse(
          role === "teacher"
            ? teacherBootstrap
            : {
                ...teacherBootstrap,
                allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "LEAVE_CLASS", "VIEW_CLASS"],
                current_membership: { ...teacherBootstrap.current_membership, role: "student" },
                teacher_profile: null,
              },
        ),
      );
    }
    if (url === "/api/v1/notices?importance=all") {
      return Promise.resolve(
        jsonResponse({
          items: [
            role === "student"
              ? { ...importantNotice, confirmation_state: "modified_unconfirmed" }
              : importantNotice,
            role === "student" ? { ...regularNotice, confirmation_state: "unread" } : regularNotice,
          ],
          next_cursor: null,
          server_today: "2026-07-14",
        }),
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <NoticesPage />
    </MemoryRouter>,
  );
  return fetchMock;
}

function NoticeDetailNavigationHarness(): React.JSX.Element {
  const navigate = useNavigate();

  return (
    <main>
      <h1>공지 상세 테스트</h1>
      <button onClick={() => void navigate(-1)} type="button">
        브라우저 뒤로가기
      </button>
      <button onClick={() => void navigate("/notices")} type="button">
        새 공지 목록 진입
      </button>
    </main>
  );
}

function BrowserHistoryBackControl(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <button onClick={() => void navigate(-1)} type="button">
      브라우저 기록 뒤로가기
    </button>
  );
}

function renderNoticeHistoryFlow(entryKey: string, returningItems = [importantNotice]) {
  const returningListRequest = deferred<Response>();
  let listRequestCount = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
    const progressResponse = noticeProgressFixture(url);
    if (progressResponse !== undefined) return Promise.resolve(progressResponse);
    if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(studentBootstrap));
    if (url === "/api/v1/notices?importance=all") {
      listRequestCount += 1;
      if (listRequestCount === 2) return returningListRequest.promise;
      return Promise.resolve(
        jsonResponse({
          items: [importantNotice],
          next_cursor: null,
          server_today: "2026-07-14",
        }),
      );
    }
    if (url === "/api/v1/notices/17") {
      return Promise.resolve(jsonResponse({ ...importantNotice, confirmation_state: "unread" }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const scrollToMock = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  vi.spyOn(window, "scrollY", "get").mockReturnValue(300);

  render(
    <MemoryRouter initialEntries={[{ key: entryKey, pathname: "/notices" }]}>
      <BrowserHistoryBackControl />
      <Routes>
        <Route element={<NoticesPage />} path="/notices" />
        <Route element={<NoticeDetailPage />} path="/notices/:noticeId" />
      </Routes>
    </MemoryRouter>,
  );

  return {
    resolveReturningList: () =>
      returningListRequest.resolve(
        jsonResponse({ items: returningItems, next_cursor: null, server_today: "2026-07-14" }),
      ),
    scrollToMock,
  };
}

describe("NoticesPage", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("retries only bootstrap in place before loading the notice list", async () => {
    let bootstrapRequestCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const progressResponse = noticeProgressFixture(url);
      if (progressResponse !== undefined) return Promise.resolve(progressResponse);
      if (url === "/api/v1/bootstrap") {
        bootstrapRequestCount += 1;
        return Promise.resolve(
          bootstrapRequestCount === 1
            ? jsonResponse(
                {
                  error: {
                    code: "QA_FORCED_503",
                    message: "잠시 후 다시 시도해 주세요.",
                  },
                },
                503,
              )
            : jsonResponse(teacherBootstrap),
        );
      }
      if (url === "/api/v1/notices?importance=all") {
        return Promise.resolve(
          jsonResponse({
            items: [importantNotice],
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/notices?wave=bootstrap-retry"]}>
        <NoticesPage />
      </MemoryRouter>,
    );

    const retryButton = await screen.findByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");
    fireEvent.click(retryButton);
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();

    expect(await screen.findByRole("link", { name: /수행평가 안내/u })).toBeVisible();
    expect(bootstrapRequestCount).toBe(2);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/notices?importance=all",
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.method === undefined || init.method === "GET"),
    ).toBe(true);
  });

  it("renders one pinned notice flow and regular-by-default teacher creation", async () => {
    renderList();

    await screen.findByRole("button", { name: "공지 작성" });
    const pageHeading = screen.getByRole("heading", { level: 1, name: "공지" });
    expect(pageHeading).toBeVisible();
    expect(
      within(pageHeading.closest("header")!).getByRole("button", { name: "공지 작성" }),
    ).toBeVisible();
    expect(
      within(pageHeading.closest("header")!).getByRole("button", { name: "공지 검색 열기" }),
    ).toBeVisible();
    expect(pageHeading.closest("header")).toHaveClass("content-frame-header");
    expect(screen.getByRole("button", { name: "공지 작성" })).toHaveClass("content-write");
    expect(
      screen.queryByRole("navigation", { name: "통합 알림·공지·준비물" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    const importantLink = await screen.findByRole("link", { name: /수행평가 안내/u });
    expect(importantLink).toHaveAttribute("href", "/notices/17");
    expect(importantLink).toHaveClass("content-card");
    expect(screen.getByRole("link", { name: /이번 주 청소구역 안내/u })).toHaveAttribute(
      "href",
      "/notices/18",
    );
    expect(within(importantLink).getByText("중요")).toBeVisible();
    expect(within(screen.getByRole("list", { name: "공지 목록" })).getAllByRole("link")[0]).toBe(
      importantLink,
    );

    const createButton = screen.getByRole("button", { name: "공지 작성" });
    createButton.focus();
    fireEvent.click(createButton);
    const title = screen.getByRole("textbox", { name: "공지 제목" });
    const content = screen.getByRole("textbox", { name: "공지 내용" });
    expect(title).toHaveFocus();
    const publishSummary = screen.getByRole("region", { name: "게시 대상과 결과" });
    expect(publishSummary).toHaveClass("border-role-border", "bg-role-soft");
    expect(within(publishSummary).getByText("현재 반의 승인된 학생에게 게시")).toBeVisible();
    expect(within(publishSummary).getByText(/학생별 확인 현황/u)).toBeVisible();
    expect(title).toBeRequired();
    expect(title).toHaveAttribute("aria-required", "true");
    expect(content).toBeRequired();
    expect(content).toHaveAttribute("aria-required", "true");
    expect(screen.getByText("필수 · 1~100자")).toBeVisible();
    expect(screen.getByText("필수 · 1~2,000자")).toBeVisible();
    expect(screen.getByRole("group", { name: "저장 및 취소" })).toHaveAttribute(
      "data-form-action-bar",
      "fixed",
    );
    expect(screen.getByRole("checkbox", { name: /중요 공지로 표시/u })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "등록하기" }));
    const error = await screen.findByText("공지 제목은 1자 이상 100자 이하로 입력해 주세요.");
    expect(title.getAttribute("aria-describedby")).toContain(error.id);
    await waitFor(() => expect(title).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(createButton).toHaveFocus();
  });

  it("reuses one key after a committed response is lost and the page is recreated", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const idempotencyKey = "11111111-1111-4111-8111-111111111111";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(idempotencyKey);
    const createdNotice = { ...importantNotice, id: "99", is_important: false };
    const storedByKey = new Map<string, typeof createdNotice>();
    const submittedKeys: string[] = [];
    let loseFirstResponse = true;
    let createdRows = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      const progressResponse = noticeProgressFixture(url);
      if (progressResponse !== undefined) return Promise.resolve(progressResponse);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/notices?importance=all") {
        return Promise.resolve(
          jsonResponse({
            items: [importantNotice, regularNotice],
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      if (url === "/api/v1/notices" && init?.method === "POST") {
        const key = new Headers(init.headers).get("Idempotency-Key");
        if (key === null) throw new Error("Idempotency-Key가 없습니다.");
        submittedKeys.push(key);
        if (!storedByKey.has(key)) {
          storedByKey.set(key, createdNotice);
          createdRows += 1;
        }
        if (loseFirstResponse) {
          loseFirstResponse = false;
          return Promise.reject(new TypeError("response lost after commit"));
        }
        return Promise.resolve(jsonResponse(storedByKey.get(key), 201));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const firstRender = render(
      <MemoryRouter initialEntries={["/notices"]}>
        <NoticesPage />
      </MemoryRouter>,
    );
    await screen.findByText(/기준일/u);
    fireEvent.click(screen.getByRole("button", { name: "공지 작성" }));
    fireEvent.change(screen.getByRole("textbox", { name: "공지 제목" }), {
      target: { value: "응답 유실 확인 공지" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "공지 내용" }), {
      target: { value: "같은 요청은 한 번만 저장되어야 합니다." },
    });
    const firstForm = screen.getByRole("textbox", { name: "공지 제목" }).closest("form");
    if (firstForm === null) throw new Error("공지 등록 폼을 찾지 못했습니다.");
    fireEvent.submit(firstForm);
    fireEvent.submit(firstForm);

    expect(await screen.findByText(/공지 작성 요청이 저장됐는지 확인하지 못했어요/u)).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => requestUrl(input) === "/api/v1/notices" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "공지 제목" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "결과 다시 확인" })).toBeEnabled();
    expect(createdRows).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("textbox", { name: "공지 제목" })).not.toBeInTheDocument();
    expect(window.sessionStorage.length).toBe(1);

    firstRender.unmount();
    render(
      <MemoryRouter initialEntries={["/notices"]}>
        <NoticesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/공지 작성 요청이 저장됐는지 확인하지 못했어요/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "공지 작성" }));
    expect(screen.getByRole("textbox", { name: "공지 제목" })).toHaveValue("응답 유실 확인 공지");
    expect(screen.getByRole("textbox", { name: "공지 내용" })).toHaveValue(
      "같은 요청은 한 번만 저장되어야 합니다.",
    );
    fireEvent.click(screen.getByRole("button", { name: "결과 다시 확인" }));

    await waitFor(() => expect(submittedKeys).toHaveLength(2));
    expect(submittedKeys).toEqual([idempotencyKey, idempotencyKey]);
    expect(createdRows).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("does not send a create request when safe retry storage is unavailable", async () => {
    const fetchMock = renderList();
    /*
     * ⚠️ **목록이 도착한 뒤에 눌러야 한다**(T-HUB-27, 2026-08-20 재현으로 확인).
     *
     * 이 스펙이 재려는 것은 "저장소를 못 쓸 때 POST 를 안 보낸다"인데, 제품에는 그보다
     * **먼저 걸리는 갈래**가 하나 더 있다 — 기준일(`server_today`)을 아직 못 받았으면
     * 저장소를 건드리기도 전에 "서버에서 확인하지 못했습니다"로 끝난다
     * (`use-idempotent-content-create.ts` 의 `authoritativeServerToday === undefined` 갈래).
     * 기준일은 **목록 응답**에 실려 오는데 「공지 등록」 단추는 그전에 이미 보인다.
     *
     * 그래서 목록을 안 기다리면 **어느 갈래로 갈지가 경합**이 된다. 전체 게이트처럼
     * 부하가 걸린 곳에서 목록이 늦게 오면 다른 갈래로 빠졌고, 그게 이 케이스가 넉 달간
     * 세 번 흔들린 이유다. 실제로 목록 응답을 300ms 늦춰 **결정적으로 재현**했다.
     * ⚠️ 그러므로 **대기 시간을 늘리는 처방은 틀렸다** — 아무리 기다려도 그 글은 안 온다.
     */
    expect(await screen.findByRole("link", { name: /수행평가 안내/u })).toBeVisible();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("storage denied", "SecurityError");
    });
    fireEvent.click(await screen.findByRole("button", { name: "공지 작성" }));
    fireEvent.change(screen.getByRole("textbox", { name: "공지 제목" }), {
      target: { value: "저장 공간 차단 확인" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "공지 내용" }), {
      target: { value: "안전 정보가 없으면 POST를 보내지 않습니다." },
    });
    fireEvent.click(screen.getByRole("button", { name: "등록하기" }));

    expect(
      await screen.findByText(/임시 정보를 저장할 수 없어 보내지 않았어요/u, undefined, {
        timeout: 3_000,
      }),
    ).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => requestUrl(input) === "/api/v1/notices" && init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("keeps the submit button locked until the server date arrives", async () => {
    /*
     * 기준일이 오기 전에 누르면 제품이 "네트워크 연결을 확인하세요"를 띄웠다 —
     * 네트워크는 멀쩡하고 화면이 아직 준비가 안 된 것이라 읽는 사람이 헷갈린다
     * (2026-08-20 Hex 결정으로 막았다). 목록 응답을 손에 쥐고 있다가 놓아 주면서
     * **잠겼다가 풀리는 것**을 잰다. 잠금이 조용히 풀리면 여기서 잡힌다.
     */
    const listRequest = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const progressResponse = noticeProgressFixture(url);
      if (progressResponse !== undefined) return Promise.resolve(progressResponse);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/notices?importance=all") return listRequest.promise;
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/notices"]}>
        <NoticesPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "공지 작성" }));
    expect(screen.getByRole("button", { name: "등록하기" })).toBeDisabled();

    listRequest.resolve(
      jsonResponse({ items: [importantNotice], next_cursor: null, server_today: "2026-07-14" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "등록하기" })).toBeEnabled();
    });
  });

  it("does not replay an old key after the server date advances even if the client clock rolls back", async () => {
    const request = {
      content: "서버 보존 시간을 넘긴 키는 다시 보내지 않습니다.",
      is_important: false,
      title: "시계 변경 안전성",
    };
    window.sessionStorage.setItem(
      "classhub:idempotent-create:notices:1",
      JSON.stringify({
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        request,
        serverDate: "2026-07-14",
        startedAt: 1_000,
        version: 2,
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(1_000 + 22 * 60 * 60 * 1_000);
    let authoritativeServerToday = "2026-07-14";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      const progressResponse = noticeProgressFixture(url);
      if (progressResponse !== undefined) return Promise.resolve(progressResponse);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/notices?importance=all") {
        return Promise.resolve(
          jsonResponse({
            items: [importantNotice, regularNotice],
            next_cursor: null,
            server_today: authoritativeServerToday,
          }),
        );
      }
      if (url === "/api/v1/notices" && init?.method === "POST") {
        throw new Error("만료된 키로 POST를 보내면 안 됩니다.");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/notices"]}>
        <NoticesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/공지 작성 요청이 저장됐는지 확인하지 못했어요/u)).toBeVisible();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => requestUrl(input) === "/api/v1/notices?importance=all",
        ),
      ).toHaveLength(1),
    );
    authoritativeServerToday = "2026-07-15";
    fireEvent.click(screen.getByRole("button", { name: "공지 작성" }));
    expect(screen.getByRole("textbox", { name: "공지 제목" })).toHaveValue(request.title);
    fireEvent.click(screen.getByRole("button", { name: "결과 다시 확인" }));

    expect(await screen.findByText(/다시 확인할 수 있는 시간이 지났어요/u)).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => requestUrl(input) === "/api/v1/notices" && init?.method === "POST",
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/notices?importance=all",
      ),
    ).toHaveLength(2);
  });

  it("treats a legacy importance URL as the same unified list", async () => {
    const fetchMock = renderList("teacher", "/notices?importance=regular");

    expect(await screen.findByRole("heading", { name: "공지 목록" })).toBeVisible();
    expect(await screen.findByRole("link", { name: /수행평가 안내/u })).toBeVisible();
    expect(screen.getByRole("link", { name: /이번 주 청소구역 안내/u })).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/notices?importance=all",
      ),
    ).toHaveLength(1);
  });

  it("appends the next unified page", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const progressResponse = noticeProgressFixture(url);
      if (progressResponse !== undefined) return Promise.resolve(progressResponse);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/notices?importance=all") {
        return Promise.resolve(
          jsonResponse({
            items: [importantNotice],
            next_cursor: "next",
            server_today: "2026-07-14",
          }),
        );
      }
      if (url === "/api/v1/notices?importance=all&cursor=next") {
        return Promise.resolve(
          jsonResponse({
            items: [regularNotice],
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    render(
      <MemoryRouter initialEntries={["/notices"]}>
        <NoticesPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "지난 공지 더 보기" }));
    expect(await screen.findByRole("link", { name: /이번 주 청소구역 안내/u })).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestUrl(input) === "/api/v1/notices?importance=all&cursor=next",
      ),
    ).toBe(true);
  });

  it("shows student revision states without teacher mutation controls", async () => {
    renderList("student");

    expect(await screen.findByText("바뀐 내용을 확인해 주세요")).toBeVisible();
    const heading = screen.getByRole("heading", { name: "공지" });
    expect(
      within(heading.closest("header")!).queryByRole("button", { name: "공지 작성" }),
    ).not.toBeInTheDocument();
    expect(heading.closest("header")).toHaveClass("content-frame-header");
    expect(screen.getByText("아직 안 했어요")).toBeVisible();
    expect(screen.queryByRole("button", { name: "공지 작성" })).not.toBeInTheDocument();
  });

  it.each([
    { entryKey: "app-return-entry", returnControl: "소식" },
    { entryKey: "browser-return-entry", returnControl: "브라우저 기록 뒤로가기" },
  ])(
    "restores the originating notice link focus after async $returnControl navigation",
    async ({ entryKey, returnControl }) => {
      const { resolveReturningList, scrollToMock } = renderNoticeHistoryFlow(entryKey);
      const originLink = await screen.findByRole("link", { name: /수행평가 안내/u });
      originLink.focus();
      expect(originLink).toHaveFocus();
      fireEvent.click(originLink);

      expect(await screen.findByRole("heading", { name: "수행평가 안내", level: 1 })).toBeVisible();
      scrollToMock.mockClear();
      const backControl = screen.getByRole("button", { name: returnControl });
      backControl.focus();
      fireEvent.click(backControl);

      expect(await screen.findByRole("heading", { name: "공지 목록" })).toBeVisible();
      expect(screen.getByRole("heading", { level: 1, name: "공지" })).toBeVisible();
      expect(scrollToMock).not.toHaveBeenCalled();
      resolveReturningList();

      const returnedLink = await screen.findByRole("link", { name: /수행평가 안내/u });
      await waitFor(() => {
        expect(scrollToMock).toHaveBeenCalledWith({ behavior: "auto", left: 0, top: 300 });
        expect(returnedLink).toHaveFocus();
      });
    },
  );

  it("falls back to the list heading when the originating notice no longer exists", async () => {
    const { resolveReturningList, scrollToMock } = renderNoticeHistoryFlow(
      "deleted-target-entry",
      [],
    );
    const originLink = await screen.findByRole("link", { name: /수행평가 안내/u });
    originLink.focus();
    fireEvent.click(originLink);

    expect(await screen.findByRole("heading", { name: "수행평가 안내", level: 1 })).toBeVisible();
    scrollToMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "소식" }));
    expect(await screen.findByRole("heading", { name: "공지 목록" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "공지" })).toBeVisible();
    resolveReturningList();

    expect(await screen.findByText("아직 공지가 없어요.")).toBeVisible();
    const listHeading = screen.getByRole("heading", { name: "공지 목록" });
    expect(listHeading).toHaveClass("focus-visible:ring-2", "focus-visible:ring-role-primary");
    await waitFor(() => {
      expect(scrollToMock).toHaveBeenCalledWith({ behavior: "auto", left: 0, top: 300 });
      expect(listHeading).toHaveFocus();
    });
  });

  it("restores scrollY=300 after list data renders when returning to the same history entry", async () => {
    const returningListRequest = deferred<Response>();
    let listRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const progressResponse = noticeProgressFixture(url);
      if (progressResponse !== undefined) return Promise.resolve(progressResponse);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/notices?importance=all") {
        listRequestCount += 1;
        if (listRequestCount === 2) return returningListRequest.promise;
        return Promise.resolve(
          jsonResponse({
            items: [importantNotice],
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const scrollToMock = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    vi.spyOn(window, "scrollY", "get").mockReturnValue(300);

    render(
      <MemoryRouter initialEntries={[{ key: "restore-list-entry", pathname: "/notices" }]}>
        <Routes>
          <Route element={<NoticesPage />} path="/notices" />
          <Route element={<NoticeDetailNavigationHarness />} path="/notices/:noticeId" />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("link", { name: /수행평가 안내/u }));
    expect(await screen.findByRole("heading", { name: "공지 상세 테스트" })).toBeVisible();
    scrollToMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "브라우저 뒤로가기" }));
    expect(await screen.findByRole("heading", { name: "공지 목록" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "공지" })).toBeVisible();
    expect(scrollToMock).not.toHaveBeenCalled();

    returningListRequest.resolve(
      jsonResponse({
        items: [importantNotice],
        next_cursor: null,
        server_today: "2026-07-14",
      }),
    );
    expect(await screen.findByRole("link", { name: /수행평가 안내/u })).toBeVisible();
    await waitFor(() =>
      expect(scrollToMock).toHaveBeenCalledWith({ behavior: "auto", left: 0, top: 300 }),
    );
  });

  it("does not apply a saved scroll position to a new notice-list history entry", async () => {
    let listRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const progressResponse = noticeProgressFixture(url);
      if (progressResponse !== undefined) return Promise.resolve(progressResponse);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/notices?importance=all") {
        listRequestCount += 1;
        return Promise.resolve(
          jsonResponse({
            items: [importantNotice],
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const scrollToMock = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    vi.spyOn(window, "scrollY", "get").mockReturnValue(300);

    render(
      <MemoryRouter initialEntries={[{ key: "fresh-source-entry", pathname: "/notices" }]}>
        <Routes>
          <Route element={<NoticesPage />} path="/notices" />
          <Route element={<NoticeDetailNavigationHarness />} path="/notices/:noticeId" />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("link", { name: /수행평가 안내/u }));
    expect(await screen.findByRole("heading", { name: "공지 상세 테스트" })).toBeVisible();
    scrollToMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "새 공지 목록 진입" }));
    const freshEntryLink = await screen.findByRole("link", { name: /수행평가 안내/u });
    expect(freshEntryLink).not.toHaveFocus();
    expect(listRequestCount).toBe(2);
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("requires VIEW_CLASS before making the first notices request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const progressResponse = noticeProgressFixture(url);
      if (progressResponse !== undefined) return Promise.resolve(progressResponse);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse({ ...teacherBootstrap, allowed_actions: ["LOGOUT"] }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    render(
      <MemoryRouter initialEntries={["/notices"]}>
        <NoticesPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) => requestUrl(input).startsWith("/api/v1/notices")),
      ).toHaveLength(0);
    });
  });
});

describe("NoticesPage loading shell", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a role-neutral branded notice shell while bootstrap is delayed", async () => {
    const bootstrapRequest = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const progressResponse = noticeProgressFixture(url);
      if (progressResponse !== undefined) return Promise.resolve(progressResponse);
      if (url === "/api/v1/bootstrap") return bootstrapRequest.promise;
      if (url === "/api/v1/notices?importance=all") {
        return Promise.resolve(
          jsonResponse({
            items: [importantNotice],
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/notices"]}>
        <NoticesPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("main")).toHaveAttribute("data-content-frame", "true");
    const heading = screen.getByRole("heading", { name: "공지" });
    expect(heading).toBeVisible();
    expect(heading.closest("header")).toHaveClass("content-frame-header");
    expect(screen.getByRole("status")).toHaveTextContent("로그인과 반 정보를 확인하고 있어요.");
    expect(screen.queryByRole("navigation", { name: "주요 메뉴" })).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input).startsWith("/api/v1/notices")),
    ).toHaveLength(0);

    bootstrapRequest.resolve(jsonResponse(teacherBootstrap));
    expect(await screen.findByRole("link", { name: /수행평가 안내/u })).toBeVisible();
  });

  it("keeps the identified notice page visible while the first list request is delayed", async () => {
    const listRequest = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const progressResponse = noticeProgressFixture(url);
      if (progressResponse !== undefined) return Promise.resolve(progressResponse);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/notices?importance=all") return listRequest.promise;
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/notices"]}>
        <NoticesPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "공지 목록" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "공지" })).toBeVisible();
    expect(screen.getAllByRole("navigation", { name: "주요 메뉴" })).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "공지 목록" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("공지 목록을 불러오고 있어요.");

    listRequest.resolve(
      jsonResponse({
        items: [importantNotice],
        next_cursor: null,
        server_today: "2026-07-14",
      }),
    );
    expect(await screen.findByRole("link", { name: /수행평가 안내/u })).toBeVisible();
  });

  it("shows one safe initial error and recovers through its next action", async () => {
    let listRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const progressResponse = noticeProgressFixture(url);
      if (progressResponse !== undefined) return Promise.resolve(progressResponse);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/notices?importance=all") {
        listRequestCount += 1;
        if (listRequestCount === 1) {
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: "NOTICE_LOOKUP_FAILED",
                  message: "SELECT notice_id FROM internal_notice_table",
                },
              },
              503,
            ),
          );
        }
        return Promise.resolve(
          jsonResponse({
            items: [importantNotice],
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/notices"]}>
        <NoticesPage />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(alert).toHaveTextContent("공지 목록을 불러오지 못했어요.");
    expect(alert).toHaveTextContent("인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요.");
    expect(screen.queryByText(/internal_notice_table/u)).not.toBeInTheDocument();

    const retryButton = within(alert).getByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");
    fireEvent.click(retryButton);
    expect(await screen.findByRole("link", { name: /수행평가 안내/u })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(listRequestCount).toBe(2);
  });

  it("keeps cached notices during a failed refresh and clears the warning after retry", async () => {
    const retryRequest = deferred<Response>();
    let listRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const progressResponse = noticeProgressFixture(url);
      if (progressResponse !== undefined) return Promise.resolve(progressResponse);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/notices?importance=all") {
        listRequestCount += 1;
        if (listRequestCount === 1) {
          return Promise.resolve(
            jsonResponse({
              items: [importantNotice],
              next_cursor: null,
              server_today: "2026-07-14",
            }),
          );
        }
        if (listRequestCount === 2) {
          return Promise.resolve(
            jsonResponse(
              { error: { code: "NOTICE_LOOKUP_FAILED", message: "공지 조회 실패" } },
              503,
            ),
          );
        }
        return retryRequest.promise;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/notices"]}>
        <NoticesPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: /수행평가 안내/u })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "공지 목록 새로고침" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("최신 공지를 확인하지 못했어요.");
    expect(alert).toHaveTextContent("이전에 불러온 공지를 계속 표시하고 있어");
    expect(screen.getByRole("link", { name: /수행평가 안내/u })).toBeVisible();

    const retryButton = within(alert).getByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");
    fireEvent.click(retryButton);
    expect(retryButton).toBeDisabled();
    expect(retryButton).toHaveAttribute("aria-busy", "true");
    fireEvent.click(retryButton);
    expect(listRequestCount).toBe(3);

    retryRequest.resolve(
      jsonResponse({ items: [regularNotice], next_cursor: null, server_today: "2026-07-14" }),
    );
    expect(await screen.findByRole("link", { name: /이번 주 청소구역 안내/u })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /수행평가 안내/u })).not.toBeInTheDocument();
    expect(listRequestCount).toBe(3);
  });
});
