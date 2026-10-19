import { LoaderCircle, LogOut, Menu, Search, ShieldCheck, X, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";

import type { AdminSessionResponse } from "../../api/admin-auth";
import { RequestCooldownNotice } from "../auth/request-cooldown";
import { SiteFooter } from "../layout/site-footer";
import { ROLE_LABELS } from "./admin-console-shared";
import { AdminSessionStatus } from "./admin-session-status";
import { AdminStepUpDialog } from "./admin-step-up-dialog";
import "./admin-workspace.css";

/*
 * 관리자 작업 공간 틀(2026-09-30 사용자 요청: LEXI 관리자 화면처럼 왼쪽 고정 메뉴·위쪽 막대·넓은 본문).
 * 메뉴 항목은 세로 탭(role="tab")이라 기존 탭 동작·접근성 의미를 그대로 유지한다.
 */
export interface AdminWorkspaceItem<Id extends string> {
  icon: LucideIcon;
  id: Id;
  label: string;
}

export interface AdminWorkspaceGroup<Id extends string> {
  label: string;
  items: ReadonlyArray<AdminWorkspaceItem<Id>>;
}

export function AdminWorkspace<Id extends string>({
  activeId,
  children,
  groups,
  loggingOut,
  onLogout,
  onAccount,
  onSearch,
  onSelect,
  onSessionChange,
  session,
}: {
  activeId: Id | undefined;
  children: React.ReactNode;
  groups: ReadonlyArray<AdminWorkspaceGroup<Id>>;
  loggingOut: boolean;
  onLogout: () => void;
  onAccount?: () => void;
  /** 회원 검색 권한이 있을 때만 위쪽 검색창을 보인다. */
  onSearch?: ((query: string) => void) | undefined;
  onSelect: (id: Id) => void;
  onSessionChange: (session: AdminSessionResponse | undefined) => void;
  session: AdminSessionResponse;
}): React.JSX.Element {
  const [desktop, setDesktop] = useState(
    () => window.matchMedia?.("(min-width: 1100px)").matches ?? window.innerWidth >= 1100,
  );
  const desktopRef = useRef(desktop);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchInvalid, setSearchInvalid] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDetailsElement>(null);
  const searchId = useId();
  const activeGroup = groups.find((group) => group.items.some((item) => item.id === activeId));
  const activeItem = activeGroup?.items.find((item) => item.id === activeId);
  const activeTabId = activeItem?.id ?? groups[0]?.items[0]?.id;
  const [focusedTabId, setFocusedTabId] = useState(activeTabId);
  const tabbableId = groups.some((group) => group.items.some((item) => item.id === focusedTabId))
    ? focusedTabId
    : activeTabId;
  useEffect(() => setFocusedTabId(activeTabId), [activeTabId]);

  const moveTabFocus = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(
      sidebarRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    const index = tabs.indexOf(event.currentTarget);
    if (index < 0 || tabs.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
    // Move focus without loading a panel or bypassing its unsaved-work confirmation.
    tabs[next]?.focus();
  };

  const currentTab = (): HTMLElement | null =>
    sidebarRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
    sidebarRef.current?.querySelector<HTMLElement>('[role="tab"]') ??
    sidebarRef.current?.querySelector<HTMLElement>(".admin-drawer-close") ??
    null;
  const closeDrawer = (): void => {
    setDrawerOpen(false);
    bodyRef.current?.removeAttribute("inert");
    bodyRef.current?.removeAttribute("aria-hidden");
    menuButtonRef.current?.focus();
  };
  useEffect(() => {
    const media = window.matchMedia?.("(min-width: 1100px)");
    const resize = (): void => {
      const wide = media?.matches ?? window.innerWidth >= 1100;
      const previouslyWide = desktopRef.current;
      desktopRef.current = wide;
      setDesktop(wide);
      if (!wide && previouslyWide) {
        setDrawerOpen(false);
        if (sidebarRef.current?.contains(document.activeElement)) menuButtonRef.current?.focus();
      }
      if (wide) {
        setDrawerOpen(false);
        if (
          document.activeElement === menuButtonRef.current ||
          document.activeElement?.classList.contains("admin-drawer-close")
        )
          currentTab()?.focus();
      }
    };
    media?.addEventListener("change", resize);
    window.addEventListener("resize", resize);
    return () => {
      media?.removeEventListener("change", resize);
      window.removeEventListener("resize", resize);
    };
  }, []);
  useEffect(() => {
    if (!drawerOpen || desktop) return;
    currentTab()?.focus();
    const onKey = (event: KeyboardEvent): void => {
      // A confirmation dialog owns focus when it is open; never trap its controls.
      if (sidebarRef.current?.closest("[inert]") !== null) return;
      if (event.key === "Tab" && sidebarRef.current !== null) {
        const items = [
          ...sidebarRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
        ].filter((item) => {
          if (item.tabIndex < 0 || item.closest('[hidden], [inert], [aria-hidden="true"]') !== null)
            return false;
          for (let node: HTMLElement | null = item; node !== null; node = node.parentElement) {
            const style = window.getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden") return false;
            if (node === sidebarRef.current) break;
          }
          return true;
        });
        const first = items[0],
          last = items.at(-1),
          active = document.activeElement;
        if (first && last) {
          if (event.shiftKey && (active === first || !items.includes(active as HTMLElement))) {
            event.preventDefault();
            last.focus();
          } else if (
            !event.shiftKey &&
            (active === last || !items.includes(active as HTMLElement))
          ) {
            event.preventDefault();
            first.focus();
          }
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, desktop]);

  const select = (id: Id): void => {
    // Capture the visible menu trigger as the confirmation dialog's return focus.
    if (!desktop) closeDrawer();
    onSelect(id);
  };

  return (
    <>
      <a
        className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[110] focus:not-sr-only focus:rounded-control focus:bg-app-surface focus:px-4 focus:py-3 focus:text-sm focus:font-bold focus:text-app-text focus:shadow-lg"
        href="#admin-main-content"
      >
        본문으로 건너뛰기
      </a>
      <div
        className="admin-workspace"
        data-app-role="admin"
        data-app-shell="true"
        data-drawer-open={drawerOpen}
      >
        <aside
          aria-label="관리자 메뉴"
          role={drawerOpen && !desktop ? "dialog" : "complementary"}
          aria-modal={drawerOpen && !desktop ? true : undefined}
          className="admin-sidebar"
          id="admin-sidebar"
          inert={!desktop && !drawerOpen}
          ref={sidebarRef}
        >
          <div className="admin-sidebar-heading">
            <Link className="admin-sidebar-brand" to="/admin">
              <span className="admin-sidebar-brand-mark">
                <ShieldCheck aria-hidden="true" size={20} />
              </span>
              <span>
                우리반 허브 <span className="text-sm font-semibold text-app-muted">관리자</span>
              </span>
            </Link>
            {!desktop ? (
              <button
                type="button"
                className="admin-drawer-close"
                aria-label="관리자 메뉴 닫기"
                onClick={closeDrawer}
              >
                <X aria-hidden="true" size={20} />
              </button>
            ) : null}
          </div>
          <nav aria-label="관리자 기능" className="grid gap-4">
            <div aria-orientation="vertical" className="grid gap-4" role="tablist">
              {groups.map((group) => (
                <div className="admin-nav-group" key={group.label}>
                  <p className="admin-nav-group-label" aria-hidden="true">
                    {group.label}
                  </p>
                  {group.items.map(({ icon: Icon, id, label }) => (
                    <button
                      aria-controls="admin-console-panel"
                      aria-selected={activeId === id}
                      className="admin-nav-item"
                      key={id}
                      onClick={() => select(id)}
                      onFocus={() => setFocusedTabId(id)}
                      onKeyDown={moveTabFocus}
                      role="tab"
                      tabIndex={tabbableId === id ? 0 : -1}
                      type="button"
                    >
                      <Icon aria-hidden="true" size={18} /> {label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </nav>
          <div className="admin-sidebar-footer">
            <p>학생·선생님 계정과 분리된 관리자 전용 보안 영역입니다.</p>
          </div>
        </aside>
        <button
          aria-hidden="true"
          className="admin-drawer-backdrop"
          onClick={closeDrawer}
          tabIndex={-1}
          type="button"
        />

        <div
          className="admin-body"
          ref={bodyRef}
          inert={drawerOpen && !desktop}
          aria-hidden={drawerOpen && !desktop ? true : undefined}
        >
          <header className="admin-topbar">
            <button
              aria-controls="admin-sidebar"
              aria-expanded={drawerOpen}
              aria-label={drawerOpen ? "메뉴 닫기" : "메뉴 열기"}
              className="admin-topbar-button"
              onClick={() => {
                accountRef.current?.removeAttribute("open");
                setDrawerOpen((open) => !open);
              }}
              ref={menuButtonRef}
              type="button"
            >
              {drawerOpen ? (
                <X aria-hidden="true" size={20} />
              ) : (
                <Menu aria-hidden="true" size={20} />
              )}
            </button>
            <div className="admin-breadcrumb">
              {activeGroup === undefined ? null : (
                <span className="admin-breadcrumb-group">{activeGroup.label} ›</span>
              )}
              <h1>{activeItem?.label ?? "운영 콘솔"}</h1>
            </div>
            {onSearch === undefined ? null : (
              <form
                className="admin-topbar-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = query.trim();
                  if (value.length < 2) {
                    setSearchInvalid(true);
                    return;
                  }
                  setSearchInvalid(false);
                  onSearch(value);
                }}
                role="search"
              >
                <Search aria-hidden="true" className="shrink-0 text-app-muted" size={16} />
                <label className="sr-only" htmlFor={searchId}>
                  회원 검색
                </label>
                <input
                  id={searchId}
                  aria-describedby={`${searchId}-hint`}
                  aria-invalid={searchInvalid || undefined}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSearchInvalid(false);
                  }}
                  placeholder="이메일·이름 2자 이상 검색"
                  type="search"
                  value={query}
                />
                <span className="sr-only" id={`${searchId}-hint`}>
                  회원 이메일이나 이름을 앞뒤 공백을 제외하고 2자 이상 입력해 주세요.
                </span>
              </form>
            )}
            <details className="admin-account-menu" ref={accountRef}>
              <summary aria-label="관리자 계정 메뉴">
                <span aria-hidden="true" className="admin-account-initial">
                  {Array.from(session.account.display_name.trim())[0] ?? "관"}
                </span>
                <span className="admin-account-name text-sm font-bold">
                  {session.account.display_name}
                </span>
              </summary>
              <div className="admin-account-panel">
                <p className="text-sm font-extrabold">{session.account.display_name}</p>
                <div className="flex flex-wrap gap-1.5">
                  {session.account.roles.map((role) => (
                    <span
                      className="rounded-full border border-role-border bg-role-soft px-2.5 py-1 text-xs font-extrabold text-role-primary"
                      key={role}
                    >
                      {ROLE_LABELS[role]}
                    </span>
                  ))}
                </div>
                <Link
                  className="ui-button ui-button-secondary text-sm"
                  to="/admin/account"
                  onClick={
                    onAccount === undefined
                      ? undefined
                      : (event) => {
                          event.preventDefault();
                          onAccount();
                        }
                  }
                >
                  <ShieldCheck aria-hidden="true" size={17} /> 계정·보안
                </Link>
                <button
                  aria-busy={loggingOut}
                  className="ui-button ui-button-secondary text-sm"
                  disabled={loggingOut}
                  onClick={() => {
                    accountRef.current?.removeAttribute("open");
                    onLogout();
                  }}
                  type="button"
                >
                  {loggingOut ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
                  ) : (
                    <LogOut aria-hidden="true" size={17} />
                  )}{" "}
                  로그아웃
                </button>
              </div>
            </details>
          </header>
          {onSearch !== undefined && searchInvalid ? (
            <p className="mx-4 mt-3 text-sm font-semibold text-danger-text" role="alert">
              회원 이메일이나 이름을 2자 이상 입력해 주세요.
            </p>
          ) : null}
          <main
            className="admin-content app-main-content"
            data-app-role="admin"
            data-app-shell-layout="admin-workspace"
            id="admin-main-content"
            tabIndex={-1}
          >
            <AdminSessionStatus session={session} onSessionChange={onSessionChange} />
            <RequestCooldownNotice />
            <div className="mt-4 min-w-0" id="admin-console-panel" role="tabpanel">
              {children}
            </div>
            <SiteFooter />
          </main>
        </div>
      </div>
      <AdminStepUpDialog key={`${session.account.id}:${session.session.issued_at}`} />
    </>
  );
}
