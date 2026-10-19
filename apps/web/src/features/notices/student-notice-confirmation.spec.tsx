import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StudentNoticeConfirmation } from "./student-notice-confirmation";

describe("StudentNoticeConfirmation", () => {
  it.each([
    { state: "unread", label: "공지 확인하기", enabled: true },
    { state: "modified_unconfirmed", label: "최신 내용 다시 확인", enabled: true },
    { state: "confirmed", label: "확인했어요", enabled: false },
  ] as const)("shows the actual compact action for $state", ({ state, label, enabled }) => {
    const onConfirm = vi.fn();
    render(<StudentNoticeConfirmation busy={false} compact onConfirm={onConfirm} state={state} />);
    const button = screen.getByRole("button", { name: label });
    expect(button).toHaveTextContent(label);
    expect(button).toHaveProperty("disabled", !enabled);
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });

  it("shows progress and prevents repeated compact confirmation", () => {
    const onConfirm = vi.fn();
    render(<StudentNoticeConfirmation busy compact onConfirm={onConfirm} state="unread" />);
    const button = screen.getByRole("button", { name: "공지 확인하기" });
    expect(button).toHaveTextContent("확인하는 중…");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it.each([
    {
      buttonLabel: "공지 확인하기",
      enabled: true,
      explanation:
        "내용을 읽은 뒤 눌러 주세요. 누르면 선생님께 확인으로 표시되고 되돌릴 수 없어요.",
      state: "unread",
    },
    {
      buttonLabel: "최신 내용 다시 확인",
      enabled: true,
      explanation: "선생님이 내용을 고쳤어요. 최신 내용을 읽고 다시 눌러 주세요.",
      state: "modified_unconfirmed",
    },
    {
      buttonLabel: "확인했어요",
      enabled: false,
      explanation: "선생님께 확인 완료로 표시됐어요.",
      state: "confirmed",
    },
  ] as const)(
    "explains the teacher-visible result and lack of cancellation for $state",
    ({ buttonLabel, enabled, explanation, state }) => {
      const onConfirm = vi.fn();
      const { container } = render(
        <StudentNoticeConfirmation
          busy={false}
          onConfirm={onConfirm}
          state={state}
          tone="important"
        />,
      );

      expect(screen.getByText(explanation)).toBeVisible();
      expect(container.querySelector('[data-notice-surface="student-confirmation"]')).toHaveClass(
        "rounded-card",
        "border-home-important-line",
        "bg-home-important-soft",
      );
      const button = screen.getByRole("button", { name: buttonLabel });
      expect(button).toHaveProperty("disabled", !enabled);
      fireEvent.click(button);
      expect(onConfirm).toHaveBeenCalledTimes(enabled ? 1 : 0);
    },
  );

  it("uses the role surface for a regular notice", () => {
    const { container } = render(
      <StudentNoticeConfirmation
        busy={false}
        onConfirm={vi.fn()}
        state="confirmed"
        tone="latest"
      />,
    );

    expect(container.querySelector('[data-notice-surface="student-confirmation"]')).toHaveClass(
      "rounded-card",
      "border-role-border",
      "bg-role-soft",
    );
  });
});
