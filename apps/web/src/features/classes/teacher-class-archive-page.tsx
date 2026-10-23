import { Archive, LoaderCircle, RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import {
  ApiRequestError,
  archiveCurrentClass,
  getBootstrap,
  getCurrentClass,
  type ArchiveCurrentClassRequest,
  type CurrentClassResponse,
} from "../../api/auth";
import {
  AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT,
  clearAuthenticatedClientState,
} from "../../lib/authenticated-client-state";
import { listPastClasses } from "../../api/past-classes";
import { ClassRecordsDownload } from "../class-records/class-records-download";
import { AppShell } from "../layout/app-shell";
import { AsyncStatePanel } from "../layout/async-state";
import { ConfirmDialog } from "../layout/confirm-dialog";
import { ContentBackbar, ContentFrameHeader } from "../layout/content-frame";

interface SubmissionError {
  kind: "retry" | "state";
  message: string;
}

export function TeacherClassArchivePage(): React.JSX.Element {
  const navigate = useNavigate();
  const [currentClass, setCurrentClass] = useState<CurrentClassResponse>();
  const [loadError, setLoadError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [shellReady, setShellReady] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const [submissionError, setSubmissionError] = useState<SubmissionError>();
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [outcome, setOutcome] = useState<"ready" | "checking" | "unknown">("ready");
  const lifetimeRef = useRef(0);
  const mountedRef = useRef(false);
  const verificationInFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    const invalidate = () => {
      lifetimeRef.current += 1;
    };
    window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, invalidate);
    return () => {
      mountedRef.current = false;
      invalidate();
      window.removeEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, invalidate);
    };
  }, []);
  const pendingRequestRef = useRef<ArchiveCurrentClassRequest | undefined>(undefined);
  const archiveInFlightRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const submissionErrorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const lifetime = lifetimeRef.current;
    const isCurrent = () => active && mountedRef.current && lifetime === lifetimeRef.current;
    setCurrentClass(undefined);
    setLoadError(undefined);
    void (async () => {
      try {
        const bootstrap = await getBootstrap();
        if (!isCurrent()) return;
        if (
          bootstrap.destination !== "HOME" ||
          bootstrap.current_membership?.role !== "teacher" ||
          !bootstrap.allowed_actions.includes("MANAGE_CLASS")
        ) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        setShellReady(true);
        const nextClass = await getCurrentClass();
        if (!isCurrent()) return;
        setCurrentClass(nextClass);
      } catch (requestError) {
        if (!isCurrent()) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          clearAuthenticatedClientState();
          void navigate("/login", { replace: true });
          return;
        }
        if (
          requestError instanceof ApiRequestError &&
          (requestError.status === 404 || requestError.status === 423)
        ) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        setLoadError(
          requestError instanceof Error
            ? requestError.message
            : "반 종료 정보를 불러오지 못했습니다.",
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [loadAttempt, navigate]);

  // 그려지는 순간 초점을 준다. useEffect는 그린 뒤에 돌아 오류 안내가 보이는데 초점은 본문에 있는 틈이 생겼다(10-21 부하 재현 4/100).
  useLayoutEffect(() => {
    if (submissionError !== undefined) submissionErrorRef.current?.focus();
  }, [submissionError]);

  function reviewArchive(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (archiveInFlightRef.current || outcome !== "ready" || currentClass === undefined) return;
    if (confirmation !== currentClass.name) {
      setFieldError("현재 반 이름을 공백까지 똑같이 입력해 주세요.");
      inputRef.current?.focus();
      return;
    }
    setFieldError(undefined);
    setSubmissionError(undefined);
    pendingRequestRef.current = {
      class_name_confirmation: confirmation,
      expected_class_id: currentClass.id,
      expected_row_version: currentClass.row_version,
    };
    setConfirmDialogOpen(true);
  }

  async function verifyArchiveOutcome(classId: string, lifetime: number): Promise<void> {
    const isCurrent = () => mountedRef.current && lifetime === lifetimeRef.current;
    if (!isCurrent() || verificationInFlightRef.current) return;
    verificationInFlightRef.current = true;
    setOutcome("checking");
    setSubmissionError(undefined);
    try {
      // A different current class or a missing membership cannot prove this class was archived.
      const past = await listPastClasses();
      if (!isCurrent()) return;
      if (past.some((item) => item.class_id === classId && item.role === "teacher")) {
        clearAuthenticatedClientState();
        void navigate("/bootstrap", { replace: true });
        return;
      }
      const latest = await getCurrentClass();
      if (!isCurrent()) return;
      if (latest.id === classId && latest.status === "active" && latest.role === "teacher") {
        setCurrentClass(latest);
        setOutcome("ready");
        setSubmissionError({
          kind: "retry",
          message:
            "지금 확인한 반 상태는 운영 중이에요. 반 이름과 현재 상태를 확인한 뒤 다시 시도해 주세요.",
        });
        return;
      }
    } catch (requestError) {
      if (!isCurrent()) return;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        clearAuthenticatedClientState();
        void navigate("/login", { replace: true });
        return;
      }
    } finally {
      if (isCurrent()) verificationInFlightRef.current = false;
    }
    if (!isCurrent()) return;
    setOutcome("unknown");
    setSubmissionError({
      kind: "retry",
      message:
        "반 종료 결과를 확인하지 못했어요. 중복 실행을 막기 위해 종료 버튼을 잠갔어요. 연결을 확인한 뒤 결과를 다시 확인해 주세요.",
    });
  }

  async function submitArchive(request: ArchiveCurrentClassRequest): Promise<void> {
    if (archiveInFlightRef.current || outcome !== "ready" || currentClass === undefined) return;
    const classId = request.expected_class_id;
    const lifetime = lifetimeRef.current;
    const isCurrent = () => mountedRef.current && lifetime === lifetimeRef.current;
    archiveInFlightRef.current = true;
    setArchiving(true);
    setFieldError(undefined);
    setSubmissionError(undefined);

    try {
      await archiveCurrentClass(request);
      if (!isCurrent()) return;
      clearAuthenticatedClientState();
      void navigate("/bootstrap", { replace: true });
    } catch (requestError) {
      if (!isCurrent()) return;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        clearAuthenticatedClientState();
        void navigate("/login", { replace: true });
      } else if (
        requestError instanceof ApiRequestError &&
        (requestError.status === 400 ||
          requestError.code === "VALIDATION_FAILED" ||
          requestError.code === "CLASS_NAME_CONFIRMATION_MISMATCH")
      ) {
        setFieldError("현재 반 이름을 공백까지 똑같이 입력해 주세요.");
        window.setTimeout(() => {
          if (isCurrent()) inputRef.current?.focus();
        }, 0);
      } else if (requestError instanceof ApiRequestError && requestError.status === 409) {
        setSubmissionError({
          kind: "state",
          message: "반 상태가 달라져 종료 요청이 거절됐어요. 최신 계정 상태를 다시 확인해 주세요.",
        });
      } else if (requestError instanceof ApiRequestError && requestError.status === 403) {
        setSubmissionError({
          kind: "state",
          message: "반을 종료할 권한을 확인하지 못했어요. 최신 계정 상태를 다시 확인해 주세요.",
        });
      } else {
        // Network failures and server errors can include a committed transaction whose response was lost.
        await verifyArchiveOutcome(classId, lifetime);
      }
    } finally {
      if (isCurrent()) {
        archiveInFlightRef.current = false;
        setArchiving(false);
      }
    }
  }

  if (currentClass === undefined) {
    return (
      <AppShell
        contentFrame
        {...(shellReady ? { navigationRole: "teacher" as const } : {})}
        width="narrow"
      >
        {shellReady ? <ContentBackbar label="반 관리로" to="/class/manage" /> : null}

        <ContentFrameHeader title="반 운영 종료" />

        <AsyncStatePanel
          {...(loadError === undefined
            ? {}
            : {
                action: (
                  <button
                    className="ui-button ui-button-primary text-sm"
                    onClick={() => setLoadAttempt((attempt) => attempt + 1)}
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" size={17} /> 다시 시도
                  </button>
                ),
                description:
                  "현재 반 정보를 확인하지 못했어요. 인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요.",
              })}
          kind={loadError === undefined ? "loading" : "error"}
          title={
            loadError === undefined
              ? "반 종료 조건을 확인하고 있어요."
              : "반 종료 정보를 불러오지 못했어요."
          }
          tone="neutral"
        />
      </AppShell>
    );
  }

  const namesMatch = confirmation === currentClass.name;
  const showMismatch = confirmation.length > 0 && !namesMatch;

  return (
    <AppShell contentFrame navigationRole="teacher" width="narrow">
      <ContentBackbar label="반 관리로" to="/class/manage" />

      <ContentFrameHeader title="반 운영 종료" />

      <section className="content-card border border-rose-200 p-4 sm:p-6">
        <div className="grid size-10 place-items-center rounded-xl bg-rose-100 text-danger">
          <Archive aria-hidden="true" size={22} />
        </div>
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-900">
          <h2 className="flex items-center gap-2 font-black">
            <ShieldAlert aria-hidden="true" size={18} /> 반 운영을 종료하면 이렇게 처리됩니다
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>선생님과 학생의 이 반 활동은 즉시 종료됩니다.</li>
            <li>
              종료 당시 승인된 구성원은 종료 후 365일이 지나기 전까지 ‘지난 반’에서 소식을 읽기
              전용으로 볼 수 있습니다. 교사는 활성 교사 계정이어야 합니다.
            </li>
            <li>
              선생님이 쓴 반 기록은 아래에서 지금 내려받을 수 있고, 종료 후에도 365일이 지나기
              전까지 ‘지난 반’에서 내려받을 수 있습니다.
            </li>
            <li>승인을 기다리는 반 참여 요청은 취소되고 현재 반 초대 코드는 즉시 폐기됩니다.</li>
            <li>앱에서 반을 복원하는 기능은 제공하지 않습니다.</li>
            <li>
              종료 후 365일이 지나면 반의 내용과 구성원 연결 정보(멤버십)를 삭제하고, 개인정보가
              없는 최소한의 반 기록만 남깁니다.
            </li>
            <li>
              반에 연결한 평가는 평가 자체의 보관 기한과 반 종료 후 365일 중 더 이른 기한에
              삭제됩니다. 반에 연결하지 않은 개인 평가는 자체 보관 기한을 따릅니다.
            </li>
          </ul>
        </div>

        <div className="mt-4">
          <ClassRecordsDownload />
        </div>

        <form className="mt-6 space-y-4" noValidate onSubmit={reviewArchive}>
          <div>
            <label className="auth-label text-app-text" htmlFor="class-archive-confirmation">
              확인할 반 이름
            </label>
            <input
              aria-describedby={
                fieldError === undefined && !showMismatch
                  ? "class-archive-confirmation-hint"
                  : "class-archive-confirmation-hint class-archive-confirmation-error"
              }
              aria-invalid={fieldError !== undefined || showMismatch}
              aria-required="true"
              autoComplete="off"
              className="auth-input"
              disabled={archiving}
              id="class-archive-confirmation"
              onChange={(event) => {
                setConfirmation(event.target.value);
                setFieldError(undefined);
                if (outcome === "ready") setSubmissionError(undefined);
              }}
              ref={inputRef}
              required
              spellCheck={false}
              value={confirmation}
            />
            <p
              className="mt-2 break-keep text-sm leading-6 text-app-muted"
              id="class-archive-confirmation-hint"
            >
              계속하려면{" "}
              <strong className="text-app-text [overflow-wrap:anywhere]">
                {currentClass.name}
              </strong>
              을(를) 공백까지 똑같이 입력해 주세요. 앞뒤 공백도 허용되지 않습니다.
            </p>
            {fieldError === undefined && !showMismatch ? null : (
              <p
                className="mt-2 text-sm font-medium text-rose-600"
                id="class-archive-confirmation-error"
                role="alert"
              >
                {fieldError ?? "현재 반 이름과 일치하지 않습니다."}
              </p>
            )}
          </div>

          {submissionError === undefined ? null : (
            <div
              aria-label="반 운영 종료 요청 오류"
              className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm leading-6 text-rose-800 outline-none focus-visible:ring-2 focus-visible:ring-danger"
              ref={submissionErrorRef}
              role="alert"
              tabIndex={-1}
            >
              <p className="font-bold">{submissionError.message}</p>
              {outcome === "unknown" ? (
                <button
                  className="ui-button ui-button-secondary mt-3 text-sm"
                  onClick={() => {
                    void verifyArchiveOutcome(currentClass.id, lifetimeRef.current);
                  }}
                  type="button"
                >
                  <RefreshCw aria-hidden="true" size={17} /> 종료 결과 다시 확인
                </button>
              ) : null}
              {submissionError.kind === "state" ? (
                <Link
                  className="mt-2 inline-flex min-h-11 items-center font-black underline"
                  to="/bootstrap"
                >
                  최신 계정 상태 확인
                </Link>
              ) : null}
            </div>
          )}

          {outcome === "checking" ? (
            <p role="status" className="text-sm font-bold text-app-muted">
              현재 반의 종료 결과를 확인하고 있어요.
            </p>
          ) : null}
          <div className="grid gap-3 pt-2 sm:grid-cols-2">
            <Link className="ui-button ui-button-secondary min-w-0 text-sm" to="/class/manage">
              {archiving || outcome !== "ready" ? "반 관리로 돌아가기" : "반 유지하고 돌아가기"}
            </Link>
            <button
              aria-busy={archiving}
              className="ui-button ui-button-danger-solid min-w-0 text-sm"
              disabled={!namesMatch || archiving || outcome !== "ready"}
              ref={reviewButtonRef}
              type="submit"
            >
              {archiving ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
              ) : (
                <Archive aria-hidden="true" size={18} />
              )}
              {archiving ? "종료하는 중" : "반 운영 종료 검토"}
            </button>
          </div>
        </form>

        <ConfirmDialog
          cancelLabel="반 유지"
          confirmLabel="반 운영 종료 실행"
          description="반 활동은 즉시 종료되고 초대 코드는 폐기됩니다. 종료 당시 승인된 구성원은 종료 후 365일이 지나기 전까지 지난 반 소식을 읽기 전용으로 볼 수 있습니다. 교사는 활성 교사 계정이어야 합니다. 365일이 지나면 반 내용과 멤버십을 삭제하고 개인정보 없는 최소 반 기록만 남깁니다. 반 연결 평가는 자체 보관 기한과 반 종료 후 365일 중 더 이른 기한에 삭제되며, 반에 연결하지 않은 개인 평가는 자체 기한을 따릅니다. 앱에서는 반을 복원할 수 없습니다."
          onCancel={() => {
            setConfirmDialogOpen(false);
            pendingRequestRef.current = undefined;
          }}
          onConfirm={() => {
            const request = pendingRequestRef.current;
            pendingRequestRef.current = undefined;
            setConfirmDialogOpen(false);
            if (request !== undefined) void submitArchive(request);
          }}
          open={confirmDialogOpen}
          returnFocusTo={reviewButtonRef.current}
          title={`‘${currentClass.name}’ 반 운영을 종료할까요?`}
        />
      </section>
    </AppShell>
  );
}
