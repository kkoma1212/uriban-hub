import { useEffect, useRef, useState } from "react";
import {
  applyReviewRow,
  getReviewSource,
  readReviewImpact,
  requireReviewTeacher,
  type ReviewImpact,
} from "./change-review-api";
import {
  desiredResultMatches,
  makeReviewPlan,
  makeReviewRow,
  normalizedFields,
  reviewRowKey,
  storeReviewPlan,
  validateReviewPlan,
  type ReviewKind,
  type ReviewPlan,
  type ReviewRow,
} from "./change-review-model";

type Impacts = Record<string, ReviewImpact | undefined>;
export function useChangeReview(initial: ReviewPlan) {
  const [plan, setPlan] = useState(initial),
    current = useRef(initial);
  const [busy, setBusy] = useState(false),
    busyRef = useRef(false),
    alive = useRef(true);
  const [error, setError] = useState<string>(),
    [saveFailed, setSaveFailed] = useState(false);
  const [reviewed, setReviewed] = useState(false),
    [impacts, setImpacts] = useState<Impacts>({});
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function commit(next: ReviewPlan, required = false): void {
    if (!alive.current) throw new Error("검토 화면을 닫았어요.");
    try {
      storeReviewPlan(next);
      setSaveFailed(false);
    } catch {
      setSaveFailed(true);
      if (required)
        throw new Error(
          "검토 진행 상태를 저장하지 못해 적용을 멈췄어요. 이미 반영된 항목은 결과를 다시 확인해 주세요.",
        );
    }
    current.current = next;
    setPlan(next);
  }
  async function work(action: () => Promise<void>): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      if (alive.current) {
        setReviewed(false);
        setError(failure instanceof Error ? failure.message : "변경 내용을 확인하지 못했어요.");
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function inspect(planToCheck: ReviewPlan): Promise<ReviewPlan> {
    await requireReviewTeacher(planToCheck.membershipId);
    const rows: ReviewRow[] = [];
    for (const row of planToCheck.rows) {
      if (!alive.current) throw new Error("검토 화면을 닫았어요.");
      const latest = await getReviewSource(row.source.kind, row.source.id);
      if (
        (row.status === "done" || row.status === "unknown") &&
        desiredResultMatches(row, latest)
      ) {
        rows.push({ ...row, status: "done" });
        continue;
      }
      if (row.status === "done" || latest.etag !== row.source.etag) {
        if (row.status !== "done")
          commit({
            ...current.current,
            rows: current.current.rows.map((item) =>
              reviewRowKey(item.source) === reviewRowKey(row.source)
                ? { ...item, status: "conflict" }
                : item,
            ),
          });
        throw new Error(
          `‘${row.source.title}’이 다른 곳에서 수정됐어요. 완료된 변경을 확인하고 최신 내용으로 다시 검토해 주세요.`,
        );
      }
      rows.push({ ...row, status: "waiting" });
    }
    return { ...planToCheck, rows };
  }
  async function inspectImpacts(next: ReviewPlan): Promise<Impacts> {
    const results = await Promise.all(
      next.rows
        .filter((row) => row.status !== "done")
        .map(
          async (row) => [reviewRowKey(row.source), await readReviewImpact(row.source)] as const,
        ),
    );
    if (!alive.current) throw new Error("검토 화면을 닫았어요.");
    return Object.fromEntries(results);
  }
  function editRow(key: string, change: Partial<Pick<ReviewRow, "decision" | "draft">>): void {
    if (busyRef.current || current.current.started) return;
    const next = {
      ...current.current,
      rows: current.current.rows.map((row) =>
        row.status !== "done" && reviewRowKey(row.source) === key ? { ...row, ...change } : row,
      ),
    };
    commit(next);
    setReviewed(false);
    setError(undefined);
    setImpacts({});
  }
  function removeRow(key: string): void {
    if (busyRef.current || current.current.started) return;
    commit({
      ...current.current,
      rows: current.current.rows.filter(
        (row) =>
          row.source.kind === "schedule" ||
          row.status === "done" ||
          reviewRowKey(row.source) !== key,
      ),
    });
    setReviewed(false);
    setImpacts({});
  }
  async function addRow(kind: Exclude<ReviewKind, "schedule">, id: string): Promise<void> {
    if (current.current.started) return;
    await work(async () => {
      if (current.current.rows.length >= 9)
        throw new Error("관련 안내는 한 번에 8개까지 검토할 수 있어요.");
      if (current.current.rows.some((row) => reviewRowKey(row.source) === `${kind}:${id}`)) return;
      const source = await getReviewSource(kind, id);
      commit({ ...current.current, rows: [...current.current.rows, makeReviewRow(source)] });
      setReviewed(false);
      setImpacts({});
    });
  }
  async function review(): Promise<void> {
    await work(async () => {
      const issue = validateReviewPlan(current.current);
      if (issue !== undefined) throw new Error(issue);
      const next = await inspect(current.current);
      commit(next);
      const nextImpacts = await inspectImpacts(next);
      setImpacts(nextImpacts);
      setReviewed(true);
    });
  }
  async function apply(): Promise<void> {
    if (!reviewed) return;
    await work(async () => {
      const checked = await inspect(current.current),
        latestImpacts = await inspectImpacts(checked);
      if (JSON.stringify(latestImpacts) !== JSON.stringify(impacts)) {
        setImpacts(latestImpacts);
        throw new Error("학생 확인 현황이 바뀌었어요. 변경 영향을 다시 검토한 뒤 적용해 주세요.");
      }
      let next = {
        ...checked,
        started: true,
        rows: checked.rows.map((row) => ({ ...row, draft: normalizedFields(row.draft) })),
      };
      commit(next, true);
      setReviewed(false);
      for (let index = 0; index < next.rows.length; index += 1) {
        const row = next.rows[index];
        if (row === undefined || row.decision === "keep" || row.status === "done") continue;
        if (!alive.current) return;
        // Persist the exact conditional intent BEFORE sending; an interrupted tab resumes by reading its result.
        next = {
          ...next,
          rows: next.rows.map((item, position) =>
            position === index ? { ...item, status: "unknown" as const } : item,
          ),
        };
        commit(next, true);
        try {
          await applyReviewRow(row);
          if (!alive.current) return;
          const actual = await getReviewSource(row.source.kind, row.source.id);
          if (!desiredResultMatches(row, actual))
            throw new Error("변경 후 내용을 다시 확인해야 해요.");
          next = {
            ...next,
            rows: next.rows.map((item, position) =>
              position === index ? { ...item, status: "done" as const } : item,
            ),
          };
          commit(next, true);
        } catch (failure) {
          throw new Error(
            `‘${row.source.title}’의 결과 확인에서 멈췄어요. 앞서 완료된 변경은 유지됩니다. 결과를 다시 확인한 뒤 남은 항목을 적용해 주세요.${failure instanceof Error ? ` (${failure.message})` : ""}`,
          );
        }
      }
      setReviewed(true);
    });
  }
  async function refreshSources(): Promise<void> {
    if (current.current.rows.some((row) => row.status === "unknown")) return;
    await work(async () => {
      await requireReviewTeacher(current.current.membershipId);
      const rows = await Promise.all(
        current.current.rows.map(async (row) => {
          const latest = await getReviewSource(row.source.kind, row.source.id);
          if (row.status === "done") {
            if (!desiredResultMatches(row, latest))
              throw new Error(
                "완료된 항목이 이후 다시 수정됐어요. 현재 내용을 확인한 뒤 새 검토를 시작해 주세요.",
              );
            return row;
          }
          return {
            ...row,
            source: latest,
            status: "waiting" as const,
            decision: row.source.kind === "schedule" ? ("change" as const) : null,
          };
        }),
      );
      commit({ ...current.current, started: false, rows });
      setImpacts({});
      setReviewed(false);
      setError(
        "최신 원본을 불러왔어요. 완료된 변경과 작성 중인 변경안은 보존했으니 남은 항목의 변경·유지를 다시 선택해 주세요.",
      );
    });
  }
  async function startNew(): Promise<void> {
    if (current.current.rows.some((row) => row.status === "unknown")) {
      setError("먼저 적용 결과를 다시 확인해 주세요.");
      return;
    }
    await work(async () => {
      await requireReviewTeacher(current.current.membershipId);
      const source = await getReviewSource("schedule", current.current.scheduleId);
      commit(makeReviewPlan(current.current.membershipId, source), true);
      setReviewed(false);
      setImpacts({});
    });
  }
  const complete =
    plan.started && plan.rows.every((row) => row.decision === "keep" || row.status === "done");
  return {
    plan,
    busy,
    error,
    saveFailed,
    reviewed,
    impacts,
    complete,
    editRow,
    removeRow,
    addRow,
    review,
    apply,
    refreshSources,
    startNew,
  };
}
