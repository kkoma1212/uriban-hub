import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/*
 * 화면 열기·새로고침(navigation)은 서버의 최신 화면 뼈대(index.html)부터 받고, 3초 안에 안 오거나
 * 실패하면 저장해 둔 것을 쓴다. 전에는 저장본을 먼저 띄우고 뒤에서 새 버전을 받아 자동 새로고침해서,
 * 배포 직후 휴대폰이 한동안 옛 화면을 썼다(2026-10-05 실기기 검수, 사용자 선택 C).
 * 아래 함수들은 sw.js로 그대로 옮겨 적히므로 바깥 값을 쓰지 않는다. API 경로는 화면이 아니라 손대지 않고,
 * 관리자 경로도 넘기지 않는다 — 관리자 화면은 별도 묶음이다(빌드 검사가 이 정규식을 sw.js에서 찾는다).
 */
const isUserAppNavigation = ({ request, url }: { request: Request; url: URL }): boolean =>
  request.mode === "navigate" &&
  !/^\/api(?:\/|%2f|$)/iu.test(url.pathname) &&
  !/^\/admin(?:\/|%2f|$)/iu.test(url.pathname);
const latestAppShellFirst = async ({ request }: { request: Request }): Promise<Response> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) return response;
  } catch {
    // 끊김·시간 초과는 아래 저장본으로 연다.
  }
  return (await caches.match("/index.html", { ignoreSearch: true })) ?? Response.error();
};

/*
 * 화면은 두 묶음으로 빌드한다(T-ADMIN-SPLIT, 2026-10-07 사용자 결정): 이용자(학생·교사) 화면 Web/과
 * 관리자 화면 AdminWeb/. 한쪽만 고쳐도 다른 쪽 묶음이 바뀌지 않게 입구(index.html / admin/index.html)와
 * 경로표(router.tsx / admin-router.tsx)를 나눴다. CLASSHUB_WEB_TARGET=admin일 때만 관리자 묶음을 만든다.
 */
const buildsAdminBundle = process.env.CLASSHUB_WEB_TARGET === "admin";
const adminEntry = fileURLToPath(new URL("./admin/index.html", import.meta.url));

/** 개발 서버 한 곳(5174·5176)에서 /admin 화면 요청에는 관리자 입구를 내준다. 빌드 결과에는 영향이 없다. */
const serveAdminEntryInDevelopment = (): Plugin => ({
  name: "classhub-admin-entry-dev",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const pathname = (request.url ?? "").split("?", 1)[0] ?? "";
      const isAdminScreen =
        request.method === "GET" &&
        /^\/admin(?:\/[^.]*)?$/u.test(pathname) &&
        (request.headers.accept ?? "").includes("text/html");
      if (!isAdminScreen) return next();
      readFile(adminEntry, "utf8")
        .then((html) => server.transformIndexHtml(request.url ?? pathname, html))
        .then((html) => {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(html);
        })
        .catch(next);
    });
  },
});

export default defineConfig(() => ({
  build: {
    outDir: buildsAdminBundle ? "../../AdminWeb" : "../../Web",
    ...(buildsAdminBundle ? { rollupOptions: { input: adminEntry } } : {}),
    /*
     * woff2를 data: URI로 인라인하면 두 가지가 깨진다.
     * 1) production CSP가 font-src 'self'라 브라우저가 인라인 글꼴을 거부한다(대체 글꼴로 표시).
     * 2) 한글 unicode-range 서브셋(@font-face 87개)의 존재 이유가 사라진다 —
     *    안 쓰는 글자 범위까지 CSS에 묻어 와 모든 사용자가 항상 내려받는다.
     * 기본 4096바이트 한도에 작은 서브셋 6개가 걸려 실제로 이 상태였다.
     */
    // 2026-09-27: Pretendard·Gaegu CSS는 woff2 뒤에 woff도 적어 두어, woff도 인라인하지 않는다.
    assetsInlineLimit: (filePath: string) => (/\.woff2?$/u.test(filePath) ? false : undefined),
  },
  plugins: [
    react(),
    tailwindcss(),
    serveAdminEntryInDevelopment(),
    // 관리자 묶음은 앱 설치·오프라인 저장을 하지 않는다(admin-main.tsx 주석).
    ...(buildsAdminBundle
      ? []
      : [
          VitePWA({
            injectRegister: null,
            /*
             * 2026-08-10 Hex 결정: 사용자가 띠를 눌러야 새 버전이 적용되던 방식(prompt)을
             * 자동 적용으로 바꾼다. 검수 때마다 띠가 걸렸고, 실사용 학생은 안 누르면 옛
             * 화면에 갇혔다. 대가는 "쓰던 중에 화면이 새로 뜰 수 있다"이며 실제 배포에서
             * 관찰하기로 했다. 갇히는 쪽이 더 나쁘다는 판단.
             */
            registerType: "autoUpdate",
            manifest: {
              id: "/",
              name: "우리반 허브",
              short_name: "우리반 허브",
              description: "오늘 우리 반에 필요한 정보를 모아 보는 학급 대시보드",
              display: "standalone",
              start_url: "/bootstrap",
              scope: "/",
              theme_color: "#1e4536",
              background_color: "#efe8dc",
              lang: "ko",
              icons: [
                { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
                { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
                {
                  src: "/icons/icon-maskable-512.png",
                  sizes: "512x512",
                  type: "image/png",
                  purpose: "maskable",
                },
              ],
            },
            workbox: {
              // 웹 푸시 수신·알림 클릭 처리(public/push-sw.js). generateSW 방식은 유지한다.
              importScripts: ["push-sw.js"],
              globPatterns: ["**/*.{js,mjs,css,html,ico,png,svg,webp}"],
              navigateFallback: null,
              runtimeCaching: [
                {
                  urlPattern: isUserAppNavigation,
                  handler: latestAppShellFirst,
                },
              ],
            },
          }),
        ]),
  ],
  server: {
    host: "localhost",
    // 두쫀쿠 키우기(5173)와 주소를 분리하고 자동 포트 이동을 막는다.
    // 개발 묶음(dev-sandbox, 2026-10-03)만 5176·3010으로 바꿔 띄운다. 기본값은 운영 로컬 그대로.
    port: Number(process.env.CLASSHUB_WEB_PORT ?? 5174),
    strictPort: true,
    proxy: {
      "/api/v1": {
        target: process.env.CLASSHUB_API_PROXY_TARGET ?? "http://127.0.0.1:3000",
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: "localhost",
    port: 5174,
    strictPort: true,
  },
}));
