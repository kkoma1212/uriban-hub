import { BookmarkPlus, Check, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ApiRequestError } from "../../api/auth";
import {
  checkTeacherLibraryDraft,
  saveTeacherLibraryItem,
  type PersonalInfoHit,
  type TeacherLibraryKind,
} from "../../api/teacher-library";
import { useModalIsolation } from "../layout/use-modal-isolation";

const HIT_LABEL: Record<PersonalInfoHit["kind"], string> = {
  email: "이메일",
  name: "학생 이름",
  phone: "전화번호",
};

interface SaveToLibraryButtonProps {
  body: string | null;
  kind: TeacherLibraryKind;
  sourceId: string;
  title: string;
}

/**
 * 공지·준비물 글을 교사 자료함에 담는다(S2). 담기 전에 학생 이름·연락처 모양을 찾아 보여 주고,
 * 교사가 고치거나 '개인정보 없음'을 확인해야 저장된다. 학생 확인·체크 기록은 옮기지 않는다.
 */
export function SaveToLibraryButton({
  body,
  kind,
  sourceId,
  title,
}: SaveToLibraryButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        className="ui-button ui-button-secondary min-h-11 gap-1.5 px-3 text-sm"
        disabled={saved}
        onClick={() => setOpen(true)}
        ref={opener}
        type="button"
      >
        {saved ? (
          <Check aria-hidden="true" size={17} />
        ) : (
          <BookmarkPlus aria-hidden="true" size={17} />
        )}
        {saved ? "자료함에 담음" : "자료함에 담기"}
      </button>
      {open ? (
        <SaveToLibraryDialog
          initial={{ body, kind, source_id: sourceId, title }}
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
          onSaved={() => {
            setSaved(true);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function SaveToLibraryDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: { body: string | null; kind: TeacherLibraryKind; source_id: string; title: string };
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body ?? "");
  const [hits, setHits] = useState<PersonalInfoHit[]>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const titleInput = useRef<HTMLInputElement>(null);
  useModalIsolation({
    dialogRef: dialog,
    initialFocusRef: titleInput,
    onDismiss: onClose,
    open: true,
  });

  const draft = () => ({
    body: body.trim() === "" ? null : body,
    kind: initial.kind,
    source_id: initial.source_id,
    title,
  });

  async function check(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setConfirmed(false);
    try {
      setHits((await checkTeacherLibraryDraft(draft())).hits);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "확인하지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void check();
    // 처음 열 때 원문 그대로 한 번 확인한다. 이후는 '다시 확인'으로.
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await saveTeacherLibraryItem(draft());
      onSaved();
    } catch (failure) {
      setError(
        failure instanceof ApiRequestError && failure.status === 409
          ? "이미 자료함에 담긴 글이에요."
          : failure instanceof Error
            ? failure.message
            : "담지 못했어요.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <div
        aria-labelledby="save-to-library-title"
        aria-modal="true"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-card bg-app-surface p-5 shadow-xl"
        ref={dialog}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-extrabold text-app-text" id="save-to-library-title">
            자료함에 담기
          </h2>
          <button
            aria-label="닫기"
            className="ui-button ui-button-tertiary min-h-11 px-2"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>
        <p className="mt-1 text-sm text-app-muted">
          글 내용만 담기고, 학생이 읽었는지·체크했는지는 옮기지 않아요. 반이 끝나거나 학교를 옮겨도
          선생님 계정에 남아요.
        </p>
        <label className="mt-4 block text-sm font-bold text-app-text" htmlFor="library-title">
          제목
        </label>
        <input
          className="mt-1 w-full rounded-xl border border-app-border bg-app-surface px-3 py-2"
          id="library-title"
          maxLength={100}
          ref={titleInput}
          onChange={(event) => {
            setTitle(event.target.value);
            setHits(undefined);
            setConfirmed(false);
          }}
          value={title}
        />
        <label className="mt-3 block text-sm font-bold text-app-text" htmlFor="library-body">
          내용
        </label>
        <textarea
          className="mt-1 min-h-32 w-full rounded-xl border border-app-border bg-app-surface px-3 py-2"
          id="library-body"
          maxLength={initial.kind === "supply" ? 500 : 2000}
          onChange={(event) => {
            setBody(event.target.value);
            setHits(undefined);
            setConfirmed(false);
          }}
          value={body}
        />
        <section aria-label="개인정보 확인" className="mt-3 rounded-xl bg-app-surface-muted p-3">
          {hits === undefined ? (
            <button
              className="ui-button ui-button-secondary min-h-11 w-full text-sm"
              disabled={busy || title.trim() === ""}
              onClick={() => void check()}
              type="button"
            >
              {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" size={17} /> : null}
              고친 내용 다시 확인
            </button>
          ) : hits.length === 0 ? (
            <p className="text-sm font-bold text-app-text">
              학생 이름·전화번호·이메일 모양을 찾지 못했어요.
            </p>
          ) : (
            <>
              <p className="text-sm font-bold text-rose-700">
                개인정보로 보이는 부분이 있어요. 지우거나 바꾼 뒤 다시 확인해 주세요.
              </p>
              <ul aria-label="찾은 개인정보" className="mt-2 flex flex-wrap gap-2">
                {hits.map((hit) => (
                  <li
                    className="rounded-lg bg-rose-50 px-2 py-1 text-sm text-rose-700"
                    key={`${hit.kind}:${hit.text}`}
                  >
                    {HIT_LABEL[hit.kind]}: <mark>{hit.text}</mark>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-2 text-xs text-app-muted">
            자동 확인은 별명·줄임말·사진 속 정보까지는 찾지 못해요. 마지막 확인은 선생님이 해
            주세요.
          </p>
          <label className="mt-2 flex min-h-11 items-center gap-2 text-sm font-bold text-app-text">
            <input
              checked={confirmed}
              disabled={hits === undefined}
              onChange={(event) => setConfirmed(event.target.checked)}
              type="checkbox"
            />
            학생 개인정보가 없음을 확인했어요
          </label>
        </section>
        {error === undefined ? null : (
          <p className="mt-3 text-sm font-medium text-rose-700" role="alert">
            {error}
          </p>
        )}
        <button
          className="ui-button ui-button-primary mt-4 h-12 w-full rounded-2xl"
          disabled={busy || !confirmed || hits === undefined || title.trim() === ""}
          onClick={() => void save()}
          type="button"
        >
          자료함에 담기
        </button>
      </div>
    </div>
  );
}
