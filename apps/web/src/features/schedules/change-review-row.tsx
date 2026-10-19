import { ArrowRight, ExternalLink, Trash2 } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router";
import type { ReviewImpact } from "./change-review-api";
import { reviewLabel, reviewPath, type ReviewFields, type ReviewRow } from "./change-review-model";

interface Props {
  row: ReviewRow;
  locked: boolean;
  impact: ReviewImpact | undefined;
  scheduleDate: string;
  proposedDate: string;
  onChange: (change: Partial<Pick<ReviewRow, "decision" | "draft">>) => void;
  onRemove: () => void;
}
export function ChangeReviewRow({
  row,
  locked,
  impact,
  scheduleDate,
  proposedDate,
  onChange,
  onRemove,
}: Props): React.JSX.Element {
  const id = useId(),
    source = row.source,
    disabled = locked || row.status === "done",
    label = reviewLabel(source);
  function changeField(key: keyof ReviewFields, value: string): void {
    onChange({ draft: { ...row.draft, [key]: value } });
  }
  const status =
    row.status === "done"
      ? "적용 완료"
      : row.status === "unknown"
        ? "결과 확인 필요"
        : row.status === "conflict"
          ? "다른 수정 확인 필요"
          : row.decision === "keep"
            ? "유지"
            : "검토 중";
  return (
    <section
      aria-label={`${source.title} 변경 검토`}
      className="min-w-0 rounded-card border border-app-border bg-app-surface-raised p-5 shadow-sm sm:p-6"
      data-review-row={`${source.kind}:${source.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-extrabold text-role-primary">
            {label} · {status}
          </p>
          <h2 className="mt-2 break-words text-lg font-extrabold text-app-text">{source.title}</h2>
        </div>
        {source.kind === "schedule" || row.status === "done" ? null : (
          <button
            aria-label={`${source.title} 검토에서 제외`}
            className="ui-icon-button ui-button-secondary"
            disabled={disabled}
            onClick={onRemove}
            type="button"
          >
            <Trash2 aria-hidden="true" size={18} />
          </button>
        )}
      </div>
      {source.kind === "schedule" ? (
        <p className="mt-3 text-sm font-semibold text-app-muted">
          기준 일정의 새 날짜와 본문을 검토해 주세요.
        </p>
      ) : (
        <fieldset className="mt-4 grid gap-2 sm:grid-cols-2" disabled={disabled}>
          <legend className="mb-2 text-sm font-bold text-app-text">
            이번 변경에서 처리할 방법
          </legend>
          {(
            [
              ["change", "변경"],
              ["keep", "유지"],
            ] as const
          ).map(([value, text]) => (
            <label
              key={value}
              className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 ${row.decision === value ? "border-role-primary bg-role-soft" : "border-app-border bg-app-surface-muted"}`}
            >
              <input
                checked={row.decision === value}
                className="size-4 shrink-0 accent-role-primary"
                name={`${id}-decision`}
                onChange={() => onChange({ decision: value })}
                type="radio"
              />
              <span className="font-bold text-app-text">{text}</span>
            </label>
          ))}
        </fieldset>
      )}
      {source.kind !== "notice" && source.kind !== "schedule" && source.date !== scheduleDate ? (
        <p className="mt-3 break-keep text-sm leading-6 text-app-muted">
          이 항목의 날짜는 기준 일정과 달라요. 별도 마감일인지 확인한 뒤 변경 또는 유지를 선택해
          주세요.
        </p>
      ) : null}
      <div className="mt-5 grid min-w-0 gap-4 lg:grid-cols-2">
        <div className="min-w-0 rounded-2xl border border-app-border bg-app-surface-muted p-4">
          <h3 className="text-sm font-extrabold text-app-muted">변경 전</h3>
          <p className="mt-3 break-words font-bold text-app-text">{source.title}</p>
          {source.date === "" ? null : (
            <p className="mt-2 font-bold text-role-primary">
              <time dateTime={source.date}>{source.date}</time>
            </p>
          )}
          <p className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-app-text">
            {source.body || "등록된 설명이 없어요."}
          </p>
          <Link
            className="ui-button ui-button-secondary mt-4 min-h-11 text-sm"
            to={reviewPath(source)}
          >
            <ExternalLink aria-hidden="true" size={16} />
            현재 상세 보기
          </Link>
        </div>
        {row.decision !== "change" ? (
          <div className="flex min-w-0 items-center rounded-2xl border border-role-border bg-role-soft p-4 text-sm font-bold leading-6 text-app-text">
            {row.decision === "keep"
              ? "이 항목의 내용·날짜·학생 확인 기록을 유지합니다."
              : "변경 또는 유지를 선택하면 변경안을 검토할 수 있어요."}
          </div>
        ) : (
          <div className="min-w-0 rounded-2xl border border-role-border bg-app-surface p-4">
            <h3 className="flex items-center gap-2 text-sm font-extrabold text-role-primary">
              <ArrowRight aria-hidden="true" size={16} />
              변경 후
            </h3>
            <label className="auth-label mt-4" htmlFor={`${id}-title`}>
              변경할 제목
            </label>
            <input
              className="ui-input mt-2"
              disabled={disabled}
              id={`${id}-title`}
              onChange={(event) => changeField("title", event.target.value)}
              value={row.draft.title}
            />
            {source.kind === "notice" ? null : (
              <div className="mt-4">
                <label className="auth-label" htmlFor={`${id}-date`}>
                  {source.kind === "schedule"
                    ? "새 일정 날짜"
                    : label === "숙제"
                      ? "변경할 마감 날짜"
                      : "변경할 준비 날짜"}
                </label>
                <input
                  className="ui-input mt-2"
                  disabled={disabled}
                  id={`${id}-date`}
                  onChange={(event) => changeField("date", event.target.value)}
                  type="date"
                  value={row.draft.date}
                />
                {source.kind !== "schedule" && proposedDate !== "" ? (
                  <button
                    className="ui-button ui-button-secondary mt-2 min-h-11 text-sm"
                    disabled={disabled}
                    onClick={() => changeField("date", proposedDate)}
                    type="button"
                  >
                    일정 변경일로 맞추기
                  </button>
                ) : null}
              </div>
            )}
            <label className="auth-label mt-4" htmlFor={`${id}-body`}>
              {source.kind === "notice" ? "변경할 공지 본문" : "변경할 설명"}
            </label>
            <textarea
              className="ui-input mt-2 min-h-36 resize-y"
              disabled={disabled}
              id={`${id}-body`}
              onChange={(event) => changeField("body", event.target.value)}
              rows={5}
              value={row.draft.body}
            />
            <p className="mt-2 break-keep text-xs leading-5 text-app-muted">
              본문 속 날짜·요일·별도 마감일도 함께 검토해 주세요.
            </p>
          </div>
        )}
      </div>
      <div
        className="mt-4 rounded-2xl border border-role-border bg-role-soft p-4"
        aria-label="학생에게 미치는 영향"
      >
        {source.kind === "schedule" ? (
          <p className="break-keep text-sm leading-6 text-app-text">
            일정 날짜는 달력과 홈에 반영됩니다. 일정에는 학생 확인 기록이 없어요.
          </p>
        ) : row.status === "done" ? (
          <p className="break-keep text-sm leading-6 text-app-text">
            변경을 반영했어요. 학생의 현재 재확인 상태는 상세 화면에서 확인할 수 있어요.
          </p>
        ) : impact === undefined ? (
          <p className="text-sm leading-6 text-app-text">
            변경 영향을 확인하면 게시 대상과 학생 확인 현황을 볼 수 있어요.
          </p>
        ) : (
          <>
            <p className="break-keep text-sm font-bold leading-6 text-app-text">
              게시 대상 {impact.confirmed + impact.unconfirmed + impact.modified}명 · 이미 확인{" "}
              {impact.confirmed}명 · 미확인 {impact.unconfirmed}명 · 재확인 대기 {impact.modified}명
            </p>
            {row.decision === "keep" ? (
              <p className="mt-2 text-sm text-app-text">
                유지하는 항목의 학생 확인 상태는 바뀌지 않아요.
              </p>
            ) : (
              <details className="mt-2">
                <summary className="flex min-h-11 cursor-pointer items-center break-keep text-sm font-bold text-role-primary">
                  다시 확인이 필요해질 학생 {impact.confirmed}명 보기
                </summary>
                {impact.members.length === 0 ? (
                  <p className="mt-2 text-sm text-app-muted">현재 확인을 마친 학생은 없어요.</p>
                ) : (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {impact.members.map((member) => (
                      <li
                        className="break-words rounded-lg border border-role-border bg-app-surface px-3 py-2 text-sm text-app-text"
                        key={member.id}
                      >
                        {member.number === null ? "" : `${member.number}번 `}
                        {member.name}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            )}
            <p className="mt-2 break-keep text-xs leading-5 text-app-muted">
              확인 현황은 조회 시점 기준이며 학생의 확인에 따라 달라질 수 있어요. 별도 재알림은 상세
              화면에서 선택합니다.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
