import { ChevronDown } from "lucide-react";
import { useLayoutEffect, useState, type RefObject } from "react";

/*
 * 1366×768 노트북(브라우저 안쪽 높이 약 657px)에서 교사 메뉴 아래쪽 '반 대화·급식·반 관리'가
 * 가려져도 메뉴 안을 내려야 한다는 티가 나지 않았다(2026-10-21 첫 사용 점검 5). 학생 메뉴도
 * 같은 높이에서 147px 넘쳐 함께 쓴다(2026-10-22 사용자 결정).
 * 메뉴가 넘치고 아직 끝까지 내리지 않았을 때만 아래쪽에 안내를 겹쳐 보인다.
 */
export function useRailHasMoreBelow(
  scrollerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): boolean {
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!enabled || scroller === null) return;
    const update = (): void => {
      // 끝까지 내려도 소수점 픽셀 반올림으로 1px이 남을 수 있어 2px 여유를 둔다.
      setHasMoreBelow(scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    // 창 높이(메뉴 칸)와 메뉴 항목 수(내용 높이)가 바뀔 때 모두 다시 잰다.
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    if (observer !== undefined) {
      observer.observe(scroller);
      for (const child of scroller.children) observer.observe(child);
    }
    return () => {
      scroller.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [enabled, scrollerRef]);
  return enabled && hasMoreBelow;
}

/** 보이는 안내일 뿐이다. 메뉴 링크는 그대로 키보드·화면 읽기 프로그램으로 닿는다. */
export function RailMoreHint(): React.JSX.Element {
  return (
    <div aria-hidden="true" className="app-rail-more-hint" data-rail-more-hint="true">
      <ChevronDown size={14} strokeWidth={2.5} />
      아래에 메뉴가 더 있어요
    </div>
  );
}
