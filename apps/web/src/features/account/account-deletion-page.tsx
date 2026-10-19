import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, Eye, EyeOff, LoaderCircle, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router";
import { z } from "zod";

import {
  ApiRequestError,
  deleteAccount,
  getBootstrap,
  type BootstrapResponse,
  type DeleteAccountRequest,
} from "../../api/auth";
import { clearAuthenticatedClientState } from "../../lib/authenticated-client-state";
import { AppShell, AppShellBar, type AppNavigationRole } from "../layout/app-shell";
import { ConfirmDialog } from "../layout/confirm-dialog";
import { PageHeader } from "../layout/page-header";

const accountDeletionSchema = z.object({
  confirmation: z
    .string()
    .refine((value): boolean => value === "탈퇴", "확인 문구로 ‘탈퇴’를 정확히 입력해 주세요."),
  current_password: z.string().min(1, "현재 비밀번호를 입력해 주세요."),
});

type AccountDeletionForm = z.infer<typeof accountDeletionSchema>;

interface PageContext {
  backLabel: string;
  backTo: string;
  blockedByClass: boolean;
  canDelete: boolean;
  navigationRole?: AppNavigationRole;
}

interface SubmissionError {
  kind: "blocked" | "retry";
  message: string;
}

function contextFromBootstrap(bootstrap: BootstrapResponse): PageContext {
  const role: AppNavigationRole =
    bootstrap.current_membership?.role ??
    (bootstrap.teacher_profile === null ? "student" : "teacher");
  const blockedByClass =
    role === "teacher" &&
    bootstrap.current_membership?.role === "teacher" &&
    bootstrap.current_membership.status === "approved" &&
    bootstrap.current_class !== null &&
    ["active", "suspended"].includes(bootstrap.current_class.status);

  if (bootstrap.destination === "HOME") {
    return role === "teacher"
      ? {
          backLabel: "관리로",
          backTo: "/class/manage",
          blockedByClass,
          canDelete: bootstrap.allowed_actions.includes("DELETE_ACCOUNT"),
          navigationRole: "teacher",
        }
      : {
          backLabel: "설정으로",
          backTo: "/settings",
          blockedByClass,
          canDelete: bootstrap.allowed_actions.includes("DELETE_ACCOUNT"),
          navigationRole: "student",
        };
  }

  return {
    backLabel: "계정 안내로",
    backTo: "/bootstrap",
    blockedByClass,
    canDelete: bootstrap.allowed_actions.includes("DELETE_ACCOUNT"),
  };
}

export function AccountDeletionPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [pageContext, setPageContext] = useState<PageContext>();
  const [loadError, setLoadError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const pendingRequestRef = useRef<DeleteAccountRequest | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);
  const [submissionError, setSubmissionError] = useState<SubmissionError>();
  const deletionInFlightRef = useRef(false);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const submissionErrorRef = useRef<HTMLDivElement>(null);
  const {
    formState: { errors, isValid },
    handleSubmit,
    register,
    setError: setFieldError,
    setFocus,
    setValue,
  } = useForm<AccountDeletionForm>({
    defaultValues: { confirmation: "", current_password: "" },
    mode: "onChange",
    resolver: zodResolver(accountDeletionSchema),
  });

  useEffect(() => {
    let active = true;
    setLoadError(undefined);
    void getBootstrap()
      .then((bootstrap) => {
        if (!active) return;
        setPageContext(contextFromBootstrap(bootstrap));
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setLoadError(
          requestError instanceof Error ? requestError.message : "계정 상태를 불러오지 못했습니다.",
        );
      });
    return () => {
      active = false;
    };
  }, [loadAttempt, navigate]);

  useEffect(() => {
    if (submissionError !== undefined) submissionErrorRef.current?.focus();
  }, [submissionError]);

  const reviewDeletion = handleSubmit((values) => {
    if (deletionInFlightRef.current) return;
    setSubmissionError(undefined);
    pendingRequestRef.current = {
      confirmation: "탈퇴",
      current_password: values.current_password,
    };
    setConfirmDialogOpen(true);
  });

  async function submitDeletion(request: DeleteAccountRequest): Promise<void> {
    if (deletionInFlightRef.current) return;
    deletionInFlightRef.current = true;
    setDeleting(true);
    setSubmissionError(undefined);

    try {
      await deleteAccount(request);
      clearAuthenticatedClientState();
      void navigate("/login", { replace: true, state: { accountDeleted: true } });
    } catch (requestError) {
      pendingRequestRef.current = undefined;
      setValue("current_password", "", { shouldDirty: true });
      setFieldError("current_password", {
        message: "보안을 위해 현재 비밀번호를 다시 입력해 주세요.",
        type: "server",
      });
      let recoveryFocus: keyof AccountDeletionForm | undefined;

      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        if (requestError.code === "INVALID_CREDENTIALS") {
          setFieldError(
            "current_password",
            { message: "현재 비밀번호가 올바르지 않아요.", type: "server" },
            { shouldFocus: true },
          );
          recoveryFocus = "current_password";
        } else {
          void navigate("/login", { replace: true });
        }
      } else if (
        requestError instanceof ApiRequestError &&
        (requestError.status === 400 || requestError.code === "VALIDATION_FAILED")
      ) {
        setFieldError(
          "confirmation",
          { message: "확인 문구로 ‘탈퇴’를 정확히 입력해 주세요.", type: "server" },
          { shouldFocus: true },
        );
        recoveryFocus = "confirmation";
      } else if (requestError instanceof ApiRequestError && requestError.status === 409) {
        setSubmissionError({
          kind: "blocked",
          message:
            "담당 중인 반이 있어 계정을 삭제할 수 없어요. 반 운영을 먼저 종료하거나 관리자에게 이관한 뒤 다시 시도해 주세요.",
        });
      } else if (
        requestError instanceof ApiRequestError &&
        (requestError.status === 429 || requestError.code === "RATE_LIMITED")
      ) {
        setSubmissionError({
          kind: "retry",
          message:
            "현재 비밀번호 확인을 너무 많이 시도했어요. 계정은 변경되지 않았습니다. 잠시 후 다시 시도해 주세요.",
        });
      } else if (requestError instanceof ApiRequestError && requestError.status === 503) {
        setSubmissionError({
          kind: "retry",
          message:
            "보안 확인 서비스에 일시적인 문제가 생겼어요. 계정은 변경되지 않았습니다. 잠시 후 다시 시도해 주세요.",
        });
      } else if (requestError instanceof ApiRequestError && requestError.status === 403) {
        setSubmissionError({
          kind: "retry",
          message:
            "요청 보안 정보를 다시 확인해야 해요. 현재 서비스 주소를 유지한 채 새로고침하고 다시 시도해 주세요.",
        });
      } else {
        setSubmissionError({
          kind: "retry",
          message:
            "계정을 삭제하지 못했습니다. 계정은 변경되지 않았습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.",
        });
      }

      deletionInFlightRef.current = false;
      setDeleting(false);
      const fieldToFocus = recoveryFocus;
      if (fieldToFocus !== undefined) {
        window.setTimeout(() => setFocus(fieldToFocus), 0);
      }
    }
  }

  if (pageContext === undefined) {
    return (
      <AppShell width="narrow">
        <AppShellBar brandTo="/bootstrap" context="계정 삭제" />
        <PageHeader
          description="계정 삭제 가능 여부와 보호 정보를 먼저 확인해요."
          eyebrow="내 계정"
          title="계정 삭제"
        />
        {loadError === undefined ? (
          <div aria-live="polite" className="mt-6 text-center" role="status">
            <LoaderCircle
              aria-hidden="true"
              className="mx-auto animate-spin text-role-primary"
              size={32}
            />
            <p className="mt-4 font-bold">계정 보호 정보를 확인하고 있어요.</p>
          </div>
        ) : (
          <div aria-live="assertive" className="mt-6 text-center" role="alert">
            <AlertCircle aria-hidden="true" className="mx-auto text-rose-500" size={32} />
            <p className="mt-4 font-bold text-rose-700">{loadError}</p>
            <button
              className="ui-button ui-button-primary mt-5 text-sm"
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              type="button"
            >
              다시 시도
            </button>
          </div>
        )}
      </AppShell>
    );
  }

  const blockedByClass = pageContext.blockedByClass || !pageContext.canDelete;

  return (
    <AppShell
      {...(pageContext.navigationRole === undefined
        ? {}
        : { navigationRole: pageContext.navigationRole })}
      width="narrow"
    >
      <AppShellBar
        backLabel={pageContext.backLabel}
        backTo={pageContext.backTo}
        brandTo={pageContext.navigationRole === undefined ? "/bootstrap" : "/home"}
        context="계정 삭제"
      />

      <PageHeader
        description={
          blockedByClass
            ? pageContext.blockedByClass
              ? "운영 중이거나 일시 중지된 반의 담당 선생님 계정은 바로 삭제할 수 없습니다. 반 운영을 종료하거나 관리자에게 이관한 뒤 다시 진행해 주세요."
              : "현재 계정 상태에서는 계정 삭제가 허용되지 않습니다. 계정 안내 화면에서 상태를 확인해 주세요."
            : "삭제가 완료되면 즉시 로그아웃되며 같은 계정을 복구할 수 없습니다. 처리 결과를 확인한 뒤 본인 확인 정보를 입력해 주세요."
        }
        eyebrow={blockedByClass ? "계정 삭제 전 필수 단계" : "위험 작업"}
        title="계정 삭제"
      />

      {blockedByClass ? (
        <section className="mt-5 rounded-shell border border-amber-200 bg-app-surface-raised p-5 shadow-card sm:p-7">
          <div className="grid size-10 place-items-center rounded-xl bg-amber-100 text-amber-700">
            <ShieldAlert aria-hidden="true" size={22} />
          </div>
          <h2 className="mt-4 text-lg font-black text-app-text">다음 단계를 먼저 완료해 주세요</h2>
          <Link
            className="ui-button ui-button-secondary mt-5 w-full text-sm sm:w-auto"
            to={pageContext.backTo}
          >
            {pageContext.blockedByClass ? "반 관리로 돌아가기" : "계정 안내로 돌아가기"}
          </Link>
        </section>
      ) : (
        <section className="mt-5 rounded-shell border border-rose-200 bg-app-surface-raised p-5 shadow-card sm:p-7">
          <div className="grid size-10 place-items-center rounded-xl bg-rose-100 text-danger">
            <Trash2 aria-hidden="true" size={22} />
          </div>
          <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-900">
            <h2 className="font-black">삭제하면 이렇게 처리됩니다</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>모든 기기에서 로그아웃되고, 아직 쓰지 않은 인증 메일 링크도 쓸 수 없게 돼요.</li>
              <li>현재 반 접근이 종료되고 계정과 반 안의 개인정보가 익명화됩니다.</li>
              <li>삭제한 계정과 과거 반 상태는 다시 되돌릴 수 없습니다.</li>
            </ul>
          </div>

          <form className="mt-6 space-y-4" noValidate onSubmit={reviewDeletion}>
            <div>
              <label className="auth-label" htmlFor="account-deletion-current-password">
                현재 비밀번호
              </label>
              <div className="relative">
                <input
                  aria-describedby={
                    errors.current_password === undefined
                      ? "account-deletion-password-hint"
                      : "account-deletion-password-hint account-deletion-current-password-error"
                  }
                  aria-invalid={errors.current_password !== undefined}
                  aria-required="true"
                  autoComplete="current-password"
                  className="auth-input pr-12"
                  disabled={deleting}
                  id="account-deletion-current-password"
                  required
                  type={showCurrentPassword ? "text" : "password"}
                  {...register("current_password")}
                />
                <button
                  aria-label={showCurrentPassword ? "현재 비밀번호 숨기기" : "현재 비밀번호 보기"}
                  className="ui-icon-button absolute right-1 top-1/2 -translate-y-1/2 text-app-muted hover:text-app-text"
                  disabled={deleting}
                  onClick={() => setShowCurrentPassword((visible) => !visible)}
                  type="button"
                >
                  {showCurrentPassword ? (
                    <EyeOff aria-hidden="true" size={20} />
                  ) : (
                    <Eye aria-hidden="true" size={20} />
                  )}
                </button>
              </div>
              <p className="mt-2 text-sm text-app-muted" id="account-deletion-password-hint">
                현재 로그인에 사용하는 비밀번호를 입력해 주세요.
              </p>
              {errors.current_password?.message === undefined ? null : (
                <p
                  className="mt-2 text-sm font-medium text-rose-600"
                  id="account-deletion-current-password-error"
                  role="alert"
                >
                  {errors.current_password.message}
                </p>
              )}
            </div>

            <div>
              <label className="auth-label" htmlFor="account-deletion-confirmation">
                확인 문구
              </label>
              <input
                aria-describedby={
                  errors.confirmation === undefined
                    ? "account-deletion-confirmation-hint"
                    : "account-deletion-confirmation-hint account-deletion-confirmation-error"
                }
                aria-invalid={errors.confirmation !== undefined}
                aria-required="true"
                autoComplete="off"
                className="auth-input"
                disabled={deleting}
                id="account-deletion-confirmation"
                placeholder="탈퇴"
                required
                spellCheck={false}
                {...register("confirmation")}
              />
              <p className="mt-2 text-sm text-app-muted" id="account-deletion-confirmation-hint">
                계속하려면 <strong className="text-app-text">탈퇴</strong>를 띄어쓰기 없이 정확히
                입력해 주세요.
              </p>
              {errors.confirmation?.message === undefined ? null : (
                <p
                  className="mt-2 text-sm font-medium text-rose-600"
                  id="account-deletion-confirmation-error"
                  role="alert"
                >
                  {errors.confirmation.message}
                </p>
              )}
            </div>

            {submissionError === undefined ? null : (
              <div
                aria-label="계정 삭제 요청 오류"
                className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm leading-6 text-rose-800 outline-none focus-visible:ring-2 focus-visible:ring-danger"
                ref={submissionErrorRef}
                role="alert"
                tabIndex={-1}
              >
                <p className="font-bold">{submissionError.message}</p>
                {submissionError.kind === "blocked" ? (
                  <Link
                    className="mt-2 inline-flex min-h-11 items-center font-black underline"
                    to="/class/manage"
                  >
                    반 관리로 이동
                  </Link>
                ) : null}
              </div>
            )}

            <div className="grid gap-3 pt-2 sm:grid-cols-2">
              <Link
                className="ui-button ui-button-secondary min-w-0 text-sm"
                to={pageContext.backTo}
              >
                돌아가기
              </Link>
              <button
                aria-busy={deleting}
                className="ui-button ui-button-danger-solid min-w-0 text-sm"
                disabled={!isValid || deleting}
                ref={deleteButtonRef}
                type="submit"
              >
                {deleting ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
                ) : (
                  <Trash2 aria-hidden="true" size={18} />
                )}
                {deleting ? "삭제하는 중" : "계정 영구 삭제"}
              </button>
            </div>
          </form>

          <ConfirmDialog
            cancelLabel="계정 유지"
            confirmLabel="계정 영구 삭제"
            description={
              <>
                계정과 현재 반 접근이 즉시 종료되고 모든 기기에서 로그아웃됩니다. 이 작업은 되돌릴
                수 없습니다.
              </>
            }
            onCancel={() => {
              setConfirmDialogOpen(false);
              pendingRequestRef.current = undefined;
            }}
            onConfirm={() => {
              const request = pendingRequestRef.current;
              pendingRequestRef.current = undefined;
              setConfirmDialogOpen(false);
              if (request !== undefined) void submitDeletion(request);
            }}
            open={confirmDialogOpen}
            returnFocusTo={deleteButtonRef.current}
            title="계정을 영구 삭제할까요?"
          />
        </section>
      )}
    </AppShell>
  );
}
