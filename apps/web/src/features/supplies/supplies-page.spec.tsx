import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SuppliesPage } from "./supplies-page";

const teacherBootstrap = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "1",
    id: "1",
    role: "teacher",
    status: "approved",
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-14",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const supply = {
  content_revision: "1",
  description: "자와 컴퍼스를 함께 가져오세요.",
  id: "17",
  needed_on: "2026-07-15",
  row_version: "1",
  title: "수학 준비물",
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

function HistoryProbe(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="현재 준비물 검색 조건">{location.search}</output>
      <button onClick={() => navigate(-1)} type="button">
        테스트 뒤로가기
      </button>
    </>
  );
}

function renderList(role: "student" | "teacher" = "teacher", initialEntry = "/supplies") {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
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
    if (url === "/api/v1/supplies?scope=upcoming") {
      return Promise.resolve(
        jsonResponse({
          items: [role === "student" ? { ...supply, check_state: "modified_unconfirmed" } : supply],
          next_cursor: null,
          server_today: "2026-07-14",
        }),
      );
    }
    if (url === "/api/v1/supplies?scope=past") {
      return Promise.resolve(
        jsonResponse({ items: [], next_cursor: null, server_today: "2026-07-14" }),
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SuppliesPage />
      <HistoryProbe />
    </MemoryRouter>,
  );
  return fetchMock;
}

describe("SuppliesPage", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("retries only bootstrap in place and keeps the active supply scope", async () => {
    let bootstrapRequestCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
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
      if (url === "/api/v1/supplies?scope=upcoming") {
        return Promise.resolve(
          jsonResponse({ items: [supply], next_cursor: null, server_today: "2026-07-14" }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/supplies?scope=upcoming&wave=bootstrap-retry"]}>
        <SuppliesPage />
        <HistoryProbe />
      </MemoryRouter>,
    );

    const retryButton = await screen.findByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");
    fireEvent.click(retryButton);
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();

    expect(await screen.findByRole("link", { name: /수학 준비물/u })).toBeVisible();
    expect(screen.getByLabelText("현재 준비물 검색 조건")).toHaveTextContent(
      "?scope=upcoming&wave=bootstrap-retry",
    );
    expect(bootstrapRequestCount).toBe(2);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/supplies?scope=upcoming",
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.method === undefined || init.method === "GET"),
    ).toBe(true);
  });

  it("renders teacher controls and four accessible period tabs", async () => {
    const fetchMock = renderList();

    await screen.findByRole("button", { name: "준비물·숙제 작성" });
    expect(screen.getByRole("heading", { level: 1, name: "준비물·숙제" })).toBeVisible();
    expect(
      screen.queryByRole("navigation", { name: "통합 알림·공지·준비물" }),
    ).not.toBeInTheDocument();
    for (const primaryNavigation of screen.getAllByRole("navigation", { name: "주요 메뉴" })) {
      expect(within(primaryNavigation).getByRole("link", { name: "소식" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    }
    expect(await screen.findByRole("link", { name: /수학 준비물/u })).toHaveAttribute(
      "href",
      "/supplies/17",
    );
    expect(screen.getByRole("button", { name: "준비물·숙제 작성" })).toBeVisible();

    const tablist = screen.getByRole("tablist", { name: "준비물 기간" });
    const upcomingTab = within(tablist).getByRole("tab", { name: "다가오는 준비물·숙제" });
    const pastTab = within(tablist).getByRole("tab", { name: "지난 준비물·숙제" });
    expect(upcomingTab).toHaveAttribute("aria-selected", "true");
    expect(upcomingTab).toHaveAttribute("tabindex", "0");
    expect(pastTab).toHaveAttribute("tabindex", "-1");

    fireEvent.focus(upcomingTab);
    fireEvent.keyDown(upcomingTab, { key: "ArrowRight" });
    const todayTab = screen.getByRole("tab", { name: "오늘 준비물·숙제" });
    expect(todayTab).toHaveFocus();
    fireEvent.keyDown(todayTab, { key: "ArrowRight" });
    const weekTab = screen.getByRole("tab", { name: "이번 주 준비물·숙제" });
    expect(weekTab).toHaveFocus();
    fireEvent.keyDown(weekTab, { key: "End" });
    expect(pastTab).toHaveFocus();
    expect(upcomingTab).toHaveAttribute("aria-selected", "true");

    fireEvent.click(pastTab);
    expect(await screen.findByRole("tabpanel", { name: "지난 준비물·숙제" })).toBeVisible();
    expect(await screen.findByText("최근 90일 동안 지난 준비물·숙제가 없어요.")).toBeVisible();
    expect(screen.getByRole("status", { name: "현재 준비물 검색 조건" })).toHaveTextContent(
      "?scope=past",
    );
    expect(
      fetchMock.mock.calls.some(([input]) => requestUrl(input) === "/api/v1/supplies?scope=past"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "테스트 뒤로가기" }));
    await waitFor(() => {
      expect(upcomingTab).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("status", { name: "현재 준비물 검색 조건" })).toHaveTextContent("");
    });
  });

  it("restores the past scope from a direct URL without fetching upcoming first", async () => {
    const fetchMock = renderList("teacher", "/supplies?scope=past");

    const pastTab = await screen.findByRole("tab", { name: "지난 준비물·숙제" });
    expect(pastTab).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("최근 90일 동안 지난 준비물·숙제가 없어요.")).toBeVisible();
    expect(screen.getByRole("status", { name: "현재 준비물 검색 조건" })).toHaveTextContent(
      "?scope=past",
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input) === "/api/v1/supplies?scope=past"),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/supplies?scope=upcoming",
      ),
    ).toHaveLength(0);
  });

  it("keeps keyboard focus on an uncached scope while its list is loading", async () => {
    let resolvePast: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/supplies?scope=upcoming") {
        return Promise.resolve(
          jsonResponse({ items: [supply], next_cursor: null, server_today: "2026-07-14" }),
        );
      }
      if (url === "/api/v1/supplies?scope=past") {
        return new Promise<Response>((resolve) => {
          resolvePast = resolve;
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/supplies"]}>
        <SuppliesPage />
      </MemoryRouter>,
    );

    const pastTab = await screen.findByRole("tab", { name: "지난 준비물·숙제" });
    await screen.findByText("수학 준비물");
    await act(async () => {
      pastTab.focus();
    });
    fireEvent.click(pastTab);

    expect(pastTab).toHaveFocus();
    expect(pastTab).not.toBeDisabled();
    expect(pastTab).toHaveAttribute("aria-selected", "true");

    fireEvent.click(pastTab);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input) === "/api/v1/supplies?scope=past"),
    ).toHaveLength(1);

    await act(async () => {
      resolvePast?.(jsonResponse({ items: [], next_cursor: null, server_today: "2026-07-14" }));
    });
    expect(await screen.findByText("최근 90일 동안 지난 준비물·숙제가 없어요.")).toBeVisible();
    expect(pastTab).toHaveFocus();
  });

  it("focuses the title when the teacher opens creation and returns focus on cancel", async () => {
    renderList();
    const createButton = await screen.findByRole("button", { name: "준비물·숙제 작성" });

    createButton.focus();
    fireEvent.click(createButton);

    const title = screen.getByRole("textbox", { name: "준비물 제목" });
    expect(title).toHaveFocus();
    const publishSummary = screen.getByRole("region", { name: "게시 대상과 결과" });
    expect(within(publishSummary).getByText("학생에게 보이는 범위")).toBeVisible();
    expect(within(publishSummary).getByText(/오늘·내일 준비물은 학생의 홈/u)).toBeVisible();
    expect(within(publishSummary).getByText(/학생이 표시한 상태/u)).toBeVisible();
    expect(title).not.toHaveAttribute("maxlength");
    expect(title).toBeRequired();
    expect(title).toHaveAttribute("aria-required", "true");
    const description = screen.getByRole("textbox", { name: /설명/u });
    const neededOn = screen.getByLabelText(/필요한 날짜/u);
    expect(description).not.toHaveAttribute("maxlength");
    expect(neededOn).toBeRequired();
    expect(neededOn).toHaveAttribute("aria-required", "true");
    expect(screen.getByText("필수 · 1~100자")).toBeVisible();
    expect(screen.getByText("필수 · 날짜를 선택해 주세요.")).toBeVisible();
    expect(screen.getByRole("group", { name: "저장 및 취소" })).toHaveAttribute(
      "data-form-action-bar",
      "fixed",
    );

    fireEvent.click(screen.getByRole("button", { name: "등록하기" }));
    const titleError = await screen.findByText(
      "준비물 제목은 1자 이상 100자 이하로 입력해 주세요.",
    );
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(title.getAttribute("aria-describedby")).toContain(titleError.id);
    expect(description).not.toHaveAttribute("aria-describedby");
    expect(neededOn).not.toHaveAttribute("aria-invalid");
    await waitFor(() => expect(title).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(createButton).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "준비물 제목" })).not.toBeInTheDocument();
  });

  it("keeps one idempotency key when an ambiguous create response is retried", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const idempotencyKey = "22222222-2222-4222-8222-222222222222";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(idempotencyKey);
    const submittedKeys: string[] = [];
    let createCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/supplies?scope=upcoming") {
        return Promise.resolve(
          jsonResponse({ items: [supply], next_cursor: null, server_today: "2026-07-14" }),
        );
      }
      if (url === "/api/v1/supplies" && init?.method === "POST") {
        createCalls += 1;
        const key = new Headers(init.headers).get("Idempotency-Key");
        if (key === null) throw new Error("Idempotency-Key가 없습니다.");
        submittedKeys.push(key);
        return Promise.resolve(
          createCalls === 1
            ? jsonResponse({ error: { code: "UPSTREAM_TIMEOUT", message: "시간 초과" } }, 503)
            : jsonResponse(supply, 201),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/supplies"]}>
        <SuppliesPage />
      </MemoryRouter>,
    );
    await screen.findByText(/기준일/u);
    fireEvent.click(screen.getByRole("button", { name: "준비물·숙제 작성" }));
    fireEvent.change(screen.getByRole("textbox", { name: "준비물 제목" }), {
      target: { value: "체육 준비물" },
    });
    fireEvent.change(screen.getByLabelText(/필요한 날짜/u), {
      target: { value: "2026-07-20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "등록하기" }));

    expect(
      await screen.findByText(/준비물·숙제 등록 요청이 저장됐는지 확인하지 못했어요/u),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "준비물 제목" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "결과 다시 확인" }));
    await waitFor(() => expect(submittedKeys).toHaveLength(2));
    expect(submittedKeys).toEqual([idempotencyKey, idempotencyKey]);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("blocks an old retry when the fresh server date advances despite a rolled-back client clock", async () => {
    const request = {
      description: null,
      needed_on: "2026-07-20",
      title: "날짜 전환 준비물",
    };
    window.sessionStorage.setItem(
      "classhub:idempotent-create:supplies:1",
      JSON.stringify({
        idempotencyKey: "44444444-4444-4444-8444-444444444444",
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
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/supplies?scope=upcoming") {
        return Promise.resolve(
          jsonResponse({
            items: [supply],
            next_cursor: null,
            server_today: authoritativeServerToday,
          }),
        );
      }
      if (url === "/api/v1/supplies" && init?.method === "POST") {
        throw new Error("만료된 키로 POST를 보내면 안 됩니다.");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/supplies"]}>
        <SuppliesPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(/준비물·숙제 등록 요청이 저장됐는지 확인하지 못했어요/u),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => requestUrl(input) === "/api/v1/supplies?scope=upcoming",
        ),
      ).toHaveLength(1),
    );
    authoritativeServerToday = "2026-07-15";
    fireEvent.click(screen.getByRole("button", { name: "준비물·숙제 작성" }));
    expect(screen.getByRole("textbox", { name: "준비물 제목" })).toHaveValue(request.title);
    fireEvent.click(screen.getByRole("button", { name: "결과 다시 확인" }));

    expect(await screen.findByText(/다시 확인할 수 있는 시간이 지났어요/u)).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => requestUrl(input) === "/api/v1/supplies" && init?.method === "POST",
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/supplies?scope=upcoming",
      ),
    ).toHaveLength(2);
  });

  it("shows a student's explicit revision state without teacher mutation controls", async () => {
    renderList("student");

    expect(await screen.findByText("바뀐 내용을 확인해 주세요")).toBeVisible();
    expect(screen.queryByRole("button", { name: "준비물·숙제 작성" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("학생들이 얼마나 챙겼나요?", { exact: false }),
    ).not.toBeInTheDocument();
  });

  it("ignores a late cursor page after the teacher changes to a cached scope", async () => {
    let resolveLatePage: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/supplies?scope=upcoming") {
        return Promise.resolve(
          jsonResponse({
            items: [supply],
            next_cursor: "next-cursor",
            server_today: "2026-07-14",
          }),
        );
      }
      if (url === "/api/v1/supplies?scope=past") {
        return Promise.resolve(
          jsonResponse({ items: [], next_cursor: null, server_today: "2026-07-14" }),
        );
      }
      if (url === "/api/v1/supplies?scope=upcoming&cursor=next-cursor") {
        return new Promise<Response>((resolve) => {
          resolveLatePage = resolve;
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/supplies"]}>
        <SuppliesPage />
      </MemoryRouter>,
    );

    const upcomingTab = await screen.findByRole("tab", { name: "다가오는 준비물·숙제" });
    const pastTab = screen.getByRole("tab", { name: "지난 준비물·숙제" });
    fireEvent.click(pastTab);
    expect(await screen.findByText("최근 90일 동안 지난 준비물·숙제가 없어요.")).toBeVisible();
    fireEvent.click(upcomingTab);
    fireEvent.click(screen.getByRole("button", { name: "준비물·숙제 더 보기" }));
    fireEvent.click(pastTab);

    resolveLatePage?.(
      jsonResponse({
        items: [{ ...supply, id: "99", title: "늦게 도착한 준비물" }],
        next_cursor: null,
        server_today: "2026-07-14",
      }),
    );
    await waitFor(() => {
      expect(screen.getByText("최근 90일 동안 지난 준비물·숙제가 없어요.")).toBeVisible();
      expect(screen.queryByText("늦게 도착한 준비물")).not.toBeInTheDocument();
    });
    fireEvent.click(upcomingTab);
    expect(screen.queryByText("늦게 도착한 준비물")).not.toBeInTheDocument();
  });

  it("shows one initial list error and recovers without exposing server diagnostics", async () => {
    let listRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/public/system-state") {
        return Promise.resolve(jsonResponse({ maintenance: false, announcement: null }));
      }
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/supplies?scope=upcoming") {
        listRequestCount += 1;
        if (listRequestCount === 1) {
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: "SUPPLY_LOOKUP_FAILED",
                  message: "relation private_supply_cache does not exist",
                },
              },
              503,
            ),
          );
        }
        return Promise.resolve(
          jsonResponse({ items: [supply], next_cursor: null, server_today: "2026-07-14" }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/supplies"]}>
        <SuppliesPage />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(alert).toHaveTextContent("준비물 목록을 불러오지 못했어요.");
    expect(screen.queryByText(/private_supply_cache/u)).not.toBeInTheDocument();

    const retryButton = within(alert).getByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");
    fireEvent.click(retryButton);
    expect(await screen.findByRole("link", { name: /수학 준비물/u })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(listRequestCount).toBe(2);
  });

  it("requires VIEW_CLASS before making the first supplies request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(
          jsonResponse({ ...teacherBootstrap, allowed_actions: ["CHANGE_PASSWORD", "LOGOUT"] }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/supplies"]}>
        <SuppliesPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) => requestUrl(input) === "/api/v1/bootstrap"),
      ).toHaveLength(1);
      expect(
        fetchMock.mock.calls.filter(([input]) => requestUrl(input).startsWith("/api/v1/supplies")),
      ).toHaveLength(0);
    });
  });
});
