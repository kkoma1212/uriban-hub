import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";

import { ContentInputFrame, ContentInputReview } from "./content-input-frame";

describe("ContentInputFrame", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("keeps the action dock above a resized visual viewport and removes listeners on unmount", async () => {
    const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
    const remove = vi.spyOn(viewport, "removeEventListener");
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 16,
      y: 72,
      left: 16,
      top: 72,
      right: 344,
      bottom: 800,
      width: 328,
      height: 728,
      toJSON: () => ({}),
    });
    const view = render(
      <ContentInputFrame
        data-testid="frame"
        actions={<button type="submit">올리기</button>}
        preview={<p>읽기 전용 미리보기</p>}
      >
        <textarea aria-label="메모" />
      </ContentInputFrame>,
    );
    const frame = screen.getByTestId("frame");
    expect(frame.style.getPropertyValue("--input-available-height")).toBe("720px");
    expect(frame.style.getPropertyValue("--input-keyboard-bottom")).toBe("0px");
    viewport.height = 460;
    viewport.dispatchEvent(new Event("resize"));
    await waitFor(() =>
      expect(frame.style.getPropertyValue("--input-keyboard-bottom")).toBe("340px"),
    );
    expect(frame.style.getPropertyValue("--input-available-height")).toBe("380px");
    expect(frame).toHaveAttribute("data-keyboard-open", "true");
    expect(screen.getByRole("button", { name: "올리기" })).toBeInTheDocument();
    view.unmount();
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
  it("isolates the final review and restores focus without submitting when dismissed", () => {
    const confirm = vi.fn();
    function Example() {
      const [open, setOpen] = useState(false);
      const trigger = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button onClick={() => setOpen(true)} ref={trigger} type="button">
            게시 전 확인
          </button>
          <ContentInputReview
            open={open}
            title="게시 전 검토"
            onCancel={() => setOpen(false)}
            onConfirm={confirm}
            returnFocusTo={trigger.current}
          >
            <p>읽기 전용 게시 내용</p>
          </ContentInputReview>
        </>
      );
    }
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "게시 전 확인" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "게시 전 검토" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(screen.getByRole("button", { name: "더 고치기" })).toHaveFocus();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(confirm).not.toHaveBeenCalled();
  });
});
