import { LegalDocumentLinks } from "../legal/legal-document-links";
import { PUBLIC_OPERATOR } from "../legal/legal-documents";

/*
 * 2026-09-27 사용자 요청: 약관 · 저작권 · 문의를 모든 화면(로그인 · 선생님 · 학생)에서 맨 아래 한 줄로 길게.
 * 넓은 화면(900px+)은 한 줄로 이어 붙이고, 휴대폰은 좁아서 지금처럼 줄을 나눈다.
 */
export function SiteFooter({ className = "" }: { className?: string }): React.JSX.Element {
  return (
    <footer
      aria-label="서비스 정보"
      className={`app-page-footer mt-8 min-w-0 border-t border-app-border py-4 text-xs font-semibold leading-5 text-app-muted min-[900px]:flex min-[900px]:flex-wrap min-[900px]:items-center min-[900px]:gap-x-6 ${className}`}
      data-app-footer="true"
      role="contentinfo"
    >
      <LegalDocumentLinks />
      <div className="mt-2 flex min-w-0 flex-wrap gap-x-4 gap-y-1 min-[900px]:mt-0">
        <p>© 2026 우리반 허브</p>
      </div>
      <a
        className="inline-flex min-h-11 max-w-full items-center rounded-lg py-2 underline decoration-app-border underline-offset-4 hover:text-role-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary"
        href={`mailto:${PUBLIC_OPERATOR.email}`}
      >
        <span className="break-all">문의 {PUBLIC_OPERATOR.email}</span>
      </a>
    </footer>
  );
}
