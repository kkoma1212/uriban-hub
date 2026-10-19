import { CalendarDays, Check, History, LoaderCircle, UsersRound } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { SupplyCategory, SupplyWriteRequest } from "../../api/supplies";
import type { ContentAudienceRequest } from "../../api/content-audiences";
import { codePointLength } from "../../lib/text";
import { ContentFormActionBar } from "../layout/content-form-action-bar";
import {
  ContentInputFrame,
  ContentInputMemo,
  ContentInputPreview,
  ContentInputReview,
} from "../layout/content-input-frame";
import { ContentInputAudience, inputAudienceLabel } from "../updates/content-input-audience";
import { shiftCalendarDate } from "../updates/period-content";
import { ContentAudienceSelector } from "../updates/content-audience-selector";
import { formatSupplyDate } from "./supply-format";

interface SupplyFormProps {
  busy: boolean;
  compositionHeader?: React.ReactNode;
  onLoadPrevious?: () => void;
  serverToday?: string | undefined;
  focusTitleOnMount?: boolean;
  initialValue?: SupplyWriteRequest | undefined;
  locked?: boolean;
  onCancel: () => void;
  onDraftChange?: (request: SupplyWriteRequest) => void;
  onSubmit: (request: SupplyWriteRequest) => void;
  requireAudienceSelection?: boolean;
  selectedAudienceEnabled?: boolean;
  showCategorySelector?: boolean;
  showCompositionSteps?: boolean;
  showPublishSummary?: boolean;
  submitLabel: string;
}

type SupplyFormField = "audience" | "description" | "needed_on" | "title";

interface SupplyFormError {
  field: SupplyFormField;
  message: string;
}

const EMPTY_VALUE: SupplyWriteRequest = {
  audience: { mode: "all" },
  category: "general",
  description: null,
  needed_on: "",
  title: "",
};

/*
 * 숙제와 준비물은 같은 표에 들어가지만 교사가 적는 내용이 다르다. 종류를 고르면
 * 제목 칸의 말과 예시도 따라 바뀌어야 "여기 뭘 적으라는 거지"를 겪지 않는다.
 */
const CATEGORY_OPTIONS: Array<{
  label: string;
  placeholder: string;
  titleLabel: string;
  value: SupplyCategory;
}> = [
  {
    label: "준비물",
    placeholder: "예: 수학 문제집과 자",
    titleLabel: "준비물 제목",
    value: "general",
  },
  {
    label: "숙제",
    placeholder: "예: 수학 익힘책 12~15쪽",
    titleLabel: "숙제 제목",
    value: "homework",
  },
];

function isValidDateInput(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function SupplyForm({
  busy,
  compositionHeader,
  onLoadPrevious,
  serverToday,
  focusTitleOnMount = true,
  initialValue = EMPTY_VALUE,
  locked = false,
  onCancel,
  onDraftChange,
  onSubmit,
  requireAudienceSelection = false,
  selectedAudienceEnabled = false,
  showCategorySelector = true,
  showCompositionSteps = false,
  showPublishSummary = false,
  submitLabel,
}: SupplyFormProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const neededOnId = useId();
  const errorId = useId();
  const titleHintId = useId();
  const neededOnHintId = useId();
  const [audience, setAudience] = useState<ContentAudienceRequest | undefined>(
    initialValue.audience ?? (requireAudienceSelection ? undefined : { mode: "all" }),
  );
  const categoryName = useId();
  const [category, setCategory] = useState<SupplyCategory>(initialValue.category ?? "general");
  const [title, setTitle] = useState(initialValue.title);
  const [description, setDescription] = useState(initialValue.description ?? "");
  const [neededOn, setNeededOn] = useState(initialValue.needed_on);
  const activeCategory =
    CATEGORY_OPTIONS.find((option) => option.value === category) ?? CATEGORY_OPTIONS[0]!;
  const [validationError, setValidationError] = useState<SupplyFormError>();
  const [reviewRequest, setReviewRequest] = useState<SupplyWriteRequest>();
  const publishButtonRef = useRef<HTMLButtonElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);
  const neededOnInputRef = useRef<HTMLInputElement>(null);
  const audienceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusTitleOnMount) titleInputRef.current?.focus();
  }, [focusTitleOnMount]);

  useEffect(() => {
    if (!locked) return;
    setCategory(initialValue.category ?? "general");
    setTitle(initialValue.title);
    setDescription(initialValue.description ?? "");
    setNeededOn(initialValue.needed_on);
    setAudience(initialValue.audience ?? (requireAudienceSelection ? undefined : { mode: "all" }));
    setValidationError(undefined);
  }, [initialValue, locked, requireAudienceSelection]);

  useEffect(() => {
    if (locked || onDraftChange === undefined) return;
    onDraftChange({
      ...(showPublishSummary && audience !== undefined ? { audience } : {}),
      category,
      description: description === "" ? null : description,
      needed_on: neededOn,
      title,
    });
  }, [audience, category, description, locked, neededOn, onDraftChange, showPublishSummary, title]);

  useEffect(() => {
    if (validationError?.field === "title") titleInputRef.current?.focus();
    if (validationError?.field === "description") descriptionInputRef.current?.focus();
    if (validationError?.field === "needed_on") neededOnInputRef.current?.focus();
    if (validationError?.field === "audience") {
      const target = audienceRef.current?.querySelector<HTMLElement>('input[type="radio"], button');
      target?.focus();
    }
  }, [validationError]);

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    const titleLength = codePointLength(trimmedTitle);
    const descriptionLength = codePointLength(trimmedDescription);

    if (titleLength < 1 || titleLength > 100) {
      setValidationError({
        field: "title",
        message: `${activeCategory.titleLabel}은 1자 이상 100자 이하로 입력해 주세요.`,
      });
      return;
    }
    if (descriptionLength > 500) {
      setValidationError({ field: "description", message: "설명은 500자 이하로 입력해 주세요." });
      return;
    }
    if (!isValidDateInput(neededOn)) {
      setValidationError({
        field: "needed_on",
        message:
          category === "homework"
            ? "숙제 마감 날짜를 선택해 주세요."
            : "준비물이 필요한 날짜를 선택해 주세요.",
      });
      return;
    }
    if (showPublishSummary && requireAudienceSelection && audience === undefined) {
      setValidationError({
        field: "audience",
        message: "이번 숙제를 게시할 대상을 선택해 주세요.",
      });
      return;
    }
    if (showPublishSummary && audience?.mode === "selected" && audience.member_ids.length === 0) {
      setValidationError({
        field: "audience",
        message: "게시할 학생을 한 명 이상 선택해 주세요.",
      });
      return;
    }

    setValidationError(undefined);
    const request: SupplyWriteRequest = {
      ...(showPublishSummary && audience !== undefined ? { audience } : {}),
      category,
      description: trimmedDescription === "" ? null : trimmedDescription,
      needed_on: neededOn,
      title: trimmedTitle,
    };
    if (showCompositionSteps && !locked) setReviewRequest(request);
    else onSubmit(request);
  }

  if (showCompositionSteps) {
    const titleLength = codePointLength(title.trim());
    const descriptionLength = codePointLength(description.trim());
    const missing =
      titleLength === 0
        ? "제목을 적어 주세요"
        : titleLength > 100
          ? "제목을 100자 이내로 적어 주세요"
          : descriptionLength > 500
            ? "설명을 500자 이내로 적어 주세요"
            : !isValidDateInput(neededOn)
              ? "날짜를 선택해 주세요"
              : (requireAudienceSelection && audience === undefined) ||
                  (audience?.mode === "selected" && audience.member_ids.length === 0)
                ? "받는 사람을 선택해 주세요"
                : undefined;
    const today =
      serverToday ??
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    const weekday = new Date(today + "T00:00:00Z").getUTCDay();
    const days = [
      { label: "내일", date: shiftCalendarDate(today, 1) },
      { label: "모레", date: shiftCalendarDate(today, 2) },
      { label: "금요일", date: shiftCalendarDate(today, (5 - weekday + 7) % 7 || 7) },
    ];
    const dateLabel =
      neededOn === ""
        ? undefined
        : (category === "homework" ? "마감 · " : "필요한 날 · ") + formatSupplyDate(neededOn);
    const preview = (
      <ContentInputPreview
        kind={activeCategory.label}
        title={title}
        content={description.trim() || "별도 설명 없음"}
        dateLabel={dateLabel}
        audienceLabel={inputAudienceLabel(audience)}
      />
    );
    return (
      <form aria-busy={busy} className="content-input-form" noValidate onSubmit={submit}>
        <ContentInputFrame
          preview={preview}
          actions={
            <>
              <button
                className="ui-button ui-button-secondary"
                disabled={busy}
                onClick={onCancel}
                type="button"
              >
                취소
              </button>
              <button
                className="ui-button content-input-submit"
                data-incomplete={!locked && missing !== undefined}
                disabled={busy}
                ref={publishButtonRef}
                type="submit"
              >
                {busy ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
                ) : (
                  <Check aria-hidden="true" size={18} />
                )}{" "}
                {locked ? submitLabel : (missing ?? "올리기")}
              </button>
            </>
          }
        >
          {compositionHeader}
          {showCategorySelector ? (
            <fieldset className="flex shrink-0 gap-2">
              <legend className="sr-only">종류</legend>
              {CATEGORY_OPTIONS.map((option) => (
                <label className="content-input-options flex-1" key={option.value}>
                  <input
                    checked={category === option.value}
                    className="mr-2"
                    disabled={busy || locked}
                    name={categoryName}
                    onChange={() => setCategory(option.value)}
                    type="radio"
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
          ) : null}
          <ContentInputMemo
            aria-label={activeCategory.label + " 작성 내용"}
            role="region"
            footer={
              <>
                {onLoadPrevious === undefined ? null : (
                  <button disabled={busy || locked} onClick={onLoadPrevious} type="button">
                    <History aria-hidden="true" size={15} />
                    지난 글 불러오기
                  </button>
                )}
                <span>설명 선택 · {descriptionLength} / 500자</span>
              </>
            }
          >
            <label className="sr-only" htmlFor={titleId}>
              {activeCategory.titleLabel}
            </label>
            <input
              aria-describedby={
                titleHintId + (validationError?.field === "title" ? " " + errorId : "")
              }
              aria-invalid={validationError?.field === "title" || undefined}
              autoComplete="off"
              className="content-input-title"
              disabled={busy || locked}
              id={titleId}
              onChange={(event) => {
                setTitle(event.target.value);
                if (validationError?.field === "title") setValidationError(undefined);
              }}
              placeholder={activeCategory.placeholder}
              ref={titleInputRef}
              required
              value={title}
            />
            <span className="sr-only" id={titleHintId}>
              필수 · 1~100자
            </span>
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
                if (validationError?.field === "description") setValidationError(undefined);
              }}
              placeholder="학생들이 빠뜨리지 않도록 필요한 내용을 적어 주세요."
              ref={descriptionInputRef}
              value={description}
            />
          </ContentInputMemo>
          {validationError === undefined || validationError.field === "audience" ? null : (
            <p className="content-input-error" id={errorId} role="alert">
              {validationError.message}
            </p>
          )}
          <div className="content-input-support">
            <section
              className="content-input-options"
              aria-label={category === "homework" ? "마감 날짜 선택" : "필요한 날짜 선택"}
            >
              <p className="mb-2 text-xs font-bold text-app-muted">
                {category === "homework" ? "언제까지" : "언제 필요하나요"}
                {neededOn === "" ? "" : " · " + formatSupplyDate(neededOn)}
              </p>
              <div className="content-input-days">
                {days.map((day) => (
                  <button
                    aria-label={
                      day.label +
                      " " +
                      Number(day.date.slice(5, 7)) +
                      "/" +
                      Number(day.date.slice(8, 10))
                    }
                    aria-pressed={neededOn === day.date}
                    disabled={busy || locked}
                    key={day.label}
                    onClick={() => {
                      setNeededOn(day.date);
                      if (validationError?.field === "needed_on") setValidationError(undefined);
                    }}
                    type="button"
                  >
                    {day.label}
                    <small>
                      {Number(day.date.slice(5, 7)) + "/" + Number(day.date.slice(8, 10))}
                    </small>
                  </button>
                ))}
                <label
                  className="content-input-date-other"
                  data-selected={neededOn !== "" && !days.some((day) => day.date === neededOn)}
                >
                  <CalendarDays aria-hidden="true" size={17} />
                  <span>다른 날</span>
                  <span className="sr-only">
                    {category === "homework" ? "마감 날짜" : "필요한 날짜"}
                  </span>
                  <input
                    aria-label={category === "homework" ? "마감 날짜" : "필요한 날짜"}
                    aria-describedby={
                      neededOnHintId + (validationError?.field === "needed_on" ? " " + errorId : "")
                    }
                    aria-invalid={validationError?.field === "needed_on" || undefined}
                    disabled={busy || locked}
                    id={neededOnId}
                    onChange={(event) => {
                      setNeededOn(event.target.value);
                      if (validationError?.field === "needed_on") setValidationError(undefined);
                    }}
                    ref={neededOnInputRef}
                    required
                    type="date"
                    value={neededOn}
                  />
                </label>
              </div>
              <span className="sr-only" id={neededOnHintId}>
                필수 · 날짜를 선택해 주세요. 지난 날짜도 기록할 수 있으며 학생 목록은 최근 90일까지
                보여요. 그보다 오래된 항목에는 재알림을 등록할 수 없어요.
              </span>
            </section>
            {showPublishSummary ? (
              <div ref={audienceRef}>
                <ContentInputAudience
                  audience={audience}
                  busy={busy}
                  enabled={selectedAudienceEnabled}
                  errorId={errorId}
                  errorMessage={
                    validationError?.field === "audience" ? validationError.message : undefined
                  }
                  invalid={validationError?.field === "audience"}
                  locked={locked}
                  onChange={(next) => {
                    setAudience(next);
                    if (validationError?.field === "audience") setValidationError(undefined);
                  }}
                />
              </div>
            ) : null}
          </div>
        </ContentInputFrame>
        <ContentInputReview
          open={reviewRequest !== undefined}
          title={activeCategory.label + " 게시 전 검토"}
          onCancel={() => setReviewRequest(undefined)}
          onConfirm={() => {
            if (reviewRequest !== undefined && !busy) {
              const request = reviewRequest;
              setReviewRequest(undefined);
              onSubmit(request);
            }
          }}
          busy={busy}
          returnFocusTo={publishButtonRef.current}
        >
          <p className="mb-3 text-sm text-app-muted">
            내용과 날짜, 받는 사람을 확인해 주세요. 올리면 바로 게시됩니다.
          </p>
          {preview}
          <p className="mt-3 text-xs leading-5 text-app-muted">
            오늘·내일 항목은 학생의 홈에 표시돼요. 다가오는 항목과 최근 90일 이력은 목록·상세에서 볼
            수 있어요.
            {category === "homework"
              ? " 완료 표시는 학생의 자기 확인이에요. 파일 제출이나 교사의 검수와는 구분됩니다."
              : ""}
          </p>
        </ContentInputReview>
      </form>
    );
  }

  return (
    <form aria-busy={busy} className="grid min-w-0 gap-5" noValidate onSubmit={submit}>
      <div
        aria-label={showCompositionSteps ? `${activeCategory.label} 작성 내용` : undefined}
        className="grid min-w-0 gap-5"
        role={showCompositionSteps ? "region" : undefined}
      >
        {showCompositionSteps ? (
          <div className="rounded-2xl border border-app-border bg-app-surface-muted px-4 py-4">
            <p className="text-xs font-extrabold text-role-primary">1단계</p>
            <h3 className="mt-1 text-lg font-extrabold text-app-text">내용</h3>
            <p className="mt-1 break-keep text-xs leading-5 text-app-muted">
              {category === "homework"
                ? "숙제 제목과 마감 날짜를 먼저 적어 주세요."
                : "종류와 제목, 필요한 날짜를 먼저 적어 주세요."}
            </p>
          </div>
        ) : null}

        {showCategorySelector ? (
          <fieldset className="min-w-0" disabled={busy || locked}>
            <legend className="auth-label text-app-text">종류</legend>
            <div className="panel-surface-tinted mt-1 grid grid-cols-2 gap-2 rounded-2xl border border-app-border p-1.5">
              {CATEGORY_OPTIONS.map((option) => (
                <label
                  className={`ui-button min-h-11 min-w-0 cursor-pointer justify-center rounded-xl focus-within:outline-none focus-within:ring-2 focus-within:ring-role-primary focus-within:ring-offset-2 ${
                    category === option.value
                      ? "bg-app-surface-raised text-role-primary shadow-sm"
                      : "text-app-muted hover:text-app-text"
                  }`}
                  key={option.value}
                >
                  <input
                    checked={category === option.value}
                    className="sr-only"
                    name={categoryName}
                    onChange={() => setCategory(option.value)}
                    type="radio"
                    value={option.value}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <div>
          <label className="auth-label text-app-text" htmlFor={titleId}>
            {activeCategory.titleLabel}
            <span aria-hidden="true" className="ml-2 text-xs font-bold text-role-primary">
              필수
            </span>
          </label>
          <input
            aria-describedby={`${titleHintId}${validationError?.field === "title" ? ` ${errorId}` : ""}`}
            aria-invalid={validationError?.field === "title" || undefined}
            aria-required="true"
            autoComplete="off"
            className="ui-input"
            disabled={busy || locked}
            id={titleId}
            onChange={(event) => {
              setTitle(event.target.value);
              if (validationError?.field === "title") setValidationError(undefined);
            }}
            placeholder={activeCategory.placeholder}
            ref={titleInputRef}
            required
            value={title}
          />
          <p className="mt-2 text-xs font-medium text-app-muted" id={titleHintId}>
            필수 · 1~100자
          </p>
        </div>

        <div>
          <label className="auth-label text-app-text" htmlFor={descriptionId}>
            설명 <span className="font-medium text-app-muted">(선택)</span>
          </label>
          <textarea
            aria-describedby={validationError?.field === "description" ? errorId : undefined}
            aria-invalid={validationError?.field === "description" || undefined}
            className="ui-input min-h-32 resize-y py-3 leading-6"
            disabled={busy || locked}
            id={descriptionId}
            onChange={(event) => {
              setDescription(event.target.value);
              if (validationError?.field === "description") setValidationError(undefined);
            }}
            placeholder="학생들이 빠뜨리지 않도록 필요한 내용을 적어 주세요."
            ref={descriptionInputRef}
            rows={4}
            value={description}
          />
          <p className="mt-2 text-right text-xs font-medium text-app-muted">
            {codePointLength(description.trim())} / 500자
          </p>
        </div>

        <div>
          <label className="auth-label text-app-text" htmlFor={neededOnId}>
            {category === "homework" ? "마감 날짜" : "필요한 날짜"}
            <span aria-hidden="true" className="ml-2 text-xs font-bold text-role-primary">
              필수
            </span>
          </label>
          <div className="relative">
            <CalendarDays
              aria-hidden="true"
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-app-text"
              size={19}
            />
            <input
              aria-describedby={`${neededOnHintId}${validationError?.field === "needed_on" ? ` ${errorId}` : ""}`}
              aria-invalid={validationError?.field === "needed_on" || undefined}
              aria-required="true"
              className="ui-input pl-12"
              disabled={busy || locked}
              id={neededOnId}
              onChange={(event) => {
                setNeededOn(event.target.value);
                if (validationError?.field === "needed_on") setValidationError(undefined);
              }}
              ref={neededOnInputRef}
              required
              type="date"
              value={neededOn}
            />
          </div>
          <p className="mt-2 break-keep text-xs leading-5 text-app-muted" id={neededOnHintId}>
            <span className="font-bold text-app-muted">필수 · 날짜를 선택해 주세요.</span>
            <span className="block">
              지난 날짜도 기록할 수 있으며, 학생 목록은 최근 90일까지 보여요. 그보다 오래된{" "}
              {activeCategory.label}에는 재알림을 등록할 수 없어요.
            </span>
          </p>
        </div>
      </div>

      {showPublishSummary ? (
        <section
          aria-label="게시 대상과 결과"
          className="rounded-2xl border border-role-border bg-role-soft px-4 py-4"
        >
          {showCompositionSteps ? (
            <div className="mb-4 rounded-2xl border border-role-border bg-app-surface-raised px-4 py-4">
              <p className="text-xs font-extrabold text-role-primary">2단계</p>
              <h3 className="mt-1 text-lg font-extrabold text-app-text">대상</h3>
              <p className="mt-1 break-keep text-xs leading-5 text-app-muted">
                실제로 이 준비물이나 숙제를 볼 학생 범위를 확인해 주세요.
              </p>
            </div>
          ) : null}
          <div>
            <p className="flex items-center gap-2 font-extrabold text-role-primary">
              <UsersRound aria-hidden="true" size={18} />
              학생에게 보이는 범위
            </p>
            <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
              오늘·내일 {activeCategory.label}
              {category === "homework" ? "는" : "은"} 학생의 홈에 표시돼요. 다가오는 항목과 최근
              90일 이력은 학생 목록·상세에서 확인할 수 있고, 선생님은 상세에서 학생이 표시한 상태를
              볼 수 있어요.
            </p>
            {category === "homework" ? (
              <p className="mt-2 break-keep text-xs leading-5 text-app-muted">
                완료 표시는 학생의 자기 확인이에요. 파일 제출이나 교사의 검수와는 구분됩니다.
              </p>
            ) : null}
            <div className="mt-4 border-t border-role-border pt-4" ref={audienceRef}>
              <ContentAudienceSelector
                busy={busy}
                enabled={selectedAudienceEnabled}
                errorId={errorId}
                invalid={validationError?.field === "audience"}
                locked={locked}
                onChange={(nextAudience) => {
                  setAudience(nextAudience);
                  if (validationError?.field === "audience") setValidationError(undefined);
                }}
                value={audience}
              />
            </div>
          </div>
        </section>
      ) : null}

      {validationError === undefined ? null : (
        <p
          className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700"
          id={errorId}
          role="alert"
        >
          {validationError.message}
        </p>
      )}

      {showCompositionSteps ? (
        <section
          aria-label={`${activeCategory.label} 게시 전 검토`}
          className="rounded-2xl border border-app-border bg-app-surface-raised px-4 py-4 shadow-sm"
        >
          <p className="text-xs font-extrabold text-role-primary">3단계</p>
          <h3 className="mt-1 text-lg font-extrabold text-app-text">검토</h3>
          <article className="mt-4 rounded-2xl border border-app-border bg-app-surface p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs font-extrabold text-app-muted">
              <span className="rounded-full bg-role-soft px-2.5 py-1 text-role-primary">
                {category === "homework" ? "숙제" : "준비물"}
              </span>
              <span>
                {audience === undefined
                  ? "게시 대상을 선택해 주세요."
                  : audience.mode === "all"
                    ? "올릴 때의 반 전체 학생"
                    : `선택 학생 ${audience.member_ids.length}명`}
              </span>
            </div>
            <h4 className="mt-3 break-words text-base font-extrabold text-app-text">
              {title.trim() === "" ? "제목을 입력해 주세요." : title}
            </h4>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-app-muted">
              {description.trim() === "" ? "별도 설명 없음" : description}
            </p>
            <dl className="mt-4 flex items-center justify-between gap-4 border-t border-app-border pt-3 text-xs">
              <dt className="font-bold text-app-muted">
                {category === "homework" ? "마감일" : "필요한 날"}
              </dt>
              <dd className="font-extrabold text-app-text">
                {neededOn === "" ? "날짜를 선택해 주세요." : formatSupplyDate(neededOn)}
              </dd>
            </dl>
            <p className="mt-3 text-xs font-bold text-app-muted">등록하면 바로 게시됩니다.</p>
          </article>
        </section>
      ) : null}

      <ContentFormActionBar busy={busy} onCancel={onCancel} submitLabel={submitLabel} />
    </form>
  );
}
