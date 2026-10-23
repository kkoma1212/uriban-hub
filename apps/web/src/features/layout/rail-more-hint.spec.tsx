import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RailMoreHint, useRailHasMoreBelow } from "./rail-more-hint";

function Rail({ enabled }: { enabled: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const hasMoreBelow = useRailHasMoreBelow(ref, enabled);
  return (
    <div data-testid="rail" ref={ref}>
      {hasMoreBelow ? <RailMoreHint /> : null}
    </div>
  );
}

// jsdom은 배치를 계산하지 않아 높이·스크롤 위치를 직접 정한다(1366×657에서 181px 모자람).
function measure({ scrollHeight, scrollTop }: { scrollHeight: number; scrollTop: number }): void {
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(500);
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(scrollHeight);
  vi.spyOn(Element.prototype, "scrollTop", "get").mockReturnValue(scrollTop);
}

const hint = (): Element | null => document.querySelector("[data-rail-more-hint]");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rail more hint", () => {
  it("메뉴가 넘치면 보이고, 끝까지 내리면 사라진다", () => {
    measure({ scrollHeight: 681, scrollTop: 0 });
    render(<Rail enabled />);
    expect(hint()).toHaveTextContent("아래에 메뉴가 더 있어요");
    expect(hint()).toHaveAttribute("aria-hidden", "true");

    measure({ scrollHeight: 681, scrollTop: 181 });
    fireEvent.scroll(screen.getByTestId("rail"));
    expect(hint()).toBeNull();
  });

  it("메뉴가 다 보이면 보이지 않는다", () => {
    measure({ scrollHeight: 500, scrollTop: 0 });
    render(<Rail enabled />);
    expect(hint()).toBeNull();
  });

  it("꺼 두면(휴대폰·태블릿 메뉴) 넘쳐도 보이지 않는다", () => {
    measure({ scrollHeight: 681, scrollTop: 0 });
    render(<Rail enabled={false} />);
    expect(hint()).toBeNull();
  });
});
