import { createBrowserRouter, Navigate } from "react-router";
import type { RouteObject } from "react-router";

import {
  RouteErrorBoundary,
  RouteHydrationFallback,
  RouteRuntime,
} from "./features/layout/router-runtime";
import { routeMetadataForPattern } from "./features/layout/app-route-metadata";

/*
 * 관리자 화면 묶음(AdminWeb)의 경로. 이용자 화면 묶음(Web, router.tsx)과 빌드·배포를 나눠
 * 한쪽만 고쳐도 다른 쪽 묶음이 바뀌지 않게 한다(T-ADMIN-SPLIT, 2026-10-07 사용자 결정).
 * 약관 화면은 관리자 화면 아래쪽 약관 링크가 열 곳이라 함께 둔다.
 */
const childRoutes: RouteObject[] = [
  { path: "/", element: <Navigate replace to="/admin" /> },
  {
    path: "/admin",
    lazy: async () => {
      const module = await import("./features/admin/admin-console-page");
      return { Component: module.AdminConsolePage };
    },
  },
  {
    path: "/admin/login",
    lazy: async () => {
      const module = await import("./features/admin/admin-login-page");
      return { Component: module.AdminLoginPage };
    },
  },
  {
    path: "/admin/account",
    lazy: async () => {
      const module = await import("./features/admin/admin-account-page");
      return { Component: module.AdminAccountPage };
    },
  },
  ...[
    "/legal/terms",
    "/legal/privacy-consent",
    "/legal/privacy-policy",
    "/legal/guardian-consent",
  ].map((path): RouteObject => ({
    path,
    lazy: async () => {
      const module = await import("./features/legal/legal-document-page");
      return { Component: module.LegalDocumentPage };
    },
  })),
  {
    path: "*",
    lazy: async () => {
      const module = await import("./features/layout/not-found-page");
      return { Component: module.NotFoundPage };
    },
  },
];

export const adminRoutes: RouteObject[] = [
  {
    element: <RouteRuntime />,
    errorElement: <RouteErrorBoundary />,
    hydrateFallbackElement: <RouteHydrationFallback />,
    children: childRoutes.map((route) => {
      const metadata = route.path === undefined ? undefined : routeMetadataForPattern(route.path);
      return metadata === undefined ? route : { ...route, handle: { routeMetadata: metadata } };
    }),
  },
];

export const adminRouter = createBrowserRouter(adminRoutes);
