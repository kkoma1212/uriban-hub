import { BellRing, Check, History, LoaderCircle, UsersRound } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { NoticeWriteRequest } from "../../api/notices";
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
import { ContentAudienceSelector } from "../updates/content-audience-selector";

interface NoticeFormProps {
  busy: boolean;
  compositionHeader?: React.ReactNode;
  onLoadPrevious?: () => void;
  focusTitleOnMount?: boolean;
  initialValue?: NoticeWriteRequest;
  locked?: boolean;
  onCancel: () => void;
  onDraftChange?: (request: NoticeWriteRequest) => void;
  onSubmit: (request: NoticeWriteRequest) => void;
  requireAudienceSelection?: boolean;
  selectedAudienceEnabled?: boolean;
  showCompositionSteps?: boolean;
  showPublishSummary?: boolean;
  submitLabel: string;
}

type NoticeFormField = "audience" | "content" | "title";

interface NoticeFormError {
  field: NoticeFormField;
  message: string;
}

const EMPTY_VALUE: NoticeWriteRequest = {
  audience: { mode: "all" },
  category: "general",
  content: "",
  is_important: false,
  title: "",
};

export function NoticeForm({
  busy,
  compositionHeader,
  onLoadPrevious,
  focusTitleOnMount = true,
  initialValue = EMPTY_VALUE,
  locked = false,
  onCancel,
  onDraftChange,
  onSubmit,
  requireAudienceSelection = false,
  selectedAudienceEnabled = false,
  showCompositionSteps = false,
  showPublishSummary = false,
  submitLabel,
}: NoticeFormProps): React.JSX.Element {
  const titleId = useId();
  const contentId = useId();
  const importantId = useId();
  const errorId = useId();
  const titleHintId = useId();
  const contentHintId = useId();
  const [audience, setAudience] = useState<ContentAudienceRequest | undefined>(
    initialValue.audience ?? (requireAudienceSelection ? undefined : { mode: "all" }),
  );
  const [category, setCategory] = useState(initialValue.category ?? "general");
  const [title, setTitle] = useState(initialValue.title);
  const [content, setContent] = useState(initialValue.content);
  const [isImportant, setIsImportant] = useState(initialValue.is_important);
  const [validationError, setValidationError] = useState<NoticeFormError>();
  const [reviewRequest, setReviewRequest] = useState<NoticeWriteRequest>();
  const publishButtonRef = useRef<HTMLButtonElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const contentInputRef = useRef<HTMLTextAreaElement>(null);
  const audienceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusTitleOnMount) titleInputRef.current?.focus();
  }, [focusTitleOnMount]);

  useEffect(() => {
    if (!locked) return;
    setTitle(initialValue.title);
    setContent(initialValue.content);
    setIsImportant(initialValue.is_important);
    setAudience(initialValue.audience ?? (requireAudienceSelection ? undefined : { mode: "all" }));
    setCategory(initialValue.category ?? "general");
    setValidationError(undefined);
  }, [initialValue, locked, requireAudienceSelection]);

  useEffect(() => {
    if (locked || onDraftChange === undefined) return;
    onDraftChange({
      ...(showPublishSummary && audience !== undefined ? { audience } : {}),
      category,
      content,
      is_important: isImportant,
      title,
    });
  }, [audience, category, content, isImportant, locked, onDraftChange, showPublishSummary, title]);

  useEffect(() => {
    if (validationError?.field === "title") titleInputRef.current?.focus();
    if (validationError?.field === "content") contentInputRef.current?.focus();
    if (validationError?.field === "audience") {
      const target = audienceRef.current?.querySelector<HTMLElement>('input[type="radio"], button');
      target?.focus();
    }
  }, [validationError]);

  /*
   * 문제가 된 입력 바로 아래에 renders한다. 폼 끝에 두면 제출 액션바가 고정이라
   * 어디서든 누를 수 있는 반면 오류는 화면 밖(측정값 1458px)에 남아, 시각 사용자만
   * 아무 반응 없는 버튼을 반복해서 누르게 된다.
   */
  const validationMessage =
    validationError === undefined ? null : (
      <p
        className="mt-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700"
        id={errorId}
        role="alert"
      >
        {validationError.message}
      </p>
    );

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();
    const titleLength = codePointLength(trimmedTitle);
    const contentLength = codePointLength(trimmedContent);
    if (titleLength < 1 || titleLength > 100) {
      setValidationError({
        field: "title",
        message: "공지 제목은 1자 이상 100자 이하로 입력해 주세요.",
      });
      return;
    }
    if (contentLength < 1 || contentLength > 2000) {
      setValidationError({
        field: "content",
        message: "공지 내용은 1자 이상 2,000자 이하로 입력해 주세요.",
      });
      return;
    }
    if (showPublishSummary && requireAudienceSelection && audience === undefined) {
      setValidationError({
        field: "audience",
        message: "이번 공지를 게시할 대상을 선택해 주세요.",
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
    const request: NoticeWriteRequest = {
      ...(showPublishSummary && audience !== undefined ? { audience } : {}),
      category,
      content: trimmedContent,
      is_important: isImportant,
      title: trimmedTitle,
    };
    if (showCompositionSteps && !locked) setReviewRequest(request);
    else onSubmit(request);
  }

  if (showCompositionSteps) {
    const titleLength = codePointLength(title.trim());
    const contentLength = codePointLength(content.trim());
    const missing =
      titleLength === 0
        ? "제목을 적어 주세요"
        : titleLength > 100
          ? "제목을 100자 이내로 적어 주세요"
          : contentLength === 0
            ? "내용을 적어 주세요"
            : contentLength > 2000
              ? "내용을 2,000자 이내로 적어 주세요"
              : (requireAudienceSelection && audience === undefined) ||
                  (audience?.mode === "selected" && audience.member_ids.length === 0)
                ? "받는 사람을 선택해 주세요"
                : undefined;
    const preview = (
      <ContentInputPreview
        kind={category === "performance" ? "수행평가 공지" : "공지"}
        title={title}
        content={content}
        important={isImportant}
        boardMessage={isImportant ? undefined : "일반 공지는 소식에서 볼 수 있어요."}
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
          <ContentInputMemo
            aria-label="공지 작성 내용"
            role="region"
            footer={
              <>
                {onLoadPrevious === undefined ? null : (
                  <button disabled={busy || locked} onClick={onLoadPrevious} type="button">
                    <History aria-hidden="true" size={15} />
                    지난 글 불러오기
                  </button>
                )}
                <span>{contentLength.toLocaleString()} / 2,000자</span>
                <label
                  className="flex min-h-8 items-center gap-1.5 font-bold"
                  htmlFor={importantId}
                >
                  <input
                    checked={isImportant}
                    disabled={busy || locked}
                    id={importantId}
                    onChange={(event) => setIsImportant(event.target.checked)}
                    type="checkbox"
                  />
                  중요 공지로 표시
                </label>
              </>
            }
          >
            <label className="sr-only" htmlFor={titleId}>
              공지 제목
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
              placeholder="제목을 적어 주세요"
              ref={titleInputRef}
              required
              value={title}
            />
            <span className="sr-only" id={titleHintId}>
              필수 · 1~100자
            </span>
            <label className="sr-only" htmlFor={contentId}>
              공지 내용
            </label>
            <textarea
              aria-describedby={
                contentHintId + (validationError?.field === "content" ? " " + errorId : "")
              }
              aria-invalid={validationError?.field === "content" || undefined}
              className="content-input-textarea"
              disabled={busy || locked}
              id={contentId}
              onChange={(event) => {
                setContent(event.target.value);
                if (validationError?.field === "content") setValidationError(undefined);
              }}
              placeholder="학생들이 꼭 알아야할 내용을 적어주세요"
              ref={contentInputRef}
              required
              value={content}
            />
            <span className="sr-only" id={contentHintId}>
              필수 · 1~2,000자
            </span>
          </ContentInputMemo>
          {validationError === undefined || validationError.field === "audience" ? null : (
            <p className="content-input-error" id={errorId} role="alert">
              {validationError.message}
            </p>
          )}
          <div className="content-input-support">
            {compositionHeader === undefined ? (
              <label className="content-input-options">
                공지 분류
                <select
                  className="ui-input mt-2"
                  disabled={busy || locked}
                  onChange={(event) => setCategory(event.target.value as "general" | "performance")}
                  value={category}
                >
                  <option value="general">일반 공지</option>
                  <option value="performance">수행평가 공지</option>
                </select>
              </label>
            ) : null}
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
          title="공지 게시 전 검토"
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
            내용과 받는 사람을 확인해 주세요. 올리면 바로 게시됩니다.
          </p>
          {preview}
        </ContentInputReview>
      </form>
    );
  }

  return (
    <form aria-busy={busy} className="grid min-w-0 gap-5" noValidate onSubmit={submit}>
      <div
        aria-label={showCompositionSteps ? "공지 작성 내용" : undefined}
        className="grid min-w-0 gap-5"
        role={showCompositionSteps ? "region" : undefined}
      >
        {showCompositionSteps ? (
          <div className="rounded-2xl border border-app-border bg-app-surface-muted px-4 py-4">
            <p className="text-xs font-extrabold text-role-primary">1단계</p>
            <h3 className="mt-1 text-lg font-extrabold text-app-text">내용</h3>
            <p className="mt-1 break-keep text-xs leading-5 text-app-muted">
              학생이 바로 이해할 제목과 내용을 먼저 적어 주세요.
            </p>
          </div>
        ) : null}

        <div>
          <label className="auth-label" htmlFor={titleId}>
            공지 제목
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
            placeholder="예: 수행평가 제출일 안내"
            ref={titleInputRef}
            required
            value={title}
          />
          <p className="mt-2 text-xs font-medium text-app-muted" id={titleHintId}>
            필수 · 1~100자
          </p>
          {validationError?.field === "title" ? validationMessage : null}
        </div>

        <div>
          <label className="auth-label" htmlFor={contentId}>
            공지 내용
            <span aria-hidden="true" className="ml-2 text-xs font-bold text-role-primary">
              필수
            </span>
          </label>
          <textarea
            aria-describedby={`${contentHintId}${validationError?.field === "content" ? ` ${errorId}` : ""}`}
            aria-invalid={validationError?.field === "content" || undefined}
            aria-required="true"
            className="ui-input min-h-48 resize-y py-3 leading-7"
            disabled={busy || locked}
            id={contentId}
            onChange={(event) => {
              setContent(event.target.value);
              if (validationError?.field === "content") setValidationError(undefined);
            }}
            placeholder="학생들이 꼭 알아야할 내용을 적어주세요"
            ref={contentInputRef}
            required
            rows={7}
            value={content}
          />
          <div className="mt-2 flex items-center justify-between gap-3 text-xs font-medium text-app-muted">
            <p id={contentHintId}>필수 · 1~2,000자</p>
            <p>{codePointLength(content.trim()).toLocaleString("ko-KR")} / 2,000자</p>
          </div>
          {validationError?.field === "content" ? validationMessage : null}
        </div>

        <div>
          <label className="auth-label" htmlFor={`${titleId}-category`}>
            공지 분류
          </label>
          <select
            className="ui-input"
            disabled={busy || locked}
            id={`${titleId}-category`}
            onChange={(event) => setCategory(event.target.value as "general" | "performance")}
            value={category}
          >
            <option value="general">일반 공지</option>
            <option value="performance">수행평가</option>
          </select>
          <p className="mt-2 text-xs font-medium leading-5 text-app-muted">
            수행평가로 분류하면 소식에서 따로 모아볼 수 있어요.
          </p>
        </div>

        <label
          className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3.5 transition-colors ${
            isImportant
              ? "border-rose-200 bg-home-important-soft"
              : "border-app-border bg-app-surface-muted"
          }`}
          htmlFor={importantId}
        >
          <input
            checked={isImportant}
            className="mt-1 size-5 shrink-0 accent-rose-600"
            disabled={busy || locked}
            id={importantId}
            onChange={(event) => setIsImportant(event.target.checked)}
            type="checkbox"
          />
          <span className="min-w-0">
            <span
              className={`flex items-center gap-2 font-bold ${
                isImportant ? "text-home-important" : "text-app-text"
              }`}
            >
              <BellRing aria-hidden="true" size={17} /> 중요 공지로 표시
            </span>
            <span
              className={`mt-1 block break-keep text-xs leading-5 ${
                isImportant ? "text-home-important" : "text-app-muted"
              }`}
            >
              켜면 공지 목록과 오늘의 공지 카드 위쪽에 고정돼요. 표시만 바꾸면 학생 확인 기록은
              유지됩니다.
            </span>
          </span>
        </label>
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
                실제로 이 공지를 볼 학생 범위를 확인해 주세요.
              </p>
            </div>
          ) : null}
          <div>
            <p className="flex items-center gap-2 font-extrabold text-role-primary">
              <UsersRound aria-hidden="true" size={18} />
              현재 반의 승인된 학생에게 게시
            </p>
            <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
              등록하면 학생의 홈과 공지 목록에 표시되고, 공지에서 학생별 확인 현황을 볼 수 있어요.
            </p>
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

      {validationError?.field === "audience" ? validationMessage : null}

      {showCompositionSteps ? (
        <section
          aria-label="공지 게시 전 검토"
          className="rounded-2xl border border-app-border bg-app-surface-raised px-4 py-4 shadow-sm"
        >
          <p className="text-xs font-extrabold text-role-primary">3단계</p>
          <h3 className="mt-1 text-lg font-extrabold text-app-text">검토</h3>
          <article className="mt-4 rounded-2xl border border-app-border bg-app-surface p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs font-extrabold text-app-muted">
              <span className="rounded-full bg-role-soft px-2.5 py-1 text-role-primary">
                {category === "performance" ? "수행평가" : "공지"}
              </span>
              {isImportant ? (
                <span className="rounded-full bg-home-important-soft px-2.5 py-1 text-home-important">
                  중요
                </span>
              ) : null}
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
            <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-6 text-app-muted">
              {content.trim() === "" ? "내용을 입력하면 여기에 미리 보여요." : content}
            </p>
            <p className="mt-4 border-t border-app-border pt-3 text-xs font-bold text-app-muted">
              등록하면 바로 게시됩니다.
            </p>
          </article>
        </section>
      ) : null}

      <ContentFormActionBar busy={busy} onCancel={onCancel} submitLabel={submitLabel} />
    </form>
  );
}
