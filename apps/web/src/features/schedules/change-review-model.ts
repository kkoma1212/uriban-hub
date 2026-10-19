import { z } from "zod";
import { codePointLength } from "../../lib/text";
import { addScheduleCalendarDays } from "./schedule-calendar-date";

const identifier = z.string().regex(/^[1-9][0-9]{0,18}$/u);
const fields = z.object({ title: z.string(), body: z.string(), date: z.string() });
const common = {
  id: identifier,
  etag: z.string().regex(/^"[1-9][0-9]*"$/u),
  rowVersion: identifier,
  title: z.string(),
  body: z.string(),
  date: z.string(),
};
const snapshotSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("schedule"),
    meta: z.object({
      scheduleType: z.enum(["assignment", "exam", "other", "performance"]),
      subject: z.string().nullable(),
    }),
  }),
  z.object({
    ...common,
    kind: z.literal("notice"),
    contentRevision: identifier,
    meta: z.object({ category: z.enum(["general", "performance"]), important: z.boolean() }),
  }),
  z.object({
    ...common,
    kind: z.literal("supply"),
    contentRevision: identifier,
    meta: z.object({ category: z.enum(["general", "homework"]) }),
  }),
]);
const rowSchema = z.object({
  source: snapshotSchema,
  draft: fields,
  decision: z.enum(["change", "keep"]).nullable(),
  status: z.enum(["waiting", "unknown", "done", "conflict"]),
});
const planSchema = z
  .object({
    version: z.literal(1),
    membershipId: identifier,
    scheduleId: identifier,
    started: z.boolean(),
    rows: z.array(rowSchema).min(1).max(9),
  })
  .refine(
    (plan) =>
      plan.rows[0]?.source.kind === "schedule" &&
      plan.rows[0].source.id === plan.scheduleId &&
      plan.rows.slice(1).every((row) => row.source.kind !== "schedule") &&
      new Set(plan.rows.map((row) => reviewRowKey(row.source))).size === plan.rows.length &&
      plan.rows.every((row) => row.source.etag === `"${row.source.rowVersion}"`),
  );

export type ReviewSnapshot = z.infer<typeof snapshotSchema>;
export type ReviewKind = ReviewSnapshot["kind"];
export type ReviewFields = z.infer<typeof fields>;
export type ReviewRow = z.infer<typeof rowSchema>;
export type ReviewPlan = z.infer<typeof planSchema>;

export function reviewRowKey(source: Pick<ReviewSnapshot, "kind" | "id">): string {
  return `${source.kind}:${source.id}`;
}
export function reviewPath(source: Pick<ReviewSnapshot, "kind" | "id">): string {
  return `/${source.kind === "schedule" ? "schedules" : source.kind === "notice" ? "notices" : "supplies"}/${source.id}`;
}
export function reviewLabel(source: ReviewSnapshot): string {
  return source.kind === "schedule"
    ? "일정"
    : source.kind === "notice"
      ? "공지"
      : source.meta.category === "homework"
        ? "숙제"
        : "준비물";
}
export function reviewStorageKey(membershipId: string, scheduleId: string): string {
  return `classhub:change-review:v1:${membershipId}:${scheduleId}`;
}
export function snapshotFields(source: ReviewSnapshot): ReviewFields {
  return { title: source.title, body: source.body, date: source.date };
}
export function normalizedFields(draft: ReviewFields): ReviewFields {
  return { title: draft.title.trim(), body: draft.body.trim(), date: draft.date };
}
export function sameFields(left: ReviewFields, right: ReviewFields): boolean {
  return left.title === right.title && left.body === right.body && left.date === right.date;
}
export function desiredResultMatches(row: ReviewRow, current: ReviewSnapshot): boolean {
  return (
    reviewRowKey(row.source) === reviewRowKey(current) &&
    sameFields(normalizedFields(row.draft), snapshotFields(current)) &&
    JSON.stringify(row.source.meta) === JSON.stringify(current.meta)
  );
}
export function makeReviewRow(source: ReviewSnapshot): ReviewRow {
  return {
    source,
    draft: snapshotFields(source),
    decision: source.kind === "schedule" ? "change" : null,
    status: "waiting",
  };
}
export function makeReviewPlan(membershipId: string, source: ReviewSnapshot): ReviewPlan {
  const row = makeReviewRow(source);
  row.draft.date = "";
  return { version: 1, membershipId, scheduleId: source.id, started: false, rows: [row] };
}
export function readReviewPlan(membershipId: string, scheduleId: string): ReviewPlan | undefined {
  try {
    const raw = window.sessionStorage.getItem(reviewStorageKey(membershipId, scheduleId));
    if (raw === null || raw.length > 60_000) return undefined;
    const parsed = planSchema.safeParse(JSON.parse(raw));
    return parsed.success &&
      parsed.data.membershipId === membershipId &&
      parsed.data.scheduleId === scheduleId
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}
export function storeReviewPlan(plan: ReviewPlan): void {
  const key = reviewStorageKey(plan.membershipId, plan.scheduleId),
    value = JSON.stringify(plan);
  window.sessionStorage.setItem(key, value);
  if (window.sessionStorage.getItem(key) !== value)
    throw new Error("검토 내용의 저장을 확인할 수 없어요.");
}
export function validateReviewPlan(plan: ReviewPlan): string | undefined {
  const root = plan.rows[0];
  if (root === undefined || root.source.kind !== "schedule" || root.decision !== "change")
    return "기준 일정을 확인해 주세요.";
  if (!plan.started && root.draft.date === root.source.date)
    return "변경할 새 일정 날짜를 선택해 주세요.";
  for (const row of plan.rows) {
    const name = row.source.title,
      draft = normalizedFields(row.draft);
    if (row.decision === null) return `‘${name}’을 변경할지 유지할지 선택해 주세요.`;
    if (row.decision === "keep" || row.status === "done") continue;
    if (codePointLength(draft.title) < 1 || codePointLength(draft.title) > 100)
      return `‘${name}’의 제목은 1~100자로 입력해 주세요.`;
    if (
      codePointLength(draft.body) > (row.source.kind === "notice" ? 2000 : 500) ||
      (row.source.kind === "notice" && draft.body === "")
    )
      return `‘${name}’의 ${row.source.kind === "notice" ? "본문은 1~2,000자" : "설명은 500자 이하"}로 입력해 주세요.`;
    if (row.source.kind !== "notice") {
      try {
        if (addScheduleCalendarDays(draft.date, 0) !== draft.date) throw new Error();
      } catch {
        return `‘${name}’의 날짜를 선택해 주세요.`;
      }
    }
    if (sameFields(draft, snapshotFields(row.source)))
      return `‘${name}’은 변경 내용이 없어요. 내용을 수정하거나 유지로 선택해 주세요.`;
  }
  return undefined;
}
