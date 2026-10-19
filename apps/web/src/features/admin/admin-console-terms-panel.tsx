import { BookOpenText, LoaderCircle, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import type * as React from "react";

import {
  createAdminTermsVersion,
  listAdminTermsConsents,
  listAdminTermsVersions,
  updateAdminTermsVersionStatus,
  type AdminTermsConsent,
  type AdminTermsConsentType,
  type AdminTermsDocumentType,
  type AdminTermsVersion,
} from "../../api/admin-management";
import {
  adminErrorMessage,
  formatDateTime,
  InlineNotice,
  ActionError,
  LoadState,
  PanelFrame,
  StepUpHint,
} from "./admin-console-shared";
import { ConfirmDialog } from "../layout/confirm-dialog";

const TERMS_DOCUMENT_TYPE_LABELS: Record<AdminTermsDocumentType, string> = {
  guardian_consent: "보호자 동의서",
  privacy_consent: "개인정보 수집·이용 동의서",
  privacy_policy: "개인정보 처리방침",
  terms: "이용약관",
};

function TermsVersionEditor({
  canWrite,
  item,
  onUpdated,
}: {
  canWrite: boolean;
  item: AdminTermsVersion;
  onUpdated: (version: AdminTermsVersion) => void;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  // 게시·폐기는 가입·동의 전체에 영향을 준다 — 대상과 결과를 한 번 더 보여 주고 확인받는다(총검수 C2-03).
  const [confirming, setConfirming] = useState(false);
  const actionButton = useRef<HTMLButtonElement>(null);
  const nextStatus = item.status === "draft" ? "published" : "retired";
  const maximumEffectiveAt = useMemo(() => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  }, []);
  const effectiveTimestamp = new Date(effectiveAt).getTime();
  const effectiveAtReady =
    nextStatus === "retired" ||
    (effectiveAt.length > 0 &&
      !Number.isNaN(effectiveTimestamp) &&
      effectiveTimestamp <= Date.now());

  async function updateStatus(): Promise<void> {
    if (busy || item.status === "retired" || reason.trim().length === 0 || !effectiveAtReady)
      return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const result = await updateAdminTermsVersionStatus(
        item.id,
        nextStatus === "published"
          ? {
              effective_at: new Date(effectiveAt).toISOString(),
              reason: reason.trim(),
              status: "published",
            }
          : { reason: reason.trim(), status: "retired" },
      );
      onUpdated(result.version);
      setReason("");
      setEffectiveAt("");
      setSaved(true);
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "약관 상태를 변경하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl bg-app-surface-muted p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words font-extrabold text-app-text">{item.title}</p>
        <span className="shrink-0 rounded-full bg-app-surface px-2.5 py-1 text-xs font-bold text-app-muted">
          {item.status === "draft" ? "초안" : item.status === "published" ? "게시" : "폐기"}
        </span>
      </div>
      <p className="mt-1 text-xs font-semibold text-app-muted">
        {TERMS_DOCUMENT_TYPE_LABELS[item.document_type]} · {item.policy_version} · 생성{" "}
        {formatDateTime(item.created_at)}
        {item.effective_at === null ? "" : ` · 시행 ${formatDateTime(item.effective_at)}`}
      </p>
      <details className="mt-3 rounded-xl border border-app-border bg-app-surface p-3">
        <summary className="flex min-h-11 cursor-pointer items-center font-bold text-app-text">
          게시 전 본문·SHA-256 확인
        </summary>
        <p className="mt-2 text-xs font-bold text-app-muted">내용 SHA-256</p>
        <code className="mt-1 block break-all rounded-lg bg-app-surface-muted p-2 text-xs font-bold text-app-text">
          {item.content_sha256}
        </code>
        <p className="mt-3 text-xs font-bold text-app-muted">저장된 본문</p>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-app-surface-muted p-3 text-xs font-semibold leading-5 text-app-text">
          {item.content}
        </pre>
      </details>
      {canWrite && item.status !== "retired" ? (
        <div
          className={`mt-3 grid gap-2 sm:items-end ${
            nextStatus === "published"
              ? "sm:grid-cols-[220px_minmax(0,1fr)_auto]"
              : "sm:grid-cols-[minmax(0,1fr)_auto]"
          }`}
        >
          {nextStatus === "published" ? (
            <div>
              <label className="auth-label" htmlFor={`terms-effective-at-${item.id}`}>
                시행 일시
              </label>
              <input
                className="ui-input ui-input-compact"
                id={`terms-effective-at-${item.id}`}
                max={maximumEffectiveAt}
                onChange={(event) => setEffectiveAt(event.target.value)}
                required
                type="datetime-local"
                value={effectiveAt}
              />
              <p className="mt-1 text-xs font-semibold text-app-muted">
                현재 시각 이하만 선택할 수 있습니다.
              </p>
            </div>
          ) : null}
          <div>
            <label className="auth-label" htmlFor={`terms-status-reason-${item.id}`}>
              {nextStatus === "published" ? "게시" : "폐기"} 사유
            </label>
            <input
              className="ui-input ui-input-compact"
              id={`terms-status-reason-${item.id}`}
              // 서버 한도(300자)와 맞춘다 — 500자까지 받고 저장 때 거절했다(총검수 C2-10).
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
              placeholder="감사 기록에 남을 사유"
              value={reason}
            />
          </div>
          <button
            aria-busy={busy}
            className={
              nextStatus === "published"
                ? "ui-button ui-button-primary text-sm"
                : "ui-button ui-button-danger text-sm"
            }
            disabled={busy || reason.trim().length === 0 || !effectiveAtReady}
            onClick={() => setConfirming(true)}
            ref={actionButton}
            type="button"
          >
            {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" size={17} /> : null}
            {nextStatus === "published" ? "게시" : "폐기"}
          </button>
        </div>
      ) : null}
      <ConfirmDialog
        confirmLabel={nextStatus === "published" ? "게시" : "폐기"}
        description={
          nextStatus === "published"
            ? "게시하면 새 가입과 동의에 이 문서가 바로 쓰이고, 같은 종류의 지금 게시본은 자동으로 폐기돼요. 되돌리려면 다른 버전을 새로 게시해야 해요."
            : "폐기한 문서는 다시 게시할 수 없어요."
        }
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void updateStatus();
        }}
        open={confirming}
        returnFocusTo={actionButton.current}
        title={`“${item.title}”을(를) ${nextStatus === "published" ? "게시" : "폐기"}할까요?`}
      />
      {saved ? (
        <p className="mt-2 text-xs font-bold text-emerald-700" role="status">
          상태를 변경했습니다.
        </p>
      ) : null}
      {error === undefined ? null : (
        <p className="mt-2 text-xs font-bold text-danger-text" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
export function TermsPanel({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [versions, setVersions] = useState<AdminTermsVersion[]>();
  const [consents, setConsents] = useState<AdminTermsConsent[]>();
  // 최대 500건을 받아 앞 20건만 보이고 전체 건수도 몰랐다 — 건수와 '더 보기'(총검수 C3-10).
  const [consentShown, setConsentShown] = useState(20);
  const [documentType, setDocumentType] = useState<AdminTermsDocumentType>("terms");
  const [consentType, setConsentType] = useState<AdminTermsConsentType>("terms");
  const [consentPolicyVersion, setConsentPolicyVersion] = useState("");
  const [version, setVersion] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [consentLoading, setConsentLoading] = useState(false);
  const [error, setError] = useState<string>();
  // 초안 등록 실패가 불러오기 실패 상자로 떠 목록이 통째로 사라졌다(총검수 C3-03).
  const [createError, setCreateError] = useState<string>();
  const [consentError, setConsentError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const nextVersions = await listAdminTermsVersions();
      setVersions(nextVersions.versions);
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "약관 자료를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadConsents(event?: React.FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    const policyVersion = consentPolicyVersion.trim();
    if (policyVersion.length === 0 || consentLoading) return;
    setConsentLoading(true);
    setConsentError(undefined);
    try {
      const result = await listAdminTermsConsents({
        consent_type: consentType,
        policy_version: policyVersion,
      });
      setConsents(result.consents);
      setConsentShown(20);
    } catch (requestError) {
      setConsentError(adminErrorMessage(requestError, "동의 기록을 조회하지 못했습니다."));
    } finally {
      setConsentLoading(false);
    }
  }

  async function create(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      busy ||
      version.trim().length === 0 ||
      title.trim().length === 0 ||
      content.trim().length === 0
    )
      return;
    setBusy(true);
    setCreateError(undefined);
    setNotice(undefined);
    try {
      const result = await createAdminTermsVersion({
        content: content.trim(),
        document_type: documentType,
        policy_version: version.trim(),
        title: title.trim(),
      });
      setVersions((current) => [result.version, ...(current ?? [])]);
      setVersion("");
      setTitle("");
      setContent("");
      setNotice("새 약관 초안을 등록했습니다.");
    } catch (requestError) {
      setCreateError(adminErrorMessage(requestError, "약관 초안을 등록하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelFrame
      description="이용약관·개인정보 동의서·처리방침·보호자 동의서 버전과 사용자 동의 현황을 함께 확인합니다."
      icon={BookOpenText}
      title="약관 관리"
    >
      {canWrite ? (
        <>
          <StepUpHint />
          <form
            className="mt-5 grid gap-4 rounded-2xl border border-app-border bg-app-surface-raised p-4 sm:p-5"
            onSubmit={create}
          >
            <h3 className="font-black text-app-text">새 버전 초안 등록</h3>
            <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
              <div>
                <label className="auth-label" htmlFor="terms-document-type">
                  문서 유형
                </label>
                <select
                  className="ui-input"
                  id="terms-document-type"
                  onChange={(event) =>
                    setDocumentType(event.target.value as AdminTermsDocumentType)
                  }
                  value={documentType}
                >
                  <option value="terms">이용약관</option>
                  <option value="privacy_consent">개인정보 수집·이용 동의서</option>
                  <option value="privacy_policy">개인정보 처리방침</option>
                  <option value="guardian_consent">보호자 동의서</option>
                </select>
              </div>
              <div>
                <label className="auth-label" htmlFor="terms-version">
                  버전
                </label>
                <input
                  className="ui-input"
                  id="terms-version"
                  maxLength={80}
                  onChange={(event) => setVersion(event.target.value)}
                  placeholder="예: 2026-09-01"
                  value={version}
                />
              </div>
            </div>
            <div>
              <label className="auth-label" htmlFor="terms-title">
                제목
              </label>
              <input
                className="ui-input"
                id="terms-title"
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
                value={title}
              />
            </div>
            <div>
              <label className="auth-label" htmlFor="terms-content">
                본문
              </label>
              <textarea
                className="ui-input h-auto min-h-48 py-3"
                id="terms-content"
                maxLength={100000}
                onChange={(event) => setContent(event.target.value)}
                value={content}
              />
            </div>
            <button
              aria-busy={busy}
              className="ui-button ui-button-primary w-full sm:w-fit"
              disabled={
                busy ||
                version.trim().length === 0 ||
                title.trim().length === 0 ||
                content.trim().length === 0
              }
              type="submit"
            >
              {busy ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
              ) : (
                <BookOpenText aria-hidden="true" size={17} />
              )}{" "}
              초안 등록
            </button>
            <ActionError message={createError} />
          </form>
        </>
      ) : null}
      {notice === undefined ? null : <InlineNotice>{notice}</InlineNotice>}
      <LoadState error={error} loading={loading} onRetry={() => void load()} />
      {!loading && error === undefined ? (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <section
            aria-labelledby="terms-version-list-title"
            className="rounded-2xl border border-app-border p-4"
          >
            <h3 className="font-black text-app-text" id="terms-version-list-title">
              등록 버전 {versions?.length ?? 0}개
            </h3>
            {versions?.length === 0 ? (
              <p className="mt-3 text-sm font-semibold text-app-muted">등록된 버전이 없습니다.</p>
            ) : (
              <ul className="mt-3 grid gap-2">
                {versions?.map((item) => (
                  <TermsVersionEditor
                    canWrite={canWrite}
                    item={item}
                    key={item.id}
                    onUpdated={(updated) =>
                      setVersions((current) =>
                        current?.map((versionItem) => {
                          if (versionItem.id === updated.id) return updated;
                          if (
                            updated.status === "published" &&
                            versionItem.document_type === updated.document_type &&
                            versionItem.status === "published"
                          ) {
                            return { ...versionItem, status: "retired" };
                          }
                          return versionItem;
                        }),
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </section>
          <section
            aria-labelledby="terms-consent-list-title"
            className="rounded-2xl border border-app-border p-4"
          >
            <h3 className="font-black text-app-text" id="terms-consent-list-title">
              사용자 동의 기록
            </h3>
            <p className="mt-1 text-xs font-semibold leading-5 text-app-muted">
              전체 동의 목록은 자동 조회하지 않습니다. 동의 유형과 정확한 정책 버전으로 조회합니다.
            </p>
            <form className="mt-3 grid gap-2" onSubmit={(event) => void loadConsents(event)}>
              <div>
                <label className="auth-label" htmlFor="terms-consent-type-filter">
                  동의 유형
                </label>
                <select
                  className="ui-input ui-input-compact"
                  id="terms-consent-type-filter"
                  onChange={(event) => setConsentType(event.target.value as AdminTermsConsentType)}
                  value={consentType}
                >
                  <option value="terms">이용약관 동의</option>
                  <option value="privacy">개인정보 동의</option>
                </select>
              </div>
              <div>
                <label className="auth-label" htmlFor="terms-consent-version-filter">
                  정책 버전
                </label>
                <input
                  className="ui-input ui-input-compact"
                  id="terms-consent-version-filter"
                  maxLength={80}
                  onChange={(event) => setConsentPolicyVersion(event.target.value)}
                  placeholder="예: 2026-09-01"
                  required
                  value={consentPolicyVersion}
                />
              </div>
              <button
                className="ui-button ui-button-secondary w-full text-sm"
                disabled={consentLoading || consentPolicyVersion.trim().length === 0}
                type="submit"
              >
                {consentLoading ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
                ) : (
                  <Search aria-hidden="true" size={17} />
                )}
                동의 기록 조회
              </button>
            </form>
            {consentError === undefined ? null : (
              <p className="mt-3 text-sm font-bold text-danger-text" role="alert">
                {consentError}
              </p>
            )}
            {consents === undefined ? (
              <p className="mt-3 rounded-xl bg-app-surface-muted p-3 text-sm font-semibold text-app-muted">
                정책 버전을 입력해야 동의 기록을 불러옵니다.
              </p>
            ) : consents.length === 0 ? (
              <p className="mt-3 text-sm font-semibold text-app-muted">동의 기록이 없습니다.</p>
            ) : (
              <>
                <p className="mt-3 text-sm font-semibold text-app-muted" data-consent-count>
                  {consents.length >= 500 ? "최근 500건" : `전체 ${consents.length}건`} 중{" "}
                  {Math.min(consentShown, consents.length)}건 표시
                </p>
                <ul className="mt-3 grid gap-2">
                  {consents.slice(0, consentShown).map((item) => (
                    <li className="rounded-xl bg-app-surface-muted p-3" key={item.id}>
                      <p className="break-all font-extrabold text-app-text">
                        사용자 ID {item.user_id}
                      </p>
                      <p className="mt-1 text-xs font-semibold text-app-muted">
                        {item.consent_type === "terms" ? "이용약관" : "개인정보"}{" "}
                        {item.policy_version} · {formatDateTime(item.accepted_at)}
                        {item.withdrawn_at === null ? "" : " · 철회"}
                      </p>
                    </li>
                  ))}
                </ul>
                {consentShown < consents.length ? (
                  <button
                    className="ui-button ui-button-secondary mt-3 text-sm"
                    onClick={() => setConsentShown((current) => current + 20)}
                    type="button"
                  >
                    20건 더 보기
                  </button>
                ) : null}
              </>
            )}
          </section>
        </div>
      ) : null}
    </PanelFrame>
  );
}
