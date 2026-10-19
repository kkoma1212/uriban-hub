import { AlertCircle, CheckCircle2, LoaderCircle, LogOut, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
  ApiRequestError,
  getBootstrap,
  logout,
  updateAccountProfile,
  type BootstrapResponse,
} from "../../api/auth";
import {
  BLOCKED_DISPLAY_NAME_MESSAGE,
  containsBlockedDisplayNameWord,
} from "../../lib/display-name-policy";
import { codePointLength } from "../../lib/text";
import { AppShell, AppShellBar, type AppNavigationRole } from "../layout/app-shell";
import { PageHeader } from "../layout/page-header";
import { BirthDatePanel } from "./birth-date-panel";

interface PageContext {
  backLabel: string;
  backTo: string;
  bootstrap: BootstrapResponse;
  navigationRole?: AppNavigationRole;
}

const forbiddenControlCharacters = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/u;

function hasHtmlElement(value: string): boolean {
  if (typeof DOMParser === "undefined") return /<[A-Za-z][^>]*>/u.test(value);
  const document = new DOMParser().parseFromString(value, "text/html");
  return document.body.querySelector("*") !== null;
}

function validateDisplayName(value: string): string | undefined {
  const normalized = value.trim();
  const length = codePointLength(normalized);
  if (length < 2 || length > 20) {
    return "기본 이름은 앞뒤 공백을 제외하고 2~20자로 입력해 주세요.";
  }
  if (forbiddenControlCharacters.test(normalized) || hasHtmlElement(normalized)) {
    return "기본 이름에는 줄바꿈, 제어 문자, HTML 요소를 사용할 수 없어요.";
  }
  if (containsBlockedDisplayNameWord(normalized)) return BLOCKED_DISPLAY_NAME_MESSAGE;
  return undefined;
}

function canEditProfile(bootstrap: BootstrapResponse): boolean {
  return (
    bootstrap.account.is_active &&
    bootstrap.account.email_verified &&
    bootstrap.destination !== "CHANGE_TEMPORARY_PASSWORD" &&
    bootstrap.destination !== "TEACHER_REVOKED" &&
    bootstrap.destination !== "VERIFY_EMAIL" &&
    bootstrap.teacher_profile?.status !== "revoked" &&
    bootstrap.teacher_profile?.temporary_password_must_change !== true
  );
}

function contextFromBootstrap(bootstrap: BootstrapResponse): PageContext {
  const role: AppNavigationRole =
    bootstrap.current_membership?.role ??
    (bootstrap.teacher_profile === null ? "student" : "teacher");

  if (bootstrap.destination !== "HOME") {
    return {
      backLabel: "계정 안내로",
      backTo: "/bootstrap",
      bootstrap,
    };
  }

  return role === "teacher"
    ? {
        backLabel: "관리로",
        backTo: "/class/manage",
        bootstrap,
        navigationRole: "teacher",
      }
    : {
        backLabel: "설정으로",
        backTo: "/settings",
        bootstrap,
        navigationRole: "student",
      };
}

export function AccountProfilePage(): React.JSX.Element {
  const navigate = useNavigate();
  const [pageContext, setPageContext] = useState<PageContext>();
  const [draftName, setDraftName] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string>();
  const submittingRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    setLoadError(undefined);
    void getBootstrap()
      .then((bootstrap) => {
        if (!active) return;
        if (!canEditProfile(bootstrap)) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        setDraftName(bootstrap.account.display_name);
        setPageContext(contextFromBootstrap(bootstrap));
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setLoadError(
          requestError instanceof Error ? requestError.message : "이름 정보를 불러오지 못했습니다.",
        );
      });
    return () => {
      active = false;
    };
  }, [loadAttempt, navigate]);

  async function submitProfile(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submittingRef.current || loggingOut || pageContext === undefined) return;

    const normalized = draftName.trim();
    const validationError = validateDisplayName(draftName);
    if (validationError !== undefined) {
      setFieldError(validationError);
      setSuccess(undefined);
      nameInputRef.current?.focus();
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setDraftName(normalized);
    setFieldError(undefined);
    setSubmitError(undefined);
    setSuccess(undefined);
    try {
      const result = await updateAccountProfile({ display_name: normalized });
      setDraftName(result.display_name);
      setPageContext((current) =>
        current === undefined
          ? current
          : {
              ...current,
              bootstrap: {
                ...current.bootstrap,
                account: { ...current.bootstrap.account, display_name: result.display_name },
              },
            },
      );
      setSuccess(
        result.profile_updated
          ? "기본 이름을 변경했어요."
          : "이미 같은 기본 이름을 사용하고 있어요.",
      );
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      if (requestError instanceof ApiRequestError && requestError.status === 403) {
        void navigate("/bootstrap", { replace: true });
        return;
      }
      if (requestError instanceof ApiRequestError && requestError.code === "VALIDATION_FAILED") {
        setFieldError("기본 이름은 2~20자의 일반 텍스트로 입력해 주세요.");
        return;
      }
      setSubmitError(
        requestError instanceof Error ? requestError.message : "기본 이름을 변경하지 못했습니다.",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function submitLogout(): Promise<void> {
    if (loggingOut || submittingRef.current) return;
    setLoggingOut(true);
    setLogoutError(undefined);
    try {
      await logout();
      void navigate("/login", { replace: true });
    } catch (requestError) {
      setLogoutError(
        requestError instanceof Error ? requestError.message : "로그아웃하지 못했습니다.",
      );
      setLoggingOut(false);
    }
  }

  if (pageContext === undefined) {
    return (
      <AppShell width="narrow">
        <AppShellBar brandTo="/bootstrap" context="내 이름" />
        <PageHeader
          description="계정과 반에서 사용하는 이름을 확인해요."
          eyebrow="내 계정"
          title="내 이름"
        />
        {loadError === undefined ? (
          <div aria-live="polite" className="mt-6 text-center" role="status">
            <LoaderCircle
              aria-hidden="true"
              className="mx-auto animate-spin text-role-primary"
              size={32}
            />
            <p className="mt-4 font-bold">이름을 확인하고 있어요.</p>
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

  const { bootstrap } = pageContext;
  const classDisplayName =
    bootstrap.current_membership?.display_name_in_class ?? bootstrap.account.display_name;
  const hasClassSpecificName =
    bootstrap.current_membership?.display_name_in_class !== null &&
    bootstrap.current_membership?.display_name_in_class !== undefined;
  const descriptionIds = [
    "display-name-hint",
    "display-name-counter",
    fieldError === undefined ? undefined : "display-name-error",
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

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
        context="내 이름"
      />
      <PageHeader
        description="로그인 계정 전체에서 사용하는 이름이에요. 반에서 보이는 이름은 선생님이 별도로 관리할 수 있습니다."
        eyebrow="내 계정"
        title="내 이름"
      />

      <section className="mt-5 rounded-shell border border-app-border bg-app-surface-raised p-5 shadow-card sm:p-7">
        <dl className="grid gap-3 rounded-2xl border border-app-border bg-app-surface-muted p-4">
          <div>
            <dt className="text-sm font-bold text-app-muted">기본 이름</dt>
            <dd className="mt-1 text-lg font-black text-app-text [overflow-wrap:anywhere]">
              {bootstrap.account.display_name}
            </dd>
          </div>
          {bootstrap.current_membership === null ? (
            <div className="border-t border-app-border pt-3">
              <dt className="text-sm font-bold text-app-muted">현재 반</dt>
              <dd className="mt-1 font-bold text-app-text">참여 중인 반이 없어요.</dd>
            </div>
          ) : (
            <>
              <div className="border-t border-app-border pt-3">
                <dt className="text-sm font-bold text-app-muted">반에서 보이는 이름</dt>
                <dd className="mt-1 font-black text-app-text [overflow-wrap:anywhere]">
                  {classDisplayName}
                </dd>
              </div>
              {bootstrap.current_membership.role === "student" ? (
                <div className="border-t border-app-border pt-3">
                  <dt className="text-sm font-bold text-app-muted">학생 번호</dt>
                  <dd className="mt-1 font-black text-app-text">
                    {bootstrap.current_membership.student_number ?? "미지정"}
                  </dd>
                </div>
              ) : null}
            </>
          )}
        </dl>

        {bootstrap.current_membership === null ? null : (
          <p className="mt-4 rounded-2xl border border-role-border bg-role-soft px-4 py-3 text-sm leading-6 text-app-text">
            {hasClassSpecificName
              ? "반에서 보이는 이름은 선생님이 관리합니다. 기본 이름을 바꿔도 반 화면의 이름은 바뀌지 않아요."
              : "별도의 반 이름이 없어 지금은 기본 이름이 반 화면에도 사용됩니다."}
          </p>
        )}

        <form className="mt-6 space-y-4" noValidate onSubmit={(event) => void submitProfile(event)}>
          <div>
            <label className="auth-label" htmlFor="account-display-name">
              새 기본 이름
            </label>
            <input
              aria-describedby={descriptionIds}
              aria-invalid={fieldError !== undefined}
              autoComplete="name"
              className="auth-input"
              disabled={submitting || loggingOut}
              id="account-display-name"
              ref={nameInputRef}
              onBlur={() => setFieldError(validateDisplayName(draftName))}
              onChange={(event) => {
                const value = event.target.value;
                setDraftName(value);
                setSuccess(undefined);
                if (fieldError !== undefined) setFieldError(validateDisplayName(value));
              }}
              value={draftName}
            />
            <div className="mt-2 flex items-start justify-between gap-3 text-sm">
              <p className="leading-6 text-app-muted" id="display-name-hint">
                앞뒤 공백을 제외한 일반 텍스트 2~20자
              </p>
              <p className="shrink-0 font-bold text-app-muted" id="display-name-counter">
                {codePointLength(draftName.trim())}/20
              </p>
            </div>
            {fieldError === undefined ? null : (
              <p
                className="mt-2 text-sm font-medium text-rose-600"
                id="display-name-error"
                role="alert"
              >
                {fieldError}
              </p>
            )}
          </div>

          {submitError === undefined ? null : (
            <p
              className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
              role="alert"
            >
              {submitError}
            </p>
          )}
          {success === undefined ? null : (
            <p
              aria-live="polite"
              className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800"
              role="status"
            >
              <CheckCircle2 aria-hidden="true" size={18} />
              {success}
            </p>
          )}

          <button
            aria-busy={submitting}
            className="ui-button ui-button-primary h-12 w-full"
            disabled={submitting || loggingOut}
            type="submit"
          >
            {submitting ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={19} />
            ) : (
              <Pencil aria-hidden="true" size={19} />
            )}
            {submitting ? "변경하는 중" : "기본 이름 변경"}
          </button>
        </form>
      </section>
      <BirthDatePanel
        role={
          bootstrap.current_membership?.role ??
          (bootstrap.teacher_profile === null ? "student" : "teacher")
        }
      />
      <div className="mt-5 flex flex-col items-end gap-3">
        {logoutError === undefined ? null : (
          <p className="text-sm font-medium text-danger-text" role="alert">
            {logoutError}
          </p>
        )}
        <button
          aria-busy={loggingOut}
          className="ui-button ui-button-secondary min-h-11 px-4 text-sm"
          disabled={loggingOut || submitting}
          onClick={() => void submitLogout()}
          type="button"
        >
          {loggingOut ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
          ) : (
            <LogOut aria-hidden="true" size={17} />
          )}
          {loggingOut ? "로그아웃 중" : "로그아웃"}
        </button>
      </div>
    </AppShell>
  );
}
