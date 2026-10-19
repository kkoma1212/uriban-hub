import { Bell } from "lucide-react";
import { Link } from "react-router";

/**
 * 시안 머리의 알림 종(2026-09-27 사용자: 모양만). 알림함이 아직 없어서, 누르면 가장 가까운
 * 곳인 우리반 소식으로 간다 — 눌러도 아무 일 없는 버튼을 두지 않기 위해서다.
 */
export function NewsBellLink(): React.JSX.Element {
  return (
    <Link
      aria-label="우리반 소식 보기"
      className="ui-icon-button ui-button-secondary size-11 min-h-11 min-w-11"
      data-home-news-bell
      to="/updates"
    >
      <Bell aria-hidden="true" size={17} />
    </Link>
  );
}
