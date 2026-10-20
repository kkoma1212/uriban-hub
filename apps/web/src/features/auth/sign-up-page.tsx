import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useLocation, useNavigate } from "react-router";

import {
  ApiRequestError,
  createGuardianConsentRequest,
  getGuardianConsentRequestStatus,
  getSignUpOptions,
  signUp,
} from "../../api/auth";
import { ageRouteForBirthDate, isAcceptableBirthDate } from "../../lib/birth-date";
import { readPendingInviteCode } from "../../lib/invite-link";
import { PageHeader } from "../layout/page-header";
import { useConsentDocuments } from "../legal/use-consent-documents";
import { AuthShell, LoginMobileHeader } from "./auth-shell";
import { AgeRouteChoice, BirthDateField, RoleChoice } from "./sign-up-choices";
import { SignUpAccountFields } from "./sign-up-account-fields";
import { SignUpConsentFields } from "./sign-up-consent-fields";
import {
  consentFields,
  createSignUpSchema,
  guardianEmailSchema,
  type GuardianRequestState,
  type SignUpForm,
} from "./sign-up-form";
import { GuardianConsentSection } from "./sign-up-guardian-section";
import { useRequestCooldown } from "./request-cooldown";
import {
  cancelPendingSocialSignup,
  getPendingSocialSignup,
  socialSignUp,
  socialProviderLabels,
  type PendingSocialSignup,
} from "../../api/social-auth";

/*
 * 2026-10-01 사용자 요청: 한 화면에 계속 붙던 가입 칸을 네 단계로 나눈다 — 칸이 늘 때마다
 * 오른쪽 가입 카드와 같은 높이로 붙은 왼쪽 칠판까지 길어지던 문제를 없앤다.
 */
const STEPS = ["누구로", "나이", "계정 정보", "동의"] as const;
type Step = 1 | 2 | 3 | 4;

export function SignUpPage(): React.JSX.Element {
  const legal = useConsentDocuments();
  const cooldownSeconds = useRequestCooldown();
  const navigate = useNavigate();
  const location = useLocation();
  const socialRequested = new URLSearchParams(location.search).get("social") === "1";
  const [step, setStep] = useState<Step>(1);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const previousFocusedStep = useRef<Step>(1);
  const [birthDateRequired, setBirthDateRequired] = useState<boolean>();
  // 2026-10-02 사용자 결정(P-025③): 받을 수 있는 환경이어도 생년월일은 선택 입력이다.
  const [birthDateCollected, setBirthDateCollected] = useState(false);
  const [optionsError, setOptionsError] = useState(false);
  const birthDateRequiredRef = useRef(false);
  const [socialSignup, setSocialSignup] = useState<PendingSocialSignup>();
  const [socialError, setSocialError] = useState<string>();
  // 회사 프로필 사진은 본인이 고를 때만 쓴다(기본 꺼짐).
  const [useProviderPicture, setUseProviderPicture] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [socialStoppedNotice, setSocialStoppedNotice] = useState(false);
  const [guardianRequest, setGuardianRequest] = useState<GuardianRequestState>();
  const [guardianRequestError, setGuardianRequestError] = useState<string>();
  const [isGuardianRequesting, setIsGuardianRequesting] = useState(false);
  const [isGuardianChecking, setIsGuardianChecking] = useState(false);
  const submissionPending = useRef(false);
  // 담임 QR로 들어왔으면 거의 학생이다. 미리 골라 두되 선생님이면 바꿀 수 있다(ux2 2026-10-15).
  const [invitedByClass] = useState(() => readPendingInviteCode() !== null);
  const {
    clearErrors,
    formState: { errors, isSubmitting },
    getValues,
    handleSubmit,
    register,
    setError,
    setValue,
    trigger,
    watch,
  } = useForm<SignUpForm>({
    defaultValues: {
      age_route: undefined,
      birth_date: "",
      confirm_password: "",
      display_name: "",
      email: "",
      guardian_email: "",
      password: "",
      privacy: false,
      role: invitedByClass ? "student" : undefined,
      terms: false,
    },
    // 생년월일을 받는지는 서버 설정을 읽은 뒤에 정해진다 — 검사 규칙도 그때의 값을 쓴다.
    resolver: (values, context, options) =>
      zodResolver(createSignUpSchema(socialRequested, birthDateRequiredRef.current))(
        values,
        context,
        options,
      ),
  });

  useEffect(() => {
    if (!socialRequested) return;
    const controller = new AbortController();
    void getPendingSocialSignup(controller.signal)
      .then(setSocialSignup)
      .catch(() => {
        if (!controller.signal.aborted)
          setSocialError("빠른 로그인 확인이 만료됐어요. 로그인 화면에서 다시 시작해 주세요.");
      });
    return () => controller.abort();
  }, [socialRequested]);

  // 2026-10-02 사용자 결정(P-025②): 시범 동안 만 14세 미만 가입을 닫으면 보호자 동의 대신 안내만 보인다.
  const [under14Open, setUnder14Open] = useState(true);

  function loadSignUpOptions(signal?: AbortSignal): void {
    setOptionsError(false);
    void getSignUpOptions(signal)
      .then((options) => {
        birthDateRequiredRef.current = options.birth_date_required === true;
        setBirthDateRequired(options.birth_date_required === true);
        setBirthDateCollected(
          options.birth_date_collected === true || options.birth_date_required === true,
        );
        setUnder14Open(options.under_14_signup !== false);
      })
      .catch(() => {
        if (!signal?.aborted) setOptionsError(true);
      });
  }

  useEffect(() => {
    const controller = new AbortController();
    loadSignUpOptions(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    // 첫 진입에는 가입 안내를 그대로 보여 주고, 단계를 바꿀 때만 새 입력으로 이동한다.
    stepHeading.current?.focus({ preventScroll: previousFocusedStep.current === step });
    previousFocusedStep.current = step;
  }, [step]);

  const ageRoute = watch("age_route");
  const accountRole = watch("role");
  const birthDate = watch("birth_date");
  const consentValues = watch(consentFields);
  const allConsented = consentValues.every(Boolean);
  const canEnterAccount =
    ageRoute === "over_14" ||
    (ageRoute === "guardian_consent" && guardianRequest?.status === "approved");
  const birthDateReady =
    birthDateRequired === true
      ? isAcceptableBirthDate(birthDate)
      : birthDate === "" || isAcceptableBirthDate(birthDate);

  useEffect(() => {
    if (canEnterAccount && socialSignup?.email && getValues("email") === "") {
      setValue("email", socialSignup.email);
    }
    // 2026-10-01 사용자 결정: 회사 닉네임을 기본 이름에 미리 채운다(고칠 수 있고 이름 검사는 그대로).
    const suggested = socialSignup?.display_name?.trim();
    if (canEnterAccount && suggested && getValues("display_name") === "") {
      setValue("display_name", suggested);
    }
  }, [canEnterAccount, socialSignup, getValues, setValue]);

  function selectAgeRoute(nextRoute: "guardian_consent" | "over_14"): void {
    if (socialRequested && nextRoute === "guardian_consent") {
      void cancelPendingSocialSignup().catch(() => undefined);
      void navigate("/sign-up", { replace: true });
      setSocialSignup(undefined);
      // 아무 안내 없이 빠른 로그인 가입이 사라지지 않게 알린다(총검수 B3-02).
      setSocialStoppedNotice(true);
    }
    setValue("age_route", nextRoute, { shouldDirty: true });
    clearErrors(["age_route", "email", "guardian_email"]);
    setGuardianRequest(undefined);
    setGuardianRequestError(undefined);
    setSubmitError(undefined);
    if (nextRoute === "over_14") {
      setValue("guardian_email", "", { shouldDirty: true });
    }
  }

  function changeBirthDate(value: string): void {
    clearErrors("birth_date");
    if (!isAcceptableBirthDate(value)) return;
    const route = ageRouteForBirthDate(value);
    if (route !== getValues("age_route")) selectAgeRoute(route);
  }

  async function requestGuardianConsent(): Promise<void> {
    if (!legal.ready) return;
    const parsedEmail = guardianEmailSchema.safeParse(getValues("guardian_email"));
    clearErrors("guardian_email");
    setGuardianRequestError(undefined);

    if (!parsedEmail.success) {
      setError("guardian_email", {
        message: parsedEmail.error.issues[0]?.message ?? "보호자 이메일을 확인해 주세요.",
        type: "manual",
      });
      return;
    }

    setIsGuardianRequesting(true);
    try {
      const response = await createGuardianConsentRequest(parsedEmail.data, legal.documents);
      setValue("guardian_email", parsedEmail.data, { shouldDirty: true });
      setGuardianRequest({
        completionToken: response.completion_token,
        expiresAt: response.expires_at,
        requestId: response.request_id,
        status: response.consent_delivery_status === "failed" ? "delivery_failed" : "pending",
      });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "LEGAL_DOCUMENTS_CHANGED") {
        setValue("terms", false);
        setValue("privacy", false);
        setGuardianRequest(undefined);
        legal.reload();
      }
      if (
        error instanceof ApiRequestError &&
        ["RATE_LIMITED", "LEGAL_DOCUMENTS_CHANGED"].includes(error.code)
      ) {
        setGuardianRequestError(error.message);
      } else {
        setGuardianRequestError(
          error instanceof Error ? error.message : "보호자 동의 메일을 요청하지 못했어요.",
        );
      }
    } finally {
      setIsGuardianRequesting(false);
    }
  }

  async function checkGuardianConsentStatus(): Promise<void> {
    if (guardianRequest === undefined) return;

    setGuardianRequestError(undefined);
    setIsGuardianChecking(true);
    try {
      const response = await getGuardianConsentRequestStatus({
        completion_token: guardianRequest.completionToken,
        request_id: guardianRequest.requestId,
      });
      setGuardianRequest((current) =>
        current === undefined ? current : { ...current, status: response.status },
      );
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "TOKEN_INVALID_OR_EXPIRED") {
        setGuardianRequest((current) =>
          current === undefined ? current : { ...current, status: "expired" },
        );
      } else {
        setGuardianRequestError(
          error instanceof Error ? error.message : "보호자 동의 상태를 확인하지 못했어요.",
        );
      }
    } finally {
      setIsGuardianChecking(false);
    }
  }

  async function goNext(): Promise<void> {
    if (submissionPending.current) return;
    setSubmitError(undefined);
    if (step === 1) {
      if (accountRole === undefined) {
        setError("role", { message: "가입할 계정 유형을 선택해 주세요.", type: "manual" });
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      const enteredBirthDate = getValues("birth_date");
      if (
        (birthDateRequired === true || enteredBirthDate !== "") &&
        !isAcceptableBirthDate(enteredBirthDate)
      ) {
        setError("birth_date", { message: "생년월일을 확인해 주세요.", type: "manual" });
        return;
      }
      if (ageRoute === undefined) {
        setError("age_route", {
          message: "연령에 맞는 가입 방법을 선택해 주세요.",
          type: "manual",
        });
        return;
      }
      if (!canEnterAccount) return;
      setStep(3);
      return;
    }
    if (step === 3) {
      const valid = await trigger(["email", "display_name", "password", "confirm_password"], {
        shouldFocus: true,
      });
      if (valid) setStep(4);
    }
  }

  function goBack(): void {
    if (submissionPending.current) return;
    setSubmitError(undefined);
    setStep((current) => (current > 1 ? ((current - 1) as Step) : current));
  }

  const submitValidated = handleSubmit(
    async (values) => {
      if (!legal.ready) return;
      if (socialRequested && !socialSignup) return;
      setSubmitError(undefined);
      if (values.age_route === undefined || values.role === undefined) return;
      const guardianProof = guardianRequest;
      if (values.age_route === "guardian_consent" && guardianProof?.status !== "approved") {
        setSubmitError("보호자 동의가 완료된 뒤 가입할 수 있어요.");
        return;
      }

      try {
        const account = {
          ...(legal.documents ? { legal_documents: legal.documents } : {}),
          ...(birthDateCollected && values.birth_date !== ""
            ? { birth_date: values.birth_date }
            : {}),
          consents: { privacy: true as const, terms: true as const },
          display_name: values.display_name.trim(),
          email: values.email.trim().toLowerCase(),
          password: values.password,
          role: values.role,
        };
        // 소셜 가입이 일반 가입처럼 중립 응답(LOGIN)을 주면 세션이 없으므로 로그인 안내로 간다.
        let socialSession = false;
        const submitAccount = socialRequested
          ? async (request: Parameters<typeof signUp>[0]) => {
              const result = await socialSignUp({
                ...request,
                ...(socialSignup?.has_picture === true && useProviderPicture
                  ? { use_provider_picture: true }
                  : {}),
              });
              socialSession = result?.next_action !== "LOGIN";
            }
          : signUp;
        if (values.age_route === "over_14") {
          await submitAccount({ ...account, age_route: "over_14" });
        } else {
          if (guardianProof === undefined) return;
          await submitAccount({
            ...account,
            age_route: "guardian_consent",
            guardian_consent: {
              completion_token: guardianProof.completionToken,
              request_id: guardianProof.requestId,
            },
          });
        }
        if (socialRequested && socialSession) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        navigate("/login", {
          replace: true,
          state: { signupRequested: true, signupEmail: account.email },
        });
      } catch (error) {
        if (error instanceof ApiRequestError && error.code === "LEGAL_DOCUMENTS_CHANGED") {
          setValue("terms", false);
          setValue("privacy", false);
          setGuardianRequest(undefined);
          legal.reload();
          // 보호자 동의도 지워지므로 그대로 두면 같은 오류만 반복된다 — 2단계로 돌려보낸다(총검수 B3-05).
          if (values.age_route === "guardian_consent") {
            setStep(2);
            setSubmitError(
              "동의 문서가 바뀌어 보호자 동의를 다시 받아야 해요. 보호자 동의를 다시 요청해 주세요.",
            );
            return;
          }
          setSubmitError(error.message);
          return;
        }
        if (error instanceof ApiRequestError && error.code === "RATE_LIMITED") {
          setSubmitError(error.message);
          return;
        }
        setSubmitError(error instanceof Error ? error.message : "가입을 완료하지 못했습니다.");
      }
    },
    (invalid) => {
      // 앞 단계 칸이 틀리면 그 단계로 돌아가 바로 고칠 수 있게 한다.
      if (invalid.role !== undefined) setStep(1);
      else if (invalid.birth_date !== undefined || invalid.age_route !== undefined) setStep(2);
      else if (
        invalid.email !== undefined ||
        invalid.display_name !== undefined ||
        invalid.password !== undefined ||
        invalid.confirm_password !== undefined
      )
        setStep(3);
    },
  );

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (step !== 4) {
      await goNext();
      return;
    }
    if (submissionPending.current) return;
    submissionPending.current = true;
    try {
      await submitValidated(event);
    } finally {
      submissionPending.current = false;
    }
  }

  const nextDisabled =
    (step === 2 && (birthDateRequired === undefined || !birthDateReady || !canEnterAccount)) ||
    (step === 3 && socialRequested && !socialSignup);

  return (
    <AuthShell fixedContextPanel mobileTopAligned>
      <LoginMobileHeader />
      {/* '1 / 2' 배지는 바로 아래 4단계 진행 표시와 맞지 않아 뺐고, 머리글과 제목이 둘 다 '가입'이던
          것도 하나로 줄였다(총검수 B3-04). */}
      <PageHeader
        className="mb-5 border-b border-app-border pb-5"
        description={
          socialRequested
            ? "빠른 로그인으로 가입해도 연령 확인과 필수 동의가 필요해요."
            : "가입한 이메일로 받은 6자리 인증번호로 가입을 완료해요."
        }
        eyebrow="우리반 허브"
        title="가입"
      />

      {socialRequested ? (
        <p
          className="mb-4 text-sm leading-6 text-app-muted"
          role={socialError ? "alert" : "status"}
        >
          {socialError ??
            (socialSignup
              ? `${socialProviderLabels[socialSignup.provider]} 계정을 확인했어요. 아래 가입 정보를 입력해 주세요.`
              : "빠른 로그인 정보를 확인하고 있어요.")}
          {socialError ? (
            <Link className="ml-2 underline" to="/login">
              로그인으로 돌아가기
            </Link>
          ) : null}
        </p>
      ) : null}

      <ol aria-label="가입 단계" className="mb-4 grid grid-cols-4 gap-1.5" data-sign-up-steps>
        {STEPS.map((label, index) => {
          const number = index + 1;
          const state = number < step ? "done" : number === step ? "current" : "next";
          return (
            <li
              aria-current={state === "current" ? "step" : undefined}
              className="min-w-0"
              data-step-state={state}
              key={label}
            >
              <span
                className={`block h-1.5 rounded-full ${
                  state === "next" ? "bg-app-border" : "bg-role-primary"
                }`}
              />
              <span
                className={`mt-1.5 block truncate text-xs font-bold ${
                  state === "current" ? "text-role-primary" : "text-app-muted"
                }`}
              >
                {number}. {label}
              </span>
            </li>
          );
        })}
      </ol>

      <form
        className="min-w-0 space-y-5 rounded-shell border border-app-border bg-app-surface-raised p-5 shadow-card sm:p-6 min-[900px]:border-0 min-[900px]:bg-transparent min-[900px]:p-0 min-[900px]:shadow-none"
        noValidate
        onSubmit={submit}
      >
        <h2 className="sr-only" ref={stepHeading} tabIndex={-1}>
          {step}단계: {STEPS[step - 1]}
        </h2>

        {/* 동의 문서 상태는 문서를 쓰는 단계(보호자 동의 요청·필수 동의)에서 보이고 다시 불러올 수 있다. */}
        {(step === 2 || step === 4) && legal.error && (
          <div role="alert" className="text-sm text-danger-text">
            <p>{legal.error}</p>
            <button
              type="button"
              className="ui-button ui-button-secondary mt-2"
              onClick={legal.reload}
            >
              다시 불러오기
            </button>
          </div>
        )}
        {(step === 2 || step === 4) && !legal.ready && !legal.error && (
          <p role="status" className="text-sm text-app-muted">
            동의 대상 문서를 확인하고 있어요.
          </p>
        )}

        {step === 1 && invitedByClass && (
          <p
            className="rounded-2xl border border-role-border bg-role-soft px-4 py-3 text-sm leading-6 text-app-text"
            data-invite-pending="true"
            role="status"
          >
            반 초대로 들어와 학생을 미리 골랐어요. 선생님이면 바꿔 주세요.
          </p>
        )}

        {step === 1 && (
          <RoleChoice
            error={errors.role?.message}
            onSelect={(value) => {
              setValue("role", value, { shouldDirty: true, shouldValidate: true });
              clearErrors("role");
              setSubmitError(undefined);
            }}
            selected={accountRole}
          />
        )}

        {step === 2 && (
          <>
            {socialStoppedNotice && (
              <p
                className="break-keep rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800"
                role="status"
              >
                만 14세 미만은 빠른 로그인으로 가입할 수 없어 빠른 로그인 가입을 멈췄어요.
              </p>
            )}
            {optionsError ? (
              <div role="alert" className="text-sm text-danger-text">
                <p>가입 설정을 불러오지 못했어요.</p>
                <button
                  type="button"
                  className="ui-button ui-button-secondary mt-2"
                  onClick={() => loadSignUpOptions()}
                >
                  다시 불러오기
                </button>
              </div>
            ) : birthDateRequired === undefined ? (
              <p role="status" className="text-sm text-app-muted">
                가입 설정을 확인하고 있어요.
              </p>
            ) : birthDateRequired ? (
              <BirthDateField
                role={accountRole}
                error={errors.birth_date?.message}
                inputProps={register("birth_date", {
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                    changeBirthDate(event.target.value),
                })}
                value={birthDate}
              />
            ) : (
              <>
                <AgeRouteChoice
                  birthDateOffered={birthDateCollected}
                  error={errors.age_route?.message}
                  onSelect={selectAgeRoute}
                  selected={ageRoute}
                />
                {birthDateCollected ? (
                  <BirthDateField
                    role={accountRole}
                    error={errors.birth_date?.message}
                    inputProps={register("birth_date", {
                      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                        changeBirthDate(event.target.value),
                    })}
                    optional
                    value={birthDate}
                  />
                ) : null}
              </>
            )}
            {ageRoute === "guardian_consent" && birthDateReady && !under14Open && (
              <p
                className="rounded-2xl border border-app-border bg-app-surface-muted px-4 py-3 text-sm font-semibold leading-6 text-app-text"
                data-under-14-closed
                role="status"
              >
                지금은 만 14세 이상 학생과 선생님만 가입할 수 있어요. 만 14세 미만 학생은 아직
                가입할 수 없어요.
              </p>
            )}
            {ageRoute === "guardian_consent" &&
              under14Open &&
              birthDateReady &&
              guardianRequest?.status !== "approved" && (
                <GuardianConsentSection
                  cooldownSeconds={cooldownSeconds}
                  errors={errors}
                  guardianRequest={guardianRequest}
                  guardianRequestError={guardianRequestError}
                  isGuardianChecking={isGuardianChecking}
                  isGuardianRequesting={isGuardianRequesting}
                  legalReady={legal.ready}
                  onCheck={() => void checkGuardianConsentStatus()}
                  onRequest={() => void requestGuardianConsent()}
                  register={register}
                />
              )}

            {ageRoute === "guardian_consent" && guardianRequest?.status === "approved" && (
              <div
                aria-live="polite"
                className="flex min-w-0 items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold leading-6 text-emerald-800"
                role="status"
              >
                <CheckCircle2 aria-hidden="true" className="mt-1 shrink-0" size={17} />
                <span className="min-w-0 break-keep">
                  보호자 동의가 확인됐어요. 다음 단계에서 학생 가입 정보를 입력해 주세요.
                </span>
              </div>
            )}
          </>
        )}

        {step === 3 && (
          <SignUpAccountFields
            clearErrors={clearErrors}
            errors={errors}
            password={watch("password")}
            register={register}
            role={accountRole}
            social={socialRequested}
          />
        )}
        {step === 3 && socialRequested && socialSignup?.has_picture === true && (
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border border-app-border p-3 text-sm">
            <input
              checked={useProviderPicture}
              className="auth-checkbox mt-0.5"
              onChange={(event) => setUseProviderPicture(event.target.checked)}
              type="checkbox"
            />
            <span className="min-w-0 break-keep">
              <span className="block font-bold text-app-text">
                {socialProviderLabels[socialSignup.provider]} 프로필 사진을 우리반 허브 사진으로
                쓰기
              </span>
              <span className="mt-1 block text-xs leading-5 text-app-muted">
                반 친구와 선생님에게 보여요. 설정에서 언제든 바꾸거나 지울 수 있어요.
              </span>
            </span>
          </label>
        )}

        {step === 4 && (
          <SignUpConsentFields
            allConsented={allConsented}
            birthDateCollected={birthDateCollected}
            birthDateEntered={birthDate !== ""}
            documents={legal.documents}
            disabled={isSubmitting}
            errors={errors}
            legalReady={legal.ready}
            register={register}
            role={accountRole}
            setValue={setValue}
          />
        )}

        {submitError !== undefined && (
          <div
            className="min-w-0 break-words rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
            role="alert"
          >
            {submitError}
          </div>
        )}

        <div className="flex min-w-0 gap-2">
          {step > 1 && (
            <button
              className="ui-button ui-button-secondary h-12 shrink-0 rounded-2xl px-4"
              disabled={isSubmitting}
              onClick={goBack}
              type="button"
            >
              <ArrowLeft aria-hidden="true" size={18} />
              이전
            </button>
          )}
          {step < 4 ? (
            <button
              className="ui-button ui-button-primary group h-12 min-w-0 flex-1 rounded-2xl px-5"
              disabled={nextDisabled}
              type="submit"
            >
              다음
              <ArrowRight className="transition group-hover:translate-x-1" size={19} />
            </button>
          ) : (
            <button
              aria-busy={isSubmitting}
              className="ui-button ui-button-primary group h-12 min-w-0 flex-1 rounded-2xl px-5"
              disabled={
                !legal.ready ||
                isSubmitting ||
                cooldownSeconds > 0 ||
                (socialRequested && !socialSignup)
              }
              type="submit"
            >
              {isSubmitting ? (
                <>
                  <LoaderCircle aria-hidden="true" className="animate-spin" size={20} /> 가입하고
                  있어요
                </>
              ) : (
                <>
                  가입하기
                  <ArrowRight className="transition group-hover:translate-x-1" size={19} />
                </>
              )}
            </button>
          )}
        </div>
      </form>

      <p className="mt-5 text-center text-sm text-app-muted">
        이미 계정이 있나요?{" "}
        <Link
          className="inline-flex min-h-11 items-center rounded-lg px-2 font-bold text-role-primary hover:underline"
          to="/login"
        >
          로그인
        </Link>
      </p>

      {/* 빠른 로그인 가입은 가입과 함께 로그인되므로 이 안내가 사실과 다르다(총검수 B3-06). */}
      {socialRequested ? null : (
        <div className="mt-4 flex items-center justify-center gap-2 text-xs text-app-muted">
          <Check aria-hidden="true" size={14} /> 가입해도 바로 로그인되지는 않아요.
        </div>
      )}
    </AuthShell>
  );
}
