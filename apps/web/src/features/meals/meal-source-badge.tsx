import { formatMealDate, formatMealSourceUpdatedAt } from "./meal-format";

interface MealSourceMetadata {
  source?: string;
  source_loaded_on?: string | null;
  source_updated_at?: string;
}

export function MealSourceBadge({
  detailed = false,
  meal,
}: {
  detailed?: boolean;
  meal: MealSourceMetadata;
}): React.JSX.Element | null {
  if (meal.source === "neis") {
    const sourceLoadedOn = meal.source_loaded_on;
    const loadedOn =
      detailed && sourceLoadedOn !== undefined && sourceLoadedOn !== null
        ? formatMealDate(sourceLoadedOn)
        : null;
    return (
      <span
        className="inline-flex max-w-full flex-wrap items-center gap-x-1 rounded-full border border-success-border bg-success-surface px-2 py-1 text-[0.6875rem] font-bold leading-4 text-success-text"
        data-meal-source="neis"
      >
        <span>교육청(나이스) 정보</span>
        {loadedOn === null || sourceLoadedOn === undefined || sourceLoadedOn === null ? null : (
          <>
            <span aria-hidden="true">·</span>
            <time dateTime={sourceLoadedOn} data-meal-source-loaded-on>
              {loadedOn} 기준
            </time>
          </>
        )}
      </span>
    );
  }
  if (meal.source !== "seed") return null;
  const updatedAt =
    detailed && meal.source_updated_at !== undefined
      ? formatMealSourceUpdatedAt(meal.source_updated_at)
      : null;

  return (
    <span
      className="inline-flex max-w-full flex-wrap items-center gap-x-1 rounded-full border border-warning-border bg-warning-surface px-2 py-1 text-[0.6875rem] font-bold leading-4 text-warning-text"
      data-meal-source="seed"
    >
      {/*
        "임시 데이터"는 학생에게 "가짜"로 읽혔다(2026-08-10 Hex 지적). 실제 뜻은
        "학교 급식 연동으로 들어온 것이 아니라 사람이 넣었다"이므로 그대로 적는다.
        급식이 아예 없는 날은 여기까지 오지 않는다 — 그건 "등록된 급식이 없어요"다.
      */}
      <span>학교 연동 정보 없음</span>
      <span className="text-[0.625rem] font-semibold opacity-90">직접 등록</span>
      {updatedAt === null || meal.source_updated_at === undefined ? null : (
        <>
          <span aria-hidden="true">·</span>
          <time dateTime={meal.source_updated_at} data-meal-source-updated-at>
            {updatedAt}
          </time>
        </>
      )}
    </span>
  );
}
