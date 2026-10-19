import { Camera, LoaderCircle, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  PROFILE_PHOTO_ACCEPT,
  deleteOwnProfilePhoto,
  getOwnProfilePhoto,
  prepareProfilePhoto,
  updateOwnProfilePhoto,
  type OwnProfilePhotoState,
  type PreparedProfilePhoto,
} from "../../api/profile-photos";
import { ConfirmDialog } from "../layout/confirm-dialog";
import { Avatar } from "./avatar";

/*
 * 설정의 프로필 사진: 고르기 → 미리보기 → 저장 · 취소, 저장된 사진 삭제.
 * 업로드 API · 사진 처리 · 표시 부품은 Codex가 준비한 것(api/profile-photos · Avatar)을 그대로 쓴다.
 * 서버에 기능이 없으면(enabled:false) 아무 조작도 보이지 않고 이름 첫 글자 표시를 유지한다.
 */

const PREVIEW_SIZE = 72;

interface Pending {
  prepared: PreparedProfilePhoto;
  previewUrl: string;
}

export function ProfilePhotoSettings({ name }: { name: string }): React.JSX.Element | null {
  const [state, setState] = useState<OwnProfilePhotoState>();
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState<"delete" | "prepare" | "save">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();

  useEffect(() => {
    let active = true;
    setLoadError(false);
    getOwnProfilePhoto()
      .then((result) => {
        if (active) setState(result);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  if (loadError) {
    return (
      <div className="px-4 py-3.5" data-profile-photo-settings>
        <p className="text-sm text-app-muted" role="alert">
          프로필 사진을 불러오지 못했어요. 다시 시도해 주세요.
        </p>
        <button
          className="ui-button ui-button-secondary mt-2 min-h-11 text-sm"
          onClick={() => setLoadAttempt((value) => value + 1)}
          type="button"
        >
          사진 다시 불러오기
        </button>
      </div>
    );
  }

  if (state === undefined || !state.enabled) return null;
  const photo = state.photo;

  async function choose(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    setBusy("prepare");
    setError(undefined);
    setNotice(undefined);
    try {
      const prepared = await prepareProfilePhoto(file);
      setPending({ prepared, previewUrl: `data:image/webp;base64,${prepared.image_base64}` });
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : "사진을 처리하지 못했어요.");
    } finally {
      setBusy(undefined);
      // 같은 파일을 다시 골라도 change가 일어나게 비운다.
      if (inputRef.current !== null) inputRef.current.value = "";
    }
  }

  async function save(): Promise<void> {
    if (pending === undefined) return;
    setBusy("save");
    setError(undefined);
    try {
      setState(await updateOwnProfilePhoto(pending.prepared));
      setPending(undefined);
      setNotice("프로필 사진을 저장했어요.");
    } catch (saveError) {
      // 실패하면 미리보기를 남겨 두어 다시 저장하거나 취소할 수 있게 한다.
      setError(saveError instanceof Error ? saveError.message : "사진을 저장하지 못했어요.");
    } finally {
      setBusy(undefined);
    }
  }

  async function remove(): Promise<void> {
    setBusy("delete");
    setError(undefined);
    setNotice(undefined);
    try {
      setState(await deleteOwnProfilePhoto());
      setNotice("프로필 사진을 지웠어요. 이름 첫 글자로 보여요.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "사진을 지우지 못했어요.");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="px-4 py-3.5" data-profile-photo-settings>
      <div className="flex items-center gap-4">
        {pending === undefined ? (
          <Avatar name={name} photoUrl={photo?.url ?? null} size={PREVIEW_SIZE} />
        ) : (
          <img
            alt="새 프로필 사진 미리보기"
            className="shrink-0 rounded-full border border-role-border object-cover"
            height={PREVIEW_SIZE}
            src={pending.previewUrl}
            width={PREVIEW_SIZE}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-bold text-app-text">프로필 사진</p>
          <p className="mt-0.5 break-keep text-xs leading-5 text-app-muted" id={descriptionId}>
            저장한 사진은 같은 반의 승인된 구성원과 선생님에게 보여요.
          </p>
          <p className="break-keep text-xs leading-5 text-app-muted">
            다른 사람의 얼굴이나 개인정보가 담긴 사진은 올리지 마세요.
          </p>
        </div>
      </div>

      <div aria-live="polite" className="mt-3 flex flex-wrap gap-2">
        {pending === undefined ? (
          <>
            <input
              accept={PROFILE_PHOTO_ACCEPT}
              aria-describedby={descriptionId}
              aria-label="프로필 사진 고르기"
              className="sr-only"
              disabled={busy !== undefined}
              onChange={(event) => void choose(event.target.files?.[0])}
              ref={inputRef}
              type="file"
            />
            <button
              aria-busy={busy === "prepare"}
              className="ui-button ui-button-secondary min-h-11 text-sm"
              disabled={busy !== undefined}
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              {busy === "prepare" ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
              ) : (
                <Camera aria-hidden="true" size={17} />
              )}
              {photo === null ? "사진 고르기" : "사진 바꾸기"}
            </button>
            {photo === null ? null : (
              <button
                aria-busy={busy === "delete"}
                className="ui-button ui-button-tertiary min-h-11 text-sm text-danger-text"
                disabled={busy !== undefined}
                onClick={() => setDeleteOpen(true)}
                ref={deleteButtonRef}
                type="button"
              >
                {busy === "delete" ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
                ) : (
                  <Trash2 aria-hidden="true" size={17} />
                )}
                사진 지우기
              </button>
            )}
          </>
        ) : (
          <>
            <button
              aria-busy={busy === "save"}
              className="ui-button ui-button-primary min-h-11 text-sm"
              disabled={busy !== undefined}
              onClick={() => void save()}
              type="button"
            >
              {busy === "save" ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
              ) : null}
              {busy === "save" ? "저장하는 중..." : "이 사진으로 저장"}
            </button>
            <button
              className="ui-button ui-button-secondary min-h-11 text-sm"
              disabled={busy !== undefined}
              onClick={() => {
                setPending(undefined);
                setError(undefined);
              }}
              type="button"
            >
              취소
            </button>
          </>
        )}
      </div>

      {error === undefined ? null : (
        <p
          className="mt-3 rounded-xl border border-danger-border bg-danger-surface px-3 py-2 text-sm font-medium text-danger-text"
          role="alert"
        >
          {error}
        </p>
      )}
      {notice === undefined ? null : (
        <p className="mt-3 text-sm font-semibold text-role-primary" role="status">
          {notice}
        </p>
      )}

      <ConfirmDialog
        confirmLabel="사진 지우기"
        confirmTone="danger"
        description="지우면 반 친구와 선생님에게 이름 첫 글자로 보여요."
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          setDeleteOpen(false);
          void remove();
        }}
        open={deleteOpen}
        returnFocusTo={deleteButtonRef.current}
        title="프로필 사진을 지울까요?"
      />
    </div>
  );
}
