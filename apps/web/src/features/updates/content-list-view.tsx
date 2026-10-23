import { Check, ChevronRight, LoaderCircle, Search, X } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Link } from "react-router";
import { ApiRequestError } from "../../api/auth";
import { listNoticeConfirmations } from "../../api/notices";
import { listSupplyChecks } from "../../api/supplies";
import { ContentSearchBox } from "../layout/content-search-box";
import type { ContentPageSnapshot } from "../layout/content-pagination";
import { HighlightMatch, searchExcerpt } from "../layout/highlight-match";
import { stripRichText } from "../../lib/rich-text";

export const CONTENT_DESKTOP_QUERY = "(min-width: 1280px)";

/** 펼친 서버 묶음을 저장해 상세에서 돌아와도 앞의 목록을 함께 복원한다. */
export function useContentListPosition() {
  const [positions, setPositions] = useState<Record<string, ContentPageSnapshot>>({});
  const received = useCallback(
    (
      key: string,
      previousCount: number,
      count: number,
      append: boolean,
      cursor?: string,
      restore?: ContentPageSnapshot,
    ): void => {
      setPositions((current) => {
        if (restore !== undefined) return { ...current, [key]: restore };
        const pages = append ? [...(current[key]?.pages ?? [])] : [];
        if (count > 0) pages.push({ cursor, offset: 0, start: append ? previousCount + 1 : 1 });
        return { ...current, [key]: { index: Math.max(0, pages.length - 1), pages } };
      });
    },
    [],
  );
  return {
    received,
    page: (key: string, _items: unknown[] | undefined) => ({
      snapshot: positions[key] ?? { index: 0, pages: [] },
    }),
  };
}

export async function readContentList<
  T extends { items: unknown[]; next_cursor: string | null; server_today?: string },
>(
  request: (cursor: string | undefined) => Promise<T>,
  cursor: string | undefined,
  restore: ContentPageSnapshot | undefined,
): Promise<{ result: T; cursor: string | undefined; restore: ContentPageSnapshot | undefined }> {
  if (restore === undefined) return { result: await request(cursor), cursor, restore: undefined };
  // 이전 10개 단위 기록도 서버 커서가 같은 묶음은 한 번만 읽는다.
  const batchCount = Math.max(
    1,
    new Set(restore.pages.slice(0, restore.index + 1).map((page) => page.cursor)).size,
  );
  let next: string | undefined;
  let firstDay: string | undefined;
  let result: T | undefined;
  const items: unknown[] = [];
  const pages: ContentPageSnapshot["pages"] = [];
  for (let batch = 0; batch < batchCount; batch += 1) {
    let loaded: T;
    try {
      loaded = await request(next);
    } catch (error) {
      if (batch === 0 || !(error instanceof ApiRequestError) || error.status !== 400) throw error;
      return { result: await request(undefined), cursor: undefined, restore: undefined };
    }
    if (batch === 0) firstDay = loaded.server_today;
    else if (firstDay !== loaded.server_today)
      return { result: await request(undefined), cursor: undefined, restore: undefined };
    pages.push({ cursor: next, offset: 0, start: items.length + 1 });
    items.push(...loaded.items);
    result = loaded;
    if (loaded.next_cursor === null) break;
    next = loaded.next_cursor;
  }
  return {
    result: { ...result!, items } as T,
    cursor: undefined,
    restore: { index: Math.max(0, pages.length - 1), pages },
  };
}
export function useContentDesktop(): boolean {
  const [desktop, setDesktop] = useState(
    () =>
      typeof window.matchMedia === "function" && window.matchMedia(CONTENT_DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(CONTENT_DESKTOP_QUERY);
    const changed = () => setDesktop(media.matches);
    changed();
    media.addEventListener?.("change", changed);
    return () => media.removeEventListener?.("change", changed);
  }, []);
  return desktop;
}
export function selectContentInPlace(event: MouseEvent<HTMLAnchorElement>): boolean {
  if (
    event.button !== 0 ||
    event.detail === 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    typeof window.matchMedia !== "function" ||
    !window.matchMedia(CONTENT_DESKTOP_QUERY).matches
  )
    return false;
  event.preventDefault();
  return true;
}

export function ListSearch(props: ComponentProps<typeof ContentSearchBox>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="relative min-w-0" data-content-list-search>
      <button
        aria-label={open ? "검색 닫기" : props.label + " 열기"}
        aria-controls={id}
        aria-expanded={open}
        className="ui-icon-button xl:hidden"
        onClick={() => setOpen(!open)}
        type="button"
      >
        {open ? <X aria-hidden size={21} /> : <Search aria-hidden size={21} />}
      </button>
      <div
        className={`[&>div]:mb-0 [&_input]:min-h-11 [&_input]:rounded-xl [&_input]:text-sm xl:static xl:w-56 ${open ? "absolute right-0 top-12 z-20 w-[min(20rem,calc(100vw-2rem))] rounded-xl bg-app-surface p-2 shadow-card xl:p-0" : "hidden xl:block"}`}
        id={id}
      >
        <ContentSearchBox {...props} />
      </div>
    </div>
  );
}

export function contentDateGroup(value: string, today: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "날짜 미정";
  const day =
    value.length > 10 ? parsed.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }) : value;
  const date = new Date(day + "T00:00:00Z").getTime();
  const current = new Date(today + "T00:00:00Z");
  if (!Number.isFinite(date) || !Number.isFinite(current.getTime())) return "날짜 미정";
  const delta = Math.round((date - current.getTime()) / 86400000);
  if (delta === 0) return "오늘";
  const weekStart = current.getTime() - ((current.getUTCDay() + 6) % 7) * 86400000;
  if (date >= weekStart && date < weekStart + 7 * 86400000) return "이번 주";
  if (delta > 0) return "다가오는 날";
  if (date >= weekStart - 7 * 86400000) return "지난주";
  return "그 전";
}

export function groupContentItems<T>(
  items: T[],
  dateFor: (item: T) => string,
  today: string,
): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = contentDateGroup(dateFor(item), today);
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  const order = ["오늘", "이번 주", "다가오는 날", "지난주", "그 전", "날짜 미정"];
  return [...groups].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
}

export function DateGroupedList<T>({
  items,
  dateFor,
  today,
  renderItem,
  listRef,
  label,
  moveLast,
  firstGroupInHeader = false,
}: {
  items: T[];
  dateFor: (item: T) => string;
  moveLast?: (item: T) => boolean;
  firstGroupInHeader?: boolean;
  today: string;
  renderItem: (item: T) => ReactNode;
  listRef?: Ref<HTMLUListElement>;
  label: string;
}): React.JSX.Element {
  const ordered = groupContentItems(items, dateFor, today);
  return (
    <ul aria-label={label} className="grid min-w-0 content-start gap-2" ref={listRef}>
      {ordered.map(([group, groupItems], index) => (
        <Fragment key={group}>
          <li
            role="presentation"
            className={firstGroupInHeader && index === 0 ? "sr-only" : "pb-1 pt-3 first:pt-0"}
          >
            <h2 className="text-[13px] font-bold text-app-muted">
              {group} <span className="ml-1 font-semibold text-app-muted">{groupItems.length}</span>
            </h2>
          </li>
          {(moveLast === undefined
            ? groupItems
            : [...groupItems.filter((item) => !moveLast(item)), ...groupItems.filter(moveLast)]
          ).map(renderItem)}
        </Fragment>
      ))}
    </ul>
  );
}

export function ContentMore({
  busy,
  onMore,
  label = "지난 소식 더 보기",
}: {
  busy: boolean;
  onMore: () => void;
  label?: string;
}): React.JSX.Element {
  return (
    <button
      aria-busy={busy}
      className="ui-button ui-button-secondary mt-3 min-h-12 w-full rounded-2xl text-sm"
      disabled={busy}
      onClick={onMore}
      type="button"
    >
      {busy ? <LoaderCircle aria-hidden className="animate-spin" size={17} /> : null}
      {label}
    </button>
  );
}

export function ContentPostCard({
  to,
  state,
  onClick,
  linkRef,
  selected,
  title,
  body,
  term,
  kind,
  important,
  date,
  dateLabel,
  dueSoon,
  past = false,
  footer,
  meta,
}: {
  to: string;
  state?: unknown;
  // body는 공지 본문의 **굵게**·==형광펜== 기호를 포함할 수 있다 — 발췌에는 기호를 뺀 글자만 쓴다(아래).
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  linkRef?: Ref<HTMLAnchorElement>;
  selected?: boolean | undefined;
  title: string;
  body?: string | null | undefined;
  term?: string | undefined;
  kind: string;
  important?: boolean;
  date?: string | undefined;
  dateLabel?: string | undefined;
  dueSoon?: boolean;
  past?: boolean;
  footer?: ReactNode;
  meta?: ReactNode;
}): React.JSX.Element {
  const excerpt = body ? stripRichText(body) : body;
  return (
    <Link
      to={to}
      state={state}
      ref={linkRef}
      onClick={onClick}
      className={`content-card group block min-w-0 p-4 outline-offset-2 ${selected ? "ring-2 ring-[#2b6149]" : ""}`}
      data-content-selected={selected ? "true" : "false"}
      data-content-past={past ? "true" : undefined}
    >
      <span className="flex flex-wrap items-center gap-2 text-[13px] text-app-muted">
        <span className="rounded-lg bg-app-surface-muted px-2 py-1 text-xs font-bold">{kind}</span>
        {meta}
        {important ? (
          <span className="rounded-lg bg-home-important-soft px-2 py-1 text-xs font-bold text-home-important">
            중요
          </span>
        ) : null}
      </span>
      <span
        data-content-title
        className={`mt-2 block break-words text-[17px] font-extrabold leading-snug tracking-[-0.02em] ${past ? "text-app-muted" : "text-app-text"}`}
      >
        <HighlightMatch text={title} term={term} />
      </span>
      {date && dateLabel ? (
        <time
          dateTime={date}
          className={`mt-1 block text-[13px] font-bold ${past ? "text-app-muted" : dueSoon ? "text-danger" : "text-role-primary"}`}
        >
          {dateLabel}
          {past ? <span className="ml-2 font-medium">날짜 지남</span> : null}
        </time>
      ) : null}
      {excerpt ? (
        <p
          data-content-excerpt
          className={
            "mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-app-muted " +
            (term !== undefined && excerpt.toLowerCase().includes(term.toLowerCase())
              ? "line-clamp-4"
              : "line-clamp-2")
          }
        >
          <HighlightMatch text={searchExcerpt(excerpt, term, 0)} term={term} />
        </p>
      ) : null}
      <span
        data-content-footer
        className="mt-3 flex min-h-8 items-center gap-3 border-t border-app-border pt-3 text-[13px] text-app-muted"
      >
        <span className="min-w-0 flex-1">{footer ?? "내용 보기"}</span>
        <ChevronRight aria-hidden className="shrink-0 text-app-muted" size={18} />
      </span>
    </Link>
  );
}

export function StudentContentState({
  state,
  doneLabel,
  openLabel = "아직 안 했어요",
}: {
  state: string | undefined;
  doneLabel: string;
  openLabel?: string;
}): React.JSX.Element | null {
  if (state === undefined) return null;
  const done = state === "confirmed" || state === "checked";
  return (
    <span
      className={`inline-flex items-center gap-1 font-bold ${done ? "text-role-primary" : "text-app-text"}`}
    >
      {done ? <Check aria-hidden size={15} /> : null}
      {done
        ? doneLabel
        : state === "modified_unconfirmed"
          ? "바뀐 내용을 확인해 주세요"
          : openLabel}
    </span>
  );
}

// 기존 집계 API를 재사용하되 보이는 카드만 조회하고 동시에 세 개까지만 요청한다.
let progressActive = 0;
const progressQueue: Array<() => void> = [];
function queueProgress<T>(request: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = () => {
      progressActive += 1;
      void request()
        .then(resolve, reject)
        .finally(() => {
          progressActive -= 1;
          progressQueue.shift()?.();
        });
    };
    if (progressActive < 3) start();
    else progressQueue.push(start);
  });
}

export function CompactContentProgress({
  id,
  kind,
  revision,
  doneLabel,
  refreshKey,
}: {
  id: string;
  kind: "notice" | "supply";
  revision: string;
  doneLabel: string;
  refreshKey?: number;
}): React.JSX.Element {
  const host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [counts, setCounts] = useState<{ done: number; pending: number }>();
  const [failed, setFailed] = useState(false);
  const [requestStarted, setRequestStarted] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      {
        root:
          typeof window.matchMedia === "function" &&
          window.matchMedia(CONTENT_DESKTOP_QUERY).matches
            ? (host.current?.closest(".content-split-main") ?? null)
            : null,
        rootMargin: "80px",
      },
    );
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setCounts(undefined);
    setFailed(false);
    setRequestStarted(false);
    void queueProgress(async () => {
      if (!active) return undefined;
      setRequestStarted(true);
      return kind === "notice"
        ? listNoticeConfirmations(id, "unread")
        : listSupplyChecks(id, "unchecked");
    })
      .then((result) => {
        if (!active || result === undefined) return;
        if (result.content_revision !== revision) {
          setFailed(true);
          return;
        }
        const c = result.counts;
        const done = "confirmed" in c ? c.confirmed : c.checked;
        const pending = ("unread" in c ? c.unread : c.unchecked) + c.modified_unconfirmed;
        setCounts({ done, pending });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [visible, id, kind, revision, refreshKey]);
  const total = counts ? counts.done + counts.pending : 0;
  return (
    <span
      ref={host}
      className="flex min-w-0 items-center gap-3"
      data-content-progress={
        counts ? "ready" : failed ? "error" : requestStarted ? "loading" : "waiting"
      }
    >
      {counts ? (
        <>
          <span className="min-w-0 flex-1">
            <span
              aria-hidden
              className="mb-1 block h-1.5 overflow-hidden rounded-full bg-app-border"
            >
              <span
                className="block h-full rounded-full bg-[#2b6149]"
                style={{ width: `${total === 0 ? 100 : (counts.done / total) * 100}%` }}
              />
            </span>
            <b className="text-app-text">{counts.done}</b>/{total}명 {doneLabel}
          </span>
          <span className="shrink-0 font-bold text-app-text">
            {counts.pending === 0 ? `모두 ${doneLabel}` : `${counts.pending}명 남음`}
          </span>
        </>
      ) : (
        <span className="text-xs">
          {failed
            ? "확인 현황은 상세에서 다시 확인해 주세요"
            : requestStarted
              ? "확인 현황 불러오는 중"
              : "확인 현황 조회 대기 중"}
        </span>
      )}
    </span>
  );
}

export function isDueSoon(date: string, today: string): boolean {
  const days =
    (new Date(date + "T00:00:00Z").getTime() - new Date(today + "T00:00:00Z").getTime()) / 86400000;
  return days >= 0 && days <= 1;
}
