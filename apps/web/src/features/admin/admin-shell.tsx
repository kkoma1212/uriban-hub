import { ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import type { AdminSessionResponse } from "../../api/admin-auth";
import { AdminSessionStatus } from "./admin-session-status";
import { SiteFooter } from "../layout/site-footer";
import { RequestCooldownNotice } from "../auth/request-cooldown";
import { AdminStepUpDialog } from "./admin-step-up-dialog";

export function AdminShell({
  children,
  homeHref = "/admin/login",
  surface = true,
  wide = false,
  session,
  onSessionChange,
  showRequestCooldownNotice = true,
}: {
  children: React.ReactNode;
  showRequestCooldownNotice?: boolean;
  homeHref?: string;
  surface?: boolean;
  wide?: boolean;
  session?: AdminSessionResponse | undefined;
  onSessionChange?: (session: AdminSessionResponse | undefined) => void;
}): React.JSX.Element {
  return (
    <>
      <a
        className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[110] focus:not-sr-only focus:rounded-control focus:bg-app-surface focus:px-4 focus:py-3 focus:text-sm focus:font-bold focus:text-app-text focus:shadow-lg"
        href="#admin-main-content"
      >
        본문으로 건너뛰기
      </a>
      <main
        className="app-main-content min-h-dvh bg-app-canvas pb-8 text-app-text"
        data-app-role="admin"
        data-app-shell="true"
        data-app-shell-layout="admin-main"
        id="admin-main-content"
        tabIndex={-1}
      >
        <div className={`mx-auto min-w-0 w-full ${wide ? "max-w-[70rem]" : "max-w-2xl"}`}>
          <div className="app-topbar mb-0">
            <Link
              className="inline-flex min-h-11 min-w-0 items-center gap-2.5 rounded-control text-app-text"
              to={homeHref}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-control bg-role-soft text-role-primary">
                <ShieldCheck aria-hidden="true" size={21} />
              </span>
              <span className="min-w-0 text-base font-extrabold tracking-[-0.02em]">
                우리반 허브 <span className="text-sm font-semibold text-app-muted">관리자</span>
              </span>
            </Link>
          </div>
          {session === undefined || onSessionChange === undefined ? null : (
            <AdminSessionStatus session={session} onSessionChange={onSessionChange} />
          )}
          {surface ? (
            <section className="ui-panel mt-6">
              {showRequestCooldownNotice ? <RequestCooldownNotice /> : null}
              {children}
            </section>
          ) : (
            <div className="mt-6 min-w-0">
              {showRequestCooldownNotice ? <RequestCooldownNotice /> : null}
              {children}
            </div>
          )}
          <p className="mt-6 break-keep text-center text-xs leading-5 text-app-muted">
            학생 계정·선생님 계정과 분리된 관리자 전용 보안 영역입니다.
          </p>
          <SiteFooter />
        </div>
      </main>
      {session === undefined ? null : (
        <AdminStepUpDialog key={`${session.account.id}:${session.session.issued_at}`} />
      )}
    </>
  );
}
