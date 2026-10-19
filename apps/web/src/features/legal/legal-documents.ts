export const LEGAL_DOCUMENTS = [
  { type: "terms", path: "/legal/terms", title: "이용약관" },
  {
    type: "privacy_consent",
    path: "/legal/privacy-consent",
    title: "개인정보 수집·이용 동의서",
  },
  { type: "privacy_policy", path: "/legal/privacy-policy", title: "개인정보처리방침" },
  {
    type: "guardian_consent",
    path: "/legal/guardian-consent",
    title: "만 14세 미만 보호자 고지·동의서",
  },
] as const;

export type LegalDocumentType = (typeof LEGAL_DOCUMENTS)[number]["type"];

// 2026-10-19 사용자 결정(D3): 공개 연락처는 서비스 전용 메일, 실명은 처리방침 안에만 둔다.
export const PUBLIC_OPERATOR = {
  email: "uribanhub@naver.com",
} as const;
