import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";

import { APP_MAIN_ID, ProductWordmark } from "../layout/app-shell";
import { SiteFooter } from "../layout/site-footer";
import { getLegalDocument, type LegalDocumentResponse } from "./legal-api";
import { LegalDocumentContent } from "./legal-document-content";
import { LegalDocumentLinks } from "./legal-document-links";
import { LEGAL_DOCUMENTS, PUBLIC_OPERATOR } from "./legal-documents";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "long", timeZone: "Asia/Seoul" }).format(
    new Date(value),
  );
}

export function LegalDocumentPage(): React.JSX.Element {
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const document = LEGAL_DOCUMENTS.find(
    (item) => item.path === pathname.replace(/\/+$/u, "").toLowerCase(),
  )!;
  const policyVersion = searchParams.get("policy_version") ?? undefined;
  const [result, setResult] = useState<LegalDocumentResponse>();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setResult(undefined);
    setDraft(undefined);
    setError(false);
    async function load(): Promise<void> {
      try {
        const response = await getLegalDocument(document.type, policyVersion);
        if (!active) return;
        setResult(response);
        if (
          (import.meta.env.DEV || import.meta.env.MODE === "preview") &&
          response.version === null &&
          policyVersion === undefined
        ) {
          const module = await import("./development-legal-documents");
          if (active)
            setDraft(module.reviewDraftContent(module.DEVELOPMENT_LEGAL_DOCUMENTS[document.type]));
        }
      } catch {
        if (active) setError(true);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [document.type, policyVersion, attempt]);

  const version = result?.version;
  return (
    <div className="min-h-dvh bg-app-canvas px-5 py-8 text-app-text sm:px-8">
      <div className="mx-auto w-full min-w-0 max-w-4xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <ProductWordmark to="/login" />
          <Link className="ui-button ui-button-secondary text-sm" to="/login">
            로그인으로
          </Link>
        </header>
        <main id={APP_MAIN_ID} tabIndex={-1}>
          <h1 className="break-keep text-2xl font-extrabold tracking-tight sm:text-3xl">
            {document.title}
          </h1>
          <div className="mt-4 text-xs text-app-muted">
            <LegalDocumentLinks newTab={false} />
          </div>
          {result === undefined && !error ? (
            <p className="mt-8 flex items-center gap-2" role="status">
              <LoaderCircle aria-hidden="true" className="animate-spin" size={20} />
              문서를 불러오고 있어요.
            </p>
          ) : null}
          {error ? (
            <div
              className="mt-6 rounded-card border border-danger-border bg-danger-surface p-5"
              role="alert"
            >
              <p className="font-bold text-danger-text">문서를 불러오지 못했어요.</p>
              <button
                className="ui-button ui-button-secondary mt-4"
                onClick={() => setAttempt((current) => current + 1)}
                type="button"
              >
                다시 시도
              </button>
            </div>
          ) : null}
          {version ? (
            <>
              <div className="mt-6 rounded-card border border-app-border bg-app-surface-muted p-4 text-sm">
                <p className="font-bold">
                  {version.status === "published" ? "현재 시행본" : "이전 시행본"} ·{" "}
                  {version.policy_version}
                </p>
                <p className="mt-1 text-app-muted">시행일 {formatDate(version.effective_at)}</p>
                <details className="mt-2">
                  <summary className="flex min-h-11 cursor-pointer items-center">
                    문서 식별 정보
                  </summary>
                  <p className="break-all">버전 ID: {version.id}</p>
                  <p className="mt-1 break-all text-xs">SHA-256: {version.content_sha256}</p>
                </details>
              </div>
              <article
                className="mt-5 min-w-0 rounded-card border border-app-border bg-app-surface-raised p-5 sm:p-8"
                aria-label={version.title}
              >
                <LegalDocumentContent content={version.content} />
              </article>
            </>
          ) : null}
          {result?.versions.length ? (
            <div className="mt-5">
              <label className="auth-label" htmlFor="legal-version">
                시행본 선택
              </label>
              <select
                className="ui-input mt-2"
                id="legal-version"
                onChange={(event) =>
                  setSearchParams(
                    event.target.value === "" ? {} : { policy_version: event.target.value },
                  )
                }
                value={policyVersion ?? ""}
              >
                <option value="">현재 시행본</option>
                {result.versions.map((item) => (
                  <option key={item.id} value={item.policy_version}>
                    {item.policy_version} · {formatDate(item.effective_at)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {version === null && draft === undefined ? (
            <section
              className="mt-6 rounded-card border border-app-border bg-app-surface-raised p-5"
              role="status"
            >
              <h2 className="font-bold">
                {policyVersion === undefined
                  ? "아직 게시된 문서가 없습니다."
                  : "요청한 시행본을 찾을 수 없습니다."}
              </h2>
              <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
                게시된 문서는 이 주소에서 로그인 없이 확인할 수 있어요. 문의는{" "}
                {PUBLIC_OPERATOR.email}로 보내 주세요.
              </p>
            </section>
          ) : null}
          {draft === undefined ? null : (
            <section className="mt-6" aria-label="검토용 개발 초안">
              <div
                className="rounded-card border border-warning-border bg-warning-surface p-5 text-sm leading-6 text-warning-text"
                role="status"
              >
                <h2 className="font-extrabold">검토용 초안 · 시행 전</h2>
                <p className="mt-2">
                  아래 문서는 개발·미리보기 사이트에서 제공되는 검토본입니다. 운영 정보 확정과 법률
                  검토가 끝나지 않아 실제 이용에 적용되는 약관·동의서가 아닙니다.
                </p>
              </div>
              <article className="mt-5 min-w-0 rounded-card border border-app-border bg-app-surface-raised p-5 sm:p-8">
                <LegalDocumentContent content={draft} />
              </article>
            </section>
          )}
        </main>
        <SiteFooter />
      </div>
    </div>
  );
}
