import {
  Archive,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Check,
  Copy,
  KeyRound,
  LockKeyhole,
  LoaderCircle,
  ScrollText,
  Pencil,
  RefreshCw,
  RotateCcw,
  School,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import {
  ApiRequestError,
  getBootstrap,
  getCurrentClass,
  getCurrentInviteCode,
  rotateCurrentInviteCode,
  updateCurrentClass,
  type CurrentClassResponse,
  type InviteCodeResponse,
} from "../../api/auth";
import {
  clearIdempotentCreateAttempt,
  expiredMutationResultMessage,
  idempotentCreateStorageKey,
  type IdempotentCreateAttempt,
  isMutationOutcomeUnknown,
  persistIdempotentCreateAttempt,
  prepareServerDatedIdempotentCreateAttempt,
  readIdempotentCreateAttempt,
  unavailableMutationAuthorityMessage,
  unavailableMutationStorageMessage,
  unknownMutationResultMessage,
} from "../../lib/idempotent-create";
import { codePointLength } from "../../lib/text";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import { teacherOnlyAccessRedirect } from "../layout/access-redirect-notice";
import { AppShell } from "../layout/app-shell";
import { AsyncStatePanel } from "../layout/async-state";
import { ConfirmDialog } from "../layout/confirm-dialog";
import { ContentFrameBody, ContentFrameHeader } from "../layout/content-frame";
import { AppearanceControl } from "../theme";
import { InviteQrCode } from "./invite-qr-code";
import { DetailsGrid, SchoolDetailsPanel } from "./school-details-panel";

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    // 초대 코드 발급 시각은 뷰어 기기 시간대가 아니라 KST 기준으로 고정한다.
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

interface InviteCodeRotationAttemptRequest {
  previous_code: string;
}

const UNKNOWN_INVITE_ROTATION_MESSAGE = unknownMutationResultMessage("반 초대 코드 재발급 요청");
const UNKNOWN_CLASS_UPDATE_MESSAGE =
  "반 정보 저장 결과를 확인하지 못했습니다. 입력을 유지했습니다. 같은 내용으로 다시 저장하면 두 번 바뀌지 않고 결과를 확인할 수 있어요.";

function isInviteCodeRotationAttemptRequest(
  value: unknown,
): value is InviteCodeRotationAttemptRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<InviteCodeRotationAttemptRequest>).previous_code === "string"
  );
}

/**
 * 휴대폰에서는 더보기에서 들어오므로 돌아가는 링크를 둔다. 제목 위 줄이 아니라 제목 줄 오른쪽 도구
 * 자리에 두어 제목 위치가 다른 탭과 같다. PC는 왼쪽 메뉴에 반 관리가 있어 숨긴다.
 */
function ClassManageBackLink(): React.JSX.Element {
  return (
    <Link className="content-back-link px-2 lg:hidden" to="/more">
      <ChevronLeft aria-hidden="true" size={20} />
      더보기
    </Link>
  );
}

export function TeacherClassManagementPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [currentClass, setCurrentClass] = useState<CurrentClassResponse>();
  const [invite, setInvite] = useState<InviteCodeResponse>();
  const [accountDisplayName, setAccountDisplayName] = useState("");
  const [accountDeletionAllowed, setAccountDeletionAllowed] = useState(false);
  const [membershipId, setMembershipId] = useState<string>();
  const [serverToday, setServerToday] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [shellReady, setShellReady] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateOutcomeUnknown, setRotateOutcomeUnknown] = useState(false);
  const [rotateDialogOpen, setRotateDialogOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftExpectedStudentCount, setDraftExpectedStudentCount] = useState(30);
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string | undefined;
    count?: string | undefined;
  }>({});
  const studentCountInputRef = useRef<HTMLInputElement>(null);
  const classNameInputRef = useRef<HTMLInputElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const rotateButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditingRef = useRef(false);
  const rotatingRef = useRef(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(false);
  const lifetimeGenerationRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const rotateAttemptRef = useRef<
    IdempotentCreateAttempt<InviteCodeRotationAttemptRequest> | undefined
  >(undefined);
  const rotateAttemptStorageKey =
    membershipId === undefined
      ? undefined
      : idempotentCreateStorageKey("invite-code-rotations", membershipId);

  async function load(): Promise<void> {
    const lifetime = lifetimeGenerationRef.current;
    const generation = ++loadGenerationRef.current;
    const isCurrent = () =>
      mountedRef.current &&
      lifetime === lifetimeGenerationRef.current &&
      generation === loadGenerationRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const bootstrap = await getBootstrap();
      if (!isCurrent()) return;
      const accessRedirect = teacherOnlyAccessRedirect(bootstrap);
      if (accessRedirect !== null) {
        void navigate(accessRedirect.path, {
          replace: true,
          ...(accessRedirect.path === "/home" ? { state: accessRedirect.state } : {}),
        });
        return;
      }
      const teacherMembership = bootstrap.current_membership;
      if (teacherMembership === null) return;
      setShellReady(true);
      setAccountDeletionAllowed(bootstrap.allowed_actions.includes("DELETE_ACCOUNT"));
      setAccountDisplayName(bootstrap.account.display_name);
      setMembershipId(teacherMembership.id);
      setServerToday(bootstrap.server_today);
      const [nextClass, nextInvite] = await Promise.all([
        getCurrentClass(),
        getCurrentInviteCode(),
      ]);
      if (!isCurrent()) return;
      const nextRotateStorageKey = idempotentCreateStorageKey(
        "invite-code-rotations",
        teacherMembership.id,
      );
      const pendingRotation = readIdempotentCreateAttempt(
        nextRotateStorageKey,
        isInviteCodeRotationAttemptRequest,
      );
      setCurrentClass(nextClass);
      setInvite(nextInvite);
      setDraftName(nextClass.name);
      setDraftExpectedStudentCount(nextClass.expected_student_count ?? 30);
      if (
        pendingRotation !== undefined &&
        pendingRotation.request.previous_code === nextInvite.invite_code.code
      ) {
        rotateAttemptRef.current = pendingRotation;
        setRotateOutcomeUnknown(true);
        setError(UNKNOWN_INVITE_ROTATION_MESSAGE);
      } else {
        if (pendingRotation !== undefined) {
          clearIdempotentCreateAttempt(nextRotateStorageKey, pendingRotation.idempotencyKey);
          setNotice("반 초대 코드 재발급 결과를 확인했습니다.");
        }
        rotateAttemptRef.current = undefined;
        setRotateOutcomeUnknown(false);
      }
    } catch (requestError) {
      if (!isCurrent()) return;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(
        requestError instanceof Error ? requestError.message : "반 정보를 불러오지 못했습니다.",
      );
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    lifetimeGenerationRef.current += 1;
    const clearSession = (): void => {
      lifetimeGenerationRef.current += 1;
      loadGenerationRef.current += 1;
      rotateAttemptRef.current = undefined;
      rotatingRef.current = false;
      savingRef.current = false;
      setCurrentClass(undefined);
      setInvite(undefined);
      setMembershipId(undefined);
      setAccountDisplayName("");
      setAccountDeletionAllowed(false);
      setShellReady(false);
      setDraftName("");
      setDraftExpectedStudentCount(30);
      setRotateDialogOpen(false);
      setEditing(false);
      setCopied(false);
      setError(undefined);
      setNotice(undefined);
      void navigate("/bootstrap", { replace: true });
    };
    window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, clearSession);
    void load();
    return () => {
      mountedRef.current = false;
      lifetimeGenerationRef.current += 1;
      loadGenerationRef.current += 1;
      window.removeEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, clearSession);
    };
  }, []);

  useEffect(() => {
    if (editing) classNameInputRef.current?.focus();
    else if (wasEditingRef.current) editButtonRef.current?.focus();
    wasEditingRef.current = editing;
  }, [editing]);

  async function copyInviteCode(): Promise<void> {
    if (invite === undefined) return;
    const lifetime = lifetimeGenerationRef.current;
    try {
      await navigator.clipboard.writeText(invite.invite_code.code);
      if (!mountedRef.current || lifetime !== lifetimeGenerationRef.current) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      if (!mountedRef.current || lifetime !== lifetimeGenerationRef.current) return;
      setError("반 초대 코드를 복사하지 못했습니다. 코드를 직접 선택해 주세요.");
    }
  }

  async function rotateInviteCode(): Promise<void> {
    if (
      !mountedRef.current ||
      rotatingRef.current ||
      invite === undefined ||
      rotateAttemptStorageKey === undefined ||
      serverToday === undefined
    ) {
      return;
    }
    const lifetime = lifetimeGenerationRef.current;
    const isCurrent = () => mountedRef.current && lifetime === lifetimeGenerationRef.current;
    rotatingRef.current = true;
    setRotating(true);
    setError(undefined);
    setNotice(undefined);
    setCopied(false);
    const finishRotation = (): void => {
      if (!isCurrent()) return;
      rotatingRef.current = false;
      setRotating(false);
    };

    const existingAttempt =
      rotateAttemptRef.current ??
      readIdempotentCreateAttempt(rotateAttemptStorageKey, isInviteCodeRotationAttemptRequest);
    let authoritativeServerToday = serverToday;
    let currentInvite = invite;

    if (existingAttempt !== undefined) {
      try {
        const [freshBootstrap, freshInvite] = await Promise.all([
          getBootstrap(),
          getCurrentInviteCode(),
        ]);
        if (!isCurrent()) return;
        const freshMembership = freshBootstrap.current_membership;
        if (
          freshBootstrap.destination !== "HOME" ||
          freshMembership?.id !== membershipId ||
          freshMembership?.role !== "teacher" ||
          !freshBootstrap.allowed_actions.includes("MANAGE_CLASS")
        ) {
          void navigate("/bootstrap", { replace: true });
          finishRotation();
          return;
        }
        authoritativeServerToday = freshBootstrap.server_today;
        setServerToday(freshBootstrap.server_today);
        currentInvite = freshInvite;
        setInvite(freshInvite);
        if (freshInvite.invite_code.code !== existingAttempt.request.previous_code) {
          clearIdempotentCreateAttempt(rotateAttemptStorageKey, existingAttempt.idempotencyKey);
          rotateAttemptRef.current = undefined;
          setRotateOutcomeUnknown(false);
          setNotice("반 초대 코드 재발급 결과를 확인했습니다.");
          finishRotation();
          return;
        }
      } catch (requestError) {
        if (!isCurrent()) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
        } else {
          setError(unavailableMutationAuthorityMessage("반 초대 코드 재발급 요청"));
        }
        finishRotation();
        return;
      }
    }

    const rotationRequest =
      existingAttempt?.request ?? ({ previous_code: currentInvite.invite_code.code } as const);
    const preparation = prepareServerDatedIdempotentCreateAttempt(
      rotateAttemptStorageKey,
      rotationRequest,
      authoritativeServerToday,
      existingAttempt,
    );
    if (preparation.kind === "expired") {
      setError(expiredMutationResultMessage("반 초대 코드 재발급 요청"));
      finishRotation();
      return;
    }
    if (preparation.kind === "mismatch") {
      setError(
        "확인하지 못한 반 초대 코드 재발급 요청이 남아 있습니다. 먼저 그 결과를 확인해 주세요.",
      );
      finishRotation();
      return;
    }
    if (preparation.kind === "storage-unavailable") {
      setError(unavailableMutationStorageMessage());
      finishRotation();
      return;
    }
    rotateAttemptRef.current = preparation.attempt;
    try {
      const nextInvite = await rotateCurrentInviteCode(preparation.attempt.idempotencyKey);
      if (!isCurrent()) return;
      clearIdempotentCreateAttempt(rotateAttemptStorageKey, preparation.attempt.idempotencyKey);
      rotateAttemptRef.current = undefined;
      setRotateOutcomeUnknown(false);
      setInvite(nextInvite);
      setNotice("반 초대 코드를 재발급했습니다.");
    } catch (requestError) {
      if (!isCurrent()) return;
      if (isMutationOutcomeUnknown(requestError)) {
        setRotateOutcomeUnknown(true);
        setError(
          persistIdempotentCreateAttempt(rotateAttemptStorageKey, preparation.attempt)
            ? UNKNOWN_INVITE_ROTATION_MESSAGE
            : `${UNKNOWN_INVITE_ROTATION_MESSAGE} 이 화면을 닫거나 새로고침하지 마세요. 닫으면 저장됐는지 다시 확인할 수 없어요.`,
        );
      } else {
        clearIdempotentCreateAttempt(rotateAttemptStorageKey, preparation.attempt.idempotencyKey);
        rotateAttemptRef.current = undefined;
        setRotateOutcomeUnknown(false);
        setError(
          requestError instanceof Error
            ? requestError.message
            : "반 초대 코드를 재발급하지 못했습니다.",
        );
      }
    } finally {
      finishRotation();
    }
  }

  async function saveClassInformation(): Promise<void> {
    if (!mountedRef.current || currentClass === undefined || savingRef.current) return;
    const lifetime = lifetimeGenerationRef.current;
    const isCurrent = () => mountedRef.current && lifetime === lifetimeGenerationRef.current;
    const name = draftName.trim();
    const nameLength = codePointLength(name);
    const nextErrors = {
      ...(nameLength < 1 || nameLength > 40
        ? { name: "반 이름은 1자 이상 40자 이하로 입력해 주세요." }
        : {}),
      ...(!Number.isInteger(draftExpectedStudentCount) ||
      draftExpectedStudentCount < 1 ||
      draftExpectedStudentCount > 60
        ? { count: "예상 학생 수는 1명 이상 60명 이하로 입력해 주세요." }
        : {}),
    };
    setFieldErrors(nextErrors);
    if (nextErrors.name || nextErrors.count) {
      (nextErrors.name ? classNameInputRef : studentCountInputRef).current?.focus();
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const updated = await updateCurrentClass(
        { expected_student_count: draftExpectedStudentCount, name },
        currentClass.row_version,
      );
      if (!isCurrent()) return;
      setCurrentClass(updated);
      setDraftName(updated.name);
      setDraftExpectedStudentCount(updated.expected_student_count ?? draftExpectedStudentCount);
      setEditing(false);
      setNotice("반 정보를 저장했습니다.");
    } catch (requestError) {
      if (!isCurrent()) return;
      let recoveredCommittedUpdate = false;
      if (
        requestError instanceof ApiRequestError &&
        requestError.code === "RESOURCE_VERSION_CHANGED"
      ) {
        try {
          const latest = await getCurrentClass();
          if (!isCurrent()) return;
          setCurrentClass(latest);
          setDraftName(latest.name);
          setDraftExpectedStudentCount(latest.expected_student_count ?? 30);
          if (latest.name === name && latest.expected_student_count === draftExpectedStudentCount) {
            setEditing(false);
            setNotice("반 정보 저장 결과를 확인했습니다.");
            recoveredCommittedUpdate = true;
          }
        } catch {
          if (!isCurrent()) return;
          // The original concurrency error remains the most useful message.
        }
      }
      if (!recoveredCommittedUpdate) {
        setError(
          isMutationOutcomeUnknown(requestError)
            ? UNKNOWN_CLASS_UPDATE_MESSAGE
            : requestError instanceof Error
              ? requestError.message
              : "반 정보를 수정하지 못했습니다.",
        );
      }
    } finally {
      if (isCurrent()) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  if (currentClass === undefined || invite === undefined) {
    return (
      <AppShell
        alignedFrame
        contentFrame
        {...(shellReady ? { navigationRole: "teacher" as const } : {})}
        width="wide"
      >
        <ContentFrameHeader actions={shellReady ? <ClassManageBackLink /> : null} title="반 관리" />
        <ContentFrameBody>
          <AsyncStatePanel
            {...(loading
              ? {}
              : {
                  action: (
                    <button
                      className="ui-button ui-button-primary text-sm"
                      onClick={() => void load()}
                      type="button"
                    >
                      <RefreshCw size={17} />
                      다시 시도
                    </button>
                  ),
                  description:
                    "반 정보는 변경되지 않았습니다. 인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요.",
                })}
            kind={loading ? "loading" : "error"}
            title={loading ? "반 정보를 준비하고 있어요." : "반 정보를 불러오지 못했어요."}
            tone="neutral"
          />
        </ContentFrameBody>
      </AppShell>
    );
  }
  const expired = invite.invite_code.status === "expired";
  return (
    <AppShell alignedFrame contentFrame navigationRole="teacher" width="wide">
      <ContentFrameHeader actions={<ClassManageBackLink />} title="반 관리">
        <p
          className="mt-2 flex min-w-0 flex-col items-start gap-1 text-sm text-app-muted sm:flex-row sm:items-center sm:gap-2"
          aria-label="현재 반 상태"
        >
          <span
            className="min-w-0 max-w-full break-words [overflow-wrap:anywhere] sm:truncate"
            title={currentClass.name}
          >
            {currentClass.name}
          </span>
          <span className="shrink-0">
            <span aria-hidden="true" className="hidden sm:inline">
              ·{" "}
            </span>
            승인 학생 {currentClass.active_student_count}명
          </span>
        </p>
      </ContentFrameHeader>
      <ContentFrameBody>
        {error === undefined ? null : (
          <p
            className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
            role="alert"
          >
            {error}
          </p>
        )}
        {notice === undefined ? null : (
          <p
            aria-live="polite"
            className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-700"
            role="status"
          >
            {notice}
          </p>
        )}

        <div
          className="grid min-w-0 items-start gap-[18px] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
          data-class-management-overview="true"
        >
          <div className="min-w-0">
            <h2 className="mb-2 text-[13px] font-bold text-app-muted">학생 초대</h2>
            <section aria-label="학생 초대" className="content-card p-3.5 sm:p-[18px]">
              <div className="flex min-w-0 items-center gap-2 sm:gap-4">
                {expired ? null : <InviteQrCode code={invite.invite_code.code} compact />}
                <div className="min-w-0 flex-1">
                  <code className="block break-all text-[26px] font-extrabold leading-tight tracking-[0.06em] text-role-primary">
                    {invite.invite_code.code}
                  </code>
                  <p className="mt-1 text-xs leading-5 text-app-muted">
                    {expired ? "만료된 초대 코드예요" : "학생이 앱에서 이 코드를 넣어요"}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      aria-live="polite"
                      className="ui-button ui-button-secondary min-h-11 px-2 text-sm sm:px-3"
                      onClick={() => void copyInviteCode()}
                      type="button"
                    >
                      {copied ? (
                        <Check aria-hidden="true" size={16} />
                      ) : (
                        <Copy aria-hidden="true" size={16} />
                      )}
                      {copied ? "복사됨" : "코드 복사"}
                    </button>
                    <button
                      aria-busy={rotating}
                      aria-label={
                        rotateOutcomeUnknown ? "결과 다시 확인" : "새 코드 (반 초대 코드 재발급)"
                      }
                      className="ui-button ui-button-secondary min-h-11 px-2 text-sm sm:px-3"
                      disabled={rotating}
                      onClick={() => setRotateDialogOpen(true)}
                      ref={rotateButtonRef}
                      type="button"
                    >
                      {rotating ? (
                        <LoaderCircle aria-hidden="true" className="animate-spin" size={16} />
                      ) : (
                        <RotateCcw aria-hidden="true" size={16} />
                      )}
                      {rotateOutcomeUnknown ? "결과 다시 확인" : "새 코드"}
                    </button>
                  </div>
                </div>
              </div>
              <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-app-muted">
                <CalendarClock aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
                {formatDateTime(invite.invite_code.expires_at)}까지 쓸 수 있어요.
              </p>
              <Link
                className="ui-button ui-button-primary mt-3 min-h-11 text-sm"
                to="/members/manage"
              >
                학생 참여 요청 확인
              </Link>
              <details className="mt-3 border-t border-app-border pt-1">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-bold text-app-muted">
                  학생과 시작하기
                </summary>
                <p className="text-sm leading-6 text-app-muted">
                  학생에게 초대 코드를 전달하고 참여 요청을 승인해 주세요. 첫 공지를 게시한 뒤 공지
                  상세에서 학생들의 확인 현황을 볼 수 있어요.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    className="ui-button ui-button-secondary text-sm"
                    to="/updates?create=notice"
                  >
                    첫 공지 작성
                  </Link>
                </div>
              </details>
            </section>
          </div>
          <div className="min-w-0">
            <h2 className="mb-2 text-[13px] font-bold text-app-muted">반 정보</h2>
            <section
              aria-label="반 정보"
              className="content-card overflow-hidden p-0 divide-y divide-app-border"
            >
              <details>
                <summary className="content-row cursor-pointer gap-3 px-4">
                  <School aria-hidden="true" className="shrink-0 text-role-primary" size={20} />
                  <span className="shrink-0 text-[15px] font-bold">학교</span>
                  <span className="ml-auto min-w-0 truncate text-right text-sm text-app-muted">
                    {currentClass.school_name}
                  </span>
                  <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={18} />
                </summary>
                <div className="px-4 pb-4">
                  <SchoolDetailsPanel school={currentClass} />
                </div>
              </details>
              <div>
                <button
                  aria-controls="class-information-editor"
                  aria-expanded={editing}
                  aria-label="반 이름 · 예상 학생 수 수정"
                  className="content-row w-full gap-3 px-4 text-left"
                  disabled={saving}
                  onClick={() => {
                    setDraftName(currentClass.name);
                    setDraftExpectedStudentCount(currentClass.expected_student_count ?? 30);
                    setFieldErrors({});
                    setEditing(!editing);
                    setError(undefined);
                    setNotice(undefined);
                  }}
                  ref={editButtonRef}
                  type="button"
                >
                  <Pencil aria-hidden="true" className="shrink-0 text-role-primary" size={20} />
                  {/* 학년도는 고칠 수 없어 제목에서 뺐다 — 고칠 수 있는 두 칸만(총검수 B1-12). */}
                  <span className="grid min-w-0 flex-1 gap-1 sm:flex sm:items-center sm:justify-between sm:gap-3">
                    <span className="text-[15px] font-bold">반 이름 · 인원</span>
                    <span className="min-w-0 truncate text-sm text-app-muted sm:max-w-[45%] sm:text-right">
                      {currentClass.name} · 예상 {currentClass.expected_student_count ?? "-"}명
                    </span>
                  </span>
                  <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={18} />
                </button>
                {editing ? (
                  <form
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveClassInformation();
                    }}
                    className="grid gap-4 border-t border-app-border bg-app-surface-muted p-4 sm:grid-cols-2"
                    id="class-information-editor"
                  >
                    <label className="text-sm font-bold text-app-text">
                      반 이름
                      <input
                        className="ui-input ui-input-compact mt-2"
                        aria-label="반 이름"
                        aria-invalid={fieldErrors.name ? true : undefined}
                        aria-describedby={fieldErrors.name ? "class-name-error" : undefined}
                        onChange={(event) => {
                          setDraftName(event.target.value);
                          setFieldErrors((value) => ({ ...value, name: undefined }));
                        }}
                        ref={classNameInputRef}
                        value={draftName}
                      />
                      {fieldErrors.name ? (
                        <span
                          id="class-name-error"
                          role="alert"
                          className="mt-2 block text-sm font-medium text-rose-700"
                        >
                          {fieldErrors.name}
                        </span>
                      ) : null}
                    </label>
                    <label className="text-sm font-bold text-app-text">
                      예상 학생 수
                      <input
                        className="ui-input ui-input-compact mt-2"
                        aria-label="예상 학생 수"
                        aria-invalid={fieldErrors.count ? true : undefined}
                        aria-describedby={fieldErrors.count ? "class-count-error" : undefined}
                        ref={studentCountInputRef}
                        max={60}
                        min={1}
                        onChange={(event) => {
                          setDraftExpectedStudentCount(Number(event.target.value));
                          setFieldErrors((value) => ({ ...value, count: undefined }));
                        }}
                        type="number"
                        value={draftExpectedStudentCount}
                      />
                      {fieldErrors.count ? (
                        <span
                          id="class-count-error"
                          role="alert"
                          className="mt-2 block text-sm font-medium text-rose-700"
                        >
                          {fieldErrors.count}
                        </span>
                      ) : null}
                    </label>
                    {draftExpectedStudentCount < currentClass.active_student_count ? (
                      <p className="text-sm font-bold text-app-muted sm:col-span-2">
                        현재 승인 학생 수보다 작아도 저장할 수 있습니다. 예상 학생 수는 승인 제한이
                        아닙니다.
                      </p>
                    ) : null}
                    <div className="flex gap-2 sm:col-span-2">
                      <button
                        aria-busy={saving}
                        className="ui-button ui-button-primary text-sm"
                        disabled={saving}
                        type="submit"
                      >
                        {saving ? (
                          <LoaderCircle aria-hidden="true" className="animate-spin" size={16} />
                        ) : (
                          <Save size={16} />
                        )}
                        저장
                      </button>
                      <button
                        className="ui-button ui-button-secondary text-sm"
                        disabled={saving}
                        onClick={() => {
                          setEditing(false);
                          setFieldErrors({});
                          setError(undefined);
                          setNotice(undefined);
                        }}
                        type="button"
                      >
                        취소
                      </button>
                    </div>
                  </form>
                ) : null}

                {/* 학년도·학년·승인 학생 수는 수정을 열지 않아도 늘 보인다(총검수 B1-12). */}
                <div className="px-4 pb-4">
                  <DetailsGrid
                    details={[
                      [
                        "학년도 · 학년",
                        currentClass.academic_year + "학년도 · " + currentClass.grade + "학년",
                      ],
                      [
                        "승인 학생",
                        currentClass.active_student_count +
                          "명 / 예상 " +
                          currentClass.expected_student_count +
                          "명",
                      ],
                      ["담임 선생님", currentClass.teacher_display_name],
                    ]}
                  />
                </div>
              </div>
              <Link
                aria-label="관리 기록 보기"
                className="content-row gap-3 px-4"
                to="/class/manage/audit-logs"
              >
                <ScrollText aria-hidden="true" className="shrink-0 text-role-primary" size={20} />
                <span className="flex-1 text-[15px] font-bold">관리 기록</span>
                <span className="text-sm text-app-muted">관리 활동 보기</span>
                <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={18} />
              </Link>
            </section>
            {currentClass.active_student_count > (currentClass.expected_student_count ?? 0) ? (
              <p className="mt-3 rounded-2xl bg-app-surface-muted px-4 py-3 text-sm font-bold text-app-muted">
                승인 학생 수가 예상 학생 수를 넘었습니다. 반 참여 요청과 승인은 계속 가능합니다.
              </p>
            ) : null}
          </div>
        </div>
        <details className="content-card mt-4 p-0">
          <summary className="content-row cursor-pointer gap-3 px-4">
            <LockKeyhole aria-hidden="true" className="shrink-0 text-role-primary" size={20} />
            <span className="flex-1 text-[15px] font-bold">계정 관리</span>
            <span className="max-w-[45%] truncate text-sm text-app-muted">
              {accountDisplayName}
            </span>
            <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={18} />
          </summary>
          <div className="border-t border-app-border px-4 pb-4">
            <AppearanceControl className="mt-5 rounded-2xl border border-app-border bg-app-surface-muted p-4" />
            <p className="mt-4 text-sm font-bold text-app-muted">기본 이름</p>
            <p className="mt-1 text-lg font-black text-app-text">{accountDisplayName}</p>
            <p className="mt-4 text-sm leading-6 text-app-muted">
              비밀번호를 변경하면 현재 기기를 포함한 모든 기기에서 로그아웃됩니다.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link className="ui-button ui-button-secondary text-sm" to="/account/profile">
                <Pencil aria-hidden="true" size={17} /> 내 이름 변경
              </Link>
              <Link className="ui-button ui-button-secondary text-sm" to="/account/password">
                <KeyRound aria-hidden="true" size={17} /> 비밀번호 변경
              </Link>
            </div>

            <div className="mt-6 border-t border-rose-100 pt-6">
              <h3 className="font-black text-rose-800">계정 삭제</h3>
              {accountDeletionAllowed ? (
                <>
                  <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
                    계정과 반 접근이 즉시 종료되며 삭제한 계정은 복구할 수 없습니다.
                  </p>
                  <Link className="ui-button ui-button-danger mt-5 text-sm" to="/account/deletion">
                    <Trash2 aria-hidden="true" size={17} /> 계정 삭제 알아보기
                  </Link>
                </>
              ) : (
                <div className="mt-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-900">
                  <p className="break-keep">
                    운영 중이거나 일시 중지된 담당 반이 있으면 계정을 삭제할 수 없습니다. 먼저 반
                    운영을 종료하거나 관리자에게 이관해 주세요.
                  </p>
                  <Link
                    className="mt-2 inline-flex min-h-11 items-center font-black underline"
                    to="/account/deletion"
                  >
                    계정 삭제 조건 확인
                  </Link>
                </div>
              )}
            </div>
          </div>
        </details>
        <Link
          aria-label="반 운영 종료 알아보기"
          className="mt-[18px] block rounded-2xl border border-rose-200 bg-app-surface p-4"
          to="/class/archive"
        >
          <span className="flex items-center gap-2 text-[15px] font-extrabold text-danger">
            <Archive aria-hidden="true" size={18} />반 운영 종료
            <ChevronRight aria-hidden="true" className="ml-auto" size={18} />
          </span>
          <span className="mt-1 block text-[13px] leading-5 text-app-muted">
            반 접근과 초대 코드가 종료돼요. 보존 범위를 확인하고 반 이름을 다시 입력한 뒤
            진행합니다.
          </span>
        </Link>
        <ConfirmDialog
          confirmLabel={rotateOutcomeUnknown ? "결과 다시 확인" : "반 초대 코드 재발급"}
          description={
            rotateOutcomeUnknown
              ? "코드가 바뀌었는지 먼저 확인해요. 그대로면 한 번 더 요청하지만, 새 코드를 또 만들지는 않아요."
              : "기존 코드는 즉시 사용할 수 없어요. 이미 승인을 기다리는 반 참여 요청은 유지됩니다."
          }
          onCancel={() => setRotateDialogOpen(false)}
          onConfirm={() => {
            setRotateDialogOpen(false);
            void rotateInviteCode();
          }}
          open={rotateDialogOpen}
          returnFocusTo={rotateButtonRef.current}
          title={
            rotateOutcomeUnknown
              ? "반 초대 코드 재발급 결과를 다시 확인할까요?"
              : "반 초대 코드를 재발급할까요?"
          }
        />
      </ContentFrameBody>
    </AppShell>
  );
}
