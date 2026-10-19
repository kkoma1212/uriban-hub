import { Info } from "lucide-react";
import type { FieldErrors, UseFormRegister, UseFormSetValue } from "react-hook-form";

import type { LegalConsentSnapshot } from "../legal/legal-api";
import { LegalDocumentLink } from "../legal/legal-document-links";
import { SignUpFieldError as FieldError } from "./sign-up-field-error";
import { consentFields, type SignUpForm } from "./sign-up-form";

/** 가입 4단계: 필수 동의와 개인정보 수집·이용 안내. */
export function SignUpConsentFields({
  allConsented,
  birthDateCollected,
  birthDateEntered = false,
  documents,
  disabled = false,
  errors,
  legalReady,
  register,
  role,
  setValue,
}: {
  allConsented: boolean;
  birthDateCollected: boolean;
  /** 생년월일을 실제로 입력했는지(선택 항목 안내를 보여 줄지). */
  birthDateEntered?: boolean;
  documents: LegalConsentSnapshot | undefined;
  disabled?: boolean;
  errors: FieldErrors<SignUpForm>;
  legalReady: boolean;
  register: UseFormRegister<SignUpForm>;
  role?: SignUpForm["role"];
  setValue: UseFormSetValue<SignUpForm>;
}): React.JSX.Element {
  const consentError = errors.terms?.message ?? errors.privacy?.message;
  return (
    <fieldset
      aria-describedby={consentError === undefined ? undefined : "sign-up-consent-error"}
      aria-invalid={consentError === undefined ? undefined : true}
      className="min-w-0 rounded-2xl border border-app-border bg-app-surface-muted p-4"
      disabled={disabled}
    >
      <legend className="sr-only">필수 동의</legend>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-app-border pb-4 font-bold text-app-text">
        <input
          checked={allConsented}
          className="auth-checkbox"
          onChange={(event) => {
            for (const field of consentFields) {
              setValue(field, event.target.checked, { shouldValidate: true });
            }
          }}
          disabled={!legalReady}
          type="checkbox"
        />
        필수 항목 모두 동의
      </label>

      <div className="mt-3 space-y-3 text-sm">
        <div className="auth-consent-row">
          <input
            aria-describedby={errors.terms === undefined ? undefined : "sign-up-consent-error"}
            aria-invalid={errors.terms === undefined ? undefined : true}
            className="auth-checkbox"
            id="sign-up-terms"
            disabled={!legalReady}
            type="checkbox"
            {...register("terms")}
          />
          <label
            className="auth-consent-copy inline-flex min-h-11 cursor-pointer items-center"
            htmlFor="sign-up-terms"
          >
            (필수) 이용약관 동의
          </label>
          <LegalDocumentLink
            className="auth-consent-meta text-xs text-role-primary"
            documentType="terms"
            policyVersion={documents?.terms.policy_version}
          >
            전문 보기 ↗
          </LegalDocumentLink>
        </div>
        <div className="auth-consent-row">
          <input
            aria-describedby={errors.privacy === undefined ? undefined : "sign-up-consent-error"}
            aria-invalid={errors.privacy === undefined ? undefined : true}
            className="auth-checkbox"
            id="sign-up-privacy"
            disabled={!legalReady}
            type="checkbox"
            {...register("privacy")}
          />
          <label
            className="auth-consent-copy inline-flex min-h-11 cursor-pointer items-center"
            htmlFor="sign-up-privacy"
          >
            (필수) 개인정보 수집·이용 동의
          </label>
          <LegalDocumentLink
            className="auth-consent-meta text-xs text-role-primary"
            documentType="privacy_consent"
            policyVersion={documents?.privacy_consent.policy_version}
          >
            전문 보기 ↗
          </LegalDocumentLink>
        </div>
      </div>

      <FieldError id="sign-up-consent-error" message={consentError} />
      <div className="mt-4 rounded-xl border border-app-border bg-app-surface-raised p-3 text-xs leading-6 text-app-muted">
        <p className="font-bold text-app-text">개인정보 수집·이용 안내</p>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>목적: 계정 생성·로그인, 학급 참여와 서비스 보안</li>
          <li>항목: 이메일·기본 이름·역할·비밀번호 확인값·연령 경로·동의 기록 및 필수 보안정보</li>
          {/* 2026-10-02 사용자 결정(P-025③): 생년월일은 필수 동의와 분리된 선택 항목이다. */}
          {birthDateCollected && birthDateEntered ? (
            <li>
              {role === "teacher"
                ? "선택 항목: 생년월일 — 만 14세 여부 확인."
                : "선택 항목: 생년월일 — 만 14세 여부 확인·담임 선생님의 학생 확인·생일 알림(본인이 켠 경우)."}{" "}
              입력하지 않아도 가입할 수 있어요. 한 번 입력하면 직접 고칠 수 없고 운영자에게 요청해야
              해요.
            </li>
          ) : null}
          <li>
            보유기간: 계정 삭제 때까지가 원칙이며, 기능별 기록·동의 증빙의 별도 보유기간은 전문에서
            확인해 주세요.
          </li>
          <li>동의를 거부할 수 있지만 필수 정보에 동의하지 않으면 가입할 수 없어요.</li>
        </ul>
        <LegalDocumentLink
          documentType="privacy_policy"
          policyVersion={documents?.privacy_policy.policy_version}
        >
          개인정보처리방침 보기 ↗
        </LegalDocumentLink>
        <p>전문은 새 탭에서 열려 입력 내용과 체크 상태가 유지돼요.</p>
      </div>
      {(import.meta.env.DEV || import.meta.env.MODE === "preview") && (
        <div className="mt-4 flex min-w-0 gap-2 rounded-xl bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-800">
          <Info aria-hidden="true" className="mt-0.5 shrink-0" size={15} />
          <span className="min-w-0 break-keep">
            현재 가입은 테스트용입니다. 약관·개인정보 문서의 검토와 정식 게시가 끝난 뒤 실제 가입을
            받습니다.
          </span>
        </div>
      )}
    </fieldset>
  );
}
