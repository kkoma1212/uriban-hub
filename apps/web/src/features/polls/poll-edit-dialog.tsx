import { LockKeyhole, PencilLine, Plus, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ApiRequestError } from "../../api/auth";
import { updatePoll, type PollEntityResponse, type UpdatePollRequest } from "../../api/polls";
import { codePointLength } from "../../lib/text";
import { useModalIsolation } from "../layout/use-modal-isolation";

const MINIMUM_CLOSE_DELAY_MS = 5 * 60 * 1_000;
const MAXIMUM_CLOSE_SPAN_MS = 30 * 24 * 60 * 60 * 1_000;

function localDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60 * 1_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function normalizedOption(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

interface OptionDraft {
  id: string;
  value: string;
}

/**
 * 진행 중 투표 수정 창(2026-10-04 사용자 결정, 제한형). 제목·설명·마감은 언제든, 선택지는 참여한 학생이
 * 없을 때만 고친다. 공개 설정은 보여 주지도 보내지도 않는다. 최종 판정은 서버가 한다(잠금 안에서 표를 센다).
 */
export function PollEditDialog({
  entity,
  onClose,
  onSaved,
  optionsLocked,
  pollId,
  returnFocusTo,
}: {
  entity: PollEntityResponse;
  onClose: () => void;
  onSaved: (entity: PollEntityResponse) => void;
  optionsLocked: boolean;
  pollId: string;
  returnFocusTo: HTMLElement | null;
}): React.JSX.Element | null {
  const { item } = entity;
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const optionSequence = useRef(0);
  const nextOption = (value: string): OptionDraft => {
    optionSequence.current += 1;
    return { id: `poll-edit-option-${optionSequence.current}`, value };
  };
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? "");
  const [closesAt, setClosesAt] = useState(localDateTimeValue(new Date(item.closes_at)));
  const [options, setOptions] = useState<OptionDraft[]>(() =>
    item.options.map((option) => nextOption(option.label)),
  );
  const [locked, setLocked] = useState(optionsLocked);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  useModalIsolation({
    dialogRef,
    initialFocusRef: titleInputRef,
    onDismiss: () => {
      if (!saving) onClose();
    },
    open: true,
    returnFocusTo,
  });

  const latestClose = new Date(new Date(item.created_at).getTime() + MAXIMUM_CLOSE_SPAN_MS);

  function requestPayload(): UpdatePollRequest | undefined {
    const nextTitle = title.trim();
    const nextDescription = description.trim();
    const nextOptions = locked
      ? item.options.map((option) => option.label)
      : options.map((option) => option.value.trim());
    const closeTime = new Date(closesAt).getTime();
    if (codePointLength(nextTitle) < 1 || codePointLength(nextTitle) > 100) {
      setFormError("투표 제목은 1~100자로 적어 주세요.");
      return undefined;
    }
    if (codePointLength(nextDescription) > 500) {
      setFormError("설명은 500자 이하로 적어 주세요.");
      return undefined;
    }
    if (nextOptions.some((option) => codePointLength(option) < 1 || codePointLength(option) > 80)) {
      setFormError("각 선택지는 1~80자로 적어 주세요.");
      return undefined;
    }
    if (new Set(nextOptions.map(normalizedOption)).size !== nextOptions.length) {
      setFormError("같은 내용의 선택지는 한 번만 사용할 수 있어요.");
      return undefined;
    }
    if (
      Number.isNaN(closeTime) ||
      closeTime - Date.now() < MINIMUM_CLOSE_DELAY_MS ||
      closeTime > latestClose.getTime()
    ) {
      setFormError("마감은 지금부터 5분 뒤~투표를 만든 날부터 30일 이내로 정해 주세요.");
      return undefined;
    }
    return {
      closes_at: new Date(closeTime).toISOString(),
      description: nextDescription === "" ? null : nextDescription,
      options: nextOptions,
      title: nextTitle,
    };
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    const payload = requestPayload();
    if (payload === undefined) return;
    setSaving(true);
    setFormError(undefined);
    try {
      onSaved(await updatePoll(pollId, entity.etag, payload));
    } catch (requestError) {
      // 창을 여는 사이 첫 표가 들어오면 서버가 선택지를 잠근다 — 선택지를 원래대로 돌리고 나머지는 남긴다.
      if (requestError instanceof ApiRequestError && requestError.code === "POLL_OPTIONS_LOCKED") {
        setLocked(true);
        setOptions(item.options.map((option) => nextOption(option.label)));
      }
      setFormError(
        requestError instanceof Error ? requestError.message : "투표를 고치지 못했어요.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 backdrop-blur-[2px] sm:items-center sm:p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="max-h-[92dvh] w-full overflow-y-auto rounded-t-[1.75rem] border border-app-border bg-app-surface-raised p-6 text-app-text shadow-2xl sm:max-w-lg sm:rounded-shell sm:p-7"
        data-poll-edit-dialog
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div
          aria-hidden="true"
          className="grid size-11 place-items-center rounded-2xl bg-role-soft text-role-primary"
        >
          <PencilLine size={21} />
        </div>
        <h2 className="mt-5 break-keep text-xl font-extrabold tracking-[-0.025em]" id={titleId}>
          투표 내용 고치기
        </h2>
        <form className="mt-4 grid gap-4" noValidate onSubmit={(event) => void submit(event)}>
          <fieldset className="grid gap-4" disabled={saving}>
            <label className="grid gap-2 text-sm font-bold">
              투표 제목
              <input
                className="ui-input ui-input-compact min-w-0"
                maxLength={100}
                onChange={(event) => setTitle(event.target.value)}
                ref={titleInputRef}
                required
                value={title}
              />
            </label>
            <label className="grid gap-2 text-sm font-bold">
              설명 (선택)
              <textarea
                className="ui-input min-h-24 min-w-0 py-3"
                maxLength={500}
                onChange={(event) => setDescription(event.target.value)}
                value={description}
              />
            </label>
            <fieldset>
              <legend className="text-sm font-bold">선택지</legend>
              {locked ? (
                <>
                  <p className="mt-2 flex items-start gap-2 rounded-xl bg-app-surface-muted p-3 text-[13px] leading-5 text-app-muted">
                    <LockKeyhole aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
                    이미 참여한 학생이 있어 선택지는 바꿀 수 없어요.
                  </p>
                  <ol className="mt-2 grid gap-1.5 text-sm">
                    {item.options.map((option, index) => (
                      <li className="flex items-center gap-2" key={option.id}>
                        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-role-soft text-xs font-extrabold text-role-primary">
                          {index + 1}
                        </span>
                        <span className="min-w-0 break-words">{option.label}</span>
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <>
                  <div className="mt-2 grid gap-2">
                    {options.map((option, index) => (
                      <div className="flex items-center gap-2" key={option.id}>
                        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-role-soft text-sm font-extrabold text-role-primary">
                          {index + 1}
                        </span>
                        <input
                          aria-label={"선택지 " + (index + 1)}
                          className="ui-input ui-input-compact min-w-0 flex-1"
                          maxLength={80}
                          onChange={(event) =>
                            setOptions((current) =>
                              current.map((draft) =>
                                draft.id === option.id
                                  ? { ...draft, value: event.target.value }
                                  : draft,
                              ),
                            )
                          }
                          required
                          value={option.value}
                        />
                        <button
                          aria-label={"선택지 " + (index + 1) + " 삭제"}
                          className="ui-icon-button ui-button-secondary"
                          disabled={options.length <= 2}
                          onClick={() =>
                            setOptions((current) =>
                              current.filter((draft) => draft.id !== option.id),
                            )
                          }
                          type="button"
                        >
                          <Trash2 aria-hidden="true" size={17} />
                        </button>
                      </div>
                    ))}
                  </div>
                  {options.length < 10 ? (
                    <button
                      className="ui-button ui-button-secondary mt-2 text-sm"
                      onClick={() => setOptions((current) => [...current, nextOption("")])}
                      type="button"
                    >
                      <Plus aria-hidden="true" size={17} />
                      선택지 추가
                    </button>
                  ) : null}
                </>
              )}
            </fieldset>
            <label className="grid gap-2 text-sm font-bold">
              마감 시각
              <input
                className="ui-input ui-input-compact min-w-0"
                max={localDateTimeValue(latestClose)}
                min={localDateTimeValue(new Date(Date.now() + MINIMUM_CLOSE_DELAY_MS))}
                onChange={(event) => setClosesAt(event.target.value)}
                required
                type="datetime-local"
                value={closesAt}
              />
              <span className="text-xs font-medium text-app-muted">
                지금부터 5분 뒤~투표를 만든 날부터 30일 이내
              </span>
            </label>
          </fieldset>
          {formError === undefined ? null : (
            <p
              className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700"
              role="alert"
            >
              {formError}
            </p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-3">
            <button
              className="ui-button ui-button-secondary"
              disabled={saving}
              onClick={onClose}
              type="button"
            >
              취소
            </button>
            <button className="ui-button ui-button-primary" disabled={saving} type="submit">
              {saving ? "저장하는 중" : "저장하기"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
