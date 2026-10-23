import { useEffect, useId, useRef } from "react";

/*
 * 오타 수정 처리(2026-10-22 사용자 결정): 고르면 공지·준비물·숙제의 판을 올리지 않아 학생 확인이 그대로 남는다.
 * 작은 변경인지는 서버만 판단한다(apps/api/src/content-edits/minor-edit.ts). 여기서는 기준을 알려 주기만 하고
 * 같은 규칙을 다시 만들지 않는다. 아래 '5자'는 서버의 MINOR_EDIT_MAX_CHANGED_CHARACTERS와 맞춰 둔다.
 */
export function MinorEditOption({
  checked,
  disabled,
  error,
  onChange,
  scheduleNote = false,
}: {
  checked: boolean;
  disabled: boolean;
  /** 서버가 오타 수정을 거절한 이유. 저장 단추가 화면 아래에 붙어 있어 이 자리에 보여야 눈에 띈다. */
  error?: string | undefined;
  onChange: (checked: boolean) => void;
  /** 준비물·숙제는 날짜·종류를 바꾸면 늘 다시 확인받는다는 안내를 더한다. */
  scheduleNote?: boolean;
}): React.JSX.Element {
  const helpId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error !== undefined) inputRef.current?.focus();
  }, [error]);
  return (
    <div className="mt-4 rounded-2xl border border-app-border bg-app-surface px-4 py-3">
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-bold text-app-text">
        <input
          aria-describedby={error === undefined ? helpId : `${helpId} ${errorId}`}
          aria-invalid={error === undefined ? undefined : true}
          checked={checked}
          className="auth-checkbox"
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          ref={inputRef}
          type="checkbox"
        />
        오타·띄어쓰기만 고쳤어요 (학생에게 다시 확인받지 않기)
      </label>
      <p className="break-keep text-xs leading-5 text-app-muted" id={helpId}>
        바뀐 글자가 5자 이하이고 숫자(날짜·시간·개수)가 그대로일 때만 저장돼요.
        {scheduleNote ? " 날짜나 종류를 바꾸면 늘 다시 확인받아요." : ""} 뜻이 바뀌는 수정이면
        고르지 마세요.
      </p>
      {error === undefined ? null : (
        <p className="mt-2 break-keep text-sm font-bold text-danger-text" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
