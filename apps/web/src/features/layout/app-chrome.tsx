import { ChevronRight } from "lucide-react";
import { Link, useLocation } from "react-router";

import { routeMetadataForPath } from "./app-route-metadata";
import { SiteFooter } from "./site-footer";

export function AppBreadcrumb(): React.JSX.Element | null {
  const { pathname } = useLocation();
  const breadcrumbs = routeMetadataForPath(pathname)?.breadcrumbs;

  if (breadcrumbs === undefined || breadcrumbs.length === 0) return null;

  return (
    <nav aria-label="현재 위치" className="app-breadcrumb min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-y-1 text-sm font-semibold leading-6 text-app-muted">
        {breadcrumbs.map((item, index) => {
          const current = index === breadcrumbs.length - 1;

          return (
            <li
              className="inline-flex min-w-0 items-center"
              key={`${item.label}-${item.to ?? "current"}`}
            >
              {index === 0 ? null : (
                <ChevronRight
                  aria-hidden="true"
                  className="mx-1 shrink-0 text-app-muted"
                  size={16}
                  strokeWidth={2}
                />
              )}
              {current || item.to === undefined ? (
                <span
                  aria-current={current ? "page" : undefined}
                  className="break-keep py-2 font-bold text-app-text [overflow-wrap:anywhere]"
                >
                  {item.label}
                </span>
              ) : (
                <Link
                  // 첫 칸은 안쪽 여백(px-2)만큼 당겨 글자를 아래 제목 시작선에 맞춘다(8px 어긋남 실측, 2026-10-04).
                  className={`inline-flex min-h-11 min-w-11 items-center rounded-control px-2 text-app-muted transition hover:bg-app-surface hover:text-app-text ${index === 0 ? "-ml-2" : ""}`}
                  to={item.to}
                >
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function AppFooter(): React.JSX.Element {
  return (
    <div className="mt-auto min-w-0">
      <SiteFooter />
    </div>
  );
}
