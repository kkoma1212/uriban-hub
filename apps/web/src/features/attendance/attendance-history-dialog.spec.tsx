import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AttendanceHistoryItem,
  AttendanceNotificationType,
} from "../../api/attendance-notifications";
import { AttendanceHistoryDialog } from "./attendance-history-dialog";

const history: AttendanceHistoryItem[] = [
  {
    expected_time: null,
    notification_date: "2026-08-28",
    notification_type: "absent",
    status: "acknowledged",
  },
  {
    expected_time: null,
    notification_date: "2026-08-30",
    notification_type: "absent",
    status: "pending",
  },
  {
    expected_time: "09:10",
    notification_date: "2026-08-29",
    notification_type: "late",
    status: "pending",
  },
];

function AttendanceDialogHarness(): React.JSX.Element {
  const [type, setType] = useState<AttendanceNotificationType>();
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button onClick={() => setType("absent")} ref={triggerRef} type="button">
        결석 기록 열기
      </button>
      <button type="button">배경 작업</button>
      <AttendanceHistoryDialog
        items={history}
        onClose={() => setType(undefined)}
        open={type !== undefined}
        returnFocusTo={triggerRef.current}
        type={type}
      />
    </>
  );
}

describe("AttendanceHistoryDialog", () => {
  afterEach(() => {
    document.body.style.overflow = "";
  });

  it("uses a labelled modal portal, locks the app, and keeps every focus path inside", async () => {
    const view = render(<AttendanceDialogHarness />);
    view.container.id = "root";
    const trigger = screen.getByRole("button", { name: "결석 기록 열기" });
    const backgroundAction = screen.getByRole("button", { name: "배경 작업" });

    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "결석 2회" });
    const close = within(dialog).getByRole("button", { name: "닫기" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(view.container).not.toContainElement(dialog);
    expect(view.container).toHaveAttribute("inert");
    expect(document.body).toHaveStyle({ overflow: "hidden" });
    expect(
      within(dialog)
        .getAllByRole("time")
        .map((item) => item.getAttribute("datetime")),
    ).toEqual(["2026-08-30", "2026-08-28"]);
    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();

    backgroundAction.focus();
    expect(close).toHaveFocus();
  });

  it("closes from Escape, overlay, or close and restores the exact trigger without stale locks", async () => {
    const view = render(<AttendanceDialogHarness />);
    view.container.id = "root";
    const trigger = screen.getByRole("button", { name: "결석 기록 열기" });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(view.container).not.toHaveAttribute("inert");
    expect(document.body).not.toHaveStyle({ overflow: "hidden" });

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    const backdrop = document.querySelector<HTMLElement>("[data-attendance-history-dialog]");
    if (backdrop === null) throw new Error("Attendance history backdrop is missing");
    fireEvent.pointerDown(dialog);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.pointerDown(backdrop);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    expect(view.container).toHaveAttribute("inert");
    view.unmount();
    expect(document.body).not.toHaveStyle({ overflow: "hidden" });
  });
});
