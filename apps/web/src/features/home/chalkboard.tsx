import { Cake, ChevronRight } from "lucide-react";
import { Link } from "react-router";

import type { HomeResponse } from "../../api/auth";

/*
 * 2026-09-27 확정 시안(칠판 + 소식 흐름)의 칠판. 오늘 꼭 알아야 할 것만 분필 글씨(Gaegu)로
 * 세 줄까지 적고, 바뀐 것은 노란 분필 밑줄로 표시한다(CI: 노랑 = 바뀜, 연두 = 일반 형광펜).
 * 테마와 무관하게 짙은 초록 칠판 + 나무 틀이라 --color-chalk-* 토큰(design-foundation.css)만 쓴다.
 */

export interface ChalkLine {
  changed?: boolean;
  key: string;
  meta: string;
  text: string;
  to: string;
}

export const CHALKBOARD_LINE_LIMIT = 3;
const CHALK_FONT = "Gaegu, 'Pretendard Variable', cursive";
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function dayCount(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

/** 준비물·숙제의 필요한 날을 칠판 오른쪽 작은 글씨로. 서버 기준 오늘(KST)과 비교한다. */
export function neededOnLabel(neededOn: string, serverToday: string): string {
  const days = dayCount(serverToday, neededOn);
  if (days < 0) return "지남";
  if (days === 0) return "오늘";
  if (days === 1) return "내일";
  if (days <= 6) return `${WEEKDAYS[new Date(`${neededOn}T00:00:00Z`).getUTCDay()]}요일`;
  return `D-${days}`;
}

/**
 * 학생 칠판에 올릴 세 줄을 고른다. 순서: 바뀐 공지(다시 확인) → 확인 안 한 중요 공지 →
 * 아직 안 챙긴 준비물·숙제(가까운 날부터). 칠판은 '꼭' 볼 것만 — 중요하지 않은 새 공지는
 * 예전 학생 홈처럼 올리지 않는다(소식 탭에서 본다). 불러오지 못한 묶음은 건너뛴다.
 */
export function studentChalkLines(home: HomeResponse): ChalkLine[] {
  const notices = home.notices.status === "error" ? [] : home.notices.data;
  const supplies = home.supplies.status === "error" ? [] : home.supplies.data;
  const lines: ChalkLine[] = [];
  const used = new Set<string>();
  const add = (line: ChalkLine) => {
    if (used.has(line.key) || lines.length >= CHALKBOARD_LINE_LIMIT) return;
    used.add(line.key);
    lines.push(line);
  };

  for (const notice of notices)
    if (notice.confirmation_state === "modified_unconfirmed")
      add({
        changed: true,
        key: `notice-${notice.id}`,
        meta: "바뀜",
        text: notice.title,
        to: `/notices/${notice.id}`,
      });
  for (const notice of notices)
    if (notice.is_important && notice.confirmation_state === "unread")
      add({
        key: `notice-${notice.id}`,
        meta: "중요",
        text: notice.title,
        to: `/notices/${notice.id}`,
      });
  [...supplies]
    .filter((supply) => supply.check_state !== "checked")
    .sort((a, b) => a.needed_on.localeCompare(b.needed_on))
    .forEach((supply) =>
      add({
        changed: supply.check_state === "modified_unconfirmed",
        key: `supply-${supply.id}`,
        meta: neededOnLabel(supply.needed_on, home.server_today),
        text: supply.title,
        to: `/supplies/${supply.id}`,
      }),
    );
  return lines;
}

/**
 * 교사 칠판: 반에 지금 걸려 있는 것. 순서: 중요 공지(최근부터) → 필요한 날이 오늘 이후인
 * 준비물·숙제(가까운 날부터) → 나머지 최근 공지. 학생 칠판과 달리 확인 상태로 거르지 않는다.
 */
export function teacherChalkLines(home: HomeResponse): ChalkLine[] {
  const notices = home.notices.status === "error" ? [] : home.notices.data;
  const supplies = home.supplies.status === "error" ? [] : home.supplies.data;
  const newest = [...notices].sort((a, b) => b.published_at.localeCompare(a.published_at));
  const lines: ChalkLine[] = [];
  const used = new Set<string>();
  const add = (line: ChalkLine) => {
    if (used.has(line.key) || lines.length >= CHALKBOARD_LINE_LIMIT) return;
    used.add(line.key);
    lines.push(line);
  };

  for (const notice of newest)
    if (notice.is_important)
      add({
        key: `notice-${notice.id}`,
        meta: "중요",
        text: notice.title,
        to: `/notices/${notice.id}`,
      });
  [...supplies]
    .filter((supply) => supply.needed_on >= home.server_today)
    .sort((a, b) => a.needed_on.localeCompare(b.needed_on))
    .forEach((supply) =>
      add({
        key: `supply-${supply.id}`,
        meta: neededOnLabel(supply.needed_on, home.server_today),
        text: supply.title,
        to: `/supplies/${supply.id}`,
      }),
    );
  for (const notice of newest)
    add({
      key: `notice-${notice.id}`,
      meta: "공지",
      text: notice.title,
      to: `/notices/${notice.id}`,
    });
  return lines;
}

/** 오늘 생일이고 본인이 알리기를 켠 학생 이름(서버가 고른다 — 태어난 해는 오지 않는다). */
export function birthdayNames(home: HomeResponse): string[] {
  return home.birthdays?.status === "ok" ? home.birthdays.data.map((b) => b.display_name) : [];
}

export function Chalkboard({
  compactEmpty = false,
  birthdays = [],
  dateLabel,
  dateTime,
  emptyText,
  footer,
  lines,
}: {
  compactEmpty?: boolean;
  birthdays?: string[];
  dateLabel: string;
  dateTime: string;
  emptyText: string;
  footer?: React.ReactNode;
  lines: ChalkLine[];
}): React.JSX.Element {
  return (
    <section
      aria-label="우리반 칠판"
      className="min-w-0 rounded-[1.25rem] bg-[var(--color-chalk-frame)] p-1 shadow-card"
      data-chalkboard
    >
      <div
        className="rounded-[1rem] px-4 pb-3 pt-3.5 text-[var(--color-chalk-text)] sm:px-5"
        style={{
          background:
            "radial-gradient(120% 90% at 20% 0%, rgb(255 255 255 / 7%) 0%, transparent 60%), var(--color-chalk-board)",
        }}
      >
        {/* 날짜·아래 글자는 70%일 때 대비가 4.5:1에 조금 못 미쳤다(총검수 B4-05). */}
        <div className="flex items-center justify-between gap-3 text-xs font-semibold text-[var(--color-chalk-text)]/80">
          <time dateTime={dateTime}>{dateLabel}</time>
          <span aria-hidden="true">우리반 칠판</span>
        </div>
        {birthdays.length > 0 && (
          <p
            className="mt-2 flex min-w-0 items-center gap-1.5 break-keep text-sm font-bold text-[var(--color-chalk-yellow)]"
            data-chalk-birthdays
          >
            <Cake aria-hidden="true" className="shrink-0" size={16} />
            오늘은 {birthdays.join(", ")}의 생일이에요
          </p>
        )}
        {/* 기본은 3줄 높이. 성공한 빈 칠판만 모바일·태블릿에서 여백을 줄인다. 실제 안내·생일·오류·PC는 기존 높이를 유지한다. */}
        <div
          className={
            "mt-3 " +
            (compactEmpty && lines.length === 0 && birthdays.length === 0
              ? "min-h-[4.75rem] sm:min-h-[5.5rem] xl:min-h-[9.25rem]"
              : "min-h-[9.25rem]")
          }
          data-chalk-body
        >
          {lines.length === 0 ? (
            <p
              className="break-keep text-balance text-2xl leading-snug [overflow-wrap:anywhere] sm:break-normal sm:text-wrap sm:text-[1.75rem] sm:[overflow-wrap:normal]"
              style={{ fontFamily: CHALK_FONT }}
            >
              {emptyText}
            </p>
          ) : (
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
              {lines.map((line) => (
                <li className="min-w-0" key={line.key}>
                  <Link
                    className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg outline-offset-2 hover:bg-white/5 active:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-chalk-text)]"
                    data-chalk-changed={line.changed ? "true" : undefined}
                    to={line.to}
                  >
                    <span
                      className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere] text-2xl leading-snug sm:text-[1.75rem]"
                      style={{ fontFamily: CHALK_FONT }}
                    >
                      <span
                        className={
                          line.changed
                            ? "text-white underline decoration-[var(--color-chalk-yellow)] decoration-2 underline-offset-[0.2em] [text-decoration-skip-ink:auto]"
                            : undefined
                        }
                        data-chalk-highlight={line.changed ? "true" : undefined}
                      >
                        {line.text}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 text-xs font-bold ${
                        line.changed
                          ? "text-[var(--color-chalk-text)]/90"
                          : "text-[var(--color-chalk-text)]/90"
                      }`}
                    >
                      {line.meta}
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="shrink-0 text-[var(--color-chalk-text)]/80"
                      size={16}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-3 flex min-h-8 items-center justify-between gap-3 border-t border-white/15 pt-2.5 text-xs text-[var(--color-chalk-text)]/80">
          <span aria-hidden="true" className="flex gap-1">
            <i className="block h-1 w-4 rounded-full bg-[var(--color-chalk-text)]/80" />
            <i className="block h-1 w-3 rounded-full bg-[var(--color-chalk-yellow)]/85" />
          </span>
          {footer}
        </div>
      </div>
    </section>
  );
}
