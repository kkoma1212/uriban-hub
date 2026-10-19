import { loadPeriodContent, periodContentDate, type ContentPeriod } from "./period-content";

export interface CatchUpItem {
  action: string;
  date: string;
  description: string;
  id: string;
  kind: "notice" | "supply";
  label: "공지" | "준비물" | "숙제";
  state: "unread" | "unchecked" | "modified_unconfirmed";
  title: string;
  to: string;
}

export interface CatchUpResult {
  checkedCount: number;
  items: CatchUpItem[];
  period: ContentPeriod;
  total: number;
}

export async function loadStudentCatchUp(
  period: ContentPeriod,
  today: string,
  active: () => boolean,
): Promise<CatchUpResult> {
  const sources = await loadPeriodContent(period, today, active);
  const items: CatchUpItem[] = [];
  let checkedCount = 0;
  for (const source of sources) {
    const state =
      source.kind === "notice" ? source.item.confirmation_state : source.item.check_state;
    if (state === "confirmed" || state === "checked") {
      checkedCount += 1;
      continue;
    }
    if (state === undefined || !["unread", "unchecked", "modified_unconfirmed"].includes(state))
      throw new Error("내 확인 상태를 불러오지 못했어요. 다시 조회해 주세요.");
    const label =
      source.kind === "notice" ? "공지" : source.item.category === "homework" ? "숙제" : "준비물";
    const date = periodContentDate(source);
    const changed = state === "modified_unconfirmed";
    const overdue = source.kind === "supply" && date < today;
    items.push({
      id: source.item.id,
      kind: source.kind,
      label,
      date,
      state,
      title: source.item.title,
      to: `/${source.kind === "notice" ? "notices" : "supplies"}/${encodeURIComponent(source.item.id)}`,
      action: changed
        ? "바뀐 내용 확인하기"
        : source.kind === "notice"
          ? "공지 읽고 확인하기"
          : overdue
            ? "지난 안내 살펴보기"
            : "할 일 확인하기",
      description: changed
        ? "내용이 바뀌었어요. 다시 읽어 주세요."
        : source.kind === "notice"
          ? "읽은 뒤 확인을 남겨 주세요."
          : overdue
            ? "예정일이 지났어요. 아직 필요한 일인지 선생님께 확인해 주세요."
            : "안내를 따르고 상세 화면에서 자기 체크를 남겨 주세요.",
    });
  }
  items.sort(
    (a, b) =>
      Number(b.state === "modified_unconfirmed") - Number(a.state === "modified_unconfirmed") ||
      a.date.localeCompare(b.date) ||
      a.title.localeCompare(b.title, "ko"),
  );
  return { period, total: sources.length, checkedCount, items };
}
