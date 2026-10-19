import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../../api/auth";
import type { InAppReminderCreateResponse } from "../../api/in-app-reminders";
import { TeacherReminderAction } from "./teacher-reminder-action";

const result: InAppReminderCreateResponse = {
  batch_id: "batch-1",
  cooldown_suppressed_count: 1,
  created_at: "2026-07-24T03:00:00.000Z",
  created_count: 2,
  current_unresolved_count: 3,
  next_available_at: "2026-07-25T03:00:00.000Z",
};

type CreateReminder = (
  contentRevision: string,
  idempotencyKey: string,
) => Promise<InAppReminderCreateResponse>;

interface ActionOptions {
  contentRevision?: string;
  lastRequestedAt?: string | null;
  onRegistered?: (created: InAppReminderCreateResponse, contentRevision: string) => void;
  statusVerified?: boolean;
  unresolvedCount?: number;
}

function actionNode(onCreate: CreateReminder, options: ActionOptions = {}): React.JSX.Element {
  return (
    <MemoryRouter>
      <TeacherReminderAction
        contentRevision={options.contentRevision ?? "7"}
        lastRequestedAt={
          options.lastRequestedAt === undefined
            ? "2026-07-23T03:00:00.000Z"
            : options.lastRequestedAt
        }
        membershipId="membership-1"
        onCreate={onCreate}
        onRegistered={options.onRegistered ?? vi.fn()}
        resourceId="notice-1"
        resourceLabel="공지"
        resourceType="notice"
        {...(options.statusVerified === undefined
          ? {}
          : { statusVerified: options.statusVerified })}
        title="현장 체험학습 안내"
        unresolvedCount={options.unresolvedCount ?? 3}
      />
    </MemoryRouter>
  );
}

function renderAction(
  onCreate: CreateReminder,
  options: ActionOptions = {},
): ReturnType<typeof render> {
  return render(actionNode(onCreate, options));
}

describe("TeacherReminderAction", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps the action visible but blocks a new request while the status is unverified", () => {
    const onCreate = vi.fn();
    renderAction(onCreate, { statusVerified: false });

    expect(screen.getByText("현재 현황을 다시 확인해 주세요")).toBeVisible();
    expect(
      screen.getByText("최신 내용과 학생 현황을 불러오기 전에는 새 요청을 등록할 수 없어요."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "최신 현황을 확인한 뒤 다시 알려주기" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "최신 현황을 확인한 뒤 다시 알려주기" }));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("cancels with focus return and registers at most once after a fast double confirm", async () => {
    let resolveCreate: ((value: InAppReminderCreateResponse) => void) | undefined;
    const onCreate = vi.fn(
      () =>
        new Promise<InAppReminderCreateResponse>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    renderAction(onCreate);

    const trigger = screen.getByRole("button", {
      name: "현재 미해결 3명에게 다시 알려주기",
    });
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    expect(status).toHaveClass("sr-only");
    expect(screen.queryByText("지금은 7번째 내용")).not.toBeInTheDocument();
    expect(screen.getByText(/이메일·문자·푸시 없이 앱 안에서만 알려요 · 최근 요청/u)).toBeVisible();
    fireEvent.click(trigger);
    const firstDialog = screen.getByRole("dialog", {
      name: "현재 미해결 3명에게 다시 알려줄까요?",
    });
    expect(within(firstDialog).getByRole("button", { name: "취소" })).toHaveFocus();
    fireEvent.click(within(firstDialog).getByRole("button", { name: "취소" }));
    expect(trigger).toHaveFocus();
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    const confirm = within(
      screen.getByRole("dialog", {
        name: "현재 미해결 3명에게 다시 알려줄까요?",
      }),
    ).getByRole("button", { name: "다시 알림" });
    expect(confirm).toHaveClass("ui-button-primary", "whitespace-nowrap");
    expect(confirm).not.toHaveClass("ui-button-danger-solid");
    expect(screen.getByText("7번째 내용")).toBeVisible();
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith("7", expect.any(String));

    resolveCreate?.(result);
    expect(await screen.findByText("앱 내 재알림 등록")).toBeVisible();
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("data-reminder-result", "notice");
    expect(status).toHaveClass("border-t");
    expect(status).not.toHaveClass("sr-only");
    expect(status).not.toHaveClass("rounded-xl", "border-emerald-200", "bg-white");
    expect(status.querySelectorAll('[aria-live], [role="status"]')).toHaveLength(0);
    expect(within(status).getByText("앱 내 재알림 등록")).toBeVisible();
    expect(within(status).getByText("미해결 3명 · 새 등록 2명 · 제한 제외 1명")).toBeVisible();
    expect(within(status).getByText(/다음 등록 가능.*7월 25일.*12:00/u)).toBeVisible();
    expect(screen.queryByText("등록할 때 7번째 내용")).not.toBeInTheDocument();
  });

  it("reuses the same idempotency key when an unknown outcome is retried", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network interrupted"))
      .mockResolvedValueOnce(result);
    renderAction(onCreate);

    fireEvent.click(screen.getByRole("button", { name: "현재 미해결 3명에게 다시 알려주기" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "다시 알림",
      }),
    );
    const retryButton = await screen.findByRole("button", { name: "등록 결과 다시 확인" });
    expect(retryButton).toBeVisible();
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");
    fireEvent.click(retryButton);
    expect(await screen.findByText("앱 내 재알림 등록")).toBeVisible();

    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate.mock.calls[0]?.[1]).toBe(onCreate.mock.calls[1]?.[1]);
  });

  it("clears a successful result when the current content revision changes", async () => {
    const onCreate = vi.fn().mockResolvedValue(result);
    const view = renderAction(onCreate);

    fireEvent.click(screen.getByRole("button", { name: "현재 미해결 3명에게 다시 알려주기" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "다시 알림",
      }),
    );
    expect(await screen.findByText("앱 내 재알림 등록")).toBeVisible();

    view.rerender(
      actionNode(onCreate, {
        contentRevision: "8",
        lastRequestedAt: null,
        unresolvedCount: 2,
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText("앱 내 재알림 등록")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("지금은 8번째 내용")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "현재 미해결 2명에게 다시 알려주기" })).toBeEnabled();
    expect(screen.getByText(/앱 안에서만 알려요 · 아직 요청 없음/u)).toBeVisible();
  });

  it("replays the stored revision and key after the page revision changes and the current count reaches zero", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network interrupted"))
      .mockResolvedValueOnce(result);
    const onRegistered = vi.fn();
    const first = renderAction(onCreate, {
      contentRevision: "7",
      onRegistered,
      unresolvedCount: 3,
    });

    fireEvent.click(screen.getByRole("button", { name: "현재 미해결 3명에게 다시 알려주기" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "다시 알림",
      }),
    );
    expect(await screen.findByRole("button", { name: "등록 결과 다시 확인" })).toBeVisible();
    const originalKey = onCreate.mock.calls[0]?.[1];
    expect(window.sessionStorage.length).toBe(1);

    first.unmount();
    renderAction(onCreate, {
      contentRevision: "8",
      lastRequestedAt: null,
      onRegistered,
      unresolvedCount: 0,
    });

    const retry = await screen.findByRole("button", { name: "등록 결과 다시 확인" });
    expect(retry).toBeEnabled();
    expect(screen.getByText("지금은 8번째 내용")).toBeVisible();
    expect(screen.getByText(/결과를 다시 확인할 요청 · 7번째 내용/u)).toBeVisible();
    fireEvent.click(retry);

    expect(await screen.findByText("앱 내 재알림 등록")).toBeVisible();
    const status = screen.getByRole("status");
    expect(within(status).getByText("앱 내 재알림 등록")).toBeVisible();
    expect(within(status).getByText(/등록할 때 7번째 내용 · 지금은 8번째 내용/u)).toBeVisible();
    expect(screen.getByText(/앱 안에서만 알려요 · 아직 요청 없음/u)).toBeVisible();
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate.mock.calls.map(([revision]) => revision)).toEqual(["7", "7"]);
    expect(onCreate.mock.calls[1]?.[1]).toBe(originalKey);
    expect(onRegistered).toHaveBeenCalledWith(result, "7");
    expect(window.sessionStorage.length).toBe(0);
  });

  it("keeps a deterministic failed replay visible when the current unresolved count is zero", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network interrupted"))
      .mockRejectedValueOnce(
        new ApiRequestError(
          "CONTENT_REVISION_CHANGED",
          "내용이 변경되었습니다. 최신 내용을 확인한 뒤 다시 요청해 주세요.",
          409,
        ),
      );
    const first = renderAction(onCreate, {
      contentRevision: "7",
      unresolvedCount: 3,
    });

    fireEvent.click(screen.getByRole("button", { name: "현재 미해결 3명에게 다시 알려주기" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "다시 알림",
      }),
    );
    expect(await screen.findByRole("button", { name: "등록 결과 다시 확인" })).toBeVisible();

    first.unmount();
    renderAction(onCreate, {
      contentRevision: "8",
      lastRequestedAt: null,
      unresolvedCount: 0,
    });
    fireEvent.click(await screen.findByRole("button", { name: "등록 결과 다시 확인" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "내용이 변경되었습니다. 최신 내용을 확인한 뒤 다시 요청해 주세요.",
    );
    expect(
      screen.getByRole("button", { name: "현재 미해결 0명에게 다시 알려주기" }),
    ).toBeDisabled();
    expect(screen.queryByText("앱 내 재알림 등록")).not.toBeInTheDocument();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("distinguishes the business cooldown from a technical actor rate limit", async () => {
    const cooldownCreate = vi.fn().mockRejectedValue(
      new ApiRequestError("REMINDER_COOLDOWN_ACTIVE", "서버 제한 안내", 429, {
        next_available_at: "2026-07-25T03:00:00.000Z",
      }),
    );
    const first = renderAction(cooldownCreate);
    fireEvent.click(screen.getByRole("button", { name: "현재 미해결 3명에게 다시 알려주기" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "다시 알림",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /학생별 24시간 제한 중이에요.*7월 25일.*12:00부터/u,
    );

    first.unmount();
    window.sessionStorage.clear();
    const rateLimitedCreate = vi
      .fn()
      .mockRejectedValue(new ApiRequestError("RATE_LIMITED", "잠시 후 다시 시도해 주세요.", 429));
    renderAction(rateLimitedCreate);
    fireEvent.click(screen.getByRole("button", { name: "현재 미해결 3명에게 다시 알려주기" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "다시 알림",
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("잠시 후 다시 시도해 주세요.");
    });
    expect(screen.getByRole("alert")).not.toHaveTextContent("학생별 24시간 제한 중이에요");
  });

  it.each([360, 390, 1440])(
    "keeps the reminder action and confirmation reachable at %ipx",
    (width) => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      renderAction(vi.fn().mockResolvedValue(result));

      const section = document.querySelector('[data-reminder-action="notice"]');
      expect(section).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "현재 미해결 3명에게 다시 알려주기" }));
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(
        within(screen.getByRole("dialog")).getByRole("button", { name: "취소" }),
      ).toHaveFocus();
    },
  );
});
