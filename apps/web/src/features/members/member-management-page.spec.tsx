import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemberManagementPage } from "./member-management-page";

const APPROVE_URL = "/api/v1/members/2/approve";
const MEMBERS_URL = "/api/v1/members?status=pending%2Capproved%2Cremoved%2Crejoin_allowed";
const REJECT_URL = "/api/v1/members/2/reject";

const bootstrapFixture = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "MANAGE_CLASS"],
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
  server_today: "2026-07-13",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const pendingMemberFixture = {
  account_state: "active",
  display_name: "테스트 학생",
  display_name_in_class: null,
  email_masked: "t***@example.com",
  id: "2",
  requested_at: "2026-07-13T01:00:00.000Z",
  row_version: "1",
  status: "pending",
  status_changed_at: "2026-07-13T01:00:00.000Z",
  student_number: null,
};

const approvedMemberFixture = {
  ...pendingMemberFixture,
  email_masked: undefined,
  requested_at: null,
  status: "approved",
  student_number: 7,
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

function approvedStudent(id: string, displayName: string, studentNumber: number) {
  return { ...approvedMemberFixture, display_name: displayName, id, student_number: studentNumber };
}

function renderApprovedRoster(members: readonly unknown[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
    if (url === MEMBERS_URL) {
      return Promise.resolve(jsonResponse({ members }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  render(
    <MemoryRouter initialEntries={["/members/manage?tab=approved"]}>
      <MemberManagementPage />
    </MemoryRouter>,
  );
}

/** 화면에 실제로 그려진 순서대로 학생 이름을 읽는다. */
function rosterNames(): string[] {
  return [...document.querySelectorAll("[data-member-roster-row] [data-member-name]")].map(
    (name) => name.textContent ?? "",
  );
}

function renderPendingMember() {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    "__Host-classhub_csrf=test-csrf-token",
  );
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") {
      return Promise.resolve(jsonResponse(bootstrapFixture));
    }
    if (url === MEMBERS_URL) {
      return Promise.resolve(jsonResponse({ members: [pendingMemberFixture] }));
    }
    if (url === APPROVE_URL) {
      return Promise.resolve(
        jsonResponse({
          member: { ...pendingMemberFixture, status: "approved" },
          warnings: [],
        }),
      );
    }
    if (url === REJECT_URL) {
      return Promise.resolve(
        jsonResponse({ member: { ...pendingMemberFixture, status: "rejected" } }),
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  render(
    <MemoryRouter initialEntries={["/members/manage"]}>
      <MemberManagementPage />
    </MemoryRouter>,
  );

  return fetchMock;
}

function approveCallCount(fetchMock: ReturnType<typeof renderPendingMember>): number {
  return fetchMock.mock.calls.filter(([input]) => requestUrl(input) === APPROVE_URL).length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MemberManagementPage", () => {
  it.each([true, false])(
    "checks the target's approved state after a lost response (committed: %s), without approving twice",
    async (committed) => {
      vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
        "__Host-classhub_csrf=fixture-csrf",
      );
      let submitted = false;
      const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = requestUrl(input);
        if (url === "/api/v1/bootstrap") return jsonResponse(bootstrapFixture);
        if (url === MEMBERS_URL)
          return jsonResponse({ members: submitted && committed ? [] : [pendingMemberFixture] });
        if (url === APPROVE_URL) {
          submitted = true;
          return jsonResponse(
            { error: { code: "UNEXPECTED_RESPONSE", message: "요청 결과를 확인하지 못했어요." } },
            502,
          );
        }
        if (url === "/api/v1/members?status=approved")
          return jsonResponse({ members: committed ? [approvedMemberFixture] : [] });
        throw new Error(`Unexpected fixture endpoint: ${url}`);
      });
      render(
        <MemoryRouter initialEntries={["/members/manage"]}>
          <MemberManagementPage />
        </MemoryRouter>,
      );
      fireEvent.click(await screen.findByRole("button", { name: / 학생 승인$/u }));
      if (committed) {
        expect(
          await screen.findByText(
            "학생이 승인된 것을 확인했어요. 안내 메일이 갔는지는 확인하지 못했어요.",
          ),
        ).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: / 학생 승인$/u })).not.toBeInTheDocument();
      } else {
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "요청 결과를 확인하지 못했어요.",
        );
        expect(screen.getByRole("button", { name: / 학생 승인$/u })).toBeEnabled();
      }
      expect(
        request.mock.calls.filter(([input]) => requestUrl(input) === APPROVE_URL),
      ).toHaveLength(1);
    },
  );

  it("shows a waiting student's birth date beside the masked email for the homeroom check", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
      if (url === MEMBERS_URL)
        return Promise.resolve(
          jsonResponse({
            members: [
              { ...pendingMemberFixture, birth_date: "2011-03-05" },
              { ...pendingMemberFixture, display_name: "생일 없음", id: "3", birth_date: null },
            ],
          }),
        );
      throw new Error(`Unexpected URL: ${url}`);
    });
    render(
      <MemoryRouter initialEntries={["/members/manage"]}>
        <MemberManagementPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("t***@example.com · 생년월일 2011. 03. 05."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("t***@example.com")).toHaveLength(1);
  });

  it("does not apply UTF-16 maxlength limits to the display name or rejection reason", async () => {
    renderPendingMember();
    fireEvent.click(await screen.findByRole("button", { name: "테스트 학생 승인 정보 입력" }));

    const displayName = await screen.findByRole("textbox", { name: "반에서 보이는 이름" });
    const rejectionReason = screen.getByRole("textbox", { name: "테스트 학생 거절 사유" });

    expect(displayName).not.toHaveAttribute("maxlength");
    expect(rejectionReason).not.toHaveAttribute("maxlength");
  });

  it("exposes an operable tablist with selection, panels, and arrow-key navigation", async () => {
    const requestedStatuses: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(bootstrapFixture));
      }
      if (url.startsWith("/api/v1/members?status=")) {
        requestedStatuses.push(decodeURIComponent(url.slice("/api/v1/members?status=".length)));
        return Promise.resolve(jsonResponse({ members: [] }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/members/manage"]}>
        <MemberManagementPage />
      </MemoryRouter>,
    );

    const tablist = await screen.findByRole("tablist", { name: "학생 관리 보기" });
    expect(screen.getByRole("heading", { level: 1, name: "학생" })).toBeVisible();
    expect(screen.getByRole("main").firstElementChild).toHaveAttribute(
      "data-app-shell-width",
      "wide",
    );
    const pendingTab = within(tablist).getByRole("tab", { name: /^대기/u });
    const approvedTab = within(tablist).getByRole("tab", { name: /^참여/u });
    const removedTab = within(tablist).getByRole("tab", { name: /^제외/u });

    expect(pendingTab).toHaveAttribute("aria-selected", "true");
    expect(pendingTab).toHaveAttribute("tabindex", "0");
    expect(approvedTab).toHaveAttribute("aria-selected", "false");
    expect(approvedTab).toHaveAttribute("tabindex", "-1");
    expect(removedTab).toHaveClass("whitespace-nowrap");
    expect(await screen.findByRole("tabpanel", { name: /^대기/u })).toHaveAttribute(
      "id",
      "member-panel-pending",
    );

    await waitFor(() => expect(pendingTab).toBeEnabled());
    fireEvent.focus(pendingTab);
    fireEvent.keyDown(pendingTab, { key: "ArrowRight" });

    expect(approvedTab).toHaveFocus();
    expect(pendingTab).toHaveAttribute("aria-selected", "true");
    expect(requestedStatuses).toEqual(["pending,approved,removed,rejoin_allowed"]);

    fireEvent.click(approvedTab);
    await waitFor(() => {
      expect(approvedTab).toHaveAttribute("aria-selected", "true");
      expect(approvedTab).toHaveFocus();
      expect(requestedStatuses).toHaveLength(2);
    });
    expect(screen.getByRole("tabpanel", { name: /^참여/u })).toHaveAttribute(
      "aria-labelledby",
      "member-tab-approved",
    );

    await waitFor(() => expect(approvedTab).toBeEnabled());
    fireEvent.keyDown(approvedTab, { key: "End" });
    expect(removedTab).toHaveFocus();
    expect(approvedTab).toHaveAttribute("aria-selected", "true");

    fireEvent.click(removedTab);
    await waitFor(() => {
      expect(removedTab).toHaveAttribute("aria-selected", "true");
      expect(removedTab).toHaveFocus();
      expect(requestedStatuses).toHaveLength(3);
    });
  });

  it("orders the approved roster by number and finds students by name, choseong or number", async () => {
    /*
     * 서버 목록 API에는 `ORDER BY`가 없다. 그래서 여기 순서는 **일부러 뒤죽박죽**이다 —
     * 화면이 정렬을 실제로 하는지 보려면 들어오는 순서가 이미 맞아 있으면 안 된다.
     */
    renderApprovedRoster([
      approvedStudent("3", "홍예준", 28),
      approvedStudent("4", "김서윤", 2),
      approvedStudent("5", "박다은", 4),
      approvedStudent("6", "김도윤", 1),
    ]);

    await screen.findByRole("link", { name: "김도윤 학생 정보 보기" });
    const roster = screen.getByRole("list", { name: "승인 학생 목록" });
    expect(roster).toHaveAttribute("data-member-roster-view", "compact-rows");
    expect(roster.querySelectorAll("[data-member-roster-row]")).toHaveLength(4);
    expect(rosterNames()).toEqual(["김도윤", "김서윤", "박다은", "홍예준"]);
    expect(screen.getByRole("status")).toHaveTextContent("번호순 4명");

    fireEvent.click(screen.getByRole("button", { name: "학생 검색" }));
    const search = screen.getByRole("searchbox", { name: /학생 찾기/u });

    fireEvent.change(search, { target: { value: "ㄱ" } });
    expect(rosterNames()).toEqual(["김도윤", "김서윤"]);
    expect(screen.getByRole("status")).toHaveTextContent("번호순 2명");

    fireEvent.change(search, { target: { value: "ㄱㅁ" } });
    expect(rosterNames()).toEqual([]);
    expect(screen.getByText("'ㄱㅁ'로 찾은 학생이 없어요.")).toBeVisible();

    fireEvent.change(search, { target: { value: "다은" } });
    expect(rosterNames()).toEqual(["박다은"]);

    fireEvent.change(search, { target: { value: "28" } });
    expect(rosterNames()).toEqual(["홍예준"]);

    fireEvent.change(search, { target: { value: "" } });
    expect(rosterNames()).toEqual(["김도윤", "김서윤", "박다은", "홍예준"]);
  });

  it("keeps the pending queue in server order without a search box", async () => {
    renderPendingMember();
    fireEvent.click(await screen.findByRole("button", { name: "테스트 학생 승인 정보 입력" }));

    expect(await screen.findByText("테스트 학생")).toBeVisible();
    expect(screen.queryByRole("searchbox", { name: /학생 찾기/u })).not.toBeInTheDocument();
  });

  it("opens an approved student's dedicated safe profile route", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(bootstrapFixture));
      }
      if (url === MEMBERS_URL) {
        return Promise.resolve(jsonResponse({ members: [approvedMemberFixture] }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/members/manage?tab=approved"]}>
        <MemberManagementPage />
      </MemoryRouter>,
    );

    const profileLink = await screen.findByRole("link", {
      name: "테스트 학생 학생 정보 보기",
    });
    expect(profileLink).toHaveAttribute("href", "/members/manage/2");
    expect(screen.getByRole("textbox", { name: "테스트 학생 반에서 제외 사유" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "반에서 제외" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "학생 정보 수정" })).toBeNull();
  });

  it("redirects a student before requesting the teacher member list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(
          jsonResponse({
            ...bootstrapFixture,
            allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS"],
            current_membership: {
              ...bootstrapFixture.current_membership,
              role: "student",
            },
            teacher_profile: null,
          }),
        );
      }
      if (url === MEMBERS_URL) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: "ROLE_INSUFFICIENT", message: "담임 선생님만 이용할 수 있습니다." } },
            403,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/members/manage"]}>
        <Routes>
          <Route element={<MemberManagementPage />} path="/members/manage" />
          <Route element={<p>학생 홈 화면</p>} path="/home" />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("학생 홈 화면")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input) === MEMBERS_URL),
    ).toHaveLength(0);
  });

  it("blocks a one-code-point display name before calling the approval API", async () => {
    const fetchMock = renderPendingMember();
    fireEvent.click(await screen.findByRole("button", { name: "테스트 학생 승인 정보 입력" }));
    const displayName = await screen.findByRole("textbox", { name: "반에서 보이는 이름" });

    fireEvent.change(displayName, { target: { value: "😀" } });
    fireEvent.click(screen.getByRole("button", { name: / 학생 승인$/u }));

    expect(
      await screen.findByText("반에서 보이는 이름은 비워 두거나 2~20자로 입력해 주세요."),
    ).toBeInTheDocument();
    expect(approveCallCount(fetchMock)).toBe(0);
  });

  it("sends all twenty astral code points in one approval request", async () => {
    const fetchMock = renderPendingMember();
    fireEvent.click(await screen.findByRole("button", { name: "테스트 학생 승인 정보 입력" }));
    const displayName = await screen.findByRole("textbox", { name: "반에서 보이는 이름" });
    const twentyCodePoints = "😀".repeat(20);

    fireEvent.change(displayName, { target: { value: twentyCodePoints } });
    fireEvent.click(screen.getByRole("button", { name: / 학생 승인$/u }));

    await waitFor(() => {
      expect(approveCallCount(fetchMock)).toBe(1);
      expect(
        fetchMock.mock.calls.filter(([input]) => requestUrl(input) === MEMBERS_URL),
      ).toHaveLength(2);
    });
    const approvalCalls = fetchMock.mock.calls.filter(
      ([input]) => requestUrl(input) === APPROVE_URL,
    );
    expect(approvalCalls).toHaveLength(1);
    expect(approvalCalls[0]?.[1]?.body).toBe(
      JSON.stringify({
        display_name_in_class: twentyCodePoints,
        student_number: null,
      }),
    );
    expect(new Headers(approvalCalls[0]?.[1]?.headers).get("X-CSRF-Token")).toBe("test-csrf-token");
    expect(await screen.findByText("테스트 학생 학생을 승인했습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "학생들에게 공지 쓰기" })).not.toBeInTheDocument();
  });

  it("moves focus to the bulk approval result and offers writing a notice next", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
    const second = { ...pendingMemberFixture, display_name: "둘째 학생", id: "3" };
    let approved = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return jsonResponse(bootstrapFixture);
      if (url === MEMBERS_URL)
        return jsonResponse({ members: approved === 2 ? [] : [pendingMemberFixture, second] });
      if (/^\/api\/v1\/members\/[23]\/approve$/u.test(url)) {
        approved += 1;
        return jsonResponse({
          member: { ...pendingMemberFixture, status: "approved" },
          warnings: [],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    render(
      <MemoryRouter initialEntries={["/members/manage"]}>
        <MemberManagementPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "대기 학생 모두 승인 (2명)" }));
    fireEvent.click(await screen.findByRole("button", { name: "2명 승인" }));

    const result = await screen.findByText("2명을 승인했습니다.");
    const link = screen.getByRole("link", { name: "학생들에게 공지 쓰기" });
    expect(link).toHaveAttribute("href", "/updates?create=notice");
    await waitFor(() => expect(document.activeElement).toContainElement(result));
  });

  it("blocks a twenty-one-code-point display name before calling the approval API", async () => {
    const fetchMock = renderPendingMember();
    fireEvent.click(await screen.findByRole("button", { name: "테스트 학생 승인 정보 입력" }));
    const displayName = await screen.findByRole("textbox", { name: "반에서 보이는 이름" });

    fireEvent.change(displayName, { target: { value: "😀".repeat(21) } });
    fireEvent.click(screen.getByRole("button", { name: / 학생 승인$/u }));

    expect(
      await screen.findByText("반에서 보이는 이름은 비워 두거나 2~20자로 입력해 주세요."),
    ).toBeInTheDocument();
    expect(approveCallCount(fetchMock)).toBe(0);
  });

  it("accepts three hundred reason code points and blocks the next one before confirmation", async () => {
    const fetchMock = renderPendingMember();
    fireEvent.click(await screen.findByRole("button", { name: "테스트 학생 승인 정보 입력" }));
    const rejectionReason = await screen.findByRole("textbox", {
      name: "테스트 학생 거절 사유",
    });

    fireEvent.change(rejectionReason, { target: { value: "😀".repeat(301) } });
    fireEvent.click(screen.getByRole("button", { name: / 학생 거절$/u }));

    expect(await screen.findByText("거절 사유는 300자 이하로 입력해 주세요.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === REJECT_URL)).toBe(false);

    const validReason = "😀".repeat(300);
    fireEvent.change(rejectionReason, { target: { value: validReason } });
    const rejectButton = screen.getByRole("button", { name: / 학생 거절$/u });
    rejectButton.focus();
    fireEvent.click(rejectButton);

    const dialog = screen.getByRole("dialog", {
      name: "테스트 학생 학생의 반 참여 요청을 거절할까요?",
    });
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === REJECT_URL)).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(rejectButton).toHaveFocus());
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === REJECT_URL)).toBe(false);

    fireEvent.click(rejectButton);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "반 참여 요청 거절" }),
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) => requestUrl(input) === REJECT_URL),
      ).toHaveLength(1);
    });
    const rejectionCall = fetchMock.mock.calls.find(([input]) => requestUrl(input) === REJECT_URL);
    expect(rejectionCall?.[1]?.body).toBe(JSON.stringify({ reason: validReason }));

    expect(
      await screen.findByText("테스트 학생 학생의 반 참여 요청을 거절했습니다."),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "테스트 학생 거절 사유" }), {
      target: { value: "😀".repeat(301) },
    });
    fireEvent.click(screen.getByRole("button", { name: / 학생 거절$/u }));

    expect(await screen.findByText("거절 사유는 300자 이하로 입력해 주세요.")).toBeInTheDocument();
    expect(
      screen.queryByText("테스트 학생 학생의 반 참여 요청을 거절했습니다."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => requestUrl(input) === REJECT_URL)).toHaveLength(
      1,
    );
  });

  it("shows one safe initial list error and recovers through its retry action", async () => {
    let memberRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
      if (url === MEMBERS_URL) {
        memberRequestCount += 1;
        if (memberRequestCount === 1) {
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: "MEMBER_LOOKUP_FAILED",
                  message: "SELECT member_id FROM private_members",
                },
              },
              503,
            ),
          );
        }
        return Promise.resolve(jsonResponse({ members: [pendingMemberFixture] }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/members/manage"]}>
        <MemberManagementPage />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(alert).toHaveTextContent("학생 목록을 불러오지 못했어요.");
    expect(screen.queryByText(/private_members/u)).not.toBeInTheDocument();

    const retryButton = within(alert).getByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");
    fireEvent.click(retryButton);
    expect(await screen.findByText("테스트 학생")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(memberRequestCount).toBe(2);
  });

  it("keeps cached members visible during a failed refresh and retry", async () => {
    let memberRequestCount = 0;
    let resolveRetry: ((response: Response) => void) | undefined;
    const retryRequest = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
      if (url === MEMBERS_URL) {
        memberRequestCount += 1;
        if (memberRequestCount === 1) {
          return Promise.resolve(jsonResponse({ members: [pendingMemberFixture] }));
        }
        if (memberRequestCount === 2) {
          return Promise.resolve(
            jsonResponse(
              { error: { code: "MEMBER_LOOKUP_FAILED", message: "학생 조회 실패" } },
              503,
            ),
          );
        }
        return retryRequest;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/members/manage"]}>
        <MemberManagementPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("테스트 학생")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "목록 새로고침" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("최신 학생 목록을 확인하지 못했어요.");
    expect(screen.getByText("테스트 학생")).toBeVisible();

    const retryButton = within(alert).getByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");
    fireEvent.click(retryButton);
    expect(retryButton).toBeDisabled();
    expect(screen.getByText("테스트 학생")).toBeVisible();
    await waitFor(() => expect(memberRequestCount).toBe(3));
    fireEvent.click(retryButton);
    expect(memberRequestCount).toBe(3);

    resolveRetry?.(
      jsonResponse({
        members: [{ ...pendingMemberFixture, id: "3", display_name: "갱신된 테스트 학생" }],
      }),
    );
    expect(await screen.findByText("갱신된 테스트 학생")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.queryByText("테스트 학생", { exact: true })).not.toBeInTheDocument();
    expect(memberRequestCount).toBe(3);
  });
  it("shows all status counts and joins every page of today's attendance only when permitted", async () => {
    const second = approvedStudent("3", "둘째 학생", 8);
    const removed = {
      ...approvedMemberFixture,
      id: "4",
      display_name: "제외 학생",
      status: "removed",
    };
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = requestUrl(input);
      requests.push(url);
      if (url === "/api/v1/bootstrap")
        return jsonResponse({
          ...bootstrapFixture,
          allowed_actions: [...bootstrapFixture.allowed_actions, "MANAGE_ATTENDANCE_NOTIFICATIONS"],
        });
      if (url === MEMBERS_URL)
        return jsonResponse({
          members: [approvedMemberFixture, second, removed],
        });
      if (url.startsWith("/api/v1/attendance-notifications/today?")) {
        const next = url.includes("cursor=");
        return jsonResponse({
          counts: { absent: 1, acknowledged: 0, early: 0, late: 1, pending: 2, total: 2 },
          items: [{ member_id: next ? "3" : "2", notification_type: next ? "absent" : "late" }],
          next_cursor: next ? null : "next-student",
          role: "teacher",
          server_today: "2026-07-13",
        });
      }
      throw new Error("Unexpected URL: " + url);
    });
    render(
      <MemoryRouter initialEntries={["/members/manage?tab=approved"]}>
        <MemberManagementPage />
      </MemoryRouter>,
    );
    const roster = await screen.findByRole("list", { name: "승인 학생 목록" });
    expect(within(roster).getByText("지각")).toBeVisible();
    expect(within(roster).getByText("결석")).toBeVisible();
    const tabs = screen.getByRole("tablist", { name: "학생 관리 보기" });
    expect(within(tabs).getByRole("tab", { name: /^대기\s*0$/u })).toBeVisible();
    expect(within(tabs).getByRole("tab", { name: /^참여\s*2$/u })).toBeVisible();
    expect(within(tabs).getByRole("tab", { name: /^제외\s*1$/u })).toBeVisible();
    expect(
      requests.filter((url) =>
        url.startsWith("/api/v1/attendance-notifications/today?status=all&type=all"),
      ),
    ).toHaveLength(2);
    expect(screen.queryByText("최근 출결 연락")).not.toBeInTheDocument();
    expect(screen.queryByText("아직 안 한 것")).not.toBeInTheDocument();
  });

  it("keeps the roster usable when today's optional attendance cannot be loaded", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap")
        return jsonResponse({
          ...bootstrapFixture,
          allowed_actions: [...bootstrapFixture.allowed_actions, "MANAGE_ATTENDANCE_NOTIFICATIONS"],
        });
      if (url === MEMBERS_URL) return jsonResponse({ members: [approvedMemberFixture] });
      if (url.startsWith("/api/v1/attendance-notifications/today?"))
        throw new Error("출결 조회 실패");
      throw new Error("Unexpected URL: " + url);
    });
    render(
      <MemoryRouter initialEntries={["/members/manage?tab=approved"]}>
        <MemberManagementPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("link", { name: "테스트 학생 학생 정보 보기" })).toBeVisible();
    expect(screen.getByText("오늘 출결 연락을 불러오지 못해 표시하지 않았어요.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

it("locks individual decisions and approval drafts until bulk approval refresh settles", async () => {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    "__Host-classhub_csrf=test-csrf-token",
  );
  const second = { ...pendingMemberFixture, display_name: "둘째 학생", id: "3" };
  let release: (response: Response) => void = () => {};
  let approved = 0;
  let memberRequests = 0;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") return jsonResponse(bootstrapFixture);
    if (url === MEMBERS_URL) {
      memberRequests += 1;
      if (memberRequests === 2)
        return jsonResponse(
          { error: { code: "MEMBER_LOOKUP_FAILED", message: "lookup failed" } },
          503,
        );
      return jsonResponse({ members: approved === 2 ? [] : [pendingMemberFixture, second] });
    }
    if (/^\/api\/v1\/members\/[23]\/approve$/u.test(url)) {
      approved += 1;
      if (approved === 1)
        return await new Promise<Response>((resolve) => {
          release = resolve;
        });
      return jsonResponse({ member: approvedMemberFixture, warnings: [] });
    }
    throw new Error("Unexpected request");
  });
  render(
    <MemoryRouter initialEntries={["/members/manage"]}>
      <MemberManagementPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "테스트 학생 승인 정보 입력" }));
  fireEvent.click(screen.getByRole("button", { name: "목록 새로고침" }));
  const staleRetry = await screen.findByRole("button", { name: "다시 시도" });
  fireEvent.click(screen.getByRole("button", { name: "대기 학생 모두 승인 (2명)" }));
  fireEvent.click(await screen.findByRole("button", { name: "2명 승인" }));
  const progress = await screen.findByRole("button", { name: "승인 중 1/2" });
  for (const button of [
    ...screen.getAllByRole("button", { name: / 학생 승인$/u }),
    ...screen.getAllByRole("button", { name: / 학생 거절$/u }),
  ]) {
    expect(button).toBeDisabled();
    fireEvent.click(button);
  }
  expect(staleRetry).toBeDisabled();
  fireEvent.click(staleRetry);
  expect(memberRequests).toBe(2);
  expect(screen.getByRole("textbox", { name: "반에서 보이는 이름" })).toBeDisabled();
  await waitFor(() => expect(document.activeElement).toContainElement(progress));
  expect(
    fetchMock.mock.calls.filter(([input]) => /\/(approve|reject)$/u.test(requestUrl(input))),
  ).toHaveLength(1);
  release(jsonResponse({ member: approvedMemberFixture, warnings: [] }));
  const result = await screen.findByText("2명을 승인했습니다.");
  await waitFor(() => expect(document.activeElement).toContainElement(result));
});

it("shows bulk approval error alongside stale roster warning after final refresh fails", async () => {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    "__Host-classhub_csrf=test-csrf-token",
  );
  let reads = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") return jsonResponse(bootstrapFixture);
    if (url === MEMBERS_URL) {
      reads += 1;
      return reads === 1
        ? jsonResponse({
            members: [
              pendingMemberFixture,
              { ...pendingMemberFixture, id: "3", display_name: "둘째 학생" },
            ],
          })
        : jsonResponse({ error: { code: "MEMBER_LOOKUP_FAILED", message: "lookup failed" } }, 503);
    }
    if (url === APPROVE_URL) return jsonResponse({ member: approvedMemberFixture, warnings: [] });
    if (url === "/api/v1/members/3/approve")
      return jsonResponse(
        { error: { code: "MEMBER_CONFLICT", message: "승인할 수 없는 상태입니다." } },
        409,
      );
    throw new Error("Unexpected request");
  });
  render(
    <MemoryRouter initialEntries={["/members/manage"]}>
      <MemberManagementPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "대기 학생 모두 승인 (2명)" }));
  fireEvent.click(await screen.findByRole("button", { name: "2명 승인" }));
  expect(await screen.findByText(/1명은 승인하지 못했습니다/u)).toBeVisible();
  expect(screen.getByText("최신 학생 목록을 확인하지 못했어요.")).toBeVisible();
  expect(screen.getByRole("button", { name: "다시 시도" })).toBeEnabled();
  expect(reads).toBe(2);
});

it("focuses the result again when two bulk attempts return identical summaries", async () => {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    "__Host-classhub_csrf=test-csrf-token",
  );
  let approvals = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") return jsonResponse(bootstrapFixture);
    if (url === MEMBERS_URL)
      return jsonResponse({
        members: [
          pendingMemberFixture,
          { ...pendingMemberFixture, id: "3", display_name: "둘째 학생" },
        ],
      });
    if (/\/approve$/u.test(url)) {
      approvals += 1;
      return jsonResponse(
        { error: { code: "MEMBER_CONFLICT", message: "승인할 수 없는 상태입니다." } },
        409,
      );
    }
    throw new Error("Unexpected request");
  });
  render(
    <MemoryRouter initialEntries={["/members/manage"]}>
      <MemberManagementPage />
    </MemoryRouter>,
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const trigger = await screen.findByRole("button", { name: "대기 학생 모두 승인 (2명)" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "2명 승인" }));
    await waitFor(() => expect(approvals).toBe((attempt + 1) * 2));
    const result = await screen.findByText(/2명은 승인하지 못했습니다/u);
    await waitFor(() => expect(document.activeElement).toContainElement(result));
  }
});
