import { ChevronRight } from "lucide-react";
import { Link } from "react-router";

import type { HomeResponse } from "../../api/auth";
import { formatKstCalendarDate } from "../../lib/kst-format";
import { neededOnLabel } from "./chalkboard";

/*
 * 2026-09-27 확정 시안의 '우리반 소식' 흐름(홈 칠판 아래). 공지는 최근 것부터, 준비물·숙제는
 * 필요한 날이 가까운 것부터 이어 보여 준다. 학생은 내 확인 상태, 선생님은 확인 인원 막대.
 * 확인·체크 자체는 글을 열어서 한다(2026-09-27 사용자 결정: 카드에서 바로 확인 없음).
 */

const FEED_LIMIT = 8;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 게시 시각(UTC)을 한국 날짜(YYYY-MM-DD)로 — 그대로 자르면 오전 9시 전 글이 하루 앞당겨진다. */
function kstDate(timestamp: string): string {
  return new Date(Date.parse(timestamp) + KST_OFFSET_MS).toISOString().slice(0, 10);
}

type Role = "student" | "teacher";
type Counts = { done: number; total: number };

interface FeedItem {
  changed: boolean;
  /** 선생님이 다시 확인을 요청한 글(학생). */
  reminded: boolean;
  counts: Counts | null;
  done: boolean | null;
  important: boolean;
  key: string;
  kind: string;
  meta: string;
  title: string;
  to: string;
}

function followupCounts(home: HomeResponse): Map<string, Counts> {
  const followups = home.teacher_followups;
  const map = new Map<string, Counts>();
  if (followups === null || followups === undefined || followups.status === "error") return map;
  for (const item of followups.data) {
    const counts = item.counts as Record<string, number>;
    const done = "confirmed" in counts ? (counts.confirmed ?? 0) : (counts.checked ?? 0);
    const open = "unread" in counts ? (counts.unread ?? 0) : (counts.unchecked ?? 0);
    const type = "needed_on" in item ? "supply" : "notice";
    map.set(`${type}-${item.resource_id}`, {
      done,
      total: done + open + (counts.modified_unconfirmed ?? 0),
    });
  }
  return map;
}

/**
 * 불러오지 못한 묶음의 이름(옛 '해야 할 일' 흐름이 보여 주던 실패 안내를 이어받는다).
 * 서버 오류 문구는 그대로 싣지 않는다 — 내부 사정이 섞일 수 있어 정해진 이름만 보여 준다.
 */
export function homeFeedErrors(home: HomeResponse, role: Role): string[] {
  const groups: Array<[string, { status: string } | null | undefined]> = [
    ["공지", home.notices],
    ["준비물·숙제", home.supplies],
    ...(role === "student"
      ? ([
          ["다시 확인 요청", home.reminders],
          ["투표", home.polls],
        ] as Array<[string, { status: string } | undefined]>)
      : [["확인 현황", home.teacher_followups] as [string, { status: string } | null]]),
  ];
  return groups.flatMap(([label, group]) => (group?.status === "error" ? [label] : []));
}

export function homeFeedItems(home: HomeResponse, role: Role): FeedItem[] {
  const notices = home.notices.status === "error" ? [] : home.notices.data;
  const supplies = home.supplies.status === "error" ? [] : home.supplies.data;
  const reminders =
    role === "student" && home.reminders.status !== "error" ? home.reminders.data : [];
  const reminded = new Set(reminders.map((item) => `${item.reminder_type}-${item.resource_id}`));
  const counts = role === "teacher" ? followupCounts(home) : new Map<string, Counts>();
  // 학생: 아직 안 한 투표·선거를 맨 앞에(옛 '그다음 한 가지'의 투표 안내를 이어받는다).
  const polls =
    role === "student" && home.polls !== undefined && home.polls.status !== "error"
      ? home.polls.data
          .filter((poll) => !poll.has_voted)
          .map<FeedItem>((poll) => ({
            changed: false,
            counts: null,
            done: false,
            important: false,
            key: `poll-${poll.id}`,
            kind: poll.kind === "election" ? "선거" : "투표",
            meta:
              poll.closes_at === null
                ? "마감 없음"
                : `${formatKstCalendarDate(kstDate(poll.closes_at))} 마감`,
            reminded: false,
            title: poll.title,
            to: poll.kind === "election" ? "/elections" : `/polls/${poll.id}`,
          }))
      : [];
  const noticeItems = [...notices]
    .sort((a, b) => b.published_at.localeCompare(a.published_at))
    .map<FeedItem>((notice) => ({
      changed: notice.confirmation_state === "modified_unconfirmed",
      counts: counts.get(`notice-${notice.id}`) ?? null,
      done: role === "student" ? notice.confirmation_state === "confirmed" : null,
      important: notice.is_important,
      key: `notice-${notice.id}`,
      reminded: reminded.has(`notice-${notice.id}`),
      kind: "공지",
      meta: formatKstCalendarDate(kstDate(notice.published_at)),
      title: notice.title,
      to: `/notices/${notice.id}`,
    }));
  const supplyItems = [...supplies]
    .sort((a, b) => a.needed_on.localeCompare(b.needed_on))
    .map<FeedItem>((supply) => ({
      changed: supply.check_state === "modified_unconfirmed",
      counts: counts.get(`supply-${supply.id}`) ?? null,
      done: role === "student" ? supply.check_state === "checked" : null,
      important: false,
      key: `supply-${supply.id}`,
      reminded: reminded.has(`supply-${supply.id}`),
      kind: supply.category === "homework" ? "숙제" : "준비물",
      meta: `${formatKstCalendarDate(supply.needed_on)} · ${neededOnLabel(supply.needed_on, home.server_today)}`,
      title: supply.title,
      to: `/supplies/${supply.id}`,
    }));
  // 재알림 받은 글이 목록에 없으면(오래된 글 등) 재알림만으로 카드를 만든다.
  const present = new Set([...noticeItems, ...supplyItems].map((item) => item.key));
  const reminderOnly = reminders
    .filter((item) => !present.has(`${item.reminder_type}-${item.resource_id}`))
    .map<FeedItem>((item) => ({
      changed: false,
      counts: null,
      done: false,
      important: false,
      key: `${item.reminder_type}-${item.resource_id}`,
      kind:
        item.reminder_type === "notice" ? "공지" : item.category === "homework" ? "숙제" : "준비물",
      meta: "선생님이 다시 확인을 요청했어요",
      reminded: true,
      title: item.title,
      to: `/${item.reminder_type === "notice" ? "notices" : "supplies"}/${item.resource_id}`,
    }));
  return [...polls, ...reminderOnly, ...noticeItems, ...supplyItems].slice(0, FEED_LIMIT);
}

/** 학생 카드 아래 한 줄. 공지는 '확인', 준비물은 '챙김', 숙제는 '함'. */
const STUDENT_STATUS: Record<string, { done: string; open: string }> = {
  공지: { done: "확인했어요", open: "아직 확인 전" },
  숙제: { done: "다 했어요", open: "아직 안 했어요" },
  준비물: { done: "챙겼어요", open: "아직 안 챙겼어요" },
  선거: { done: "투표했어요", open: "아직 투표 전" },
  투표: { done: "투표했어요", open: "아직 투표 전" },
};

function FeedFooter({ item, role }: { item: FeedItem; role: Role }): React.JSX.Element {
  if (role === "teacher") {
    if (item.counts === null || item.counts.total === 0)
      return (
        <span className="text-xs font-semibold text-app-muted">
          확인 현황은 글에서 볼 수 있어요
        </span>
      );
    const percent = Math.round((item.counts.done / item.counts.total) * 100);
    const left = item.counts.total - item.counts.done;
    return (
      <span className="block min-w-0 flex-1">
        <span
          className="block h-1.5 overflow-hidden rounded-full bg-app-surface-muted"
          aria-hidden="true"
        >
          <span
            className="block h-full rounded-full bg-[#2b6149]"
            style={{ width: `${percent}%` }}
          />
        </span>
        <span className="mt-1 flex justify-between gap-2 text-xs text-app-muted">
          <span>
            <strong className="text-app-text">{item.counts.done}</strong>/{item.counts.total}명{" "}
            {item.kind === "공지" ? "확인" : item.kind === "준비물" ? "챙김" : "완료"}
          </span>
          {left > 0 ? <span className="font-bold text-app-text">{left}명 남음</span> : null}
        </span>
      </span>
    );
  }
  const status = STUDENT_STATUS[item.kind] ?? STUDENT_STATUS["공지"]!;
  return (
    <span className={`text-xs font-bold ${item.done ? "text-role-primary" : "text-app-muted"}`}>
      {item.done ? status.done : status.open}
    </span>
  );
}

export function HomeNewsFeed({
  home,
  role,
}: {
  home: HomeResponse;
  role: Role;
}): React.JSX.Element {
  const items = homeFeedItems(home, role);
  const errors = homeFeedErrors(home, role);
  return (
    <section
      aria-labelledby={`home-news-feed-${role}`}
      // 2026-10-02 사용자 결정: 학생도 교사와 같은 한 판(모든 폭).
      className="min-w-0 rounded-card border border-app-border bg-app-surface p-4 shadow-card"
      data-home-news-feed={role}
      data-home-news-empty={items.length === 0 ? "true" : undefined}
    >
      <div className="flex min-h-11 items-center justify-between gap-3">
        <h2 className="text-base font-extrabold text-app-text" id={`home-news-feed-${role}`}>
          우리반 소식
        </h2>
        <Link
          className="inline-flex min-h-11 items-center gap-0.5 rounded-xl px-2 text-sm font-bold text-app-muted hover:text-app-text"
          to="/updates"
        >
          전체
          <ChevronRight aria-hidden="true" size={15} />
        </Link>
      </div>
      {errors.length === 0 ? null : (
        <p
          className="mt-1 rounded-xl bg-danger-surface px-3 py-2 text-xs font-semibold leading-5 text-danger-text"
          role="alert"
        >
          {errors.join(", ")} 정보를 불러오지 못했어요.
        </p>
      )}
      {/* 불러오지 못한 묶음이 있으면 '없다'고 단정하지 않는다. */}
      {items.length === 0 && errors.length === 0 ? (
        <p className="mt-1 rounded-card border border-app-border bg-app-surface p-4 text-sm font-semibold text-app-muted">
          새 소식이 없어요.
        </p>
      ) : null}
      <ul className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-3 sm:gap-4">
        {items.map((item, index) => (
          <li className={index >= 4 ? "min-w-0 xl:hidden" : "min-w-0"} key={item.key}>
            <Link
              className="block min-w-0 rounded-card border border-app-border bg-app-surface p-3 shadow-card transition-colors hover:border-role-border sm:p-4"
              data-home-news-item={item.key}
              to={item.to}
            >
              <span className="flex items-center gap-2 text-xs font-semibold text-app-muted">
                {item.changed ? (
                  <span className="rounded-md bg-[var(--color-chalk-yellow)] px-1.5 py-0.5 font-extrabold text-[#16191b]">
                    바뀜
                  </span>
                ) : null}
                {!item.changed && item.important ? (
                  // 색 밑줄만으로는 중요 공지를 알아보기 어렵다(총검수 B1-08).
                  <span className="rounded-md bg-role-soft px-1.5 py-0.5 font-extrabold text-role-primary">
                    중요
                  </span>
                ) : null}
                <span className="rounded-md bg-app-surface-muted px-1.5 py-0.5 font-bold text-app-text">
                  {item.kind}
                </span>
                {item.reminded ? (
                  <span className="rounded-md bg-role-soft px-1.5 py-0.5 font-bold text-role-primary">
                    선생님 재알림
                  </span>
                ) : null}
                <span className="min-w-0 truncate">{item.meta}</span>
                {role === "student" && item.done === false ? (
                  <span
                    aria-label="아직 확인 전"
                    className="ml-auto size-2 shrink-0 rounded-full bg-role-primary"
                  />
                ) : null}
              </span>
              <span
                className={`mt-2 line-clamp-2 min-w-0 [overflow-wrap:anywhere] text-base font-extrabold leading-snug text-app-text sm:line-clamp-3 ${
                  item.changed
                    ? "[text-decoration:underline_#f5c842_0.35em] [text-underline-offset:-0.12em] [text-decoration-skip-ink:none]"
                    : item.important
                      ? "[text-decoration:underline_var(--color-feed-important-mark)_0.35em] [text-underline-offset:-0.12em] [text-decoration-skip-ink:none]"
                      : ""
                }`}
              >
                {item.title}
              </span>
              <span className="mt-2 flex items-center gap-3 border-t border-app-border pt-2 sm:mt-3 sm:pt-3">
                <FeedFooter item={item} role={role} />
                <ChevronRight
                  aria-hidden="true"
                  className="ml-auto shrink-0 text-app-muted"
                  size={17}
                />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
