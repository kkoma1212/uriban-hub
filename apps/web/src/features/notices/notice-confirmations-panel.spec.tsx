import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NoticeConfirmationsPanel } from "./notice-confirmations-panel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe("NoticeConfirmationsPanel", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("uses the specific secondary recovery action when the confirmation list initially fails", async () => {
    let unreadRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/notices/17/confirmations?state=unread") {
        unreadRequestCount += 1;
        if (unreadRequestCount === 1) {
          return Promise.resolve(
            jsonResponse({ error: { code: "NOTICE_LOOKUP_FAILED", message: "synthetic" } }, 503),
          );
        }
      }
      if (
        url === "/api/v1/notices/17/confirmations?state=unread" ||
        url === "/api/v1/notices/17/confirmations?state=confirmed"
      ) {
        return Promise.resolve(
          jsonResponse({
            content_revision: "1",
            counts: { confirmed: 0, modified_unconfirmed: 0, unread: 0 },
            items: [],
            last_reminder_requested_at: null,
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter>
        <NoticeConfirmationsPanel
          contentRevision="1"
          membershipId="membership-1"
          noticeId="17"
          onReloadContent={() => Promise.resolve()}
          title="수행평가 안내"
          tone="latest"
        />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole("alert");
    const retryButton = within(alert).getByRole("button", {
      name: "최신 확인 현황 다시 불러오기",
    });
    expect(retryButton).toHaveClass("ui-button-secondary");
    expect(retryButton).not.toHaveClass("ui-button-danger");

    fireEvent.click(retryButton);
    expect(await screen.findByText("현재 공지를 확인한 학생이 없어요.")).toBeVisible();
    expect(unreadRequestCount).toBe(2);
  });

  it("shows the post-revision reconfirm rate only when the notice was revised", async () => {
    const counts = [
      { confirmed: 5, modified_unconfirmed: 1, reconfirmed: 3, unread: 2 },
      { confirmed: 5, modified_unconfirmed: 0, reconfirmed: 0, unread: 2 },
    ];
    for (const current of counts) {
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            content_revision: "2",
            counts: { ...current, excluded_member_count: 0 },
            items: [],
            last_reminder_requested_at: null,
            next_cursor: null,
            server_today: "2026-09-23",
          }),
        ),
      );
      const { unmount } = render(
        <MemoryRouter>
          <NoticeConfirmationsPanel
            contentRevision="2"
            membershipId="membership-1"
            noticeId="17"
            onReloadContent={() => Promise.resolve()}
            title="시험 범위 안내"
            tone="latest"
          />
        </MemoryRouter>,
      );
      const summary = await screen.findByLabelText("현재 공지 확인 요약");
      if (current.modified_unconfirmed + current.reconfirmed > 0) {
        expect(summary).toHaveTextContent("수정 후 재확인 3/4명");
      } else {
        expect(summary).not.toHaveTextContent("수정 후 재확인");
      }
      unmount();
      vi.restoreAllMocks();
    }
  });

  it("exposes counted keyboard tabs and requests only the selected state", async () => {
    let unreadRequestCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const counts = { confirmed: 1, unread: 2, modified_unconfirmed: 1 };
      if (url === "/api/v1/notices/17/confirmations?state=confirmed") {
        return Promise.resolve(
          jsonResponse({
            content_revision: "1",
            counts,
            items: [
              {
                member_id: "2",
                display_name: "확인 학생",
                student_number: 1,
                confirmation_state: "confirmed",
              },
            ],
            last_reminder_requested_at: null,
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      if (url === "/api/v1/notices/17/confirmations?state=unread") {
        unreadRequestCount += 1;
        return Promise.resolve(
          jsonResponse({
            content_revision: String(unreadRequestCount),
            counts,
            items: [
              {
                member_id: "3",
                display_name: "미확인 학생",
                student_number: null,
                confirmation_state: "unread",
              },
            ],
            last_reminder_requested_at: "2026-07-14T03:00:00.000Z",
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const { rerender } = render(
      <MemoryRouter>
        <NoticeConfirmationsPanel
          contentRevision="1"
          membershipId="membership-1"
          noticeId="17"
          onReloadContent={() => Promise.resolve()}
          title="수행평가 안내"
          tone="latest"
        />
      </MemoryRouter>,
    );
    const memberName = await screen.findByText("미확인 학생");
    expect(memberName).toBeVisible();
    const statusHeading = screen.getByRole("heading", { level: 2, name: "학생 확인 현황" });
    expect(statusHeading).toBeVisible();
    expect(statusHeading.closest("[data-notice-surface]")).toHaveClass(
      "border-app-border",
      "bg-app-surface",
    );
    expect(memberName.closest("li")).toHaveClass("bg-app-surface-muted");
    expect(screen.getByText("현재 내용 기준이며 비활성 계정은 제외합니다.")).toBeVisible();
    expect(screen.queryByText("교사 확인 현황")).not.toBeInTheDocument();
    const tablist = screen.getByRole("tablist", { name: "공지 확인 상태" });
    expect(screen.getByRole("img", { name: /확인 현황: 확인 1명/u })).toBeVisible();
    const confirmedTab = within(tablist).getByRole("tab", { name: "확인한 학생 1명" });
    const unreadTab = within(tablist).getByRole("tab", { name: "미확인 학생 2명" });
    const modifiedTab = within(tablist).getByRole("tab", { name: "수정 후 재확인 학생 1명" });
    expect(unreadTab).toHaveAttribute("aria-selected", "true");
    expect(unreadTab).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "현재 미해결 3명에게 다시 알려주기" })).toBeVisible();
    expect(screen.getByText(/앱 안에서만 알려요/u)).toBeVisible();
    fireEvent.focus(unreadTab);
    fireEvent.keyDown(unreadTab, { key: "ArrowLeft" });
    expect(modifiedTab).toHaveFocus();
    expect(unreadTab).toHaveAttribute("aria-selected", "true");
    fireEvent.click(confirmedTab);
    expect(await screen.findByText("확인 학생")).toBeVisible();
    expect(screen.getByRole("tabpanel", { name: "확인한 학생 1명" })).toHaveAttribute(
      "aria-labelledby",
      "notice-confirmation-tab-confirmed",
    );

    rerender(
      <MemoryRouter>
        <NoticeConfirmationsPanel
          contentRevision="2"
          membershipId="membership-1"
          noticeId="17"
          onReloadContent={() => Promise.resolve()}
          title="수행평가 안내"
          tone="latest"
        />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => requestUrl(input) === "/api/v1/notices/17/confirmations?state=unread",
        ),
      ).toHaveLength(2);
    });
  });

  it("defaults to modified-unconfirmed when unread is empty", async () => {
    const counts = { confirmed: 1, unread: 0, modified_unconfirmed: 2 };
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("state=unread")) {
        return Promise.resolve(
          jsonResponse({
            content_revision: "1",
            counts,
            items: [],
            last_reminder_requested_at: null,
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      if (url.endsWith("state=modified_unconfirmed")) {
        return Promise.resolve(
          jsonResponse({
            content_revision: "1",
            counts,
            items: [
              {
                confirmation_state: "modified_unconfirmed",
                display_name: "재확인 학생",
                member_id: "4",
                student_number: 4,
              },
            ],
            last_reminder_requested_at: null,
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter>
        <NoticeConfirmationsPanel
          contentRevision="1"
          membershipId="membership-1"
          noticeId="17"
          onReloadContent={() => Promise.resolve()}
          title="수행평가 안내"
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("재확인 학생")).toBeVisible();
    expect(screen.getByRole("tab", { name: "수정 후 재확인 학생 2명" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("blocks reminder actions when the confirmation snapshot revision differs", async () => {
    const reloadContent = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        content_revision: "2",
        counts: { confirmed: 1, unread: 2, modified_unconfirmed: 0 },
        items: [],
        last_reminder_requested_at: null,
        next_cursor: null,
        server_today: "2026-07-14",
      }),
    );

    render(
      <MemoryRouter>
        <NoticeConfirmationsPanel
          contentRevision="1"
          membershipId="membership-1"
          noticeId="17"
          onReloadContent={reloadContent}
          title="수행평가 안내"
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("공지 내용과 확인 현황의 기준이 달라요.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "최신 현황을 확인한 뒤 다시 알려주기" }),
    ).toBeDisabled();
    expect(screen.getByRole("tab", { name: "미확인 학생 집계 중" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "최신 공지와 현황 다시 불러오기" }));
    expect(reloadContent).toHaveBeenCalledTimes(1);
  });

  it("refreshes the summary and selected list after a reminder is registered", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    let confirmationRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/notices/17/confirmations?state=unread") {
        confirmationRequestCount += 1;
        const refreshed = confirmationRequestCount > 1;
        return Promise.resolve(
          jsonResponse({
            content_revision: "1",
            counts: refreshed
              ? { confirmed: 1, unread: 2, modified_unconfirmed: 0 }
              : { confirmed: 0, unread: 3, modified_unconfirmed: 0 },
            items: [
              {
                confirmation_state: "unread",
                display_name: refreshed ? "남은 학생" : "첫 학생",
                member_id: refreshed ? "4" : "3",
                student_number: 3,
              },
            ],
            last_reminder_requested_at: refreshed ? "2026-07-24T03:00:00.000Z" : null,
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      if (url === "/api/v1/notices/17/reminders" && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse({
            batch_id: "batch-1",
            cooldown_suppressed_count: 0,
            created_at: "2026-07-24T03:00:00.000Z",
            created_count: 2,
            current_unresolved_count: 2,
            next_available_at: null,
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter>
        <NoticeConfirmationsPanel
          contentRevision="1"
          membershipId="membership-1"
          noticeId="17"
          onReloadContent={() => Promise.resolve()}
          title="수행평가 안내"
        />
      </MemoryRouter>,
    );

    const reminderButton = await screen.findByRole("button", {
      name: "현재 미해결 3명에게 다시 알려주기",
    });
    await waitFor(() => expect(reminderButton).toBeEnabled());
    fireEvent.click(reminderButton);
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "다시 알림",
      }),
    );

    expect(await screen.findByText("앱 내 재알림 등록")).toBeVisible();
    expect(await screen.findByRole("tab", { name: "미확인 학생 2명" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const currentSummary = screen.getByLabelText("현재 공지 확인 요약");
    expect(currentSummary).toHaveTextContent("게시 대상3명");
    expect(currentSummary).not.toHaveTextContent("확인1명");
    expect(currentSummary).not.toHaveTextContent("확인 필요2명");
    expect(await screen.findByText("남은 학생")).toBeVisible();
    expect(confirmationRequestCount).toBe(2);

    const panel = screen.getByRole("region", { name: "학생 확인 현황" });
    const summary = within(panel).getByLabelText("현재 공지 확인 요약");
    const tablist = within(panel).getByRole("tablist", { name: "공지 확인 상태" });
    const action = panel.querySelector('[data-reminder-action="notice"]');
    const list = within(panel).getByRole("list");
    expect(action).not.toBeNull();
    if (action === null) throw new Error("Reminder action was not rendered.");
    expect(summary.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(tablist.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(list.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("keeps a successful reminder result while a failed status refresh blocks new reminders", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    let confirmationRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/notices/17/confirmations?state=unread") {
        confirmationRequestCount += 1;
        if (confirmationRequestCount > 1) {
          // A real fetch rejection is a browser TypeError; apiFetch normalizes it.
          return Promise.reject(new TypeError("refresh network interrupted"));
        }
        return Promise.resolve(
          jsonResponse({
            content_revision: "1",
            counts: { confirmed: 0, unread: 3, modified_unconfirmed: 0 },
            items: [
              {
                confirmation_state: "unread",
                display_name: "미확인 학생",
                member_id: "3",
                student_number: 3,
              },
            ],
            last_reminder_requested_at: null,
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      if (url === "/api/v1/notices/17/reminders" && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse({
            batch_id: "batch-1",
            cooldown_suppressed_count: 0,
            created_at: "2026-07-24T03:00:00.000Z",
            created_count: 3,
            current_unresolved_count: 3,
            next_available_at: null,
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter>
        <NoticeConfirmationsPanel
          contentRevision="1"
          membershipId="membership-1"
          noticeId="17"
          onReloadContent={() => Promise.resolve()}
          title="수행평가 안내"
        />
      </MemoryRouter>,
    );

    const reminderButton = await screen.findByRole("button", {
      name: "현재 미해결 3명에게 다시 알려주기",
    });
    await waitFor(() => expect(reminderButton).toBeEnabled());
    fireEvent.click(reminderButton);
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "다시 알림",
      }),
    );

    expect(await screen.findByText("앱 내 재알림 등록")).toBeVisible();
    expect(
      await screen.findByText("재알림은 등록됐지만 최신 현황을 불러오지 못했어요."),
    ).toBeVisible();
    expect(
      screen.getByText("서버에 연결하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "최신 현황을 확인한 뒤 다시 알려주기" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("이전 조회 공지 확인 요약")).toBeVisible();
  });

  it("replays an unknown old-revision result without updating the current revision time", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    let listRequestCount = 0;
    let reminderRequestCount = 0;
    const reminderRequests: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.includes("/confirmations?state=")) {
        listRequestCount += 1;
        const firstRevision = listRequestCount === 1;
        const state = new URL(url, "https://classhub.test").searchParams.get("state");
        return Promise.resolve(
          jsonResponse({
            content_revision: firstRevision ? "1" : "2",
            counts: firstRevision
              ? { confirmed: 0, unread: 1, modified_unconfirmed: 0 }
              : { confirmed: 1, unread: 0, modified_unconfirmed: 0 },
            items:
              firstRevision && state === "unread"
                ? [
                    {
                      confirmation_state: "unread",
                      display_name: "미확인 학생",
                      member_id: "3",
                      student_number: 3,
                    },
                  ]
                : state === "confirmed"
                  ? [
                      {
                        confirmation_state: "confirmed",
                        display_name: "확인 학생",
                        member_id: "3",
                        student_number: 3,
                      },
                    ]
                  : [],
            last_reminder_requested_at: null,
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      if (url === "/api/v1/notices/17/reminders" && init?.method === "POST") {
        reminderRequestCount += 1;
        reminderRequests.push(init);
        if (reminderRequestCount === 1) {
          return Promise.reject(new TypeError("network interrupted"));
        }
        return Promise.resolve(
          jsonResponse({
            batch_id: "batch-1",
            cooldown_suppressed_count: 0,
            created_at: "2026-07-24T03:00:00.000Z",
            created_count: 1,
            current_unresolved_count: 1,
            next_available_at: null,
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const view = render(
      <MemoryRouter>
        <NoticeConfirmationsPanel
          contentRevision="1"
          membershipId="membership-1"
          noticeId="17"
          onReloadContent={() => Promise.resolve()}
          title="수행평가 안내"
        />
      </MemoryRouter>,
    );
    const replayReminderButton = await screen.findByRole("button", {
      name: "현재 미해결 1명에게 다시 알려주기",
    });
    await waitFor(() => expect(replayReminderButton).toBeEnabled());
    fireEvent.click(replayReminderButton);
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "다시 알림",
      }),
    );
    expect(await screen.findByRole("button", { name: "등록 결과 다시 확인" })).toBeVisible();

    view.rerender(
      <MemoryRouter>
        <NoticeConfirmationsPanel
          contentRevision="2"
          membershipId="membership-1"
          noticeId="17"
          onReloadContent={() => Promise.resolve()}
          title="수행평가 안내"
        />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("tab", { name: "미확인 학생 0명" })).toBeVisible();
    expect(await screen.findByText("지금은 2번째 내용")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "등록 결과 다시 확인" }));

    expect(await screen.findByText("앱 내 재알림 등록")).toBeVisible();
    expect(screen.getByText("등록할 때 1번째 내용 · 지금은 2번째 내용")).toBeVisible();
    expect(screen.getByText(/아직 요청 없음/u)).toBeVisible();
    expect(screen.queryByText(/^최근 요청/u)).not.toBeInTheDocument();
    expect(reminderRequests.map(({ body }) => body)).toEqual([
      JSON.stringify({ content_revision: 1 }),
      JSON.stringify({ content_revision: 1 }),
    ]);
    const keys = reminderRequests.map(({ headers }) => new Headers(headers).get("Idempotency-Key"));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(keys[1]).toBe(keys[0]);
    expect(window.sessionStorage.length).toBe(0);
  });
});
