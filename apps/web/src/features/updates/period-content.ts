import { listNotices, type NoticeItem } from "../../api/notices";
import { listSupplies, type SupplyItem } from "../../api/supplies";

export interface ContentPeriod {
  from: string;
  to: string;
}

export type PeriodContent =
  { kind: "notice"; item: NoticeItem } | { kind: "supply"; item: SupplyItem };
const DAY = 86_400_000;

export function shiftCalendarDate(value: string, days: number): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

export function validateContentPeriod(period: ContentPeriod, today: string): string | undefined {
  const valid = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    shiftCalendarDate(value, 0) === value;
  if (!valid(period.from) || !valid(period.to)) return "시작일과 종료일을 입력해 주세요.";
  if (period.from > period.to) return "종료일은 시작일과 같거나 이후로 선택해 주세요.";
  if (period.from < shiftCalendarDate(today, -90)) return "지난 90일 이후의 기간을 선택해 주세요.";
  if (Date.parse(period.to) - Date.parse(period.from) >= 31 * DAY)
    return "한 번에 최대 31일을 조회할 수 있어요. 기간을 줄여 주세요.";
  return undefined;
}

export function periodContentDate(source: PeriodContent): string {
  return source.kind === "notice"
    ? new Date(Date.parse(source.item.published_at) + 9 * 3_600_000).toISOString().slice(0, 10)
    : source.item.needed_on;
}

/** List endpoints select the current class and, for students, only their own recipients. */
export async function loadPeriodContent(
  period: ContentPeriod,
  today: string,
  active: () => boolean,
): Promise<PeriodContent[]> {
  const invalid = validateContentPeriod(period, today);
  if (invalid !== undefined) throw new Error(invalid);
  let stopped = false;
  const checkActive = () => {
    if (stopped || !active()) throw new Error("조회를 중지했어요.");
  };
  const sources = new Map<string, PeriodContent>();
  async function collect(kind: "important" | "regular" | "past" | "upcoming") {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      checkActive();
      const notice = kind === "important" || kind === "regular";
      const response = notice ? await listNotices(kind, cursor) : await listSupplies(kind, cursor);
      checkActive();
      if (response.server_today !== today)
        throw new Error("날짜가 바뀌었어요. 페이지를 새로고침해 주세요.");
      let passedPeriod = false;
      for (const item of response.items) {
        const source: PeriodContent = notice
          ? { kind: "notice", item: item as NoticeItem }
          : { kind: "supply", item: item as SupplyItem };
        const date = periodContentDate(source);
        if (kind === "upcoming" ? date > period.to : date < period.from) passedPeriod = true;
        if (date < period.from || date > period.to) continue;
        sources.set(`${source.kind}:${item.id}`, source);
        if (sources.size > 100) throw new Error("안내가 100개를 넘어요. 조회 기간을 줄여 주세요.");
      }
      if (passedPeriod) return;
      cursor = response.next_cursor ?? undefined;
      if (cursor !== undefined) {
        if (response.items.length === 0 || cursors.has(cursor) || cursors.size >= 25)
          throw new Error(
            "안내 목록을 끝까지 조회하지 못했어요. 소식 목록에서 확인하거나 다시 조회해 주세요.",
          );
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
  }
  try {
    await Promise.all([
      collect("important"),
      collect("regular"),
      ...(period.from < today ? [collect("past")] : []),
      ...(period.to >= today ? [collect("upcoming")] : []),
    ]);
    checkActive();
    return [...sources.values()];
  } finally {
    stopped = true;
  }
}
