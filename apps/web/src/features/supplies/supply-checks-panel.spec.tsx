import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SupplyChecksPanel } from "./supply-checks-panel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe("SupplyChecksPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the specific secondary recovery action when the check list initially fails", async () => {
    let requestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url !== "/api/v1/supplies/17/checks?state=unchecked") {
        throw new Error(`Unexpected URL: ${url}`);
      }
      requestCount += 1;
      if (requestCount === 1) {
        return Promise.resolve(
          jsonResponse({ error: { code: "SUPPLY_LOOKUP_FAILED", message: "synthetic" } }, 503),
        );
      }
      return Promise.resolve(
        jsonResponse({
          content_revision: "1",
          counts: { checked: 0, modified_unconfirmed: 0, unchecked: 0 },
          items: [],
          last_reminder_requested_at: null,
          next_cursor: null,
          server_today: "2026-07-14",
        }),
      );
    });

    render(
      <MemoryRouter>
        <SupplyChecksPanel
          category="general"
          contentRevision="1"
          focusOnLoad={false}
          membershipId="membership-1"
          onRefreshContent={async () => "1"}
          reminderEligible
          supplyId="17"
          title="수학 준비물"
        />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole("alert");
    const retryButton = within(alert).getByRole("button", {
      name: "최신 내용과 현황 다시 불러오기",
    });
    expect(retryButton).toHaveClass("ui-button-secondary");
    expect(retryButton).not.toHaveClass("ui-button-danger");

    fireEvent.click(retryButton);
    expect(await screen.findByText("아직 챙기지 않은 학생이 없어요.")).toBeVisible();
    expect(requestCount).toBe(2);
  });

  it("shows the post-revision reconfirm rate only when earlier checkers exist", async () => {
    let counts = { checked: 3, unchecked: 1, modified_unconfirmed: 2, reconfirmed: 1 };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          content_revision: "2",
          counts,
          items: [],
          last_reminder_requested_at: null,
          next_cursor: null,
          server_today: "2026-07-14",
        }),
      ),
    );
    const panel = (
      <MemoryRouter>
        <SupplyChecksPanel
          category="general"
          contentRevision="2"
          focusOnLoad={false}
          membershipId="membership-1"
          onRefreshContent={async () => "2"}
          reminderEligible
          supplyId="17"
          title="체육복"
        />
      </MemoryRouter>
    );
    const { unmount } = render(panel);
    expect(await screen.findByText("수정 후 재확인 1/3명")).toBeVisible();
    unmount();

    counts = { checked: 3, unchecked: 0, modified_unconfirmed: 0, reconfirmed: 0 };
    render(panel);
    const refresh = await screen.findByRole("button", { name: "확인 현황 새로고침" });
    await waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(document.querySelector("[data-supply-reconfirm-rate]")).toBeNull();
  });

  it("exposes three counted tabs and appends only the requested cursor page", async () => {
    let responseRevision = "1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const counts = { checked: 1, unchecked: 2, modified_unconfirmed: 1 };
      if (url === "/api/v1/supplies/17/checks?state=checked") {
        return Promise.resolve(
          jsonResponse({
            content_revision: responseRevision,
            counts,
            items: [
              {
                member_id: "2",
                display_name: "챙긴 학생",
                student_number: 1,
                check_state: "checked",
              },
            ],
            last_reminder_requested_at: null,
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      if (url === "/api/v1/supplies/17/checks?state=unchecked") {
        return Promise.resolve(
          jsonResponse({
            content_revision: responseRevision,
            counts,
            items: [
              {
                member_id: "3",
                display_name: "미챙김 학생 하나",
                student_number: null,
                check_state: "unchecked",
              },
            ],
            last_reminder_requested_at: "2026-07-14T03:00:00.000Z",
            next_cursor: "opaque-cursor",
            server_today: "2026-07-14",
          }),
        );
      }
      if (url === "/api/v1/supplies/17/checks?state=unchecked&cursor=opaque-cursor") {
        return Promise.resolve(
          jsonResponse({
            content_revision: responseRevision,
            counts,
            items: [
              {
                member_id: "4",
                display_name: "미챙김 학생 둘",
                student_number: 4,
                check_state: "unchecked",
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
        <SupplyChecksPanel
          category="general"
          contentRevision="1"
          focusOnLoad={false}
          membershipId="membership-1"
          onRefreshContent={async () => "1"}
          reminderEligible
          supplyId="17"
          title="수학 준비물"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("tab", { name: "미챙김 학생 집계 중" })).toBeInTheDocument();
    expect(document.querySelector('[data-reminder-action="supply"]')).toBeNull();

    expect(await screen.findByText("미챙김 학생 하나")).toBeVisible();
    const statusHeading = screen.getByRole("heading", {
      level: 2,
      name: "학생 준비물 현황",
    });
    expect(statusHeading).toBeVisible();
    expect(statusHeading).toHaveClass(
      "rounded-lg",
      "focus-visible:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-role-primary",
      "focus-visible:ring-offset-4",
    );
    expect(statusHeading).not.toHaveClass(
      "outline-none",
      "focus-visible:ring-4",
      "focus-visible:ring-brand-primary/25",
    );
    expect(screen.getByText("현재 내용 기준이며 비활성 계정은 제외합니다.")).toBeVisible();
    expect(screen.queryByText("교사 확인 현황")).not.toBeInTheDocument();
    const tablist = screen.getByRole("tablist", { name: "준비물 확인 상태" });
    const uncheckedTab = within(tablist).getByRole("tab", { name: "미챙김 학생 2명" });
    const modifiedTab = within(tablist).getByRole("tab", {
      name: "수정 후 재확인 학생 1명",
    });
    const reminderAction = document.querySelector('[data-reminder-action="supply"]');

    expect(uncheckedTab).toHaveAttribute("aria-selected", "true");
    expect(
      within(reminderAction as HTMLElement).getByRole("button", {
        name: "현재 미해결 3명에게 다시 알려주기",
      }),
    ).toBeVisible();
    expect(
      tablist.compareDocumentPosition(reminderAction as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (screen.getByText("미챙김 학생 하나").closest("li") as Node).compareDocumentPosition(
        reminderAction as Node,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.focus(uncheckedTab);
    fireEvent.keyDown(uncheckedTab, { key: "ArrowLeft" });
    expect(modifiedTab).toHaveFocus();
    expect(uncheckedTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "미챙김 학생 2명" })).toHaveAttribute(
      "aria-labelledby",
      "supply-check-tab-unchecked",
    );

    fireEvent.click(screen.getByRole("button", { name: "학생 더 보기" }));
    expect(await screen.findByText("미챙김 학생 둘")).toBeVisible();
    expect(screen.getByText("미챙김 학생 하나")).toBeVisible();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input]) =>
            requestUrl(input) === "/api/v1/supplies/17/checks?state=unchecked&cursor=opaque-cursor",
        ),
      ).toHaveLength(1);
    });

    responseRevision = "2";
    rerender(
      <MemoryRouter>
        <SupplyChecksPanel
          category="general"
          contentRevision="2"
          focusOnLoad={false}
          membershipId="membership-1"
          onRefreshContent={async () => "2"}
          reminderEligible
          supplyId="17"
          title="수학 준비물"
        />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => requestUrl(input) === "/api/v1/supplies/17/checks?state=unchecked",
        ),
      ).toHaveLength(2);
    });
    expect(screen.getByRole("tab", { name: "미챙김 학생 2명" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("defaults to the completed tab when no student remains unresolved", async () => {
    const counts = { checked: 1, unchecked: 0, modified_unconfirmed: 0 };
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("state=unchecked")) {
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
      if (url.endsWith("state=checked")) {
        return Promise.resolve(
          jsonResponse({
            content_revision: "1",
            counts,
            items: [
              {
                check_state: "checked",
                display_name: "챙긴 학생",
                member_id: "2",
                student_number: 2,
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
        <SupplyChecksPanel
          category="general"
          contentRevision="1"
          focusOnLoad={false}
          membershipId="membership-1"
          onRefreshContent={async () => "1"}
          reminderEligible
          supplyId="17"
          title="수학 준비물"
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("챙긴 학생")).toBeVisible();
    expect(screen.getByRole("tab", { name: "챙긴 학생 1명" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(document.querySelector('[data-reminder-action="supply"]')).not.toBeInTheDocument();
  });

  it("defaults to the modified-unconfirmed tab when it is the only unresolved state", async () => {
    const counts = { checked: 1, unchecked: 0, modified_unconfirmed: 2 };
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("state=unchecked")) {
        return Promise.resolve(
          jsonResponse({
            content_revision: "3",
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
            content_revision: "3",
            counts,
            items: [
              {
                check_state: "modified_unconfirmed",
                display_name: "다시 확인할 학생",
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
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter>
        <SupplyChecksPanel
          category="general"
          contentRevision="3"
          focusOnLoad={false}
          membershipId="membership-1"
          onRefreshContent={async () => "3"}
          reminderEligible
          supplyId="17"
          title="수학 준비물"
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("다시 확인할 학생")).toBeVisible();
    expect(screen.getByRole("tab", { name: "수정 후 재확인 학생 2명" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("blocks stale counts on a revision mismatch and recovers through the latest-content action", async () => {
    let requestCount = 0;
    const onRefreshContent = vi.fn().mockResolvedValue("1");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      requestCount += 1;
      return Promise.resolve(
        jsonResponse({
          content_revision: requestCount === 1 ? "2" : "1",
          counts: { checked: 1, unchecked: 2, modified_unconfirmed: 0 },
          items: [
            {
              check_state: "unchecked",
              display_name: "최신 현황 학생",
              member_id: "2",
              student_number: 2,
            },
          ],
          last_reminder_requested_at: null,
          next_cursor: null,
          server_today: "2026-07-14",
        }),
      );
    });

    render(
      <MemoryRouter>
        <SupplyChecksPanel
          category="general"
          contentRevision="1"
          focusOnLoad={false}
          membershipId="membership-1"
          onRefreshContent={onRefreshContent}
          reminderEligible
          supplyId="17"
          title="수학 준비물"
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "준비물 내용이 변경되어 표시 중인 내용과 확인 현황이 맞지 않아요.",
    );
    expect(
      screen.getByRole("button", { name: "최신 현황을 확인한 뒤 다시 알려주기" }),
    ).toBeDisabled();
    expect(screen.getByRole("tab", { name: "미챙김 학생 집계 중" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "최신 내용과 현황 다시 불러오기" }));

    expect(await screen.findByText("최신 현황 학생")).toBeVisible();
    expect(onRefreshContent).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "현재 미해결 2명에게 다시 알려주기" })).toBeEnabled();
  });

  it("invalidates previously loaded counts when a full status refresh fails", async () => {
    let checksRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      checksRequestCount += 1;
      if (checksRequestCount > 1) return Promise.reject(new Error("refresh interrupted"));
      return Promise.resolve(
        jsonResponse({
          content_revision: "1",
          counts: { checked: 1, unchecked: 2, modified_unconfirmed: 0 },
          items: [
            {
              check_state: "unchecked",
              display_name: "처음 불러온 학생",
              member_id: "2",
              student_number: 2,
            },
          ],
          last_reminder_requested_at: null,
          next_cursor: null,
          server_today: "2026-07-14",
        }),
      );
    });

    render(
      <MemoryRouter>
        <SupplyChecksPanel
          category="general"
          contentRevision="1"
          focusOnLoad={false}
          membershipId="membership-1"
          onRefreshContent={async () => "1"}
          reminderEligible
          supplyId="17"
          title="수학 준비물"
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: "현재 미해결 2명에게 다시 알려주기" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "확인 현황 새로고침" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "최신 확인 현황을 불러오지 못했어요.",
    );
    expect(screen.getByRole("tab", { name: "미챙김 학생 집계 중" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "최신 현황을 확인한 뒤 다시 알려주기" }),
    ).toBeDisabled();
    expect(screen.queryByText("처음 불러온 학생")).not.toBeInTheDocument();
  });

  it("keeps a successful reminder result while separating a failed status refresh", async () => {
    let checksRequestCount = 0;
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/supplies/17/checks?state=unchecked") {
        checksRequestCount += 1;
        if (checksRequestCount > 1) {
          return Promise.reject(new Error("refresh interrupted"));
        }
        return Promise.resolve(
          jsonResponse({
            content_revision: "1",
            counts: { checked: 1, unchecked: 2, modified_unconfirmed: 0 },
            items: [
              {
                check_state: "unchecked",
                display_name: "미챙김 학생",
                member_id: "2",
                student_number: 2,
              },
            ],
            last_reminder_requested_at: null,
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      if (url === "/api/v1/supplies/17/reminders" && init?.method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              batch_id: "batch-1",
              cooldown_suppressed_count: 0,
              created_at: "2026-07-24T03:00:00.000Z",
              created_count: 2,
              current_unresolved_count: 2,
              next_available_at: null,
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter>
        <SupplyChecksPanel
          category="general"
          contentRevision="1"
          focusOnLoad={false}
          membershipId="membership-1"
          onRefreshContent={async () => "1"}
          reminderEligible
          supplyId="17"
          title="수학 준비물"
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "현재 미해결 2명에게 다시 알려주기" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "다시 알림",
      }),
    );

    expect(await screen.findByText("앱 내 재알림 등록")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "앱 내 재알림 등록은 완료됐지만 최신 현황을 다시 불러오지 못했어요.",
    );
    expect(screen.getByText("미해결 2명 · 새 등록 2명 · 제한 제외 0명")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "최신 현황을 확인한 뒤 다시 알려주기" }),
    ).toBeDisabled();
    expect(checksRequestCount).toBe(2);
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          requestUrl(input) === "/api/v1/supplies/17/reminders" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });
});
