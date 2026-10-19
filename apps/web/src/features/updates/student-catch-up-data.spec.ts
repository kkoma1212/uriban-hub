import { beforeEach, describe, expect, it, vi } from "vitest";
import { listNotices, type NoticeItem } from "../../api/notices";
import { listSupplies, type SupplyItem } from "../../api/supplies";
import { loadStudentCatchUp } from "./student-catch-up-data";

vi.mock("../../api/notices", () => ({ listNotices: vi.fn() }));
vi.mock("../../api/supplies", () => ({ listSupplies: vi.fn() }));
const today = "2026-09-15";
const period = { from: "2026-09-09", to: today };
const page = <T>(items: T[], next_cursor: string | null = null) => ({
  items,
  next_cursor,
  server_today: today,
  selected_audience_enabled: true,
});
function notice(
  id: string,
  state: NoticeItem["confirmation_state"],
  published_at = "2026-09-08T15:00:00Z",
): NoticeItem {
  return {
    id,
    title: `공지 ${id}`,
    content: "안내",
    category: "general",
    published_at,
    audience_mode: "selected_snapshot",
    content_revision: "2",
    row_version: "2",
    is_important: false,
    ...(state === undefined ? {} : { confirmation_state: state }),
  };
}
function supply(id: string, state: SupplyItem["check_state"], needed_on = today): SupplyItem {
  return {
    id,
    title: `숙제 ${id}`,
    description: null,
    category: "homework",
    needed_on,
    audience_mode: "all_snapshot",
    content_revision: "2",
    row_version: "2",
    ...(state === undefined ? {} : { check_state: state }),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listNotices).mockResolvedValue(page([]));
  vi.mocked(listSupplies).mockResolvedValue(page([]));
});

describe("student catch up", () => {
  it("prioritizes changed content and omits current confirmations and checks", async () => {
    vi.mocked(listNotices).mockImplementation(async (importance) =>
      page(
        importance === "regular"
          ? [
              notice("confirmed", "confirmed"),
              notice("unread", "unread"),
              notice("changed", "modified_unconfirmed"),
            ]
          : [],
      ),
    );
    vi.mocked(listSupplies).mockImplementation(async (scope) =>
      page(
        scope === "upcoming"
          ? [
              supply("checked", "checked"),
              supply("unchecked", "unchecked"),
              supply("changed", "modified_unconfirmed"),
            ]
          : [],
      ),
    );
    const result = await loadStudentCatchUp(period, today, () => true);
    expect(result.total).toBe(6);
    expect(result.checkedCount).toBe(2);
    expect(result.items).toHaveLength(4);
    expect(result.items.slice(0, 2).every((item) => item.state === "modified_unconfirmed")).toBe(
      true,
    );
    expect(result.items.find((item) => item.id === "unread")).toMatchObject({
      action: "공지 읽고 확인하기",
      to: "/notices/unread",
      date: period.from,
    });
    expect(result.items.find((item) => item.id === "unchecked")?.description).toContain(
      "자기 체크",
    );
  });
  it("suggests checking whether past work is still needed", async () => {
    vi.mocked(listSupplies).mockImplementation(async (scope) =>
      page(scope === "past" ? [supply("past", "unchecked", "2026-09-10")] : []),
    );
    const result = await loadStudentCatchUp(period, today, () => true);
    expect(result.items[0]).toMatchObject({ action: "지난 안내 살펴보기", date: "2026-09-10" });
    expect(result.items[0]?.description).toContain("아직 필요한 일인지");
  });
  it("uses all pages within KST date boundaries without importing teacher status endpoints", async () => {
    vi.mocked(listNotices).mockImplementation(async (importance, cursor) => {
      if (importance === "important") return page([]);
      return cursor === undefined
        ? page([notice("late", "unread", "2026-09-15T15:00:00Z")], "next")
        : page([
            notice("in", "unread", "2026-09-15T14:59:59Z"),
            notice("out", "unread", "2026-09-08T14:59:59Z"),
          ]);
    });
    expect(
      (await loadStudentCatchUp(period, today, () => true)).items.map((item) => item.id),
    ).toEqual(["in"]);
    expect(listNotices).toHaveBeenCalledWith("regular", "next");
  });
  it("rejects a missing student state rather than claiming everything is complete", async () => {
    vi.mocked(listNotices).mockImplementation(async (importance) =>
      page(importance === "regular" ? [notice("unknown", undefined)] : []),
    );
    await expect(loadStudentCatchUp(period, today, () => true)).rejects.toThrow("내 확인 상태");
  });
  it("rejects partial, invalid-period, and cancelled reads", async () => {
    vi.mocked(listSupplies).mockRejectedValue(new Error("connection lost"));
    await expect(loadStudentCatchUp(period, today, () => true)).rejects.toThrow("connection lost");
    vi.clearAllMocks();
    await expect(
      loadStudentCatchUp({ from: today, to: "2026-09-14" }, today, () => true),
    ).rejects.toThrow("종료일");
    expect(listNotices).not.toHaveBeenCalled();
    await expect(loadStudentCatchUp(period, today, () => false)).rejects.toThrow("중지");
  });
});
