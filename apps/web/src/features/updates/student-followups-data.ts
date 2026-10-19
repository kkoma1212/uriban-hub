import { listNoticeConfirmations } from "../../api/notices";
import { listSupplyChecks } from "../../api/supplies";
import {
  loadPeriodContent,
  periodContentDate,
  type ContentPeriod,
  type PeriodContent,
} from "./period-content";
export {
  shiftCalendarDate,
  validateContentPeriod as validateFollowupPeriod,
} from "./period-content";

export type FollowupPeriod = ContentPeriod;

export interface StudentFollowupItem {
  date: string;
  id: string;
  kind: "notice" | "supply";
  label: "공지" | "준비물" | "숙제";
  lastReminderAt: string | null;
  state: "unread" | "unchecked" | "modified_unconfirmed";
  title: string;
}

export interface StudentFollowup {
  id: string;
  items: StudentFollowupItem[];
  name: string;
  number: number | null;
}

export interface StudentFollowupsResult {
  contentCount: number;
  period: FollowupPeriod;
  students: StudentFollowup[];
}

type Source = PeriodContent;
const changedMessage = "조회 중 안내나 확인 현황이 바뀌었어요. 다시 조회해 주세요.";

/** Existing endpoints enforce class membership and the original recipient snapshot. */
export async function loadStudentFollowups(
  period: FollowupPeriod,
  today: string,
  active: () => boolean,
  onProgress: (completed: number, total: number) => void,
): Promise<StudentFollowupsResult> {
  let stopped = false;
  const checkActive = () => {
    if (stopped || !active()) throw new Error("조회를 중지했어요.");
  };
  const students = new Map<string, StudentFollowup>();
  async function collectMembers(source: Source) {
    const states =
      source.kind === "notice"
        ? (["unread", "modified_unconfirmed"] as const)
        : (["unchecked", "modified_unconfirmed"] as const);
    const membersSeen = new Set<string>();
    let expectedCounts: string | undefined;
    let reminderAt: string | null | undefined;
    for (const state of states) {
      let cursor: string | undefined;
      let count = 0;
      let expected = 0;
      let modifiedCount = 0;
      const cursors = new Set<string>();
      do {
        checkActive();
        const response =
          source.kind === "notice"
            ? await listNoticeConfirmations(
                source.item.id,
                state === "unchecked" ? "unread" : state,
                cursor,
              )
            : await listSupplyChecks(
                source.item.id,
                state === "unread" ? "unchecked" : state,
                cursor,
              );
        checkActive();
        const counts =
          source.kind === "notice"
            ? { ...response.counts, type: "notice" }
            : { ...response.counts, type: "supply" };
        const signature = JSON.stringify(
          Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
        );
        if (
          response.content_revision !== source.item.content_revision ||
          response.server_today !== today ||
          (expectedCounts !== undefined && signature !== expectedCounts) ||
          (reminderAt !== undefined && reminderAt !== response.last_reminder_requested_at)
        )
          throw new Error(changedMessage);
        expectedCounts = signature;
        reminderAt = response.last_reminder_requested_at;
        expected = (response.counts as unknown as Record<string, number>)[state] ?? -1;
        modifiedCount = response.counts.modified_unconfirmed;
        for (const member of response.items) {
          const memberState =
            "confirmation_state" in member ? member.confirmation_state : member.check_state;
          if (memberState !== state || membersSeen.has(member.member_id))
            throw new Error(changedMessage);
          membersSeen.add(member.member_id);
          count += 1;
          const student = students.get(member.member_id) ?? {
            id: member.member_id,
            name: member.display_name,
            number: member.student_number,
            items: [],
          };
          student.items.push({
            id: source.item.id,
            kind: source.kind,
            label:
              source.kind === "notice"
                ? "공지"
                : source.item.category === "homework"
                  ? "숙제"
                  : "준비물",
            title: source.item.title,
            date: periodContentDate(source),
            state,
            lastReminderAt: response.last_reminder_requested_at,
          });
          students.set(student.id, student);
        }
        cursor = response.next_cursor ?? undefined;
        if (cursor !== undefined) {
          if (response.items.length === 0 || cursors.has(cursor) || cursors.size >= 30)
            throw new Error("학생 목록을 끝까지 조회하지 못했어요. 다시 조회해 주세요.");
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      if (count !== expected) throw new Error(changedMessage);
      if (modifiedCount === 0) return;
    }
  }

  try {
    const queue = await loadPeriodContent(period, today, active);
    let index = 0;
    let completed = 0;
    onProgress(0, queue.length);
    async function worker() {
      while (index < queue.length) {
        checkActive();
        const source = queue[index++];
        if (source === undefined) return;
        await collectMembers(source);
        checkActive();
        onProgress(++completed, queue.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
    checkActive();
    const ordered = [...students.values()].sort(
      (a, b) =>
        (a.number ?? Infinity) - (b.number ?? Infinity) ||
        a.name.localeCompare(b.name, "ko") ||
        a.id.localeCompare(b.id),
    );
    for (const student of ordered)
      student.items.sort(
        (a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, "ko"),
      );
    return { contentCount: queue.length, period, students: ordered };
  } finally {
    stopped = true;
  }
}
