import { BookOpen, CalendarDays, ClipboardCheck, FileText, LoaderCircle, Save } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { ScheduleType, ScheduleWriteRequest } from "../../api/schedules";
import { codePointLength } from "../../lib/text";
import {
  ContentInputFrame,
  ContentInputMemo,
  ContentInputPreview,
} from "../layout/content-input-frame";

interface ScheduleFormProps {
  busy: boolean;
  focusTitleOnMount?: boolean;
  initialValue?: ScheduleWriteRequest | undefined;
  locked?: boolean;
  onCancel: () => void;
  onSubmit: (request: ScheduleWriteRequest) => void;
  submitLabel: string;
}

type ScheduleFormField = "description" | "due_date" | "schedule_type" | "subject" | "title";

interface ScheduleFormError {
  field: ScheduleFormField;
  message: string;
}

const EMPTY_VALUE: ScheduleWriteRequest = {
  description: null,
  due_date: "",
  schedule_type: "other",
  subject: null,
  title: "",
};

const TYPE_OPTIONS: Array<{ label: string; value: ScheduleType; icon: typeof CalendarDays }> = [
  { label: "시험", value: "exam", icon: BookOpen },
  { label: "수행평가", value: "performance", icon: ClipboardCheck },
  { label: "과제", value: "assignment", icon: FileText },
  { label: "기타", value: "other", icon: CalendarDays },
];

function isValidDateInput(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function ScheduleForm({
  busy,
  focusTitleOnMount = true,
  initialValue = EMPTY_VALUE,
  locked = false,
  onCancel,
  onSubmit,
  submitLabel,
}: ScheduleFormProps): React.JSX.Element {
  const titleId = useId();
  const subjectId = useId();
  const typeId = useId();
  const dueDateId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const titleHintId = useId();
  const dueDateHintId = useId();
  const [title, setTitle] = useState(initialValue.title);
  const [subject, setSubject] = useState(initialValue.subject ?? "");
  const [scheduleType, setScheduleType] = useState<ScheduleType>(initialValue.schedule_type);
  const [dueDate, setDueDate] = useState(initialValue.due_date);
  const [description, setDescription] = useState(initialValue.description ?? "");
  const [validationError, setValidationError] = useState<ScheduleFormError>();
  const titleInputRef = useRef<HTMLInputElement>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);
  const typeInputRef = useRef<HTMLInputElement>(null);
  const dueDateInputRef = useRef<HTMLInputElement>(null);
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusTitleOnMount) titleInputRef.current?.focus();
  }, [focusTitleOnMount]);

  useEffect(() => {
    if (!locked) return;
    setTitle(initialValue.title);
    setSubject(initialValue.subject ?? "");
    setScheduleType(initialValue.schedule_type);
    setDueDate(initialValue.due_date);
    setDescription(initialValue.description ?? "");
    setValidationError(undefined);
  }, [initialValue, locked]);

  useEffect(() => {
    if (validationError?.field === "title") titleInputRef.current?.focus();
    if (validationError?.field === "subject") subjectInputRef.current?.focus();
    if (validationError?.field === "schedule_type") typeInputRef.current?.focus();
    if (validationError?.field === "due_date") dueDateInputRef.current?.focus();
    if (validationError?.field === "description") descriptionInputRef.current?.focus();
  }, [validationError]);

  function clearFieldError(field: ScheduleFormField): void {
    if (validationError?.field === field) setValidationError(undefined);
  }

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedSubject = subject.trim();
    const trimmedDescription = description.trim();
    const titleLength = codePointLength(trimmedTitle);
    const subjectLength = codePointLength(trimmedSubject);
    const descriptionLength = codePointLength(trimmedDescription);

    if (titleLength < 1 || titleLength > 100) {
      setValidationError({
        field: "title",
        message: "일정 제목은 1자 이상 100자 이하로 입력해 주세요.",
      });
      return;
    }
    if (subjectLength > 30) {
      setValidationError({ field: "subject", message: "과목은 30자 이하로 입력해 주세요." });
      return;
    }
    if (!TYPE_OPTIONS.some((option) => option.value === scheduleType)) {
      setValidationError({ field: "schedule_type", message: "일정 유형을 선택해 주세요." });
      return;
    }
    if (!isValidDateInput(dueDate)) {
      setValidationError({ field: "due_date", message: "일정 날짜를 선택해 주세요." });
      return;
    }
    if (descriptionLength > 500) {
      setValidationError({ field: "description", message: "설명은 500자 이하로 입력해 주세요." });
      return;
    }

    setValidationError(undefined);
    onSubmit({
      description: trimmedDescription === "" ? null : trimmedDescription,
      due_date: dueDate,
      schedule_type: scheduleType,
      subject: trimmedSubject === "" ? null : trimmedSubject,
      title: trimmedTitle,
    });
  }

  const missingField =
    title.trim() === ""
      ? "제목을 적어 주세요"
      : dueDate === ""
        ? "날짜를 선택해 주세요"
        : undefined;
  const selectedType = TYPE_OPTIONS.find((option) => option.value === scheduleType);
  const actions = (
    <div
      aria-label="저장 및 취소"
      className="grid w-full grid-cols-2 gap-2"
      data-form-action-bar="fixed"
      role="group"
    >
      <button
        className="ui-button ui-button-secondary min-h-[52px]"
        disabled={busy}
        onClick={onCancel}
        type="button"
      >
        취소
      </button>
      <button
        aria-busy={busy}
        className="ui-button content-input-submit min-h-[52px]"
        data-incomplete={!locked && missingField !== undefined}
        disabled={busy || (!locked && missingField !== undefined)}
        type="submit"
      >
        {busy ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
        ) : (
          <Save aria-hidden="true" size={18} />
        )}
        {locked ? submitLabel : (missingField ?? submitLabel)}
      </button>
    </div>
  );

  return (
    <form
      aria-busy={busy}
      className="min-w-0"
      data-input-form="schedule"
      noValidate
      onSubmit={submit}
    >
      <h2 className="mb-3 text-2xl font-extrabold tracking-tight text-app-text xl:text-[26px]">
        {submitLabel === "수정 저장" ? "일정 수정" : "새 일정"}
      </h2>
      <ContentInputFrame
        actions={actions}
        preview={
          <ContentInputPreview
            audienceLabel="반 전체"
            content={[subject.trim() ? "과목 · " + subject.trim() : "", description.trim()]
              .filter(Boolean)
              .join("\n")}
            dateLabel={isValidDateInput(dueDate) ? dueDate : "날짜를 선택해 주세요"}
            kind={"일정 · " + (selectedType?.label ?? "기타")}
            title={title.trim() || "일정 제목"}
          />
        }
      >
        <fieldset className="shrink-0" disabled={busy || locked}>
          <legend className="sr-only">일정 유형</legend>
          <div className="grid grid-cols-4 gap-1.5">
            {TYPE_OPTIONS.map((option, index) => {
              const Icon = option.icon;
              return (
                <label
                  className={
                    "flex min-h-[62px] min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-[14px] px-1 text-[13px] font-bold shadow-sm focus-within:ring-2 focus-within:ring-role-primary xl:min-h-14 xl:flex-row xl:gap-2 xl:text-sm " +
                    (scheduleType === option.value
                      ? "bg-role-primary text-app-canvas"
                      : "bg-app-surface text-app-muted")
                  }
                  key={option.value}
                >
                  <input
                    aria-describedby={
                      validationError?.field === "schedule_type" ? errorId : undefined
                    }
                    aria-invalid={validationError?.field === "schedule_type" || undefined}
                    checked={scheduleType === option.value}
                    className="sr-only"
                    name={typeId}
                    onChange={() => {
                      setScheduleType(option.value);
                      clearFieldError("schedule_type");
                    }}
                    ref={index === 0 ? typeInputRef : undefined}
                    type="radio"
                    value={option.value}
                  />
                  <Icon aria-hidden="true" size={21} />
                  {option.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        <ContentInputMemo
          footer={
            <div className="flex w-full justify-between gap-3 text-xs text-app-muted">
              <span>{codePointLength(title.trim())} / 100자</span>
              <span>{codePointLength(description.trim())} / 500자</span>
            </div>
          }
        >
          <label className="sr-only" htmlFor={titleId}>
            일정 제목
          </label>
          <input
            aria-describedby={
              titleHintId + (validationError?.field === "title" ? " " + errorId : "")
            }
            aria-invalid={validationError?.field === "title" || undefined}
            aria-required="true"
            autoComplete="off"
            className="content-input-title"
            disabled={busy || locked}
            id={titleId}
            onChange={(event) => {
              setTitle(event.target.value);
              clearFieldError("title");
            }}
            placeholder="일정 제목"
            ref={titleInputRef}
            required
            value={title}
          />
          <p className="sr-only" id={titleHintId}>
            필수 · 1~100자
          </p>
          <label className="sr-only" htmlFor={descriptionId}>
            설명 (선택)
          </label>
          <textarea
            aria-describedby={validationError?.field === "description" ? errorId : undefined}
            aria-invalid={validationError?.field === "description" || undefined}
            className="content-input-textarea"
            disabled={busy || locked}
            id={descriptionId}
            onChange={(event) => {
              setDescription(event.target.value);
              clearFieldError("description");
            }}
            placeholder="준비 범위나 제출 방법 (안 써도 돼요)"
            ref={descriptionInputRef}
            rows={4}
            value={description}
          />
        </ContentInputMemo>

        <div className="content-input-support">
          <section className="content-card grid gap-3 p-3">
            <div className="grid min-w-0 grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] gap-3">
              <label className="min-w-0 text-[13px] font-bold text-app-muted" htmlFor={subjectId}>
                과목 (선택)
                <input
                  aria-describedby={validationError?.field === "subject" ? errorId : undefined}
                  aria-invalid={validationError?.field === "subject" || undefined}
                  autoComplete="off"
                  className="ui-input ui-input-compact mt-1 min-w-0"
                  disabled={busy || locked}
                  id={subjectId}
                  onChange={(event) => {
                    setSubject(event.target.value);
                    clearFieldError("subject");
                  }}
                  placeholder="예: 수학"
                  ref={subjectInputRef}
                  value={subject}
                />
                <span className="mt-1 block text-right text-xs font-medium">
                  {codePointLength(subject.trim())} / 30자
                </span>
              </label>
              <label className="min-w-0 text-[13px] font-bold text-app-muted" htmlFor={dueDateId}>
                일정 날짜
                <input
                  aria-describedby={
                    dueDateHintId + (validationError?.field === "due_date" ? " " + errorId : "")
                  }
                  aria-invalid={validationError?.field === "due_date" || undefined}
                  aria-required="true"
                  className="ui-input ui-input-compact mt-1 min-w-0"
                  disabled={busy || locked}
                  id={dueDateId}
                  onChange={(event) => {
                    setDueDate(event.target.value);
                    clearFieldError("due_date");
                  }}
                  ref={dueDateInputRef}
                  required
                  type="date"
                  value={dueDate}
                />
              </label>
            </div>
            <p className="text-xs leading-5 text-app-muted" id={dueDateHintId}>
              지난 날짜도 기록할 수 있으며 최근 90일 일정까지 목록에서 보여요.
            </p>
          </section>
          {validationError === undefined ? null : (
            <p
              className="mt-2 rounded-xl border border-danger bg-app-surface px-3 py-2 text-sm font-bold text-danger"
              id={errorId}
              role="alert"
            >
              {validationError.message}
            </p>
          )}
        </div>
      </ContentInputFrame>
    </form>
  );
}
