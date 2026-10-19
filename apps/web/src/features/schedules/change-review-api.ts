import { getBootstrap } from "../../api/auth";
import { getNotice, listNoticeConfirmations, updateNotice } from "../../api/notices";
import { getSchedule, updateSchedule } from "../../api/schedules";
import { getSupply, listSupplyChecks, updateSupply } from "../../api/supplies";
import {
  normalizedFields,
  type ReviewKind,
  type ReviewRow,
  type ReviewSnapshot,
} from "./change-review-model";

export interface ReviewImpact {
  confirmed: number;
  unconfirmed: number;
  modified: number;
  excluded: number;
  members: { id: string; name: string; number: number | null }[];
}
export async function requireReviewTeacher(expectedMembershipId?: string): Promise<string> {
  const bootstrap = await getBootstrap(),
    member = bootstrap.current_membership;
  if (
    bootstrap.destination !== "HOME" ||
    member?.role !== "teacher" ||
    member.status !== "approved" ||
    !bootstrap.allowed_actions.includes("MANAGE_CLASS") ||
    (expectedMembershipId !== undefined && member.id !== expectedMembershipId)
  )
    throw new Error("이 반의 선생님으로 로그인한 뒤 변경 내용을 다시 확인해 주세요.");
  return member.id;
}
export async function getReviewSource(kind: ReviewKind, id: string): Promise<ReviewSnapshot> {
  if (kind === "schedule") {
    const { item, etag } = await getSchedule(id);
    return {
      kind,
      id: item.id,
      etag,
      rowVersion: item.row_version,
      title: item.title,
      body: item.description ?? "",
      date: item.due_date,
      meta: { scheduleType: item.schedule_type, subject: item.subject },
    };
  }
  if (kind === "notice") {
    const { item, etag } = await getNotice(id);
    return {
      kind,
      id: item.id,
      etag,
      rowVersion: item.row_version,
      title: item.title,
      body: item.content,
      date: "",
      contentRevision: item.content_revision,
      meta: { category: item.category, important: item.is_important },
    };
  }
  const { item, etag } = await getSupply(id);
  return {
    kind,
    id: item.id,
    etag,
    rowVersion: item.row_version,
    title: item.title,
    body: item.description ?? "",
    date: item.needed_on,
    contentRevision: item.content_revision,
    meta: { category: item.category },
  };
}
export async function applyReviewRow(row: ReviewRow): Promise<void> {
  const source = row.source,
    draft = normalizedFields(row.draft);
  if (source.kind === "schedule") {
    await updateSchedule(
      source.id,
      {
        title: draft.title,
        description: draft.body || null,
        due_date: draft.date,
        subject: source.meta.subject,
        schedule_type: source.meta.scheduleType,
      },
      source.etag,
    );
    return;
  }
  if (source.kind === "notice") {
    await updateNotice(
      source.id,
      {
        title: draft.title,
        content: draft.body,
        category: source.meta.category,
        is_important: source.meta.important,
      },
      source.etag,
    );
    return;
  }
  await updateSupply(
    source.id,
    {
      title: draft.title,
      description: draft.body || null,
      needed_on: draft.date,
      category: source.meta.category,
    },
    source.etag,
  );
}
export async function readReviewImpact(source: ReviewSnapshot): Promise<ReviewImpact | undefined> {
  if (source.kind === "schedule") return undefined;
  let cursor: string | undefined;
  let impact: ReviewImpact | undefined;
  const seen = new Set<string>();
  const seenCursors = new Set<string>();
  do {
    const result =
      source.kind === "notice"
        ? await listNoticeConfirmations(source.id, "confirmed", cursor)
        : await listSupplyChecks(source.id, "checked", cursor);
    if (result.content_revision !== source.contentRevision)
      throw new Error("내용이 변경되어 학생별 영향을 다시 확인해야 해요.");
    const counts = result.counts;
    const next = {
      confirmed: "confirmed" in counts ? counts.confirmed : counts.checked,
      unconfirmed: "unread" in counts ? counts.unread : counts.unchecked,
      modified: counts.modified_unconfirmed,
      excluded: counts.excluded_member_count,
    };
    if (
      impact !== undefined &&
      (impact.confirmed !== next.confirmed ||
        impact.unconfirmed !== next.unconfirmed ||
        impact.modified !== next.modified)
    )
      throw new Error("확인 현황이 바뀌었어요. 변경 영향을 다시 확인해 주세요.");
    impact ??= { ...next, members: [] };
    for (const item of result.items)
      if (!seen.has(item.member_id)) {
        seen.add(item.member_id);
        impact.members.push({
          id: item.member_id,
          name: item.display_name,
          number: item.student_number,
        });
      }
    cursor = result.next_cursor ?? undefined;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor) || seenCursors.size >= 20)
        throw new Error("학생 확인 목록을 끝까지 확인하지 못했어요. 다시 확인해 주세요.");
      seenCursors.add(cursor);
    }
    if (seen.size > 600 || (cursor !== undefined && result.items.length === 0))
      throw new Error("학생 확인 목록을 끝까지 확인하지 못했어요. 다시 확인해 주세요.");
  } while (cursor !== undefined);
  if (impact.members.length !== impact.confirmed)
    throw new Error("확인 현황이 바뀌었어요. 변경 영향을 다시 확인해 주세요.");
  return impact;
}
