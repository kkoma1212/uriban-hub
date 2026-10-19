import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  createBrowserRouter: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const ADMIN_PATHS = ["/admin", "/admin/login", "/admin/account"];

// T-ADMIN-SPLIT(2026-10-07): 이용자 화면 묶음과 관리자 화면 묶음은 경로표부터 나뉜다.
describe("administrator route availability", () => {
  it.each(["preview", "development", "production"])(
    "keeps administrator routes out of the user bundle in %s",
    async (mode) => {
      vi.stubEnv("MODE", mode);
      vi.resetModules();
      const { routes } = await import("../../router");
      const paths = routes[0]?.children?.map(({ path }) => path);
      expect(paths).toContain("/login");
      expect(paths).toContain("/bootstrap");
      for (const path of ADMIN_PATHS) expect(paths).not.toContain(path);
    },
  );

  it("serves only administrator screens and legal documents from the administrator bundle", async () => {
    vi.stubEnv("MODE", "production");
    vi.resetModules();
    const { adminRoutes } = await import("../../admin-router");
    const { routeMetadataForPattern } = await import("./app-route-metadata");
    const paths = adminRoutes[0]?.children?.map(({ path }) => path);
    for (const path of ADMIN_PATHS) {
      expect(paths).toContain(path);
      expect(routeMetadataForPattern(path)).toBeDefined();
    }
    expect(paths).toEqual(expect.arrayContaining(["/legal/terms", "/legal/privacy-policy", "*"]));
    for (const path of ["/login", "/bootstrap", "/home", "/sign-up"]) {
      expect(paths).not.toContain(path);
    }
  });
});
