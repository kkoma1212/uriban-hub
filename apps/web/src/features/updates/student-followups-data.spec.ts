import { beforeEach, describe, expect, it, vi } from "vitest";
import { listNotices, listNoticeConfirmations, type NoticeItem } from "../../api/notices";
import { listSupplies, listSupplyChecks, type SupplyItem } from "../../api/supplies";
import { loadStudentFollowups, validateFollowupPeriod } from "./student-followups-data";

vi.mock("../../api/notices", () => ({ listNotices: vi.fn(), listNoticeConfirmations: vi.fn() }));
vi.mock("../../api/supplies", () => ({ listSupplies: vi.fn(), listSupplyChecks: vi.fn() }));
const today = "2026-09-15";
const period = { from: "2026-09-09", to: "2026-09-15" };
const notice = (id = "n1", published_at = "2026-09-08T15:00:00Z"): NoticeItem => ({
  id,
  published_at,
  title: "체험학습 안내",
  content: "안내",
  content_revision: "2",
  row_version: "2",
  category: "general",
  audience_mode: "selected_snapshot",
  is_important: false,
});
const supply: SupplyItem = {
  id: "s1",
  title: "독서 숙제",
  description: null,
  needed_on: today,
  category: "homework",
  audience_mode: "selected_snapshot",
  content_revision: "1",
  row_version: "1",
};
const member = { member_id: "s10", display_name: "가람", student_number: 1 };
const page = <T>(items: T[], next_cursor: string | null = null) => ({
  items,
  next_cursor,
  server_today: today,
  selected_audience_enabled: true,
});
const confirmations = (
  items: Array<typeof member & { confirmation_state: "unread" | "modified_unconfirmed" }> = [],
  unread = items.length,
  modified = 0,
) => ({
  ...page(items),
  content_revision: "2",
  counts: { unread, modified_unconfirmed: modified, confirmed: 1, excluded_member_count: 1 },
  last_reminder_requested_at: "2026-09-15T00:10:00Z",
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listNotices).mockResolvedValue(page([]));
  vi.mocked(listSupplies).mockResolvedValue(page([]));
  vi.mocked(listNoticeConfirmations).mockResolvedValue(confirmations());
  vi.mocked(listSupplyChecks).mockResolvedValue({
    ...page([]),
    content_revision: "1",
    counts: { checked: 1, unchecked: 0, modified_unconfirmed: 0, excluded_member_count: 1 },
    last_reminder_requested_at: null,
  });
});

describe("student followup aggregation", () => {
  it("groups only returned unresolved recipients, preserving separate check states and item reminder time", async () => {
    vi.mocked(listNotices).mockImplementation(async (importance) =>
      page(importance === "regular" ? [notice()] : []),
    );
    vi.mocked(listSupplies).mockImplementation(async (scope) =>
      page(scope === "upcoming" ? [supply] : []),
    );
    vi.mocked(listNoticeConfirmations).mockResolvedValue(
      confirmations([{ ...member, confirmation_state: "unread" }]),
    );
    vi.mocked(listSupplyChecks).mockImplementation(async (_id, state) => ({
      ...page(
        state === "unchecked"
          ? [{ ...member, check_state: "unchecked" as const }]
          : [
              {
                member_id: "s20",
                display_name: "나래",
                student_number: 2,
                check_state: "modified_unconfirmed" as const,
              },
            ],
      ),
      content_revision: "1",
      counts: { checked: 1, unchecked: 1, modified_unconfirmed: 1, excluded_member_count: 5 },
      last_reminder_requested_at: null,
    }));
    const result = await loadStudentFollowups(period, today, () => true, vi.fn());
    expect(result.contentCount).toBe(2);
    expect(result.students.map((student) => [student.id, student.items.length])).toEqual([
      ["s10", 2],
      ["s20", 1],
    ]);
    expect(result.students[0]?.items[0]).toMatchObject({
      date: "2026-09-09",
      state: "unread",
      lastReminderAt: "2026-09-15T00:10:00Z",
    });
    expect(result.students[0]?.items[1]).toMatchObject({
      label: "숙제",
      state: "unchecked",
      lastReminderAt: null,
    });
    expect(result.students[1]?.items[0]?.state).toBe("modified_unconfirmed");
    expect(listNoticeConfirmations).toHaveBeenCalledTimes(1);
  });

  it("uses KST boundaries, traverses pages, and keeps regular notices after the important group ends", async () => {
    vi.mocked(listNotices).mockImplementation(async (importance, cursor) => {
      if (importance === "important")
        return page([notice("old", "2026-08-01T00:00:00Z")], "unneeded");
      return cursor === undefined
        ? page([notice("future", "2026-09-15T15:00:00Z")], "page2")
        : page([notice("last", "2026-09-15T14:59:59Z"), notice("early", "2026-09-08T14:59:59Z")]);
    });
    const result = await loadStudentFollowups(period, today, () => true, vi.fn());
    expect(result.contentCount).toBe(1);
    expect(listNoticeConfirmations).toHaveBeenCalledWith("last", "unread", undefined);
    expect(listNotices).not.toHaveBeenCalledWith("important", "unneeded");
  });

  it("loads all student pages and rejects a repeated cursor instead of showing a partial result", async () => {
    vi.mocked(listNotices).mockImplementation(async (importance) =>
      page(importance === "regular" ? [notice()] : []),
    );
    vi.mocked(listNoticeConfirmations).mockImplementation(async (_id, _state, cursor) => ({
      ...confirmations(
        [
          {
            ...member,
            member_id: cursor === undefined ? "s1" : "s2",
            confirmation_state: "unread",
          },
        ],
        2,
      ),
      next_cursor: cursor === undefined ? "next" : null,
    }));
    expect((await loadStudentFollowups(period, today, () => true, vi.fn())).students).toHaveLength(
      2,
    );
    vi.mocked(listNotices).mockResolvedValue(page([notice()], "loop"));
    await expect(loadStudentFollowups(period, today, () => true, vi.fn())).rejects.toThrow(
      "끝까지 조회하지 못했어요",
    );
  });

  it("rejects revision changes and missing recipients instead of reporting no unresolved students", async () => {
    vi.mocked(listNotices).mockImplementation(async (importance) =>
      page(importance === "regular" ? [notice()] : []),
    );
    vi.mocked(listNoticeConfirmations).mockResolvedValue({
      ...confirmations(),
      content_revision: "3",
    });
    await expect(loadStudentFollowups(period, today, () => true, vi.fn())).rejects.toThrow(
      "현황이 바뀌었어요",
    );
    vi.mocked(listNoticeConfirmations).mockResolvedValue(confirmations([], 1));
    await expect(loadStudentFollowups(period, today, () => true, vi.fn())).rejects.toThrow(
      "현황이 바뀌었어요",
    );
  });

  it("does not treat a failed request as an empty successful result", async () => {
    vi.mocked(listSupplies).mockRejectedValue(new Error("connection lost"));
    await expect(loadStudentFollowups(period, today, () => true, vi.fn())).rejects.toThrow(
      "connection lost",
    );
  });

  it("stops before further pages and member requests after cancellation", async () => {
    let active = true;
    vi.mocked(listNotices).mockImplementation(async () => {
      active = false;
      return page([notice()], "next");
    });
    await expect(loadStudentFollowups(period, today, () => active, vi.fn())).rejects.toThrow(
      "중지",
    );
    expect(listNoticeConfirmations).not.toHaveBeenCalled();
  });

  it("avoids irrelevant supply scopes and rejects periods beyond the API visibility window", async () => {
    await loadStudentFollowups({ from: today, to: today }, today, () => true, vi.fn());
    expect(listSupplies).toHaveBeenCalledTimes(1);
    expect(listSupplies).toHaveBeenCalledWith("upcoming", undefined);
    expect(validateFollowupPeriod({ from: "2026-01-01", to: today }, today)).toContain("90일");
    expect(validateFollowupPeriod({ from: "2026-08-01", to: today }, today)).toContain("31일");
    expect(validateFollowupPeriod({ from: today, to: "2026-09-14" }, today)).toContain("종료일");
    expect(validateFollowupPeriod({ from: "2026-02-30", to: today }, today)).toContain("입력");
  });
});
