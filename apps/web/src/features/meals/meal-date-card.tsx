import { Soup } from "lucide-react";
import { useState } from "react";

import type { MealItem } from "../../api/meals";
import { AsyncStatePanel } from "../layout/async-state";
import { allergenSummary, formatMealDate } from "./meal-format";
import { MealSourceBadge } from "./meal-source-badge";

interface MealMenuListProps {
  compact?: boolean;
  meal: MealItem;
  /** PC 넓은 칸(오늘 급식)에서는 메뉴를 두 칸으로 — 한 화면에 들어와 본문 스크롤이 생기지 않게(2026-09-30 사용자). */
  twoColumns?: boolean;
}

export function MealMenuList({
  meal,
  compact = false,
  twoColumns = false,
}: MealMenuListProps): React.JSX.Element {
  const [allergensOpen, setAllergensOpen] = useState(false);
  const flagged = meal.menu.filter((item) => item.allergens.length > 0);

  return (
    <div>
      <ul
        className={
          "min-w-0 divide-y divide-dashed divide-app-border" +
          (twoColumns ? " lg:grid lg:grid-cols-2 lg:gap-x-8 lg:divide-y-0" : "")
        }
        data-meal-menu-list
      >
        {meal.menu.map((item, index) => (
          <li
            className={
              "flex min-w-0 items-start justify-between gap-3 py-3 first:pt-0" +
              (twoColumns
                ? " lg:border-t lg:border-dashed lg:border-app-border lg:[&:nth-child(-n+2)]:border-t-0 lg:[&:nth-child(-n+2)]:pt-0"
                : "")
            }
            key={`${item.name}-${index}`}
          >
            <p className="min-w-0 flex-1 break-words text-[17px] font-bold leading-7 text-app-text [overflow-wrap:anywhere]">
              {item.name}
            </p>
            {item.allergens.length === 0 ? null : (
              <span
                aria-label={`알레르기 번호 ${item.allergens.join(", ")}`}
                className="mt-1 max-w-[42%] shrink-0 rounded-md bg-app-surface-muted px-2 py-1 text-right text-[11px] font-bold leading-4 text-app-muted [overflow-wrap:anywhere]"
                data-meal-allergen-numbers
              >
                <span className="sr-only">알레르기 있음 · </span>
                {item.allergens.join(" · ")}
              </span>
            )}
          </li>
        ))}
      </ul>

      {flagged.length === 0 ? (
        <p className="mt-3 text-xs font-medium text-app-muted">
          이 식단에는 표시된 알레르기 정보가 없어요.
        </p>
      ) : (
        <>
          <button
            aria-expanded={allergensOpen}
            className="ui-button ui-button-secondary mt-3 min-h-11 px-3 text-sm"
            onClick={() => setAllergensOpen((open) => !open)}
            type="button"
          >
            {allergensOpen
              ? "알레르기 정보 접기"
              : compact
                ? `알레르기 보기 (${flagged.length})`
                : `알레르기 정보 보기 (메뉴 ${flagged.length}가지)`}
          </button>
          {allergensOpen ? (
            <ul className="mt-3 space-y-2">
              {flagged.map((item, index) => (
                <li
                  className="min-w-0 rounded-2xl border border-app-border bg-app-surface-muted px-4 py-3"
                  key={`allergen-${item.name}-${index}`}
                >
                  <p className="break-words font-bold text-app-text [overflow-wrap:anywhere]">
                    {item.name}
                  </p>
                  <p className="mt-1 break-words text-xs font-medium leading-5 text-app-muted [overflow-wrap:anywhere]">
                    알레르기 {allergenSummary(item.allergens)}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

export function MealCalorieInfo({ meal }: { meal: MealItem }): React.JSX.Element {
  return (
    <p className="text-sm font-bold text-app-muted">
      {meal.calorie_kcal === null
        ? "칼로리 정보가 제공되지 않았어요."
        : `총 ${meal.calorie_kcal.toFixed(1)} kcal`}
    </p>
  );
}

export function EmptyMeal({
  compact = false,
  today,
}: {
  compact?: boolean;
  today: boolean;
}): React.JSX.Element {
  if (compact) {
    return (
      <div className="rounded-2xl border border-app-border bg-app-surface-muted px-3 py-5 text-center">
        <Soup aria-hidden="true" className="mx-auto text-home-meal" size={23} />
        <p className="mt-2 break-keep text-sm font-bold text-app-muted">급식 정보가 없어요.</p>
      </div>
    );
  }
  return (
    <AsyncStatePanel
      description="급식 정보가 등록되면 이곳에 바로 보여드릴게요."
      icon={Soup}
      kind="empty"
      title={today ? "오늘 등록된 급식이 없어요." : "이날 등록된 급식이 없어요."}
      tone="meal"
    />
  );
}

interface MealDateCardProps {
  panel?: boolean;
  date: string;
  featured?: boolean;
  id?: string;
  label: string;
  meal?: MealItem;
  mobileSelected?: boolean;
  sourceDetailed?: boolean;
}

export function MealDateCard({
  date,
  featured = false,
  id,
  label,
  meal,
  mobileSelected,
  sourceDetailed = false,
  panel = false,
}: MealDateCardProps): React.JSX.Element {
  const titleId = `${id ?? `meal-date-${date}`}-title`;
  const mobileVisibility =
    mobileSelected === undefined ? "grid" : mobileSelected ? "grid md:grid" : "hidden md:grid";

  return (
    <article
      aria-labelledby={titleId}
      className={`${mobileVisibility} content-card min-w-0 content-start gap-5 p-5 sm:p-7 ${panel ? "h-full" : ""}`}
      data-meal-date-card={date}
      data-mobile-selected={mobileSelected}
      data-today={featured}
      id={id}
    >
      <header className="min-w-0 border-b border-app-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-bold text-app-muted">{label}</span>
          {meal === undefined ? null : <MealSourceBadge detailed={sourceDetailed} meal={meal} />}
        </div>
        <h3 className="mt-2" id={titleId}>
          <time
            className="break-keep text-[21px] font-extrabold leading-8 text-app-text"
            dateTime={date}
          >
            {formatMealDate(date)}
          </time>
        </h3>
        <p className="mt-1 text-xs font-medium text-app-muted">
          {meal === undefined ? "급식 없음" : "급식 있음"}
        </p>
      </header>

      <div className="min-w-0">
        {meal === undefined ? (
          <EmptyMeal compact today={featured} />
        ) : (
          <MealMenuList meal={meal} twoColumns={featured} />
        )}
      </div>

      {meal === undefined ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-app-border pt-4">
          <MealCalorieInfo meal={meal} />
        </div>
      )}
    </article>
  );
}
