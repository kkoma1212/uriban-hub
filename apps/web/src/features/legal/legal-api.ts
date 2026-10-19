import { apiFetch, parseResponse } from "../../api/auth";

import type { LegalDocumentType } from "./legal-documents";

export type LegalConsentSnapshot = Record<
  LegalDocumentType,
  {
    id: string;
    policy_version: string;
    content_sha256: string;
  }
>;
export interface LegalConsentBundle {
  binding_required: boolean;
  documents: LegalConsentSnapshot | null;
}
export async function getLegalConsentBundle(): Promise<LegalConsentBundle> {
  return parseResponse<LegalConsentBundle>(
    await apiFetch("/api/v1/legal/documents/consent-bundle", {
      cache: "no-store",
      credentials: "omit",
    }),
  );
}

export interface LegalVersionSummary {
  effective_at: string;
  id: string;
  policy_version: string;
  status: "published" | "retired";
  title: string;
}

export interface LegalVersion extends LegalVersionSummary {
  content: string;
  content_sha256: string;
  document_type: LegalDocumentType;
  published_at: string;
}

export interface LegalDocumentResponse {
  version: LegalVersion | null;
  versions: LegalVersionSummary[];
}

export async function getLegalDocument(
  type: LegalDocumentType,
  policyVersion?: string,
): Promise<LegalDocumentResponse> {
  const query = new URLSearchParams();
  if (policyVersion !== undefined) query.set("policy_version", policyVersion);
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return parseResponse<LegalDocumentResponse>(
    await apiFetch(`/api/v1/legal/documents/${type}${suffix}`, {
      cache: "no-store",
      credentials: "omit",
    }),
  );
}
