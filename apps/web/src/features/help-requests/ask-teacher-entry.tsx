import { ChevronRight, MessagesSquare } from "lucide-react";
import { Link } from "react-router";

/** 학생 홈의 '선생님께 물어보기' 입구(T-HELP-CHAT). 공지·숙제와 무관한 질문을 담임에게 보낸다. */
export function AskTeacherEntry({ compact = false }: { compact?: boolean }): React.JSX.Element {
  return (
    <Link
      className={`group flex ${compact ? "min-h-11" : "min-h-14"} items-center gap-3 rounded-card border border-app-border bg-app-surface px-4 py-3 text-app-text shadow-sm transition hover:border-role-border hover:bg-role-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2`}
      data-ask-teacher-entry
      to="/help-requests/ask"
    >
      <MessagesSquare aria-hidden="true" className="shrink-0 text-role-primary" size={20} />
      <span className="min-w-0 flex-1">
        <strong className="block text-sm font-extrabold">선생님께 물어보기</strong>
        {compact ? null : (
          <span className="block text-xs text-app-muted">
            궁금한 걸 담임 선생님께 보내요. 선생님만 볼 수 있어요.
          </span>
        )}
      </span>
      <ChevronRight aria-hidden="true" className="shrink-0 text-role-primary" size={18} />
    </Link>
  );
}
