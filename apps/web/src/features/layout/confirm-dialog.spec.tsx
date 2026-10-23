import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./confirm-dialog";

function DialogHarness({
  onConfirm = () => undefined,
}: {
  onConfirm?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button onClick={() => setOpen(true)} ref={triggerRef} type="button">
        위험 작업 열기
      </button>
      <ConfirmDialog
        confirmLabel="반에서 제외"
        description="학생의 반 접근이 즉시 차단됩니다."
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          onConfirm();
        }}
        open={open}
        returnFocusTo={triggerRef.current}
        title="학생을 반에서 제외할까요?"
      />
    </>
  );
}

function NestedDialogHarness(): React.JSX.Element {
  const [outerOpen, setOuterOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  const outerTriggerRef = useRef<HTMLButtonElement>(null);
  const innerTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button onClick={() => setOuterOpen(true)} ref={outerTriggerRef} type="button">
        바깥 확인 열기
      </button>
      <ConfirmDialog
        confirmLabel="바깥 확인"
        description={
          <button onClick={() => setInnerOpen(true)} ref={innerTriggerRef} type="button">
            안쪽 확인 열기
          </button>
        }
        onCancel={() => setOuterOpen(false)}
        onConfirm={() => setOuterOpen(false)}
        open={outerOpen}
        returnFocusTo={outerTriggerRef.current}
        title="바깥 확인"
      />
      <ConfirmDialog
        cancelLabel="안쪽 취소"
        confirmLabel="안쪽 확인"
        description="가장 위의 확인창만 키보드 입력을 받습니다."
        onCancel={() => setInnerOpen(false)}
        onConfirm={() => setInnerOpen(false)}
        open={innerOpen}
        returnFocusTo={innerTriggerRef.current}
        title="안쪽 확인"
      />
    </>
  );
}

function IsolationStackHarness(): React.JSX.Element {
  const [outerOpen, setOuterOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  const outerTriggerRef = useRef<HTMLButtonElement>(null);
  const innerTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button onClick={() => setOuterOpen(true)} ref={outerTriggerRef} type="button">
        Open outer stack
      </button>
      <ConfirmDialog
        confirmLabel="Close outer"
        description={
          <button onClick={() => setInnerOpen(true)} ref={innerTriggerRef} type="button">
            Open inner stack
          </button>
        }
        onCancel={() => setOuterOpen(false)}
        onConfirm={() => setOuterOpen(false)}
        open={outerOpen}
        returnFocusTo={outerTriggerRef.current}
        title="Outer stack"
      />
      <ConfirmDialog
        confirmLabel="Close inner"
        description="Only the top modal remains interactive."
        onCancel={() => setInnerOpen(false)}
        onConfirm={() => setInnerOpen(false)}
        open={innerOpen}
        returnFocusTo={innerTriggerRef.current}
        title="Inner stack"
      />
    </>
  );
}

function InitiallyOpenDialogHarness(): React.JSX.Element {
  const [open, setOpen] = useState(true);

  return (
    <>
      <main data-testid="safe-main">
        <h1>Application content</h1>
      </main>
      <ConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Continue"
        description="No trigger was available when this modal opened."
        onCancel={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
        open={open}
        title="Initial modal"
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  afterEach(() => {
    document.body.style.overflow = "";
    vi.restoreAllMocks();
  });

  it("connects its accessible name and description, locks scrolling, and focuses cancel", async () => {
    const view = render(<DialogHarness />);
    view.container.id = "root";

    fireEvent.click(screen.getByRole("button", { name: "위험 작업 열기" }));

    const dialog = screen.getByRole("dialog", { name: "학생을 반에서 제외할까요?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("학생의 반 접근이 즉시 차단됩니다.");
    await waitFor(() => expect(screen.getByRole("button", { name: "취소" })).toHaveFocus());
    expect(document.body).toHaveStyle({ overflow: "hidden" });
    expect(view.container).toHaveAttribute("inert");

    view.unmount();
    expect(document.body).not.toHaveStyle({ overflow: "hidden" });
    expect(view.container).not.toHaveAttribute("inert");
  });

  it("traps Tab in both directions and closes with Escape before restoring trigger focus", async () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "위험 작업 열기" });
    fireEvent.click(trigger);

    const cancel = screen.getByRole("button", { name: "취소" });
    const confirm = screen.getByRole("button", { name: "반에서 제외" });
    await waitFor(() => expect(cancel).toHaveFocus());

    confirm.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.body).not.toHaveStyle({ overflow: "hidden" });
  });

  it("recovers programmatic focus that escapes the dialog", async () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "위험 작업 열기" });
    fireEvent.click(trigger);
    const cancel = screen.getByRole("button", { name: "취소" });
    await waitFor(() => expect(cancel).toHaveFocus());

    trigger.focus();
    expect(cancel).toHaveFocus();
  });

  it("keeps shared inert and scroll locks until the last nested dialog closes", async () => {
    const view = render(<NestedDialogHarness />);
    view.container.id = "root";
    const outerTrigger = screen.getByRole("button", { name: "바깥 확인 열기" });
    fireEvent.click(outerTrigger);
    const innerTrigger = await screen.findByRole("button", { name: "안쪽 확인 열기" });
    fireEvent.click(innerTrigger);
    await waitFor(() => expect(screen.getByRole("button", { name: "안쪽 취소" })).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "안쪽 확인" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "바깥 확인" })).toBeInTheDocument();
    await waitFor(() => expect(innerTrigger).toHaveFocus());
    expect(document.body).toHaveStyle({ overflow: "hidden" });
    // 스크롤 막대 자리 색(styles.css html[data-modal-open])도 마지막 창이 닫힐 때까지 유지한다.
    expect(document.documentElement).toHaveAttribute("data-modal-open");
    expect(view.container).toHaveAttribute("inert");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(outerTrigger).toHaveFocus());
    expect(document.body).not.toHaveStyle({ overflow: "hidden" });
    expect(document.documentElement).not.toHaveAttribute("data-modal-open");
    expect(view.container).not.toHaveAttribute("inert");
  });

  it("isolates the top host, observes new body siblings, and restores exact prior attributes", async () => {
    const persistentSibling = document.createElement("div");
    persistentSibling.setAttribute("aria-hidden", "false");
    persistentSibling.setAttribute("inert", "legacy-inert");
    document.body.append(persistentSibling);
    const lateSibling = document.createElement("div");
    lateSibling.setAttribute("aria-hidden", "menu");
    const view = render(<IsolationStackHarness />);
    view.container.id = "root";
    view.container.setAttribute("aria-hidden", "false");

    try {
      fireEvent.click(screen.getByRole("button", { name: "Open outer stack" }));
      const outerDialog = screen.getByRole("dialog", { name: "Outer stack" });
      const outerHost = outerDialog.closest<HTMLElement>('[data-testid="confirm-dialog-backdrop"]');
      if (outerHost === null) throw new Error("Expected the outer modal host");

      fireEvent.click(screen.getByRole("button", { name: "Open inner stack" }));
      const innerDialog = screen.getByRole("dialog", { name: "Inner stack" });
      const innerHost = innerDialog.closest<HTMLElement>('[data-testid="confirm-dialog-backdrop"]');
      if (innerHost === null) throw new Error("Expected the inner modal host");

      expect(outerHost).toHaveAttribute("inert");
      expect(outerHost).toHaveAttribute("aria-hidden", "true");
      expect(innerHost).not.toHaveAttribute("inert");
      expect(innerHost).not.toHaveAttribute("aria-hidden");
      expect(Number(innerHost.style.zIndex)).toBeGreaterThan(Number(outerHost.style.zIndex));

      document.body.append(lateSibling);
      await waitFor(() => expect(lateSibling).toHaveAttribute("inert"));
      expect(lateSibling).toHaveAttribute("aria-hidden", "true");

      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inner stack" })).toBeNull());
      expect(outerHost).not.toHaveAttribute("inert");
      expect(outerHost).not.toHaveAttribute("aria-hidden");
      expect(view.container).toHaveAttribute("inert");
      expect(lateSibling).toHaveAttribute("inert");

      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Outer stack" })).toBeNull());
      expect(view.container).not.toHaveAttribute("inert");
      expect(view.container).toHaveAttribute("aria-hidden", "false");
      expect(persistentSibling).toHaveAttribute("inert", "legacy-inert");
      expect(persistentSibling).toHaveAttribute("aria-hidden", "false");
      expect(lateSibling).not.toHaveAttribute("inert");
      expect(lateSibling).toHaveAttribute("aria-hidden", "menu");
    } finally {
      view.unmount();
      persistentSibling.remove();
      lateSibling.remove();
    }
  });

  it.each([
    ["disabled", (trigger: HTMLButtonElement) => (trigger.disabled = true)],
    ["hidden", (trigger: HTMLButtonElement) => (trigger.hidden = true)],
    ["disconnected", (trigger: HTMLButtonElement) => trigger.remove()],
    [
      "unable to accept focus",
      (trigger: HTMLButtonElement) =>
        vi.spyOn(trigger, "focus").mockImplementation(() => undefined),
    ],
  ])("uses the explicit fallback when the return target is %s", async (_label, invalidate) => {
    const wrapper = document.createElement("div");
    const trigger = document.createElement("button");
    const fallback = document.createElement("button");
    wrapper.append(trigger);
    document.body.append(wrapper, fallback);
    trigger.focus();
    const commonProps = {
      cancelLabel: "Cancel",
      confirmLabel: "Continue",
      description: "Return focus must be verified.",
      fallbackFocusTo: fallback,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      returnFocusTo: trigger,
      title: "Focus return",
    };
    const view = render(<ConfirmDialog {...commonProps} open />);

    try {
      await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
      invalidate(trigger);
      view.rerender(<ConfirmDialog {...commonProps} open={false} />);
      await waitFor(() => expect(fallback).toHaveFocus());
    } finally {
      view.unmount();
      wrapper.remove();
      fallback.remove();
    }
  });

  it("rejects a return target inside an already inert ancestor", async () => {
    const inertWrapper = document.createElement("div");
    const trigger = document.createElement("button");
    const fallback = document.createElement("button");
    inertWrapper.setAttribute("inert", "application-owned");
    inertWrapper.append(trigger);
    document.body.append(inertWrapper, fallback);
    const commonProps = {
      confirmLabel: "Continue",
      description: "An inert target cannot receive restored focus.",
      fallbackFocusTo: fallback,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      returnFocusTo: trigger,
      title: "Inert return target",
    };
    const view = render(<ConfirmDialog {...commonProps} open />);

    try {
      view.rerender(<ConfirmDialog {...commonProps} open={false} />);
      await waitFor(() => expect(fallback).toHaveFocus());
      expect(inertWrapper).toHaveAttribute("inert", "application-owned");
    } finally {
      view.unmount();
      inertWrapper.remove();
      fallback.remove();
    }
  });

  it("falls back to the application main when no return target exists", async () => {
    const view = render(<InitiallyOpenDialogHarness />);
    view.container.id = "root";
    const main = screen.getByTestId("safe-main");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(main).toHaveFocus());
    expect(main).not.toHaveAttribute("tabindex");
    expect(view.container).not.toHaveAttribute("inert");
  });

  it("does not retain stale stack state across StrictMode setup and cleanup", async () => {
    const view = render(
      <StrictMode>
        <DialogHarness />
      </StrictMode>,
    );
    view.container.id = "root";
    const trigger = screen.getByRole("button");

    fireEvent.click(trigger);
    const cancel = screen.getByRole("dialog").querySelector("button");
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(view.container).not.toHaveAttribute("inert");
    expect(view.container).not.toHaveAttribute("aria-hidden");
    expect(document.body).not.toHaveStyle({ overflow: "hidden" });
  });

  it("treats backdrop and cancel as cancellation but only the danger CTA as confirmation", async () => {
    const onConfirm = vi.fn();
    render(<DialogHarness onConfirm={onConfirm} />);
    const trigger = screen.getByRole("button", { name: "위험 작업 열기" });

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    fireEvent.pointerDown(dialog);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId("confirm-dialog-backdrop"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "반에서 제외" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("supports a compact primary confirmation for non-destructive actions", () => {
    render(
      <ConfirmDialog
        confirmLabel="다시 알림"
        confirmTone="primary"
        description="현재 미해결 학생만 앱 안에서 다시 알려요."
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        open
        title="현재 미해결 학생에게 다시 알려줄까요?"
      />,
    );

    const confirm = screen.getByRole("button", { name: "다시 알림" });
    expect(confirm).toHaveClass("ui-button-primary", "whitespace-nowrap");
    expect(confirm).not.toHaveClass("ui-button-danger-solid");
  });
});
