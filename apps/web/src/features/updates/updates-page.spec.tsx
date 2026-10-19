import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UpdatesPage } from "./updates-page";

const teacherBootstrap = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: { class_id: "1", id: "1", role: "teacher", status: "approved" },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-26",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const notice = {
  audience_mode: "selected_snapshot",
  category: "performance",
  confirmation_state: "unread",
  content: "수행평가 준비 범위를 확인해 주세요.",
  content_revision: "1",
  id: "17",
  is_important: true,
  kind: "notice",
  needed_on: null,
  published_at: "2026-07-26T03:00:00.123456Z",
  row_version: "1",
  title: "수행평가 안내",
};

const supply = {
  audience_mode: "all_snapshot",
  category: "general",
  check_state: "unchecked",
  content: "색연필과 자를 챙겨요.",
  content_revision: "1",
  id: "21",
  is_important: false,
  kind: "supply",
  needed_on: "2026-07-28",
  published_at: "2026-07-25T03:00:00.123456Z",
  row_version: "1",
  title: "미술 준비물",
};

const homework = {
  audience_mode: "all_snapshot",
  category: "homework",
  check_state: "unchecked",
  content: "3단원 문제를 풀어 와요.",
  content_revision: "1",
  id: "22",
  is_important: false,
  kind: "supply",
  needed_on: "2026-07-29",
  published_at: "2026-07-25T04:00:00.123456Z",
  row_version: "1",
  title: "수학 숙제",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function LocationSearchProbe(): React.JSX.Element {
  const location = useLocation();
  return <output aria-label="현재 검색 조건">{location.search}</output>;
}

function LocationPathProbe(): React.JSX.Element {
  const location = useLocation();
  return <output aria-label="현재 경로">{location.pathname}</output>;
}

describe("UpdatesPage", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["all", "performance"])(
    "resets an empty %s search and cancels pending input",
    async (filter) => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: false })),
      );
      const requests: URL[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = new URL(requestUrl(input), "https://classhub.test");
        if (url.pathname === "/api/v1/bootstrap") return jsonResponse(teacherBootstrap);
        if (url.pathname !== "/api/v1/updates") throw new Error(`Unexpected URL: ${url}`);
        requests.push(url);
        return jsonResponse({
          items:
            url.searchParams.has("q") || url.searchParams.get("filter") !== "all" ? [] : [notice],
          next_cursor: null,
        });
      });
      render(
        <MemoryRouter initialEntries={[`/updates?filter=${filter}`]}>
          <UpdatesPage />
        </MemoryRouter>,
      );
      const input = await screen.findByRole("searchbox");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "소식 새로고침" })).toBeEnabled(),
      );
      if (filter === "performance")
        expect(screen.getByText("선택한 종류의 소식이 없어요.")).toBeVisible();
      fireEvent.change(input, { target: { value: "가".repeat(50) } });
      await screen.findByText("검색 결과가 없어요.");
      fireEvent.change(input, { target: { value: "아직 전송하지 않은 검색" } });
      fireEvent.click(screen.getByRole("button", { name: "검색·필터 초기화" }));
      await screen.findByRole("link", { name: /수행평가 안내/u });
      expect(screen.getByRole("searchbox")).toHaveValue("");
      expect(screen.getByRole("heading", { name: "전체 소식" })).toHaveFocus();
      expect(requests.at(-1)?.searchParams.get("filter")).toBe("all");
      expect(requests.at(-1)?.searchParams.get("q")).toBeNull();
      // 실제 지연 검색 시간 뒤에도 초기화 이전 입력이 다시 전송되지 않아야 한다.
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(requests.some((url) => url.searchParams.get("q") === "아직 전송하지 않은 검색")).toBe(
        false,
      );
      expect(screen.queryByRole("button", { name: "검색·필터 초기화" })).not.toBeInTheDocument();
    },
  );

  it.each([0, 3, "unavailable"] as const)(
    "keeps attendance in primary navigation when the pending count is %s",
    async (pending) => {
      vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = requestUrl(input);
        if (url === "/api/v1/notices/17") return Promise.resolve(jsonResponse(notice));
        if (url === "/api/v1/supplies/21")
          return Promise.resolve(jsonResponse({ ...supply, description: supply.content }));
        if (url === "/api/v1/bootstrap") {
          return Promise.resolve(
            jsonResponse({
              ...teacherBootstrap,
              allowed_actions: [
                ...teacherBootstrap.allowed_actions,
                "MANAGE_ATTENDANCE_NOTIFICATIONS",
              ],
            }),
          );
        }
        if (url === "/api/v1/updates?filter=all") {
          return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
        }
        if (url === "/api/v1/attendance-notifications/today?status=pending&type=all") {
          return Promise.resolve(
            pending === "unavailable"
              ? jsonResponse({ error: { code: "UNAVAILABLE", message: "잠시 후 다시 시도" } }, 503)
              : jsonResponse({
                  role: "teacher",
                  counts: { pending },
                  items: [],
                  next_cursor: null,
                }),
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      render(
        <MemoryRouter initialEntries={["/updates"]}>
          <UpdatesPage />
          <LocationPathProbe />
        </MemoryRouter>,
      );
      const entry = await screen.findByRole("link", {
        name: pending === 3 ? "출결 연락, 미확인 3건" : "출결 연락",
      });
      expect(document.querySelector("[data-attendance-entry]")).not.toBeInTheDocument();
      expect(entry).toHaveAttribute("href", "/attendance");
      fireEvent.click(entry);
      expect(screen.getByLabelText("현재 경로")).toHaveTextContent("/attendance");
    },
  );

  it.each([false, true])(
    "keeps the student's existing attendance menu gated (%s) without a duplicate entry or teacher count",
    async (enabled) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = requestUrl(input);
        if (url === "/api/v1/notices/17") return Promise.resolve(jsonResponse(notice));
        if (url === "/api/v1/supplies/21")
          return Promise.resolve(jsonResponse({ ...supply, description: supply.content }));
        if (url === "/api/v1/bootstrap") {
          return Promise.resolve(
            jsonResponse({
              ...teacherBootstrap,
              current_membership: { ...teacherBootstrap.current_membership, role: "student" },
              allowed_actions: [
                "VIEW_CLASS",
                ...(enabled ? ["MANAGE_OWN_ATTENDANCE_NOTIFICATION"] : []),
              ],
            }),
          );
        }
        if (url === "/api/v1/updates?filter=all") {
          return Promise.resolve(jsonResponse({ items: [notice], next_cursor: null }));
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      render(
        <MemoryRouter initialEntries={["/updates"]}>
          <UpdatesPage />
        </MemoryRouter>,
      );
      await screen.findByRole("link", { name: /수행평가 안내/u });
      expect(document.querySelector("[data-attendance-entry]")).not.toBeInTheDocument();
      const entry = document.querySelector(
        '[data-primary-navigation-layout="student-desktop"] a[href="/attendance"]',
      );
      if (enabled) expect(entry).toHaveAttribute("href", "/attendance");
      else expect(entry).not.toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some(([input]) =>
          requestUrl(input).includes("attendance-notifications"),
        ),
      ).toBe(false);
    },
  );

  it("retries only bootstrap in place and keeps the active URL filter", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    let bootstrapRequestCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/notices/17") return Promise.resolve(jsonResponse(notice));
      if (url === "/api/v1/supplies/21")
        return Promise.resolve(jsonResponse({ ...supply, description: supply.content }));
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
      if (url === "/api/v1/updates?filter=supplies") {
        return Promise.resolve(
          jsonResponse({
            items: [supply],
            next_cursor: null,
            selected_audience_enabled: true,
            server_today: "2026-07-26",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/updates?filter=supplies&wave=bootstrap-retry"]}>
        <UpdatesPage />
      </MemoryRouter>,
    );

    const retryButton = await screen.findByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");
    fireEvent.click(retryButton);
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();

    expect(await screen.findByRole("link", { name: /미술 준비물/u })).toBeVisible();
    expect(await screen.findByText("확인 현황은 상세에서 다시 확인해 주세요")).toBeInTheDocument();
    const failedAside = screen.getByLabelText("선택한 소식 상세");
    expect(await within(failedAside).findByRole("heading", { name: "미술 준비물" })).toBeVisible();
    expect(bootstrapRequestCount).toBe(3);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/updates?filter=supplies",
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.method === undefined || init.method === "GET"),
    ).toBe(true);
  });

  it("does not mount or request the teacher preview below the desktop breakpoint", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/notices/17") return Promise.resolve(jsonResponse(notice));
      if (url === "/api/v1/supplies/21")
        return Promise.resolve(jsonResponse({ ...supply, description: supply.content }));
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/updates?filter=all") {
        return Promise.resolve(
          jsonResponse({
            items: [notice],
            next_cursor: null,
            selected_audience_enabled: true,
            server_today: "2026-07-26",
          }),
        );
      }
      throw new Error(`Unexpected mobile preview request: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/updates"]}>
        <UpdatesPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: /수행평가 안내/u })).toBeVisible();
    expect(screen.queryByLabelText("선택한 소식 상세")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === "/api/v1/notices/17")).toBe(
      false,
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => requestUrl(input) === "/api/v1/notices/17/confirmations?state=unread",
        ),
      ).toHaveLength(1),
    );
  });

  it("renders a teacher mixed feed, one authoring entry, URL filters, and cursor pagination", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/notices/17") return Promise.resolve(jsonResponse(notice));
      if (url === "/api/v1/supplies/21")
        return Promise.resolve(jsonResponse({ ...supply, description: supply.content }));
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/updates?filter=all") {
        return Promise.resolve(
          jsonResponse({
            items: [notice],
            next_cursor: "next cursor",
            selected_audience_enabled: true,
            server_today: "2026-07-26",
          }),
        );
      }
      if (url === "/api/v1/updates?filter=all&cursor=next+cursor") {
        return Promise.resolve(
          jsonResponse({
            items: [supply],
            next_cursor: null,
            selected_audience_enabled: true,
            server_today: "2026-07-26",
          }),
        );
      }
      if (url === "/api/v1/updates?filter=performance") {
        return Promise.resolve(
          jsonResponse({
            items: [notice],
            next_cursor: null,
            selected_audience_enabled: true,
            server_today: "2026-07-26",
          }),
        );
      }
      if (url === "/api/v1/members?status=approved") {
        return Promise.resolve(jsonResponse({ members: [] }));
      }
      if (
        url === "/api/v1/notices/17/confirmations?state=unread" ||
        url === "/api/v1/notices/17/confirmations?state=modified_unconfirmed"
      ) {
        const modified = url.endsWith("modified_unconfirmed");
        return Promise.resolve(
          jsonResponse({
            content_revision: "1",
            counts: {
              confirmed: 22,
              excluded_member_count: 2,
              modified_unconfirmed: 5,
              unread: 1,
            },
            items: modified
              ? ["김서윤", "박다은", "이현우", "정하린"].map((displayName, index) => ({
                  confirmation_state: "modified_unconfirmed",
                  display_name: displayName,
                  member_id: `modified-${index}`,
                  student_number: index + 1,
                }))
              : [
                  {
                    confirmation_state: "unread",
                    display_name: "차은호",
                    member_id: "unread-1",
                    student_number: 9,
                  },
                ],
            last_reminder_requested_at: "2026-07-26T04:00:00Z",
            next_cursor: modified ? "more" : null,
            server_today: "2026-07-26",
          }),
        );
      }
      if (
        url === "/api/v1/supplies/21/checks?state=unchecked" ||
        url === "/api/v1/supplies/21/checks?state=modified_unconfirmed"
      ) {
        const modified = url.endsWith("modified_unconfirmed");
        return Promise.resolve(
          jsonResponse({
            content_revision: "1",
            counts: {
              checked: 19,
              excluded_member_count: 0,
              modified_unconfirmed: 2,
              unchecked: 7,
            },
            items: (modified ? ["고민준", "김유나"] : ["문지호", "송예린", "오서준"]).map(
              (displayName, index) => ({
                check_state: modified ? "modified_unconfirmed" : "unchecked",
                display_name: displayName,
                member_id: `${modified ? "modified" : "unchecked"}-${index}`,
                student_number: index + 1,
              }),
            ),
            last_reminder_requested_at: null,
            next_cursor: "more",
            server_today: "2026-07-26",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/updates"]}>
        <UpdatesPage />
        <LocationPathProbe />
      </MemoryRouter>,
    );

    await screen.findByRole("button", { name: "쓰기 (소식 작성)" });
    expect(screen.getByRole("heading", { level: 1, name: "소식" })).toBeVisible();
    expect(document.querySelector(".content-frame-header")).toContainElement(
      screen.getByRole("heading", {
        level: 1,
        name: "소식",
      }),
    );
    expect(
      screen.queryByRole("navigation", { name: "통합 알림·공지·준비물" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /오늘 출결 연락/u })).not.toBeInTheDocument();
    const createButton = screen.getByRole("button", { name: "쓰기 (소식 작성)" });
    expect(createButton).toHaveAttribute("aria-expanded", "false");
    expect(createButton).toHaveClass("content-write");
    fireEvent.click(createButton);
    expect(screen.getByRole("heading", { level: 1, name: "소식 쓰기" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "소식 목록" })).toBeNull();
    const kindGroup = screen.getByRole("group", { name: "소식 종류" });
    const noticeKindButton = within(kindGroup).getByRole("button", { name: /공지/u });
    expect(noticeKindButton).toBeVisible();
    expect(within(kindGroup).getByRole("button", { name: /준비물/u })).toBeVisible();
    fireEvent.click(noticeKindButton);
    const noticeTitle = screen.getByRole("textbox", { name: "공지 제목" });
    expect(noticeTitle).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /^받는 사람:/u }));
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /학생 직접 선택/u })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "선택 완료" }));
    fireEvent.change(noticeTitle, { target: { value: "취소 후 복원할 공지" } });
    fireEvent.change(screen.getByRole("textbox", { name: "공지 내용" }), {
      target: { value: "작성 맥락을 그대로 유지합니다." },
    });
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    const restoredCreateButton = screen.getByRole("button", { name: "쓰기 (소식 작성)" });
    expect(restoredCreateButton).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "공지 제목" })).not.toBeInTheDocument();
    fireEvent.click(restoredCreateButton);
    expect(screen.getByRole("textbox", { name: "공지 제목" })).toHaveValue("취소 후 복원할 공지");
    expect(screen.getByRole("textbox", { name: "공지 내용" })).toHaveValue(
      "작성 맥락을 그대로 유지합니다.",
    );
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(await screen.findByRole("link", { name: /수행평가 안내/u })).toHaveAttribute(
      "href",
      "/notices/17",
    );
    const updatesList = screen.getByRole("list", { name: "소식 목록" });
    expect(within(updatesList).queryByText("지정 학생")).not.toBeInTheDocument();
    expect(within(updatesList).queryByText("게시 당시 전체 학생")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "학생별 미해결" }).closest(".updates-pane-header"),
    ).not.toBeNull();
    const preview = screen.getByLabelText("선택한 소식 상세");
    expect(await within(preview).findByRole("heading", { name: "수행평가 안내" })).toBeVisible();
    const pair = document.querySelector('[data-updates-master-detail="pair"]');
    expect(pair).toHaveClass("content-split");
    expect(pair?.querySelector(".content-split-main")).toContainElement(updatesList);
    expect(pair?.querySelector(".updates-pane-header")).toHaveTextContent("오늘");
    expect(updatesList.querySelector(':scope > [role="presentation"]')).toHaveClass("sr-only");
    expect(preview).toHaveClass("content-split-aside");
    expect(await within(updatesList).findByText("6명 남음")).toBeVisible();
    expect(await within(preview).findByRole("tab", { name: "확인한 학생 22명" })).toBeVisible();
    expect(within(preview).getByRole("tab", { name: "미확인 학생 1명" })).toBeVisible();
    fireEvent.click(within(preview).getByRole("tab", { name: "수정 후 재확인 학생 5명" }));
    expect(await within(preview).findByText("김서윤")).toBeVisible();
    expect(within(preview).getByText("박다은")).toBeVisible();
    expect(within(preview).getByRole("button", { name: "내용 수정" })).toBeVisible();
    expect(
      within(preview).getByRole("button", { name: "현재 미해결 6명에게 다시 알려주기" }),
    ).toBeVisible();
    const noticeProgressRequests = () =>
      fetchMock.mock.calls.filter(([input]) =>
        requestUrl(input).startsWith("/api/v1/notices/17/confirmations?"),
      ).length;
    const beforeAppend = noticeProgressRequests();
    preview.scrollTop = 24;
    fireEvent.click(screen.getByRole("button", { name: "지난 소식 더 보기" }));
    const supplyLink = await screen.findByRole("link", { name: /미술 준비물/u });
    expect(supplyLink).toHaveAttribute("href", "/supplies/21");
    await within(updatesList).findByText("9명 남음");
    expect(noticeProgressRequests()).toBe(beforeAppend);
    expect(within(updatesList).getByRole("link", { name: /수행평가 안내/u })).toBeVisible();
    expect(within(preview).getByRole("heading", { name: "수행평가 안내" })).toBeVisible();
    const supplyRequestCount = () =>
      fetchMock.mock.calls.filter(([input]) => requestUrl(input) === "/api/v1/supplies/21").length;
    fireEvent.pointerEnter(supplyLink);
    fireEvent.focus(supplyLink);
    expect(supplyRequestCount()).toBe(0);
    fireEvent.click(supplyLink, { detail: 1 });
    expect(screen.getByRole("status", { name: "현재 경로" })).toHaveTextContent("/updates");
    expect(await within(preview).findByRole("heading", { name: "미술 준비물" })).toBeVisible();
    expect(await within(preview).findByRole("tab", { name: "챙긴 학생 19명" })).toBeVisible();
    expect(within(preview).getByRole("tab", { name: "미챙김 학생 7명" })).toBeVisible();
    expect(within(preview).getByRole("tab", { name: "수정 후 재확인 학생 2명" })).toBeVisible();
    expect(
      within(preview).getByRole("button", { name: "현재 미해결 9명에게 다시 알려주기" }),
    ).toBeVisible();
    expect(supplyRequestCount()).toBe(1);
    expect(preview).toHaveProperty("scrollTop", 0);
    fireEvent.click(supplyLink, { detail: 0 });
    expect(screen.getByRole("status", { name: "현재 경로" })).toHaveTextContent("/supplies/21");
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestUrl(input) === "/api/v1/updates?filter=all&cursor=next+cursor",
      ),
    ).toBe(true);

    fireEvent.click(
      within(screen.getByRole("navigation", { name: "소식 필터" })).getByRole("link", {
        name: "수행평가",
      }),
    );
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input]) => requestUrl(input) === "/api/v1/updates?filter=performance",
        ),
      ).toBe(true);
    });
    expect(
      within(screen.getByRole("navigation", { name: "소식 필터" })).getByRole("link", {
        name: "수행평가",
      }),
    ).toHaveAttribute("aria-current", "page");
  });

  it.each([
    ["supply", "준비물"],
    ["homework", "숙제"],
  ] as const)(
    "opens requested %s authoring while preserving filters and the disabled audience gate",
    async (kind, label) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = requestUrl(input);
        if (url === "/api/v1/notices/17") return Promise.resolve(jsonResponse(notice));
        if (url === "/api/v1/supplies/21")
          return Promise.resolve(jsonResponse({ ...supply, description: supply.content }));
        if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
        if (url === "/api/v1/updates?filter=important") {
          return Promise.resolve(
            jsonResponse({
              items: [notice],
              next_cursor: null,
              selected_audience_enabled: false,
              server_today: "2026-07-26",
            }),
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      render(
        <MemoryRouter
          initialEntries={[`/updates?filter=important&create=${kind}&wave=unified-authoring`]}
        >
          <UpdatesPage />
          <LocationSearchProbe />
        </MemoryRouter>,
      );

      const supplyTitle = await screen.findByRole("textbox", { name: `${label} 제목` });
      // The field mounts before the autofocus effect commits, so the focus check
      // must settle rather than sample the first render.
      await waitFor(() => expect(supplyTitle).toHaveFocus());
      fireEvent.click(screen.getByRole("button", { name: /^받는 사람:/u }));
      expect(screen.getByRole("radio", { name: /학생 직접 선택/u })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "선택 완료" }));
      expect(screen.queryByRole("textbox", { name: "공지 제목" })).not.toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByLabelText("현재 검색 조건")).toHaveTextContent(
          "?filter=important&wave=unified-authoring",
        );
      });
      expect(
        fetchMock.mock.calls.every(
          ([, init]) => init?.method === undefined || init.method === "GET",
        ),
      ).toBe(true);
    },
  );

  it("requests a dedicated homework feed and keeps its filter when loading more", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/notices/17") return Promise.resolve(jsonResponse(notice));
      if (url === "/api/v1/supplies/21")
        return Promise.resolve(jsonResponse({ ...supply, description: supply.content }));
      urls.push(url);
      if (url === "/api/v1/bootstrap")
        return jsonResponse({
          ...teacherBootstrap,
          current_membership: { ...teacherBootstrap.current_membership, role: "student" },
          allowed_actions: ["VIEW_CLASS", "LOGOUT"],
        });
      if (url === "/api/v1/updates?filter=homework")
        return jsonResponse({
          items: [homework],
          next_cursor: "homework-page-2",
          selected_audience_enabled: false,
          server_today: "2026-07-26",
        });
      if (url === "/api/v1/updates?filter=homework&cursor=homework-page-2")
        return jsonResponse({
          items: [{ ...homework, id: "23", title: "영어 숙제" }],
          next_cursor: null,
          selected_audience_enabled: false,
          server_today: "2026-07-26",
        });
      throw new Error(`Unexpected URL: ${url}`);
    });
    render(
      <MemoryRouter initialEntries={["/updates?filter=homework"]}>
        <UpdatesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("link", { name: /수학 숙제/u })).toBeVisible();
    expect(screen.getByRole("link", { name: "숙제" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "지난 소식 더 보기" }));
    expect(await screen.findByRole("link", { name: /영어 숙제/u })).toBeVisible();
    expect(urls).toContain("/api/v1/updates?filter=homework&cursor=homework-page-2");
    expect(urls.some((url) => url.includes("filter=all"))).toBe(false);
  });

  it("shows student check states without teacher targeting or authoring controls", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const studentBootstrap = {
      ...teacherBootstrap,
      allowed_actions: [
        "CHANGE_PASSWORD",
        "LOGOUT",
        "LEAVE_CLASS",
        "VIEW_CLASS",
        "MANAGE_OWN_ATTENDANCE_NOTIFICATION",
      ],
      current_membership: { ...teacherBootstrap.current_membership, role: "student" },
      teacher_profile: null,
    };
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/notices/17") return Promise.resolve(jsonResponse(notice));
      if (url === "/api/v1/supplies/21")
        return Promise.resolve(jsonResponse({ ...supply, description: supply.content }));
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(studentBootstrap));
      if (url === "/api/v1/updates?filter=supplies") {
        return Promise.resolve(
          jsonResponse({
            items: [supply, homework],
            next_cursor: null,
            selected_audience_enabled: false,
            server_today: "2026-07-26",
          }),
        );
      }
      if (url === "/api/v1/updates?filter=all") {
        return Promise.resolve(
          jsonResponse({
            items: [supply, homework],
            next_cursor: null,
            selected_audience_enabled: false,
            server_today: "2026-07-26",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/updates?filter=supplies"]}>
        <UpdatesPage />
        <LocationPathProbe />
      </MemoryRouter>,
    );

    const updatesList = await screen.findByRole("list", { name: "소식 목록" });
    expect(within(updatesList).getByText("미술 준비물")).toBeVisible();
    expect(
      within(within(updatesList).getByRole("link", { name: /미술 준비물/u })).getByText(
        "아직 안 했어요",
      ),
    ).toBeVisible();
    expect(within(updatesList).getByText("수학 숙제")).toBeVisible();
    expect(
      within(within(updatesList).getByRole("link", { name: /수학 숙제/u })).getByText(
        "아직 안 했어요",
      ),
    ).toBeVisible();
    expect(
      within(within(updatesList).getByRole("link", { name: /수학 숙제/u })).getByText("숙제"),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "쓰기 (소식 작성)" })).not.toBeInTheDocument();
    expect(screen.queryByText("발행 당시 전체 학생")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /오늘 출결 연락/u })).not.toBeInTheDocument();
    fireEvent.click(within(updatesList).getByRole("link", { name: /수학 숙제/u }));
    expect(screen.getByRole("status", { name: "현재 경로" })).toHaveTextContent("/supplies/22");
  });

  it("uses exact type filters, keeps the global student count through search, and preserves the combined feed entry", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const urls: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(requestUrl(input), "https://classhub.test");
      if (url.pathname === "/api/v1/bootstrap")
        return jsonResponse({
          ...teacherBootstrap,
          allowed_actions: ["VIEW_CLASS"],
          current_membership: { ...teacherBootstrap.current_membership, role: "student" },
          teacher_profile: null,
        });
      if (url.pathname !== "/api/v1/updates") throw new Error("Unexpected URL: " + url.pathname);
      urls.push(url);
      const filter = url.searchParams.get("filter");
      return jsonResponse({
        items: url.searchParams.has("q")
          ? []
          : filter === "materials"
            ? [supply]
            : filter === "notices"
              ? [{ ...notice, category: "general" }]
              : [supply, homework],
        next_cursor: null,
        selected_audience_enabled: true,
        server_today: "2026-07-26",
        unresolved_count: 37,
      });
    });
    render(
      <MemoryRouter initialEntries={["/updates"]}>
        <UpdatesPage />
      </MemoryRouter>,
    );
    const pending = await screen.findByRole("link", { name: /안 한 것\s*37/u });
    expect(pending).toHaveAttribute("href", "/updates?filter=unresolved");
    expect(within(pending).getByText("37")).toHaveClass("text-danger");
    const filters = screen.getByRole("navigation", { name: "소식 필터" });
    expect(
      within(filters)
        .getAllByRole("link")
        .slice(0, 6)
        .map((link) => link.textContent),
    ).toEqual(["전체", "공지", "숙제", "준비물", "수행평가", "중요"]);
    fireEvent.click(within(filters).getByRole("link", { name: "공지" }));
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("filter")).toBe("notices"));
    fireEvent.click(within(filters).getByRole("link", { name: "준비물" }));
    await screen.findByRole("link", { name: /미술 준비물/u });
    expect(urls.at(-1)?.searchParams.get("filter")).toBe("materials");
    expect(
      within(screen.getByRole("list", { name: "소식 목록" })).queryByText("수학 숙제"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: /안 한 것\s*37/u }));
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("filter")).toBe("unresolved"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "없는 단어" } });
    await screen.findByText("검색 결과가 없어요.");
    expect(screen.getByRole("link", { name: /안 한 것\s*37/u })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(urls.at(-1)?.searchParams.get("filter")).toBe("unresolved");
    expect(urls.at(-1)?.searchParams.get("q")).toBe("없는 단어");
    fireEvent.click(screen.getByRole("button", { name: "소식 더보기" }));
    expect(screen.getByRole("link", { name: "준비물·숙제 함께 보기" })).toHaveAttribute(
      "href",
      "/updates?filter=supplies",
    );
    expect(screen.getByRole("link", { name: "놓친 안내 따라잡기" })).toHaveAttribute(
      "href",
      "/updates/catch-up",
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "소식 더보기" }), { key: "Escape" });
    expect(screen.getByRole("button", { name: "소식 더보기" })).toHaveFocus();
    expect(screen.queryByRole("link", { name: "준비물·숙제 함께 보기" })).not.toBeInTheDocument();
  });

  it("keeps older server fallback honest and moves past supplies after active items in their date group", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap")
        return jsonResponse({
          ...teacherBootstrap,
          allowed_actions: ["VIEW_CLASS"],
          current_membership: { ...teacherBootstrap.current_membership, role: "student" },
        });
      if (url === "/api/v1/updates?filter=all")
        return jsonResponse({
          items: [
            { ...homework, needed_on: "2026-07-25", published_at: notice.published_at },
            notice,
            { ...supply, published_at: notice.published_at },
          ],
          next_cursor: null,
          server_today: "2026-07-26",
        });
      throw new Error("Unexpected URL: " + url);
    });
    render(
      <MemoryRouter initialEntries={["/updates"]}>
        <UpdatesPage />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: "소식 목록" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/notices/17", "/supplies/21", "/supplies/22"]);
    const oldCard = within(list).getByRole("link", { name: /수학 숙제/u });
    expect(oldCard).toHaveAttribute("data-content-past", "true");
    expect(within(oldCard).getByText("날짜 지남")).toBeVisible();
    expect(within(oldCard).getByText("아직 안 했어요")).toBeVisible();
    expect(screen.queryByRole("link", { name: /안 한 것/u })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "놓친 안내 따라잡기" })).toHaveClass("content-filter");
  });

  it("keeps polls out of the feed and falls back to the full list for an old poll bookmark", async () => {
    /*
     * 투표는 투표 화면 한 곳에만 있다(2026-08-18 Hex 결정). 서버가 `filter=polls` 를
     * 400으로 막으므로 화면이 그 주소를 그대로 보내면 사용자가 오류를 본다 — 아래
     * mock 은 `filter=all` 이 아닌 요청이 오면 던진다. 되돌아오면 이 시험이 잡는다.
     */
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/notices/17") return Promise.resolve(jsonResponse(notice));
      if (url === "/api/v1/supplies/21")
        return Promise.resolve(jsonResponse({ ...supply, description: supply.content }));
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(
          jsonResponse({
            ...teacherBootstrap,
            allowed_actions: [...teacherBootstrap.allowed_actions, "MANAGE_POLLS"],
          }),
        );
      }
      if (url === "/api/v1/updates?filter=all") {
        return Promise.resolve(
          jsonResponse({
            items: [notice],
            next_cursor: null,
            selected_audience_enabled: false,
            server_today: "2026-07-26",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/updates?filter=polls"]}>
        <UpdatesPage />
      </MemoryRouter>,
    );

    const filters = await screen.findByRole("navigation", { name: "소식 필터" });
    expect(within(filters).queryByRole("link", { name: "투표" })).not.toBeInTheDocument();
    expect(within(filters).getByRole("link", { name: "전체" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    /*
     * 만들기 입구도 이 화면에 없다(2026-08-17 Hex 결정). 알림·띠·투표 화면 셋으로
     * 흩어져 있던 것을 선거 화면 한 곳으로 모았고, 여기는 만들어진 것을 **보는** 곳이다.
     */
    expect(screen.queryByRole("link", { name: "투표 만들기" })).not.toBeInTheDocument();
  });
});
