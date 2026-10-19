import { matchPath } from "react-router";

export interface AppBreadcrumbItem {
  label: string;
  to?: string;
}

export interface AppRouteMetadata {
  breadcrumbs?: readonly AppBreadcrumbItem[];
  pattern: string;
  title: string;
}

// 2026-09-27 확정 시안: 첫 탭 이름 '홈'과 이동 경로 첫 칸을 맞춘다.
const today = { label: "홈", to: "/home" } as const;
// 계정 하위 화면은 설정(교사·학생 공통)에서 들어간다(총검수 B2-07).
const account = { label: "설정", to: "/settings" } as const;
const activities = { label: "반 활동", to: "/activities" } as const;
const classManagement = { label: "반 관리", to: "/class/manage" } as const;
const studentManagement = { label: "학생 관리", to: "/members/manage?tab=approved" } as const;
const updates = { label: "우리반 소식", to: "/updates" } as const;

const inApp = (
  title: string,
  ...parents: readonly AppBreadcrumbItem[]
): readonly AppBreadcrumbItem[] => [...parents, { label: title }];

/**
 * 현재 운영 router의 제품 경로와 승인된 사용자 노출 이름을 묶는 정본이다.
 * 개발 전용·wildcard 경로는 이 배열에 넣지 않는다.
 */
export const PRODUCT_ROUTE_METADATA = [
  { pattern: "/", title: "로그인" },
  { pattern: "/sign-up", title: "가입" },
  { pattern: "/login", title: "로그인" },
  { pattern: "/demo", title: "예시 체험" },
  { pattern: "/join", title: "반 참여" },
  { pattern: "/bootstrap", title: "시작 안내" },
  { pattern: "/legal/terms", title: "이용약관" },
  { pattern: "/legal/privacy-consent", title: "개인정보 수집·이용 동의서" },
  { pattern: "/legal/privacy-policy", title: "개인정보처리방침" },
  { pattern: "/legal/guardian-consent", title: "만 14세 미만 보호자 고지·동의서" },
  {
    breadcrumbs: inApp("내 이름", today),
    pattern: "/account/profile",
    title: "내 이름",
  },
  {
    breadcrumbs: inApp("빠른 로그인 연결", today, account),
    pattern: "/account/social",
    title: "빠른 로그인 연결",
  },
  {
    breadcrumbs: inApp("비밀번호 변경", today, account),
    pattern: "/account/password",
    title: "비밀번호 변경",
  },
  {
    breadcrumbs: inApp("계정 삭제", today, account),
    pattern: "/account/deletion",
    title: "계정 삭제",
  },
  { breadcrumbs: [], pattern: "/home", title: "홈" },
  {
    breadcrumbs: inApp("학생 관리", today),
    pattern: "/members/manage",
    title: "학생 관리",
  },
  {
    breadcrumbs: inApp("학생 정보", today, studentManagement),
    pattern: "/members/manage/:memberId",
    title: "학생 정보",
  },
  {
    breadcrumbs: inApp("반 운영 종료", today, classManagement),
    pattern: "/class/archive",
    title: "반 운영 종료",
  },
  {
    breadcrumbs: inApp("반 관리 기록", today, classManagement),
    pattern: "/class/manage/audit-logs",
    title: "반 관리 기록",
  },
  {
    breadcrumbs: inApp("반 관리", today),
    pattern: "/class/manage",
    title: "반 관리",
  },
  { pattern: "/class/create", title: "반 만들기" },
  { breadcrumbs: inApp("내 설정", today), pattern: "/settings", title: "내 설정" },
  { breadcrumbs: inApp("우리반 소식", today), pattern: "/updates", title: "우리반 소식" },
  { breadcrumbs: inApp("지난 반 기록", today), pattern: "/past-classes", title: "지난 반 기록" },
  {
    breadcrumbs: inApp("지난 반 소식", today, { label: "지난 반 기록", to: "/past-classes" }),
    pattern: "/past-classes/:classId",
    title: "지난 반 소식",
  },
  {
    breadcrumbs: inApp("놓친 안내 따라잡기", today, updates),
    pattern: "/updates/catch-up",
    title: "놓친 안내 따라잡기",
  },
  {
    breadcrumbs: inApp("학생별 미해결", today, updates),
    pattern: "/updates/followups",
    title: "학생별 미해결",
  },
  {
    breadcrumbs: inApp("출결 연락", today),
    pattern: "/attendance",
    title: "출결 연락",
  },
  { breadcrumbs: inApp("반 활동", today), pattern: "/activities", title: "반 활동" },
  { breadcrumbs: inApp("더보기", today), pattern: "/more", title: "더보기" },
  {
    breadcrumbs: inApp("내용 재사용", today, updates),
    pattern: "/updates/reuse/:kind/:sourceId",
    title: "내용 재사용",
  },
  {
    breadcrumbs: inApp("투표", today, activities),
    pattern: "/polls",
    title: "투표",
  },
  {
    breadcrumbs: inApp("투표", today, activities),
    pattern: "/polls/:pollId",
    title: "투표",
  },
  {
    breadcrumbs: inApp("대표 선거", today, activities),
    pattern: "/elections",
    title: "대표 선거",
  },
  {
    breadcrumbs: inApp("준비물·숙제", today, updates),
    pattern: "/supplies",
    title: "준비물·숙제",
  },
  {
    breadcrumbs: inApp("준비물·숙제", today, updates),
    pattern: "/supplies/:supplyId",
    title: "준비물·숙제",
  },
  {
    breadcrumbs: inApp("공지", today, updates),
    pattern: "/notices",
    title: "공지",
  },
  {
    breadcrumbs: inApp("공지", today, updates),
    pattern: "/notices/:noticeId",
    title: "공지",
  },
  { breadcrumbs: inApp("도움 요청", today), pattern: "/help-requests", title: "도움 요청" },
  {
    breadcrumbs: inApp("선생님께 물어보기", today),
    pattern: "/help-requests/ask",
    title: "선생님께 물어보기",
  },
  {
    breadcrumbs: inApp("도움 대화", today),
    pattern: "/help-requests/:helpRequestId",
    title: "도움 대화",
  },
  { breadcrumbs: inApp("반 대화", today), pattern: "/class-chat", title: "반 대화" },
  { breadcrumbs: inApp("일정", today), pattern: "/schedules", title: "일정" },
  {
    breadcrumbs: inApp("변경 영향 검토", today, { label: "일정", to: "/schedules" }),
    pattern: "/schedules/:scheduleId/change-review",
    title: "변경 영향 검토",
  },
  {
    breadcrumbs: inApp("일정", today),
    pattern: "/schedules/:scheduleId",
    title: "일정",
  },
  {
    breadcrumbs: inApp("평가 기록", today),
    pattern: "/assessments",
    title: "평가 기록",
  },
  { breadcrumbs: inApp("급식", today), pattern: "/meals", title: "급식" },
  { pattern: "/verify-email", title: "이메일 확인" },
  { pattern: "/guardian-consent", title: "보호자 동의" },
  { pattern: "/forgot-account", title: "아이디 찾기" },
  { pattern: "/forgot-password", title: "비밀번호 찾기" },
  { pattern: "/reset-password", title: "새 비밀번호 설정" },
  ...(import.meta.env.MODE === "preview"
    ? []
    : [
        { pattern: "/admin", title: "관리자 운영 콘솔" },
        { pattern: "/admin/login", title: "관리자 로그인" },
        { pattern: "/admin/account", title: "관리자 계정" },
      ]),
] as const satisfies readonly AppRouteMetadata[];

const metadataByPattern = new Map<string, AppRouteMetadata>([
  ...PRODUCT_ROUTE_METADATA.map((metadata) => [metadata.pattern, metadata] as const),
]);

if (import.meta.env.DEV) {
  metadataByPattern.set("/local-test-admin", {
    pattern: "/local-test-admin",
    title: "로컬 테스트 관리",
  });
}

export function routeMetadataForPattern(pattern: string): AppRouteMetadata | undefined {
  return metadataByPattern.get(pattern);
}

export function routeMetadataForPath(pathname: string): AppRouteMetadata | undefined {
  const normalizedPathname = pathname.split(/[?#]/u, 1)[0] ?? pathname;

  return [...metadataByPattern.values()].find(
    ({ pattern }) =>
      matchPath({ caseSensitive: true, end: true, path: pattern }, normalizedPathname) !== null,
  );
}

export function routeDocumentTitle(pathname: string): string {
  const metadata = routeMetadataForPath(pathname);
  return `${metadata?.title ?? "페이지를 찾을 수 없음"} | 우리반 허브`;
}
