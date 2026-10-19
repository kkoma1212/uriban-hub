import { Link } from "react-router";

import { LEGAL_DOCUMENTS, type LegalDocumentType } from "./legal-documents";
import type { LegalConsentSnapshot } from "./legal-api";

export function LegalDocumentLink({
  documentType,
  children,
  className = "",
  newTab = true,
  policyVersion,
}: {
  documentType: LegalDocumentType;
  children?: React.ReactNode;
  className?: string;
  newTab?: boolean;
  policyVersion?: string | undefined;
}): React.JSX.Element {
  const document = LEGAL_DOCUMENTS.find((item) => item.type === documentType)!;

  return (
    <Link
      aria-label={newTab ? `${document.title} 전문 보기 (새 탭)` : undefined}
      className={`inline-flex min-h-11 min-w-11 max-w-full ${policyVersion ? "flex-col items-start" : "items-center"} rounded-lg py-2 font-semibold underline decoration-app-border underline-offset-4 hover:text-role-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary ${className}`}
      rel={newTab ? "noopener noreferrer" : undefined}
      target={newTab ? "_blank" : undefined}
      to={
        document.path +
        (policyVersion ? "?policy_version=" + encodeURIComponent(policyVersion) : "")
      }
    >
      {children ?? document.title}
      {policyVersion && (
        <span className="min-w-0 max-w-full whitespace-normal break-all text-xs">
          ({policyVersion})
        </span>
      )}
    </Link>
  );
}

export function LegalDocumentLinks({
  newTab = true,
  documents,
}: {
  newTab?: boolean;
  documents?: LegalConsentSnapshot | undefined;
}): React.JSX.Element {
  return (
    <nav aria-label="약관 및 개인정보 안내" className="flex min-w-0 flex-wrap gap-x-4 gap-y-1">
      {LEGAL_DOCUMENTS.map((document) => (
        <LegalDocumentLink
          documentType={document.type}
          key={document.type}
          newTab={newTab}
          policyVersion={documents?.[document.type].policy_version}
        />
      ))}
    </nav>
  );
}
