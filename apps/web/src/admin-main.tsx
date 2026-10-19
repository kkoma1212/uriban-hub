import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";

import { AppearanceProvider } from "./features/theme";
import { adminRouter } from "./admin-router";
import { canonicalDevelopmentUrl } from "./lib/canonical-development-origin";
import { installClientErrorReporter } from "./lib/client-error-reporter";
import { installPageCachePrivacy } from "./lib/page-cache-privacy";
import "./styles.css";
import "./design-foundation.css";

/*
 * 관리자 화면 묶음(AdminWeb)의 입구. 이용자 입구(main.tsx)와 달리 앱 설치·오프라인 저장(PWA)을
 * 켜지 않는다 — 관리자 화면은 개인정보를 다루므로 기기에 화면을 저장해 두지 않는다.
 */
const canonicalUrl = canonicalDevelopmentUrl(window.location.href, import.meta.env.DEV);

if (canonicalUrl !== null) {
  window.location.replace(canonicalUrl);
} else {
  const rootElement = document.getElementById("root");

  if (rootElement === null) {
    throw new Error("React root element was not found.");
  }

  installPageCachePrivacy();
  installClientErrorReporter();
  // 글꼴 선언은 첫 화면 CSS 예산 밖에서 늦게 불러온다(late-fonts.css 주석 참고).
  void import("./late-fonts.css");

  createRoot(rootElement).render(
    <StrictMode>
      <AppearanceProvider>
        <RouterProvider router={adminRouter} />
      </AppearanceProvider>
    </StrictMode>,
  );
}
