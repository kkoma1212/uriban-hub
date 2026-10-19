import { describe, expect, it } from "vitest";

import { DEVELOPMENT_LEGAL_DOCUMENTS, reviewDraftContent } from "./development-legal-documents";

describe("reviewDraftContent", () => {
  it.each(Object.entries(DEVELOPMENT_LEGAL_DOCUMENTS))(
    "%s: hides the developer header and memo but keeps the public body (B3-13)",
    (_type, content) => {
      const shown = reviewDraftContent(content);
      expect(shown).not.toMatch(
        /개발 문서 ID|제품 결정:|제품 사실 갱신|개발 검수 메모|\(개발 정본\)/u,
      );
      expect(shown).not.toContain("게시본에서는 제거한다");
      expect(shown.startsWith("# 우리반 허브 ")).toBe(true);
      expect(shown).toMatch(/^## /mu);
      // 머리말을 뺀 나머지 본문은 그대로다.
      const body = content.slice(
        content.indexOf("\n---\n") + 5,
        content.indexOf("## 개발 검수 메모"),
      );
      expect(shown).toContain(body.trim());
    },
  );
});
