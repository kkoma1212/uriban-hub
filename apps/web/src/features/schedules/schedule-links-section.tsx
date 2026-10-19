import { Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { getScheduleLinks, type ScheduleLinks } from "../../api/schedules";
import { formatScheduleDate } from "./schedule-format";

/** 일정에 연결된 공지·준비물. 연결이 없으면 카드째 그리지 않는다 — 빈 흰 카드가 남던 문제(2026-10-04 화면 검수). */
const asideCardClass =
  "h-full min-w-0 rounded-[1.25rem] border border-app-border bg-app-surface p-[18px] shadow-card lg:p-6";

export function ScheduleLinksSection({
  scheduleId,
  version,
}: {
  scheduleId: string;
  version: string;
}): React.JSX.Element | null {
  const [links, setLinks] = useState<ScheduleLinks>(),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    getScheduleLinks(scheduleId)
      .then((result) => {
        if (active) setLinks(result);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [scheduleId, version]);

  if (failed)
    return (
      <section className={asideCardClass}>
        <p className="break-keep text-sm text-app-muted" role="status">
          관련 안내를 불러오지 못했어요. 공지·준비물 화면에서 확인해 주세요.
        </p>
      </section>
    );
  if (links === undefined || links.notices.length + links.supplies.length === 0) return null;
  return (
    <section aria-labelledby="schedule-links-heading" className={asideCardClass}>
      <h2
        className="flex items-center gap-2 text-sm font-bold text-app-muted"
        id="schedule-links-heading"
      >
        <Link2 aria-hidden="true" size={16} />
        관련 안내
      </h2>
      <ul className="mt-3 grid gap-2">
        {links.notices.map((notice) => (
          <li key={`notice:${notice.id}`}>
            <Link
              className="block rounded-xl border border-app-border p-3 hover:bg-app-surface-muted"
              to={`/notices/${notice.id}`}
            >
              <span className="text-xs font-bold text-role-primary">
                {notice.is_important ? "중요 공지" : "공지"}
              </span>
              <span className="mt-1 block break-words font-bold text-app-text">{notice.title}</span>
            </Link>
          </li>
        ))}
        {links.supplies.map((supply) => (
          <li key={`supply:${supply.id}`}>
            <Link
              className="block rounded-xl border border-app-border p-3 hover:bg-app-surface-muted"
              to={`/supplies/${supply.id}`}
            >
              <span className="text-xs font-bold text-role-primary">
                {supply.category === "homework" ? "숙제" : "준비물"} ·{" "}
                {formatScheduleDate(supply.needed_on)}
              </span>
              <span className="mt-1 block break-words font-bold text-app-text">{supply.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
