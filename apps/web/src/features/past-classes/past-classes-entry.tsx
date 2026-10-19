import { ArrowRight, History } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { listPastClasses } from "../../api/past-classes";

/**
 * 지난 반이 있을 때만 보이는 입구. 첫 화면·반 없음 화면에 둔다 —
 * 불러오지 못하면 조용히 숨긴다(오늘 할 일을 가리지 않는다).
 */
export function PastClassesEntry({
  className = "",
}: {
  className?: string;
}): React.JSX.Element | null {
  const [count, setCount] = useState<number>();
  useEffect(() => {
    let active = true;
    listPastClasses()
      .then((items) => {
        if (active) setCount(items.length);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (count === undefined || count === 0) return null;
  return (
    <Link
      className={`group flex min-h-14 items-center gap-3 rounded-card border border-app-border bg-app-surface px-4 py-3 text-app-text shadow-sm transition hover:border-role-border hover:bg-role-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2 ${className}`}
      data-past-classes-entry
      to="/past-classes"
    >
      <History aria-hidden="true" className="shrink-0 text-role-primary" size={20} />
      <span className="min-w-0 flex-1">
        <strong className="block text-sm font-extrabold">지난 반 기록</strong>
        <span className="block text-xs text-app-muted">
          지난 반 {count}개의 소식을 다시 볼 수 있어요.
        </span>
      </span>
      <ArrowRight aria-hidden="true" className="shrink-0 text-app-muted" size={18} />
    </Link>
  );
}
