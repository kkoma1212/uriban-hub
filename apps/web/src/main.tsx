import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { registerSW } from "virtual:pwa-register";

import { pwaStatusController } from "./features/layout/pwa-status";
import { AppearanceProvider } from "./features/theme";
import { canonicalDevelopmentUrl } from "./lib/canonical-development-origin";
import { installClientErrorReporter } from "./lib/client-error-reporter";
import "./lib/authenticated-client-state";
import { installPageCachePrivacy } from "./lib/page-cache-privacy";
import { router } from "./router";
import "./styles.css";
import "./design-foundation.css";

const canonicalUrl = canonicalDevelopmentUrl(window.location.href, import.meta.env.DEV);

if (canonicalUrl !== null) {
  window.location.replace(canonicalUrl);
} else {
  const rootElement = document.getElementById("root");

  if (rootElement === null) {
    throw new Error("React root element was not found.");
  }

  pwaStatusController.start(registerSW);
  installPageCachePrivacy();
  installClientErrorReporter();
  // 글꼴 선언은 첫 화면 CSS 예산 밖에서 늦게 불러온다(late-fonts.css 주석 참고).
  void import("./late-fonts.css");

  createRoot(rootElement).render(
    <StrictMode>
      <AppearanceProvider>
        <RouterProvider router={router} />
      </AppearanceProvider>
    </StrictMode>,
  );
}
