import { CheckCircle2, LoaderCircle, Pencil, RefreshCw, Save, UserMinus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
  ApiRequestError,
  getBootstrap,
  getMemberProfile,
  updateMemberProfile,
  removeMember,
  type MemberListItem,
} from "../../api/auth";
import { codePointLength } from "../../lib/text";
import { teacherOnlyAccessRedirect } from "../layout/access-redirect-notice";
import { AsyncStatePanel, StaleDataAlert } from "../layout/async-state";
import { ConfirmDialog } from "../layout/confirm-dialog";
import { confirmMemberTransition } from "./member-transition-recovery";

interface ProfileDraft {
  displayName: string;
  studentNumber: string;
}

interface ProfileEditError {
  field: "display_name" | "student_number" | null;
  message: string;
}

const forbiddenDisplayNameCharacters = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/u;

function hasHtmlElement(value: string): boolean {
  if (typeof DOMParser === "undefined") return /<[A-Za-z][^>]*>/u.test(value);
  return new DOMParser().parseFromString(value, "text/html").body.querySelector("*") !== null;
}

function validateOptionalDisplayName(value: string): string | undefined {
  const normalized = value.trim();
  if (normalized === "") return undefined;
  const length = codePointLength(normalized);
  if (length < 2 || length > 20) {
    return "반에서 보이는 이름은 비워 두거나 2~20자로 입력해 주세요.";
  }
  if (forbiddenDisplayNameCharacters.test(normalized) || hasHtmlElement(normalized)) {
    return "반에서 보이는 이름에는 줄바꿈, 제어 문자, HTML 요소를 사용할 수 없어요.";
  }
  return undefined;
}

function draftFromMember(member: MemberListItem): ProfileDraft {
  return {
    displayName: member.display_name_in_class ?? "",
    studentNumber: member.student_number === null ? "" : String(member.student_number),
  };
}

interface MemberProfilePanelProps {
  memberId: string | undefined;
  initialMember?: MemberListItem;
  onProfileChanged?: (member: MemberListItem) => void;
  onRemoved?: (notice: string) => void;
  initiallyEditing?: boolean;
}

export function MemberProfilePanel({
  memberId,
  initialMember,
  onProfileChanged,
  onRemoved,
  initiallyEditing = false,
}: MemberProfilePanelProps): React.JSX.Element {
  const navigate = useNavigate();
  const [member, setMember] = useState<MemberListItem | undefined>(initialMember);
  const [draft, setDraft] = useState<ProfileDraft>(
    initialMember === undefined
      ? { displayName: "", studentNumber: "" }
      : draftFromMember(initialMember),
  );
  const [loading, setLoading] = useState(initialMember === undefined);
  const [editing, setEditing] = useState(initiallyEditing);
  const [removeReason, setRemoveReason] = useState("");
  const [removing, setRemoving] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [editError, setEditError] = useState<ProfileEditError>();
  const [notice, setNotice] = useState<string>();
  const displayNameInputRef = useRef<HTMLInputElement>(null);
  const studentNumberInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const loadGenerationRef = useRef(0);

  async function loadProfile(): Promise<boolean> {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setLoadError(undefined);
    setLoadFailed(false);
    try {
      const bootstrap = await getBootstrap();
      if (generation !== loadGenerationRef.current) return false;
      const accessRedirect = teacherOnlyAccessRedirect(bootstrap);
      if (accessRedirect !== null) {
        void navigate(accessRedirect.path, {
          replace: true,
          ...(accessRedirect.path === "/home" ? { state: accessRedirect.state } : {}),
        });
        return false;
      }
      if (memberId === undefined) {
        setMember(undefined);
        setLoadFailed(true);
        setLoadError("학생 정보 주소가 올바르지 않아요.");
        return false;
      }

      const result = await getMemberProfile(memberId);
      if (generation !== loadGenerationRef.current) return false;
      setMember(result.member);
      setDraft(draftFromMember(result.member));
      setEditError(undefined);
      setLoadFailed(false);
      return true;
    } catch (requestError) {
      if (generation !== loadGenerationRef.current) return false;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return false;
      }
      if (
        requestError instanceof ApiRequestError &&
        (requestError.status === 403 || requestError.status === 423)
      ) {
        void navigate("/bootstrap", { replace: true });
        return false;
      }
      setLoadFailed(true);
      if (requestError instanceof ApiRequestError && requestError.status === 404) {
        setMember(undefined);
        setLoadError(
          "승인 학생 정보를 찾을 수 없어요. 학생의 반 또는 승인 상태가 바뀌었는지 목록에서 확인해 주세요.",
        );
      } else {
        setLoadError("학생 정보를 불러오지 못했어요.");
      }
      return false;
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    setMember(initialMember);
    setNotice(undefined);
    setEditError(undefined);
    if (initialMember === undefined) void loadProfile();
  }, [memberId]);

  useEffect(() => {
    if (initialMember === undefined || editing || saving) return;
    setMember(initialMember);
    setDraft(draftFromMember(initialMember));
  }, [initialMember]);

  async function saveProfile(): Promise<void> {
    if (member === undefined || submittingRef.current) return;
    const normalizedDisplayName = draft.displayName.trim();
    const displayNameError = validateOptionalDisplayName(draft.displayName);
    const studentNumber = draft.studentNumber.trim() === "" ? null : Number(draft.studentNumber);

    setNotice(undefined);
    setEditError(undefined);
    if (displayNameError !== undefined) {
      setEditError({ field: "display_name", message: displayNameError });
      displayNameInputRef.current?.focus();
      return;
    }
    if (
      studentNumber !== null &&
      (!Number.isInteger(studentNumber) || studentNumber < 1 || studentNumber > 99)
    ) {
      setEditError({
        field: "student_number",
        message: "학생 번호는 비워 두거나 1부터 99 사이의 정수로 입력해 주세요.",
      });
      studentNumberInputRef.current?.focus();
      return;
    }

    const nextDisplayName = normalizedDisplayName === "" ? null : normalizedDisplayName;
    const displayNameChanged = nextDisplayName !== member.display_name_in_class;
    const studentNumberChanged = studentNumber !== member.student_number;
    if (!displayNameChanged && !studentNumberChanged) {
      setNotice(`${member.display_name} 학생 정보는 이미 같은 값입니다.`);
      return;
    }

    const request =
      displayNameChanged && studentNumberChanged
        ? { display_name_in_class: nextDisplayName, student_number: studentNumber }
        : displayNameChanged
          ? { display_name_in_class: nextDisplayName }
          : { student_number: studentNumber };

    submittingRef.current = true;
    setSaving(true);
    try {
      const result = await updateMemberProfile(member.id, request, member.row_version);
      setMember(result.member);
      setDraft(draftFromMember(result.member));
      onProfileChanged?.(result.member);
      setEditing(false);
      setNotice(
        result.profile_updated
          ? `${result.member.display_name} 학생 정보를 저장했습니다.`
          : `${result.member.display_name} 학생 정보는 이미 같은 값입니다.`,
      );
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      if (requestError instanceof ApiRequestError && requestError.status === 409) {
        const reloaded = await loadProfile();
        setEditError({
          field: null,
          message: reloaded
            ? requestError.code === "STUDENT_NUMBER_ALREADY_IN_USE"
              ? "학생 번호가 다른 학생에게 먼저 지정되어 최신 정보를 불러왔습니다. 다시 확인해 주세요."
              : "학생 정보가 다른 작업에서 먼저 변경되어 최신 정보를 불러왔습니다. 다시 수정해 주세요."
            : "학생 정보가 먼저 변경됐지만 최신 정보를 불러오지 못했습니다. 학생 목록에서 상태를 다시 확인해 주세요.",
        });
        return;
      }
      if (
        requestError instanceof ApiRequestError &&
        (requestError.status === 403 || requestError.status === 404 || requestError.status === 423)
      ) {
        const reloaded = await loadProfile();
        if (!reloaded && requestError.status !== 404) {
          void navigate("/bootstrap", { replace: true });
        }
        return;
      }
      setEditError({
        field: null,
        message:
          requestError instanceof Error ? requestError.message : "학생 정보를 저장하지 못했습니다.",
      });
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }

  function requestRemove(): void {
    if (codePointLength(removeReason.trim()) > 300) {
      setNotice(undefined);
      setEditError({ field: null, message: "반에서 제외 사유는 300자 이하로 입력해 주세요." });
      return;
    }
    setRemoveDialogOpen(true);
  }

  async function removeSelectedMember(): Promise<void> {
    if (member === undefined || removing) return;
    setRemoving(true);
    setEditError(undefined);
    setNotice(undefined);
    try {
      const result = await removeMember(member.id, removeReason.trim() || null);
      const message =
        member.display_name +
        " 학생을 반에서 제외했습니다." +
        (result.email_delivery_status === "failed"
          ? " 안내 메일을 보내지 못했어요. 학생에게 결과를 알려 주세요."
          : "");
      if (onRemoved !== undefined) onRemoved(message);
      else void navigate("/members/manage?tab=approved", { state: { memberNotice: message } });
    } catch (requestError) {
      if (await confirmMemberTransition(requestError, member.id, "removed")) {
        const message = "학생이 제외된 것을 확인했어요. 안내 메일이 갔는지는 확인하지 못했어요.";
        if (onRemoved !== undefined) onRemoved(message);
        else void navigate("/members/manage?tab=approved", { state: { memberNotice: message } });
        return;
      }
      setEditError({
        field: null,
        message:
          requestError instanceof Error
            ? requestError.message
            : "학생을 반에서 제외하지 못했습니다.",
      });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col" data-member-profile-layout="panel">
      {notice === undefined ? null : (
        <p
          className="mt-4 flex items-center gap-2 text-sm font-bold text-role-primary"
          role="status"
        >
          <CheckCircle2 aria-hidden="true" size={18} />
          {notice}
        </p>
      )}
      {loadFailed && member !== undefined ? (
        <StaleDataAlert
          busy={loading}
          description="이전에 불러온 학생 정보를 계속 표시하고 있어 최신 정보와 다를 수 있어요."
          onRetry={() => void loadProfile()}
          title="최신 학생 정보를 확인하지 못했어요."
        />
      ) : null}
      {member === undefined ? (
        loadFailed ? (
          <AsyncStatePanel
            action={
              <button
                aria-busy={loading}
                className="ui-button ui-button-primary text-sm"
                disabled={loading}
                onClick={() => void loadProfile()}
                type="button"
              >
                다시 시도
              </button>
            }
            description={loadError ?? "인터넷 연결을 확인하고 학생 목록에서 다시 열어 주세요."}
            kind="error"
            title="학생 정보를 열 수 없어요."
            tone="neutral"
          />
        ) : (
          <AsyncStatePanel kind="loading" title="학생 정보를 불러오고 있어요." tone="neutral" />
        )
      ) : (
        <>
          <section aria-label={member.display_name + " 학생 상태"} className="min-w-0">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-app-surface-muted text-base font-extrabold text-app-text">
                {member.student_number ?? "—"}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="break-words text-[21px] font-extrabold text-app-text">
                  {member.display_name}
                </h2>
                <p className="mt-1 text-[13px] text-app-muted">
                  {new Intl.DateTimeFormat("ko-KR", {
                    month: "long",
                    day: "numeric",
                    timeZone: "Asia/Seoul",
                  }).format(new Date(member.status_changed_at))}
                  부터 참여
                </p>
              </div>
              <button
                aria-busy={loading}
                aria-label="학생 정보 새로고침"
                className="ui-icon-button ui-button-secondary"
                disabled={loading || saving || removing}
                onClick={() => void loadProfile()}
                type="button"
              >
                <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} size={18} />
              </button>
            </div>
            <dl className="mt-[18px] border-t border-app-border text-sm">
              <div className="flex min-h-[46px] items-center justify-between gap-3 border-b border-app-border">
                <dt className="text-app-muted">반에서 보이는 이름</dt>
                <dd className="break-words text-right font-bold text-app-text">
                  {member.display_name_in_class ?? member.display_name}
                </dd>
              </div>
              <div className="flex min-h-[46px] items-center justify-between gap-3 border-b border-app-border">
                <dt className="text-app-muted">번호</dt>
                <dd className="font-bold text-app-text">
                  {member.student_number === null ? "미지정" : member.student_number + "번"}
                </dd>
              </div>
            </dl>
          </section>
          {editing ? (
            <form
              aria-label={`${member.display_name} 학생 정보 수정`}
              className="mt-5 min-w-0 border-t border-app-border pt-5"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void saveProfile();
              }}
            >
              <h3 className="text-base font-extrabold text-app-text">이름·번호 수정</h3>
              <p className="mt-2 text-sm leading-6 text-app-muted">
                반에서 보이는 이름을 비워 두면 학생이 설정한 기본 이름을 사용합니다. 학생 번호도
                비워 둘 수 있습니다.
              </p>
              <div className="mt-5 grid gap-4">
                <label className="text-sm font-bold text-app-text">
                  반에서 보이는 이름
                  <input
                    aria-describedby={`member-profile-display-hint${
                      editError?.field === "display_name" ? " member-profile-error" : ""
                    }`}
                    aria-label="반에서 보이는 이름"
                    aria-invalid={editError?.field === "display_name" ? true : undefined}
                    className="auth-input mt-2"
                    disabled={saving}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, displayName: event.target.value }))
                    }
                    placeholder="기본 이름 사용"
                    ref={displayNameInputRef}
                    value={draft.displayName}
                  />
                  <span
                    className="mt-1 block text-xs font-medium leading-5 text-app-muted"
                    id="member-profile-display-hint"
                  >
                    선택 · 일반 텍스트 2~20자
                  </span>
                </label>
                <label className="text-sm font-bold text-app-text">
                  학생 번호
                  <input
                    aria-describedby={`member-profile-number-hint${
                      editError?.field === "student_number" ? " member-profile-error" : ""
                    }`}
                    aria-label="학생 번호"
                    aria-invalid={editError?.field === "student_number" ? true : undefined}
                    className="auth-input mt-2"
                    disabled={saving}
                    inputMode="numeric"
                    max={99}
                    min={1}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, studentNumber: event.target.value }))
                    }
                    placeholder="미지정"
                    ref={studentNumberInputRef}
                    type="number"
                    value={draft.studentNumber}
                  />
                  <span
                    className="mt-1 block text-xs font-medium leading-5 text-app-muted"
                    id="member-profile-number-hint"
                  >
                    선택 · 1~99
                  </span>
                </label>
              </div>
              {editError === undefined ? null : (
                <p
                  className="mt-4 text-sm font-bold text-danger"
                  id="member-profile-error"
                  role="alert"
                >
                  {editError.message}
                </p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <button
                  className="ui-button ui-button-secondary"
                  disabled={saving}
                  onClick={() => {
                    setDraft(draftFromMember(member));
                    setEditing(false);
                    setEditError(undefined);
                  }}
                  type="button"
                >
                  취소
                </button>
                <button
                  aria-busy={saving}
                  className="ui-button ui-button-primary"
                  disabled={saving || loading || loadFailed}
                  type="submit"
                >
                  {saving ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
                  ) : (
                    <Save aria-hidden="true" size={17} />
                  )}
                  저장
                </button>
              </div>
            </form>
          ) : (
            <button
              className="ui-button ui-button-secondary mt-5 self-end text-sm"
              disabled={loading || loadFailed || removing}
              onClick={() => {
                setEditing(true);
                window.setTimeout(() => displayNameInputRef.current?.focus(), 0);
              }}
              type="button"
            >
              <Pencil aria-hidden="true" size={16} />
              이름·번호 수정
            </button>
          )}
          {!editing && editError !== undefined ? (
            <p className="mt-4 text-sm font-bold text-danger" role="alert">
              {editError.message}
            </p>
          ) : null}
          <div className="mt-auto pt-6">
            <div className="rounded-2xl border border-rose-200 p-4">
              <h3 className="text-sm font-extrabold text-danger">반에서 제외</h3>
              <input
                aria-label={member.display_name + " 반에서 제외 사유"}
                className="ui-input ui-input-compact mt-3"
                disabled={removing || saving}
                onChange={(event) => setRemoveReason(event.target.value)}
                placeholder="반에서 제외 사유 (선택)"
                value={removeReason}
              />
              <button
                aria-busy={removing}
                className="ui-button ui-button-danger mt-3 text-sm"
                disabled={loading || loadFailed || removing || saving}
                onClick={requestRemove}
                ref={removeTriggerRef}
                type="button"
              >
                {removing ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" size={16} />
                ) : (
                  <UserMinus aria-hidden="true" size={16} />
                )}
                반에서 제외
              </button>
            </div>
          </div>
        </>
      )}
      <ConfirmDialog
        confirmLabel="반에서 제외"
        description="즉시 반 자료 접근이 차단되고 학생 번호가 해제됩니다. 학생은 초대 코드로 다시 참여를 요청할 수 있으며, 재신청 후 선생님의 승인이 필요합니다. 입력한 사유가 있으면 학생에게 표시됩니다."
        onCancel={() => setRemoveDialogOpen(false)}
        onConfirm={() => {
          setRemoveDialogOpen(false);
          void removeSelectedMember();
        }}
        open={removeDialogOpen}
        returnFocusTo={removeTriggerRef.current}
        title={(member?.display_name ?? "선택한") + " 학생을 반에서 제외할까요?"}
      />
    </div>
  );
}
