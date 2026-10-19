import { ChevronRight } from "lucide-react";
import type { MouseEvent, Ref } from "react";
import { Link } from "react-router";

import type { ScheduleCalendarItem, ScheduleItem } from "../../api/schedules";
import { HighlightMatch, searchExcerpt } from "../layout/highlight-match";
import { formatScheduleDate, scheduleTypeLabel } from "./schedule-format";
import "./schedule-special.css";

export function scheduleCategory(item: ScheduleCalendarItem | ScheduleItem): string {
  if (!("schedule_type" in item)) return "school";
  const type = item.schedule_type;
  return type === "assignment" ? "task" : type === "other" ? "event" : "exam";
}

export function ScheduleAgendaCard({
  item,
  term,
  state,
  linkRef,
  onClick,
  selected,
}: {
  item: ScheduleCalendarItem | ScheduleItem;
  term?: string | undefined;
  state?: unknown;
  linkRef?: Ref<HTMLAnchorElement>;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  selected?: boolean | undefined;
}): React.JSX.Element {
  const school = "school_day_type" in item ? item : undefined;
  const classItem = "schedule_type" in item ? item : undefined;
  const category = scheduleCategory(item);
  const near = item.days_until >= 0 && item.days_until <= 3;
  const kind = classItem === undefined ? "학교" : scheduleTypeLabel[classItem.schedule_type];
  const subject = classItem?.subject ?? null;
  const content = (
    <>
      <span className={"schedule-agenda-countdown" + (near ? " is-near" : "")}>
        <span>{item.d_day_label ?? item.due_date.slice(5).replace("-", ".")}</span>
        <span className="schedule-agenda-date">
          {item.days_until < 0 ? "지난 일정" : "남은 날"}
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="schedule-kind-chip" data-schedule-kind={category}>
            {kind}
          </span>
          {subject === null ? null : (
            <span className="text-xs font-bold text-app-muted">
              <HighlightMatch text={subject} term={term} />
            </span>
          )}
          {school ? <span className="text-xs text-app-muted">교육청(나이스) 정보</span> : null}
        </span>
        <span className="mt-2 block break-words text-[17px] font-extrabold leading-snug text-app-text">
          <HighlightMatch text={item.title} term={term} />
        </span>
        <time
          className="mt-1 block text-[13px] font-medium text-app-muted"
          dateTime={item.due_date}
        >
          {formatScheduleDate(item.due_date)}
        </time>
        {item.description ? (
          <span
            data-content-excerpt
            className={
              "mt-2 block whitespace-pre-wrap break-words text-sm leading-6 text-app-muted " +
              (term !== undefined && item.description.toLowerCase().includes(term.toLowerCase())
                ? "line-clamp-4"
                : "line-clamp-2")
            }
          >
            <HighlightMatch text={searchExcerpt(item.description, term, 0)} term={term} />
          </span>
        ) : null}
        {school ? (
          <span className="mt-2 block text-xs text-app-muted">
            {school.school_day_type} · {school.target_grades.join(", ")}학년
          </span>
        ) : null}
      </span>
      {school ? null : (
        <ChevronRight aria-hidden className="mt-1 shrink-0 text-app-muted" size={18} />
      )}
    </>
  );
  const className =
    "content-card schedule-agenda-card " + (selected ? "ring-2 ring-[#2b6149]" : "");
  return school ? (
    <article className={className} data-schedule-kind={category}>
      {content}
    </article>
  ) : (
    <Link
      className={className}
      data-content-selected={selected ? "true" : "false"}
      data-schedule-kind={category}
      to={"/schedules/" + item.id}
      state={state}
      ref={linkRef}
      onClick={onClick}
    >
      {content}
    </Link>
  );
}
