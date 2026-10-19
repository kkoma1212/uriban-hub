// .content-filter 기간 버튼 스타일. 주소로 바로 열면 다른 화면이 이 CSS를 먼저 불러 주지 않는다(총검수 B4-01).
import "../layout/content-frame.css";
import { shiftCalendarDate, type ContentPeriod } from "./period-content";

interface ContentPeriodFormProps {
  busy: boolean;
  includeUpcoming?: boolean;
  onChange: (period: ContentPeriod) => void;
  onQuickSelect?: (period: ContentPeriod) => void;
  onSubmit: () => void;
  period: ContentPeriod;
  submitLabel: string;
  today: string;
}

export function ContentPeriodForm({
  busy,
  includeUpcoming = false,
  onChange,
  onQuickSelect = onChange,
  onSubmit,
  period,
  submitLabel,
  today,
}: ContentPeriodFormProps): React.JSX.Element {
  const presets = [
    { label: "최근 7일", from: -6, to: 0 },
    { label: "최근 30일", from: -29, to: 0 },
  ];
  if (includeUpcoming) presets.push({ label: "오늘부터 7일", from: 0, to: 6 });
  return (
    <form
      className="rounded-2xl border border-app-border bg-app-surface-raised p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="grid min-w-0 gap-2 text-sm font-bold text-app-text">
          시작일
          <input
            className="ui-input min-h-11 min-w-0 w-full"
            min={shiftCalendarDate(today, -90)}
            required
            type="date"
            value={period.from}
            onChange={(event) => onChange({ ...period, from: event.target.value })}
          />
        </label>
        <label className="grid min-w-0 gap-2 text-sm font-bold text-app-text">
          종료일
          <input
            className="ui-input min-h-11 min-w-0 w-full"
            min={period.from}
            required
            type="date"
            value={period.to}
            onChange={(event) => onChange({ ...period, to: event.target.value })}
          />
        </label>
        <button
          className="ui-button ui-button-primary col-span-2 min-h-11 px-5 sm:col-span-1"
          disabled={busy}
          type="submit"
        >
          {busy ? "불러오는 중" : submitLabel}
        </button>
      </div>
      <div aria-label="기간 빠른 선택" className="mt-3 flex flex-wrap gap-1.5" role="group">
        {presets.map((option) => (
          <button
            aria-pressed={
              period.from === shiftCalendarDate(today, option.from) &&
              period.to === shiftCalendarDate(today, option.to)
            }
            className="content-filter"
            key={option.label}
            type="button"
            onClick={() =>
              onQuickSelect({
                from: shiftCalendarDate(today, option.from),
                to: shiftCalendarDate(today, option.to),
              })
            }
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs leading-5 text-app-muted">
        공지 게시일 · 준비물·숙제 예정일 기준이에요. 과거 90일까지, 한 번에 최대 31일을 조회할 수
        있어요.
      </p>
    </form>
  );
}
