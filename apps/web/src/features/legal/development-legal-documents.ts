import documents from "./development-legal-documents.generated.json";

import type { LegalDocumentType } from "./legal-documents";

// Development and explicit preview builds share drafts; standard production builds exclude them.
export const DEVELOPMENT_LEGAL_DOCUMENTS: Record<LegalDocumentType, string> = documents;

/**
 * 공개 미리보기의 검토용 초안에서 개발·검수자용 부분을 뺀다(총검수 B3-13: 문서 ID·결정 번호·
 * 커밋 해시가 화면에 보였다). 개발 정본은 첫 구분선(---) 앞이 머리말·제0장이고, 끝의
 * '개발 검수 메모' 장은 게시본에서 빠지는 부분이다. 문서 DB의 원본은 그대로 둔다.
 * 채우지 않은 칸 표시([게시 전 확정 …])는 아직 초안이라는 사실이라 남긴다.
 */
export function reviewDraftContent(content: string): string {
  const lines = content.split("\n");
  const title = (lines[0] ?? "").replace(/\s*\(개발 정본\)\s*$/u, "");
  const rule = lines.indexOf("---");
  const memo = lines.findIndex((line) => line.startsWith("## 개발 검수 메모"));
  const body = lines.slice(rule === -1 ? 1 : rule + 1, memo === -1 ? undefined : memo);
  return [title, "", ...body].join("\n").trim() + "\n";
}
