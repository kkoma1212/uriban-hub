import { useEffect, useId, useState } from "react";
import { Link } from "react-router";

import {
  helpRequestKindLabel,
  listHelpRequests,
  type HelpRequestItem,
} from "../../api/help-requests";

const PAST_LIMIT = 5;

/**
 * 끝난 질문(선생님 답 포함)을 학생이 다시 열 수 있게 '선생님께 물어보기' 아래에 최근 대화를 보여
 * 준다(총검수 B2-02, 2026-10-03 사용자 결정). 서버는 학생 본인 대화만 돌려준다. 새 질문 쓰기가
 * 이 화면의 본 기능이라, 목록을 못 불러오면 오류 대신 목록을 숨긴다.
 */
export function PastHelpRequests(): React.JSX.Element | null {
  const [items, setItems] = useState<HelpRequestItem[]>();
  const titleId = useId();
  useEffect(() => {
    let active = true;
    listHelpRequests("all").then(
      (all) => {
        if (!active) return;
        setItems(
          all
            .filter((item) => item.status !== "open")
            .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at))
            .slice(0, PAST_LIMIT),
        );
      },
      () => {
        if (active) setItems([]);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  if (items === undefined || items.length === 0) return null;
  return (
    <section aria-labelledby={titleId} className="content-card mt-4" data-past-help-requests>
      <h2 className="text-base font-extrabold text-app-text" id={titleId}>
        지난 질문
      </h2>
      <ul className="mt-2 grid gap-2">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              className="block min-h-11 rounded-xl bg-app-surface-muted p-3 text-app-text"
              to={"/help-requests/" + item.id}
            >
              <span className="flex min-w-0 items-start justify-between gap-2">
                <span className="min-w-0 truncate text-[15px] font-bold">
                  {item.target?.title ?? helpRequestKindLabel[item.kind]}
                </span>
                {/* 일반 질문은 제목이 같아 날짜로 구분한다(목록에는 질문 본문이 없다). */}
                <span className="shrink-0 text-xs font-bold text-app-muted">
                  {item.status === "resolved" ? "끝남" : "철회"} ·{" "}
                  {new Date(item.last_activity_at).toLocaleDateString("ko-KR", {
                    day: "numeric",
                    month: "long",
                    timeZone: "Asia/Seoul",
                  })}
                </span>
              </span>
              {item.reply ? (
                <span className="mt-1 block truncate text-sm text-app-muted">
                  선생님 답: {item.reply}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
