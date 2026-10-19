import type { ReactNode } from "react";

// 홈을 처음 열어도 공통 제목 줄 스타일이 함께 불려 오게 한다(다른 탭은 content-frame.tsx가 불러옴).
import "../layout/content-frame.css";

export function HomeTopbar({
  children,
  className,
  role,
}: {
  children: ReactNode;
  className: string | undefined;
  role: "student" | "teacher";
}): React.JSX.Element {
  const resolvedClassName = className?.trim() || "우리 반";

  return (
    // 다른 8개 탭의 공통 제목 줄(content-frame-heading)과 같은 글자 크기·줄 높이·시작선을 쓴다.
    // 로고는 왼쪽 메뉴(PC)·앱 아이콘에 있으므로 제목 앞에 따로 두지 않는다(2026-09-28 사용자 요청).
    <div className="content-frame-heading min-h-12">
      <div className="flex min-w-0 items-center" data-home-wordmark>
        <h1>우리반 허브</h1>
        <span className="sr-only">{role === "teacher" ? "선생님 홈" : "학생 홈"}</span>
      </div>
      <div
        aria-label="홈 상단 메뉴"
        className="content-frame-tools min-w-0 w-full max-w-full flex-wrap sm:w-auto"
        data-home-toolbar
        role="group"
      >
        {/* 여러 반 전환이 지원되기 전까지 현재 반만 표시한다. 눌러도 열리는 것이 없어 펼치기 화살표는
            두지 않는다(총검수 B1-11·B2-08). */}
        <span
          aria-label={`현재 반: ${resolvedClassName}`}
          className="inline-flex min-h-11 min-w-0 w-full max-w-full items-center gap-1 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-sm font-bold text-app-text sm:w-auto sm:max-w-64"
          data-home-class-name
        >
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{resolvedClassName}</span>
        </span>
        {children}
      </div>
    </div>
  );
}
