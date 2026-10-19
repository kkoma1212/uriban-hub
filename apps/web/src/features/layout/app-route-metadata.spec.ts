import { describe, expect, it } from "vitest";

import {
  PRODUCT_ROUTE_METADATA,
  routeDocumentTitle,
  routeMetadataForPath,
  routeMetadataForPattern,
} from "./app-route-metadata";

const expectedProductPatterns = [
  "/",
  "/login",
  "/demo",
  "/join",
  "/sign-up",
  "/verify-email",
  "/guardian-consent",
  "/forgot-password",
  "/forgot-account",
  "/reset-password",
  "/bootstrap",
  "/account/profile",
  "/account/social",
  "/account/password",
  "/account/deletion",
  "/home",
  "/members/manage",
  "/members/manage/:memberId",
  "/class/archive",
  "/class/manage/audit-logs",
  "/class/manage",
  "/class/create",
  "/settings",
  "/updates",
  "/updates/catch-up",
  "/updates/followups",
  "/updates/reuse/:kind/:sourceId",
  "/attendance",
  "/activities",
  "/more",
  "/polls",
  "/polls/:pollId",
  "/elections",
  "/supplies",
  "/supplies/:supplyId",
  "/notices",
  "/notices/:noticeId",
  "/help-requests",
  "/help-requests/ask",
  "/help-requests/:helpRequestId",
  "/class-chat",
  "/schedules",
  "/schedules/:scheduleId",
  "/schedules/:scheduleId/change-review",
  "/assessments",
  "/meals",
  "/admin",
  "/admin/login",
  "/admin/account",
  "/past-classes",
  "/past-classes/:classId",
  "/legal/terms",
  "/legal/privacy-consent",
  "/legal/privacy-policy",
  "/legal/guardian-consent",
].sort();

describe("app route metadata", () => {
  it("covers each of the 55 product routes once without retired or development routes", () => {
    const patterns = PRODUCT_ROUTE_METADATA.map(({ pattern }) => pattern);

    expect(patterns).toHaveLength(55);
    expect(new Set(patterns)).toHaveProperty("size", 55);
    expect([...patterns].sort()).toEqual(expectedProductPatterns);
    expect(patterns).not.toContain("/local-test-admin");
    expect(patterns.filter((pattern) => pattern.startsWith("/legal/"))).toHaveLength(4);
    expect(
      patterns.filter((pattern) => pattern === "/admin" || pattern.startsWith("/admin/")),
    ).toEqual(["/admin", "/admin/login", "/admin/account"]);
  });

  it("resolves exact and dynamic paths to the approved screen language", () => {
    expect(routeMetadataForPath("/home")?.title).toBe("홈");
    expect(routeMetadataForPath("/members/manage/17")?.title).toBe("학생 정보");
    expect(routeMetadataForPath("/notices/17")?.title).toBe("공지");
    expect(routeMetadataForPath("/elections")?.title).toBe("대표 선거");
    expect(routeMetadataForPath("/admin")?.title).toBe("관리자 운영 콘솔");
    expect(routeMetadataForPath("/legal/terms")?.title).toBe("이용약관");
    expect(routeMetadataForPattern("/members/manage/:memberId")?.title).toBe("학생 정보");
  });

  it("uses the same canonical title metadata for the browser title", () => {
    expect(routeDocumentTitle("/account/profile")).toBe("내 이름 | 우리반 허브");
    expect(routeDocumentTitle("/updates")).toBe("우리반 소식 | 우리반 허브");
    expect(routeDocumentTitle("/updates/reuse/notice/17")).toBe("내용 재사용 | 우리반 허브");
    expect(routeDocumentTitle("/schedules/17/change-review")).toBe("변경 영향 검토 | 우리반 허브");
    expect(routeDocumentTitle("/polls/17")).toBe("투표 | 우리반 허브");
    expect(routeDocumentTitle("/unknown")).toBe("페이지를 찾을 수 없음 | 우리반 허브");
    expect(routeDocumentTitle("/demo")).toBe("예시 체험 | 우리반 허브");
  });

  it("does not provide titles or breadcrumbs for retired list and detail URLs", () => {
    for (const path of [
      "/seating",
      "/seating/17",
      "/grouping",
      "/grouping/18",
      "/duty",
      "/duty/19",
    ]) {
      expect(routeMetadataForPath(path)).toBeUndefined();
      expect(routeDocumentTitle(path)).toBe("페이지를 찾을 수 없음 | 우리반 허브");
    }
  });

  it("provides canonical breadcrumb trails only for in-app destinations", () => {
    expect(routeMetadataForPath("/home")?.breadcrumbs).toEqual([]);
    expect(routeMetadataForPath("/login")?.breadcrumbs).toBeUndefined();
    expect(routeMetadataForPath("/notices/17")?.breadcrumbs).toEqual([
      { label: "홈", to: "/home" },
      { label: "우리반 소식", to: "/updates" },
      { label: "공지" },
    ]);
    expect(routeMetadataForPath("/account/password")?.breadcrumbs).toEqual([
      { label: "홈", to: "/home" },
      { label: "설정", to: "/settings" },
      { label: "비밀번호 변경" },
    ]);
  });
});
