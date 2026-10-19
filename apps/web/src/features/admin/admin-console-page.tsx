import {
  Activity,
  BookOpenText,
  ChartColumn,
  FileKey2,
  GraduationCap,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Mail,
  MessageSquareText,
  RefreshCw,
  School,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  UserRoundCog,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import {
  Link,
  useNavigate,
  useSearchParams,
  useBlocker,
  UNSAFE_DataRouterContext,
} from "react-router";

import {
  ADMIN_SESSION_EXPIRED_EVENT,
  getAdminSession,
  logoutAdmin,
  type AdminRole,
  type AdminSessionResponse,
} from "../../api/admin-auth";
import { ApiRequestError } from "../../api/auth";
import { PageHeader } from "../layout/page-header";
import { AdminShell } from "./admin-shell";
import { AdminWorkspace } from "./admin-workspace";
import { AccountsPanel, ApprovalPanel } from "./admin-console-account-panels";
import { AuditPanel } from "./admin-console-audit-panel";
import { ClassActivityPanel } from "./admin-console-activity-panel";
import { ClassesPanel } from "./admin-console-classes-panel";
import { ConfirmDialog } from "../layout/confirm-dialog";
import { InquiriesPanel, type InquiryWorkState } from "./admin-console-inquiries-panel";
import { MembersPanel } from "./admin-console-members-panel";
import { PeoplePanel } from "./admin-console-people-panel";
import { OperationsPanel } from "./admin-console-operations-panel";
import { SessionsPanel } from "./admin-console-sessions-panel";
import { OverviewPanel } from "./admin-console-overview-panel";
import { adminErrorMessage } from "./admin-console-shared";
import { SystemPanel } from "./admin-console-system-panel";
import { RequestLimitsPanel } from "./admin-console-request-limits-panel";
import { MailPanel } from "./admin-console-mail-panel";
import { TermsPanel } from "./admin-console-terms-panel";

type ConsoleTab =
  | "accounts"
  | "approvals"
  | "audit"
  | "classes"
  | "class_activity"
  | "inquiries"
  | "members"
  | "system"
  | "terms"
  | "request_limits"
  | "operations"
  | "sessions"
  | "mail"
  | "overview"
  | "people";
// The mail tab exposes recoverable verification codes only to the highest administrator.

const TABS: ReadonlyArray<{
  icon: LucideIcon;
  id: ConsoleTab;
  label: string;
  roles: readonly AdminRole[];
}> = [
  {
    icon: LayoutDashboard,
    id: "overview",
    label: "한눈에 보기",
    roles: ["super_admin", "account_manager", "support", "security_auditor"],
  },
  {
    icon: School,
    id: "classes",
    label: "학교·반 목록",
    roles: ["super_admin", "account_manager", "support"],
  },
  {
    icon: GraduationCap,
    id: "people",
    label: "선생님·학생 목록",
    roles: ["super_admin", "account_manager", "support"],
  },
  {
    icon: ChartColumn,
    id: "class_activity",
    label: "반 활동 현황",
    roles: ["super_admin", "account_manager", "support"],
  },
  { icon: FileKey2, id: "approvals", label: "승인번호", roles: ["super_admin", "account_manager"] },
  { icon: Mail, id: "mail", label: "메일 관리", roles: ["super_admin"] },
  { icon: UserRoundCog, id: "accounts", label: "관리자 계정", roles: ["super_admin"] },
  {
    icon: UsersRound,
    id: "members",
    label: "계정 관리",
    roles: ["super_admin", "account_manager", "support"],
  },
  {
    icon: MessageSquareText,
    id: "inquiries",
    label: "문의",
    roles: ["super_admin", "support"],
  },
  {
    icon: ShieldAlert,
    id: "audit",
    label: "감사·보안",
    roles: ["super_admin", "security_auditor"],
  },
  {
    icon: BookOpenText,
    id: "terms",
    label: "약관",
    roles: ["super_admin", "security_auditor"],
  },
  {
    icon: Activity,
    id: "system",
    label: "시스템 상태",
    roles: ["super_admin", "security_auditor"],
  },
  {
    icon: KeyRound,
    id: "sessions",
    label: "로그인 세션",
    roles: ["super_admin", "security_auditor"],
  },
  {
    icon: ServerCog,
    id: "operations",
    label: "운영 상태",
    roles: ["super_admin", "security_auditor"],
  },
  {
    icon: ShieldCheck,
    id: "request_limits",
    label: "요청 제한",
    roles: ["super_admin", "security_auditor"],
  },
];
// 왼쪽 메뉴 묶음(2026-09-30, LEXI 관리자처럼 기능 성격별). 권한 밖 항목·빈 묶음은 보이지 않는다.
const MENU_GROUPS: ReadonlyArray<{ label: string; ids: readonly ConsoleTab[] }> = [
  { label: "운영", ids: ["overview", "classes", "people", "class_activity"] },
  { label: "가입·계정", ids: ["approvals", "members", "accounts", "mail"] },
  { label: "소통", ids: ["inquiries"] },
  { label: "보안·시스템", ids: ["audit", "sessions", "system", "operations", "request_limits"] },
  { label: "정책", ids: ["terms"] },
];
function InquiryRouteGuard({
  shouldBlock,
  requestLeave,
}: {
  shouldBlock: () => boolean;
  requestLeave: (action: () => void, cancel?: () => void) => void;
}): null {
  const blocker = useBlocker(shouldBlock);
  useEffect(() => {
    if (blocker.state === "blocked")
      requestLeave(
        () => blocker.proceed(),
        () => blocker.reset(),
      );
  }, [blocker, requestLeave]);
  return null;
}
export function AdminConsolePage(): React.JSX.Element {
  const navigate = useNavigate();
  const [session, setSession] = useState<AdminSessionResponse>();
  const [search, setSearch] = useSearchParams();
  const [memberSearch, setMemberSearch] = useState<string>();
  // ?tab=문의 같은 바로가기 주소로 특정 탭을 연다. 없거나 권한 밖이면 첫 탭(한눈에 보기).
  const [tab, setTab] = useState<ConsoleTab | undefined>(
    () => (search.get("tab") as ConsoleTab | null) ?? undefined,
  );
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string>();
  const logoutButtonRef = useRef<HTMLButtonElement>(null);
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const [hasWork, setHasWork] = useState(false);
  const work = useRef<InquiryWorkState>({ dirtyIds: [], pendingIds: [] });
  const forcedExit = useRef(false);
  const allowedNavigation = useRef(false);
  const [leave, setLeave] = useState<{
    action: () => void;
    cancel?: () => void;
    focus: HTMLElement | null;
  }>();
  const reportWork = useCallback((state: InquiryWorkState) => {
    work.current = state;
    setHasWork(state.dirtyIds.length > 0 || state.pendingIds.length > 0);
  }, []);
  const requestLeave = useCallback((action: () => void, cancel?: () => void) => {
    if (forcedExit.current) {
      action();
      return;
    }
    if (work.current.pendingIds.length > 0) {
      cancel?.();
      setError("문의 내용을 저장 중입니다. 저장이 끝난 뒤 다시 이동해 주세요.");
      return;
    }
    if (work.current.dirtyIds.length > 0) {
      setLeave({
        action,
        ...(cancel === undefined ? {} : { cancel }),
        focus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      });
      return;
    }
    action();
  }, []);
  const shouldBlock = useCallback(() => {
    if (forcedExit.current) return false;
    if (allowedNavigation.current) {
      allowedNavigation.current = false;
      return false;
    }
    return work.current.dirtyIds.length > 0 || work.current.pendingIds.length > 0;
  }, []);
  useEffect(() => {
    const expired = () => {
      forcedExit.current = true;
      work.current = { dirtyIds: [], pendingIds: [] };
      setLeave(undefined);
      setHasWork(false);
    };
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, expired);
  }, []);
  useEffect(() => {
    if (!hasWork) return;
    const unload = (event: BeforeUnloadEvent) => {
      if (
        !forcedExit.current &&
        (work.current.dirtyIds.length > 0 || work.current.pendingIds.length > 0)
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("beforeunload", unload);
    };
  }, [hasWork]);
  const confirmedNavigate = useCallback((action: () => void) => {
    allowedNavigation.current = true;
    action();
    allowedNavigation.current = false;
  }, []);

  const loadSession = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setSession(await getAdminSession());
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        forcedExit.current = true;
        void navigate("/admin/login", { replace: true });
        return;
      }
      setError(adminErrorMessage(requestError, "관리자 콘솔을 열지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    setTab((search.get("tab") as ConsoleTab | null) ?? undefined);
  }, [search]);

  const availableTabs = useMemo(
    () =>
      TABS.filter(
        (item) => session?.account.roles.some((role) => item.roles.includes(role)) === true,
      ),
    [session],
  );
  const activeTab = availableTabs.some((item) => item.id === tab) ? tab : availableTabs[0]?.id;
  const canManageAccounts =
    session?.account.roles.some((role) => role === "super_admin" || role === "account_manager") ===
    true;
  const superAdmin = session?.account.roles.includes("super_admin") === true;
  const menuGroups = MENU_GROUPS.map((group) => ({
    label: group.label,
    items: group.ids.flatMap((id) => availableTabs.filter((item) => item.id === id)),
  })).filter((group) => group.items.length > 0);

  // 메뉴를 바꾸면 주소(?tab=)도 바꿔 새로고침·뒤로 가기·바로가기가 같은 화면을 연다.
  const openTab = useCallback(
    (id: ConsoleTab): void => {
      if (id === activeTab) return;
      requestLeave(() => {
        confirmedNavigate(() => setSearch({ tab: id }, { replace: true }));
        setTab(id);
      });
    },
    [setSearch, activeTab, requestLeave, confirmedNavigate],
  );

  async function logout(): Promise<void> {
    if (loggingOut) return;
    setLoggingOut(true);
    setError(undefined);
    try {
      await logoutAdmin();
      confirmedNavigate(() => void navigate("/admin/login", { replace: true }));
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "로그아웃하지 못했습니다."));
    } finally {
      setLoggingOut(false);
    }
  }

  let panel: React.ReactNode = null;
  if (activeTab === "overview")
    panel = (
      <OverviewPanel
        canOpen={(target) => availableTabs.some((item) => item.id === target)}
        onOpen={openTab}
      />
    );
  if (activeTab === "approvals") panel = <ApprovalPanel />;
  if (activeTab === "classes") panel = <ClassesPanel />;
  if (activeTab === "people") panel = <PeoplePanel />;
  if (activeTab === "class_activity") panel = <ClassActivityPanel />;
  if (activeTab === "operations") panel = <OperationsPanel />;
  if (activeTab === "sessions")
    panel = <SessionsPanel canRevoke={session?.account.roles.includes("super_admin") === true} />;
  if (activeTab === "accounts" && session !== undefined) {
    panel = <AccountsPanel currentAccountId={session.account.id} />;
  }
  if (activeTab === "members") {
    panel = (
      <MembersPanel
        canViewMemberships={canManageAccounts}
        canWrite={canManageAccounts}
        initialSearch={memberSearch}
        key={memberSearch ?? ""}
      />
    );
  }
  if (activeTab === "inquiries")
    panel = <InquiriesPanel key={session?.account.id} onWorkState={reportWork} />;
  if (activeTab === "audit") panel = <AuditPanel />;
  if (activeTab === "terms") panel = <TermsPanel canWrite={superAdmin} />;
  if (activeTab === "system") panel = <SystemPanel canWrite={superAdmin} />;
  if (activeTab === "request_limits") panel = <RequestLimitsPanel canWrite={superAdmin} />;
  if (activeTab === "mail") panel = <MailPanel />;

  if (session !== undefined)
    return (
      <>
        {dataRouter === null ? null : (
          <InquiryRouteGuard shouldBlock={shouldBlock} requestLeave={requestLeave} />
        )}
        <ConfirmDialog
          open={leave !== undefined}
          title="작성 중인 문의를 두고 이동할까요?"
          description="저장하지 않은 문의 처리 내용은 사라집니다."
          cancelLabel="계속 작성"
          confirmLabel="저장하지 않고 이동"
          returnFocusTo={leave?.focus ?? null}
          onCancel={() => {
            leave?.cancel?.();
            setLeave(undefined);
          }}
          onConfirm={() => {
            if (work.current.pendingIds.length > 0) {
              leave?.cancel?.();
              setLeave(undefined);
              setError("문의 내용을 저장 중입니다. 저장이 끝난 뒤 다시 이동해 주세요.");
              return;
            }
            const action = leave?.action;
            setLeave(undefined);
            action?.();
          }}
        />
        <AdminWorkspace
          activeId={activeTab}
          groups={menuGroups}
          loggingOut={loggingOut}
          onLogout={() => requestLeave(() => void logout())}
          onAccount={() =>
            requestLeave(() => confirmedNavigate(() => void navigate("/admin/account")))
          }
          onSearch={
            availableTabs.some((item) => item.id === "members")
              ? (query) => {
                  requestLeave(() => {
                    confirmedNavigate(() => setSearch({ tab: "members" }, { replace: true }));
                    setMemberSearch(query);
                    setTab("members");
                  });
                }
              : undefined
          }
          onSelect={openTab}
          onSessionChange={setSession}
          session={session}
        >
          {error === undefined ? null : (
            <div
              className="mb-4 rounded-2xl border border-danger-border bg-danger-surface px-4 py-3 text-sm font-semibold text-danger-text"
              role="alert"
            >
              {error}
            </div>
          )}
          {panel ?? (
            <section className="ui-panel text-sm text-app-muted">
              이 계정에 배정된 운영 권한이 없습니다.
            </section>
          )}
        </AdminWorkspace>
      </>
    );

  return (
    <AdminShell
      homeHref="/admin"
      surface={false}
      wide
      session={session}
      onSessionChange={setSession}
    >
      <section className="ui-panel">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <PageHeader
            description="가입 승인부터 계정·문의·보안·약관·서비스 상태까지 역할별 운영 작업을 관리합니다."
            eyebrow="관리자 전용"
            title="운영 콘솔"
          />
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link className="ui-button ui-button-secondary text-sm" to="/admin/account">
              <ShieldCheck aria-hidden="true" size={17} /> 계정·보안
            </Link>
            <button
              aria-busy={loggingOut}
              className="ui-button ui-button-secondary text-sm"
              disabled={loggingOut}
              onClick={() => void logout()}
              ref={logoutButtonRef}
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
        </div>
        {error === undefined ? null : (
          <div
            className="mt-5 rounded-2xl border border-danger-border bg-danger-surface px-4 py-3 text-sm font-semibold text-danger-text"
            role="alert"
          >
            <p>{error}</p>
            {!loading ? (
              <button
                className="ui-button ui-button-secondary mt-3 text-sm"
                onClick={() => void loadSession()}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={17} /> 다시 시도
              </button>
            ) : null}
          </div>
        )}
      </section>

      <section className="ui-panel mt-4">
        <p
          className="flex min-h-44 items-center justify-center gap-2 text-sm font-bold text-app-muted"
          role="status"
        >
          {loading ? (
            <>
              <LoaderCircle aria-hidden="true" className="animate-spin" size={19} /> 관리자 권한을
              확인하고 있어요.
            </>
          ) : (
            "관리자 콘솔을 표시할 수 없습니다."
          )}
        </p>
      </section>
    </AdminShell>
  );
}
