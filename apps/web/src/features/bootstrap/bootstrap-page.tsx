import {
  AlertTriangle,
  DoorOpen,
  LoaderCircle,
  LogOut,
  MailCheck,
  KeyRound,
  RefreshCw,
  School,
  UserRoundCog,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";

import {
  ApiRequestError,
  cancelMembershipRequest,
  createMembershipRequest,
  getBootstrap,
  leaveCurrentClass,
  logout,
  resendVerificationEmail,
  type BootstrapDestination,
  type BootstrapResponse,
} from "../../api/auth";
import { consumeHomeAuthorizationRecheckRouteState } from "./bootstrap-route-state";
import { isMutationOutcomeUnknown } from "../../lib/idempotent-create";
import { SignupApprovalForm } from "./signup-approval-form";
import { AppShell, ProductWordmark } from "../layout/app-shell";
import { ConfirmDialog } from "../layout/confirm-dialog";
import { PageHeader } from "../layout/page-header";
import { PastClassesEntry } from "../past-classes/past-classes-entry";
import { useRequestCooldown } from "../auth/request-cooldown";
import { clearPendingInviteCode, readPendingInviteCode } from "../../lib/invite-link";

interface DestinationCopy {
  description: string;
  eyebrow: string;
  title: string;
}

const destinationCopy: Record<BootstrapDestination, DestinationCopy> = {
  TEACHER_REVOKED: {
    eyebrow: "계정 권한",
    title: "선생님 권한이 회수되었어요",
    description: "반 접근은 중지됐습니다. 비밀번호 변경 또는 로그아웃을 이용해 주세요.",
  },
  CHANGE_TEMPORARY_PASSWORD: {
    eyebrow: "계정 보호",
    title: "임시 비밀번호를 바꿔 주세요",
    description: "반 기능을 사용하기 전에 본인만 아는 새 비밀번호로 변경해야 합니다.",
  },
  VERIFY_EMAIL: {
    eyebrow: "이메일 확인",
    title: "이메일을 확인해 주세요",
    description: "가입한 이메일로 보낸 확인 링크를 누른 뒤 우리 반에 참여할 수 있습니다.",
  },
  SIGNUP_APPROVAL_REQUIRED: {
    eyebrow: "이메일 인증",
    title: "이메일로 받은 인증번호를 입력해 주세요",
    description: "가입한 이메일로 보낸 6자리 번호로 가입 인증을 완료해요.",
  },
  HOME: {
    eyebrow: "우리 반",
    title: "홈으로 갈 준비가 됐어요",
    description: "현재 반 참여 상태와 반 상태가 정상입니다. 홈으로 이동합니다.",
  },
  CLASS_SUSPENDED: {
    eyebrow: "반 일시 중지",
    title: "지금은 이 반을 이용할 수 없어요",
    description: "업무 데이터는 보호를 위해 차단됐습니다. 학생은 반 나가기를 선택할 수 있습니다.",
  },
  MEMBERSHIP_PENDING: {
    eyebrow: "반 참여",
    title: "반 참여 승인을 기다리고 있어요",
    description: "선생님이 참여 요청을 승인하면 홈에서 공지와 할 일을 확인할 수 있어요.",
  },
  CREATE_CLASS: {
    eyebrow: "시작 안내",
    title: "반을 만들어 주세요",
    description: "현재 담당 반이 없습니다. 학교를 선택하고 새 반을 만들어 시작하세요.",
  },
  ENTER_INVITE_CODE: {
    eyebrow: "반 참여",
    title: "반에 참여해 주세요",
    description: "선생님에게 받은 8자리 반 초대 코드를 입력하면 반 참여 요청을 보내요.",
  },
};

const membershipStatusLabels: Readonly<Record<string, string>> = {
  account_deleted: "계정 삭제 완료",
  archived: "반 운영 종료",
  canceled: "반 참여 요청 취소",
  left: "반 나가기 완료",
  rejected: "반 참여 요청 거절",
  rejoin_allowed: "다시 참여 가능",
  removed: "반에서 제외",
  transferred: "다른 반으로 이동",
};

export function BootstrapPage(): React.JSX.Element {
  const cooldownSeconds = useRequestCooldown();
  const location = useLocation();
  const navigate = useNavigate();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [error, setError] = useState<string>();
  const [authorizationMismatch, setAuthorizationMismatch] = useState(false);
  const [clearRouteStateBeforeRetry, setClearRouteStateBeforeRetry] = useState(false);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  // QR로 들어왔다면 코드를 미리 채운다. 요청은 학생이 직접 보낸다.
  const [inviteCode, setInviteCode] = useState(() => readPendingInviteCode() ?? "");
  const [inviteCodeInvalid, setInviteCodeInvalid] = useState(false);
  const [inviteCodeError, setInviteCodeError] = useState<string>();
  const inviteCodeInputRef = useRef<HTMLInputElement>(null);
  const [joining, setJoining] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [resendingVerification, setResendingVerification] = useState(false);
  const [verificationNotice, setVerificationNotice] = useState<string>();
  const [membershipNotice, setMembershipNotice] = useState<string>();
  const [transitioningMembership, setTransitioningMembership] = useState(false);
  const [confirmingMembershipAction, setConfirmingMembershipAction] = useState<
    "cancel" | "leave"
  >();
  const cancelMembershipButtonRef = useRef<HTMLButtonElement>(null);
  const leaveClassButtonRef = useRef<HTMLButtonElement>(null);
  const resendRequestInFlightRef = useRef(false);
  const bootstrapLoadGenerationRef = useRef(0);
  const homeAuthorizationRecheck = useMemo(
    () => consumeHomeAuthorizationRecheckRouteState(location.state, location.key),
    [location.key, location.state],
  );
  const bootstrapRequestKey = `${location.key}:${homeAuthorizationRecheck.status}:${
    homeAuthorizationRecheck.status === "accepted" ? homeAuthorizationRecheck.expiresAt : ""
  }`;
  const bootstrapMountedRef = useRef(false);
  const activeBootstrapRequestKeyRef = useRef(bootstrapRequestKey);
  const bootstrapLoadInFlightRef = useRef<
    { decision: object; generation: number; promise: Promise<void>; requestKey: string } | undefined
  >(undefined);
  activeBootstrapRequestKeyRef.current = bootstrapRequestKey;

  useEffect(() => {
    if (inviteCodeInvalid && inviteCodeError !== undefined) inviteCodeInputRef.current?.focus();
  }, [inviteCodeInvalid, inviteCodeError]);

  const loadBootstrap = useCallback((): Promise<void> => {
    const inFlight = bootstrapLoadInFlightRef.current;
    if (
      inFlight?.requestKey === bootstrapRequestKey &&
      inFlight.decision === homeAuthorizationRecheck
    ) {
      return inFlight.promise;
    }
    const generation = ++bootstrapLoadGenerationRef.current;
    const isCurrentRequest = (): boolean =>
      bootstrapMountedRef.current &&
      activeBootstrapRequestKeyRef.current === bootstrapRequestKey &&
      generation === bootstrapLoadGenerationRef.current;
    setBootstrapLoading(true);
    setError(undefined);
    setClearRouteStateBeforeRetry(false);
    let redirecting = false;
    const request = (async () => {
      try {
        const result = await getBootstrap();
        if (!isCurrentRequest()) return;
        if (result.destination === "HOME") {
          if (
            homeAuthorizationRecheck.status === "accepted" &&
            Date.now() <= homeAuthorizationRecheck.expiresAt
          ) {
            setBootstrap(undefined);
            setAuthorizationMismatch(true);
            return;
          }
          if (homeAuthorizationRecheck.status !== "absent") {
            setAuthorizationMismatch(false);
            setBootstrap(undefined);
            setClearRouteStateBeforeRetry(true);
            setError("이 주소는 더 이상 쓸 수 없어요. 처음 화면에서 다시 시작해 주세요.");
            return;
          }
          redirecting = true;
          void navigate("/home", { replace: true });
          return;
        }
        setAuthorizationMismatch(false);
        setClearRouteStateBeforeRetry(false);
        setBootstrap(result);
      } catch (requestError) {
        if (!isCurrentRequest()) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          redirecting = true;
          void navigate("/login", { replace: true });
          return;
        }
        setAuthorizationMismatch(false);
        setBootstrap(undefined);
        setClearRouteStateBeforeRetry(homeAuthorizationRecheck.status === "invalid");
        setError(
          requestError instanceof ApiRequestError && requestError.status === 403
            ? "계정 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요."
            : "인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요.",
        );
      } finally {
        if (isCurrentRequest() && !redirecting) setBootstrapLoading(false);
        if (bootstrapLoadInFlightRef.current?.generation === generation) {
          bootstrapLoadInFlightRef.current = undefined;
        }
      }
    })();
    bootstrapLoadInFlightRef.current = {
      decision: homeAuthorizationRecheck,
      generation,
      promise: request,
      requestKey: bootstrapRequestKey,
    };
    return request;
  }, [bootstrapRequestKey, homeAuthorizationRecheck, navigate]);

  useEffect(() => {
    bootstrapMountedRef.current = true;
    setBootstrap(undefined);
    setAuthorizationMismatch(false);
    void loadBootstrap();
    return () => {
      bootstrapMountedRef.current = false;
    };
  }, [loadBootstrap]);

  function retryBootstrapLookup(): void {
    if (clearRouteStateBeforeRetry) {
      void navigate("/bootstrap", { replace: true, state: null });
      return;
    }
    void loadBootstrap();
  }

  async function submitLogout(): Promise<void> {
    setLoggingOut(true);
    setError(undefined);
    setInviteCodeInvalid(false);
    try {
      await logout();
      void navigate("/login", { replace: true });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "로그아웃하지 못했습니다.");
      setLoggingOut(false);
    }
  }

  async function submitVerificationResend(): Promise<void> {
    if (resendRequestInFlightRef.current) return;
    resendRequestInFlightRef.current = true;
    setResendingVerification(true);
    setVerificationNotice(undefined);
    setError(undefined);
    setInviteCodeInvalid(false);

    try {
      const result = await resendVerificationEmail();
      if (result.verification_delivery_status === "failed") {
        setError(
          "이메일 확인 메일을 보내지 못했어요. 계정은 그대로 유지돼요. 잠시 후 다시 보내거나 화면 아래 문의 이메일로 알려 주세요.",
        );
        return;
      }
      setVerificationNotice(
        "이메일 확인 메일을 다시 보냈어요. 받은편지함과 스팸함을 확인해 주세요.",
      );
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }

      if (
        requestError instanceof ApiRequestError &&
        requestError.code === "EMAIL_ALREADY_VERIFIED"
      ) {
        try {
          const refreshedBootstrap = await getBootstrap();
          if (refreshedBootstrap.destination === "HOME") {
            void navigate("/home", { replace: true });
          } else {
            setBootstrap(refreshedBootstrap);
          }
        } catch (refreshError) {
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : "계정 상태를 다시 확인하지 못했습니다.",
          );
        }
        return;
      }

      setError(
        requestError instanceof Error
          ? requestError.message
          : "이메일 확인 메일을 다시 보내지 못했습니다.",
      );
    } finally {
      resendRequestInFlightRef.current = false;
      setResendingVerification(false);
    }
  }

  async function submitMembershipRequest(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (cooldownSeconds > 0 || joining) return;
    const normalizedCode = inviteCode.trim().toUpperCase();
    setError(undefined);
    setInviteCodeInvalid(false);
    setInviteCodeError(undefined);
    if (!/^[A-HJ-KM-NP-Z2-9]{8}$/u.test(normalizedCode)) {
      setInviteCodeInvalid(true);
      setInviteCodeError("반 초대 코드는 혼동 문자를 제외한 영문 대문자와 숫자 8자리입니다.");
      return;
    }

    setJoining(true);
    try {
      const result = await createMembershipRequest(normalizedCode);
      setMembershipNotice(
        result.email_delivery_status === "failed" ||
          result.teacher_notification_delivery_status === "failed"
          ? "참여 요청은 접수됐지만 일부 안내 메일을 보내지 못했어요. 이 화면에서 승인 상태를 확인해 주세요."
          : undefined,
      );
      setInviteCode("");
      clearPendingInviteCode();
      setInviteCodeInvalid(false);
      setBootstrap(await getBootstrap());
    } catch (requestError) {
      setInviteCodeInvalid(false);
      if (
        isMutationOutcomeUnknown(requestError) ||
        (requestError instanceof ApiRequestError &&
          requestError.code === "CURRENT_MEMBERSHIP_EXISTS")
      ) {
        try {
          const confirmed = await getBootstrap();
          if (confirmed.current_membership !== null) {
            setInviteCode("");
            setBootstrap(confirmed);
            setMembershipNotice("반 참여 상태를 다시 확인했어요.");
            return;
          }
        } catch {
          // Keep the original uncertain result if the state lookup also fails.
        }
      }
      if (requestError instanceof ApiRequestError) {
        if (requestError.code === "INVITE_CODE_INVALID_OR_EXPIRED") {
          setInviteCodeInvalid(true);
          setInviteCodeError(
            "반 초대 코드가 올바르지 않거나 만료됐어요. 선생님에게 새 코드를 확인해 주세요.",
          );
        } else if (requestError.code === "RATE_LIMITED") {
          setError(requestError.message);
        } else {
          setError(requestError.message);
        }
      } else {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "반 참여 요청을 보내지 못했습니다.",
        );
      }
    } finally {
      setJoining(false);
    }
  }

  async function submitOwnMembershipTransition(action: "cancel" | "leave"): Promise<void> {
    setTransitioningMembership(true);
    setError(undefined);
    setInviteCodeInvalid(false);
    try {
      if (action === "cancel") await cancelMembershipRequest();
      else await leaveCurrentClass();
      setBootstrap(await getBootstrap());
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : action === "cancel"
            ? "반 참여 요청을 취소하지 못했습니다."
            : "반에서 나가지 못했습니다.",
      );
    } finally {
      setTransitioningMembership(false);
    }
  }

  if (authorizationMismatch) {
    return (
      <AppShell centered width="narrow">
        <div
          aria-busy={bootstrapLoading}
          className="rounded-shell border border-amber-200 bg-app-surface-raised p-5 text-center shadow-card sm:p-6"
          role="alert"
        >
          <AlertTriangle aria-hidden="true" className="mx-auto text-amber-600" size={32} />
          <h1 className="mt-4 text-xl font-black text-app-text">
            홈 화면 권한을 다시 확인해 주세요.
          </h1>
          <p className="mt-3 break-keep text-sm leading-6 text-app-muted">
            계정 안내와 홈 화면 접근 상태가 일치하지 않아 안전하게 이동을 멈췄어요. 잠시 후 직접
            다시 확인해 주세요.
          </p>
          <button
            aria-busy={bootstrapLoading}
            className="ui-button ui-button-primary mt-5 text-sm"
            disabled={bootstrapLoading}
            onClick={() => void loadBootstrap()}
            type="button"
          >
            {bootstrapLoading ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
            ) : (
              <RefreshCw aria-hidden="true" size={17} />
            )}
            {bootstrapLoading ? "확인 중" : "다시 확인"}
          </button>
        </div>
      </AppShell>
    );
  }

  if (bootstrap === undefined) {
    return (
      <AppShell centered width="narrow">
        <div
          aria-busy={bootstrapLoading}
          aria-live={bootstrapLoading ? "polite" : "assertive"}
          className="rounded-shell border border-app-border bg-app-surface-raised p-5 text-center shadow-card sm:p-6"
          role={bootstrapLoading ? "status" : "alert"}
        >
          {bootstrapLoading ? (
            <LoaderCircle
              aria-hidden="true"
              className="mx-auto animate-spin text-role-primary"
              size={32}
            />
          ) : (
            <AlertTriangle aria-hidden="true" className="mx-auto text-rose-500" size={32} />
          )}
          <p className="mt-4 font-bold">
            {bootstrapLoading ? "계정 상태를 확인하고 있어요." : "계정 상태를 확인하지 못했어요."}
          </p>
          {bootstrapLoading || error === undefined ? null : (
            <>
              <p className="mt-3 text-sm text-rose-600">{error}</p>
              <button
                className="ui-button ui-button-primary mt-5 text-sm"
                onClick={retryBootstrapLookup}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={17} /> 다시 시도
              </button>
            </>
          )}
        </div>
      </AppShell>
    );
  }

  const inlineInviteError =
    bootstrap.destination === "ENTER_INVITE_CODE" &&
    inviteCodeInvalid &&
    inviteCodeError !== undefined;
  const waitingForTeacherApproval =
    bootstrap.destination === "SIGNUP_APPROVAL_REQUIRED" &&
    bootstrap.account.signup_role === "teacher" &&
    bootstrap.account.email_verified;
  const copy = waitingForTeacherApproval
    ? {
        eyebrow: "교사 승인 대기",
        title: "관리자 승인을 기다리고 있어요",
        description: "이메일 인증을 마쳤어요. 관리자가 선생님임을 확인하고 승인해야 해요.",
      }
    : destinationCopy[bootstrap.destination];

  return (
    <AppShell
      width="narrow"
      showRequestCooldownNotice={bootstrap.destination !== "MEMBERSHIP_PENDING"}
    >
      <ProductWordmark className="mb-4" context="계정 안내" />
      <PageHeader description={copy.description} eyebrow={copy.eyebrow} title={copy.title} />
      {membershipNotice === undefined ? null : (
        <p
          className="mb-4 rounded-xl border border-warning-border bg-warning-surface p-4 text-sm leading-6 text-warning-text"
          role="status"
        >
          {membershipNotice}
        </p>
      )}

      <section className="mt-5 rounded-shell border border-app-border bg-app-surface-raised p-5 shadow-card sm:p-6">
        {bootstrap.destination === "MEMBERSHIP_PENDING" || waitingForTeacherApproval ? (
          <div className="rounded-2xl border border-role-border bg-role-soft p-4">
            {/* 코드를 잘못 넣어 다른 반에 요청했을 때 되돌리는 길을 알려 준다(2026-10-21 첫 사용 점검 11).
                요청한 반은 아래 '현재 반' 상자에 학교와 함께 보인다. */}
            {bootstrap.destination === "MEMBERSHIP_PENDING" &&
            bootstrap.current_class !== null &&
            bootstrap.allowed_actions.includes("CANCEL_MEMBERSHIP_REQUEST") ? (
              <p className="mb-2 break-keep text-sm leading-6 text-app-text">
                다른 반이면 아래 ‘반 참여 요청 취소’를 눌러 주세요.
              </p>
            ) : null}
            <p className="break-keep text-sm leading-6 text-app-text">
              {waitingForTeacherApproval
                ? "관리자가 확인하면 가입한 이메일로 승인번호를 보내요. 다른 기기에서 번호를 입력했다면 여기서 승인 상태를 확인해 주세요."
                : "승인이 끝났는지 확인해 주세요. 승인되면 홈으로 이동합니다."}
            </p>
            {/* 교사 승인은 아래 승인번호 입력으로만 끝나므로, 그 확인 단추와 겹치지 않게 보조 단추로 둔다
                (2026-10-21 첫 사용 점검: 진한 주 단추 두 개). */}
            <button
              aria-busy={bootstrapLoading}
              className={`ui-button ${waitingForTeacherApproval ? "ui-button-secondary" : "ui-button-primary"} mt-3 min-h-12 w-full rounded-2xl`}
              disabled={bootstrapLoading || transitioningMembership || joining || loggingOut}
              onClick={() => void loadBootstrap()}
              type="button"
            >
              <RefreshCw
                aria-hidden="true"
                className={bootstrapLoading ? "animate-spin" : ""}
                size={18}
              />
              {bootstrapLoading ? "확인 중" : "승인 상태 확인"}
            </button>
          </div>
        ) : null}
        {bootstrap.destination === "SIGNUP_APPROVAL_REQUIRED" &&
        bootstrap.allowed_actions.includes("CONFIRM_SIGNUP_APPROVAL") ? (
          <SignupApprovalForm
            onApproved={loadBootstrap}
            signupRole={bootstrap.account.signup_role ?? null}
            emailMasked={bootstrap.account.email_masked}
            emailVerified={bootstrap.account.email_verified}
          />
        ) : null}
        {bootstrap.destination === "VERIFY_EMAIL" &&
        bootstrap.allowed_actions.includes("RESEND_EMAIL") ? (
          <button
            aria-busy={resendingVerification}
            className="ui-button ui-button-primary mt-5 h-12 w-full rounded-2xl"
            disabled={resendingVerification || cooldownSeconds > 0}
            onClick={() => void submitVerificationResend()}
            type="button"
          >
            {resendingVerification ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
            ) : (
              <MailCheck aria-hidden="true" size={18} />
            )}
            {resendingVerification ? "보내는 중" : "이메일 확인 메일 다시 보내기"}
          </button>
        ) : null}

        {verificationNotice === undefined ? null : (
          <p
            aria-label="이메일 확인 메일 재발송 결과"
            aria-live="polite"
            className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800"
            role="status"
          >
            {verificationNotice}
          </p>
        )}

        {bootstrap.destination !== "HOME" &&
        !["CREATE_CLASS", "ENTER_INVITE_CODE"].includes(bootstrap.destination) &&
        bootstrap.allowed_actions.includes("CHANGE_PASSWORD") ? (
          <Link
            className="ui-button ui-button-primary mt-5 h-12 w-full rounded-2xl"
            to="/account/password"
          >
            <KeyRound aria-hidden="true" size={18} />
            비밀번호 변경
          </Link>
        ) : null}

        {bootstrap.destination === "ENTER_INVITE_CODE" ? (
          <form
            className="mt-5 space-y-3 rounded-2xl border border-app-border bg-app-surface-muted p-4"
            onSubmit={(event) => void submitMembershipRequest(event)}
          >
            <label className="block text-sm font-bold text-app-text" htmlFor="invite-code">
              반 초대 코드
            </label>
            <p className="break-keep text-sm leading-6 text-app-muted" id="invite-code-next-step">
              코드를 입력한 뒤 선생님의 승인을 받으면 홈에서 우리 반 안내를 확인할 수 있어요.
            </p>
            <input
              aria-describedby={
                inviteCodeInvalid && inviteCodeError !== undefined
                  ? "invite-code-next-step invite-code-error"
                  : "invite-code-next-step"
              }
              aria-invalid={inviteCodeInvalid || undefined}
              autoCapitalize="characters"
              autoComplete="off"
              className="auth-input text-center font-mono text-xl font-black uppercase tracking-[0.28em]"
              id="invite-code"
              maxLength={8}
              onChange={(event) => {
                setInviteCode(event.target.value.toUpperCase());
                if (inviteCodeInvalid) {
                  setInviteCodeInvalid(false);
                  setInviteCodeError(undefined);
                }
              }}
              placeholder="ABCDEFGH"
              ref={inviteCodeInputRef}
              spellCheck={false}
              value={inviteCode}
            />
            {inlineInviteError ? (
              <p
                id="invite-code-error"
                className="text-sm font-medium leading-6 text-danger-text"
                role="alert"
              >
                {inviteCodeError}
              </p>
            ) : null}
            <button
              aria-busy={joining}
              className="ui-button ui-button-primary h-12 w-full rounded-2xl"
              disabled={joining || cooldownSeconds > 0}
              type="submit"
            >
              {joining ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
              ) : (
                <DoorOpen size={18} />
              )}
              반 참여 요청 보내기
            </button>
          </form>
        ) : null}

        {bootstrap.current_class === null ? null : (
          <div className="mt-4 rounded-2xl bg-app-surface-muted px-4 py-3">
            <p className="text-sm font-bold text-app-muted">현재 반</p>
            <p className="mt-1 font-black text-app-text">
              {bootstrap.current_class.school_name} · {bootstrap.current_class.name}
            </p>
          </div>
        )}

        {bootstrap.destination === "HOME" && bootstrap.allowed_actions.includes("MANAGE_CLASS") ? (
          <button
            className="ui-button ui-button-primary mt-4 h-12 w-full rounded-2xl"
            onClick={() => void navigate("/members/manage")}
            type="button"
          >
            <UserRoundCog size={18} />
            학생 관리
          </button>
        ) : null}

        {bootstrap.destination === "CREATE_CLASS" &&
        bootstrap.allowed_actions.includes("CREATE_CLASS") ? (
          <button
            className="ui-button ui-button-primary mt-4 h-12 w-full rounded-2xl"
            onClick={() => void navigate("/class/create")}
            type="button"
          >
            <School size={18} />반 만들기
          </button>
        ) : null}

        {/* 반을 닫았거나 학교를 옮겨 지금 반이 없어도 지난 반 기록은 볼 수 있다(S1). */}
        {bootstrap.destination === "CREATE_CLASS" ||
        bootstrap.destination === "ENTER_INVITE_CODE" ? (
          <PastClassesEntry className="mt-4" />
        ) : null}

        {bootstrap.destination === "MEMBERSHIP_PENDING" &&
        bootstrap.allowed_actions.includes("CANCEL_MEMBERSHIP_REQUEST") ? (
          <button
            aria-busy={transitioningMembership}
            className="ui-button ui-button-danger mt-4 h-12 w-full rounded-2xl"
            disabled={transitioningMembership}
            onClick={() => setConfirmingMembershipAction("cancel")}
            ref={cancelMembershipButtonRef}
            type="button"
          >
            {transitioningMembership ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
            ) : (
              <DoorOpen size={18} />
            )}
            반 참여 요청 취소
          </button>
        ) : null}

        {bootstrap.destination === "CLASS_SUSPENDED" &&
        bootstrap.allowed_actions.includes("LEAVE_CLASS") ? (
          <button
            aria-busy={transitioningMembership}
            className="ui-button ui-button-danger mt-4 h-12 w-full rounded-2xl"
            disabled={transitioningMembership}
            onClick={() => setConfirmingMembershipAction("leave")}
            ref={leaveClassButtonRef}
            type="button"
          >
            {transitioningMembership ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
            ) : (
              <DoorOpen size={18} />
            )}
            반 나가기
          </button>
        ) : null}

        {bootstrap.destination === "CREATE_CLASS" ||
        bootstrap.destination === "ENTER_INVITE_CODE" ? (
          <div className="mt-6 border-t border-app-border pt-4">
            <h2 className="text-sm font-bold text-app-muted">계정 설정</h2>
            {bootstrap.allowed_actions.includes("CHANGE_PASSWORD") ? (
              <Link
                className="ui-button ui-button-secondary mt-3 h-12 w-full rounded-2xl"
                to="/account/password"
              >
                <KeyRound aria-hidden="true" size={18} />
                비밀번호 변경
              </Link>
            ) : null}
          </div>
        ) : null}

        {/* 계정 설정은 보조 동작이라 코드 입력·반 만들기 뒤에 둔다. */}
        {bootstrap.account.email_verified &&
        bootstrap.teacher_profile?.status !== "revoked" &&
        bootstrap.teacher_profile?.temporary_password_must_change !== true &&
        !["CHANGE_TEMPORARY_PASSWORD", "TEACHER_REVOKED", "VERIFY_EMAIL"].includes(
          bootstrap.destination,
        ) ? (
          <Link
            className="ui-button ui-button-secondary mt-4 h-12 w-full rounded-2xl"
            to="/account/profile"
          >
            <UserRoundCog aria-hidden="true" size={18} />내 이름 변경
          </Link>
        ) : null}

        {bootstrap.last_membership_status === null ? null : (
          <div className="mt-4 rounded-2xl border border-app-border px-4 py-4 text-sm text-app-muted">
            최근 반 참여 상태:{" "}
            <strong>
              {membershipStatusLabels[bootstrap.last_membership_status] ?? "상태 확인 필요"}
            </strong>
            {bootstrap.last_status_reason === null
              ? null
              : ` · 사유: ${bootstrap.last_status_reason}`}
          </div>
        )}

        {error === undefined ? null : (
          <p
            className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
            id="bootstrap-error"
            role="alert"
          >
            {error}
          </p>
        )}

        {/* 막 가입한 사람에게 빨간 삭제 상자가 크게 보여 놀라게 했다(2026-10-21 첫 사용 점검 7).
            삭제 경로는 그대로 두고 화면 끝의 작은 글자 링크로 둔다. */}
        {bootstrap.allowed_actions.includes("DELETE_ACCOUNT") ? (
          <Link
            className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-app-muted underline decoration-app-border underline-offset-4 hover:text-app-text"
            to="/account/deletion"
          >
            계정 삭제 알아보기
          </Link>
        ) : null}

        {/* 화면 끝 '기준일'은 이 화면에서 쓰임이 없어 처음 쓰는 사람에게 뜻 모를 날짜였다(첫 사용 점검 18). */}
        <div className="mt-6 flex items-center justify-end gap-4 border-t border-app-border pt-4">
          <button
            aria-busy={loggingOut}
            className="ui-button ui-button-secondary text-sm"
            disabled={loggingOut}
            onClick={() => void submitLogout()}
            type="button"
          >
            {loggingOut ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
            ) : (
              <LogOut size={17} />
            )}
            로그아웃
          </button>
        </div>

        <ConfirmDialog
          cancelLabel={confirmingMembershipAction === "cancel" ? "돌아가기" : "취소"}
          confirmLabel={confirmingMembershipAction === "cancel" ? "반 참여 요청 취소" : "반 나가기"}
          description={
            confirmingMembershipAction === "cancel"
              ? "취소한 뒤에도 반 초대 코드로 다시 참여를 요청할 수 있어요."
              : "나가면 반 자료에 접근할 수 없고, 다시 참여하려면 반 초대 코드와 선생님의 승인이 필요해요."
          }
          onCancel={() => setConfirmingMembershipAction(undefined)}
          onConfirm={() => {
            const action = confirmingMembershipAction;
            setConfirmingMembershipAction(undefined);
            if (action !== undefined) void submitOwnMembershipTransition(action);
          }}
          open={confirmingMembershipAction !== undefined}
          returnFocusTo={
            confirmingMembershipAction === "cancel"
              ? cancelMembershipButtonRef.current
              : leaveClassButtonRef.current
          }
          title={
            confirmingMembershipAction === "cancel"
              ? "반 참여 요청을 취소할까요?"
              : "현재 반에서 나갈까요?"
          }
        />
      </section>
    </AppShell>
  );
}
