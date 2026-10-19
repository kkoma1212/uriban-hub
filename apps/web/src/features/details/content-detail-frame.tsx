import { ArrowLeft, MessageCircle, MoreHorizontal, X } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router";
import { AppFooter } from "../layout/app-chrome";
import { AppShell } from "../layout/app-shell";
import { ContentActionBar, ContentSplit } from "../layout/content-frame";
import { StudentHelpRequest } from "../help-requests/student-help-request";
import type { HelpRequestTargetKind } from "../../api/help-requests";

export interface EmbeddedDetailProps {
  embeddedId?: string | undefined;
  onClose?: (() => void) | undefined;
}
const EmbeddedDetailContext = createContext(false);

export function ContentDetailFrame({
  embedded = false,
  navigationRole,
  backTo,
  backLabel,
  onBack,
  tools,
  children,
  aside,
  hasActionBar = false,
}: {
  embedded?: boolean;
  navigationRole?: "teacher" | "student";
  backTo: string;
  backLabel: string;
  onBack?: () => void;
  tools?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
  hasActionBar?: boolean;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const content = (
    <EmbeddedDetailContext.Provider value={embedded}>
      <div
        className={embedded ? "flex min-h-full flex-col" : hasActionBar ? "pb-36 xl:pb-0" : ""}
        data-content-detail={embedded ? "embedded" : "page"}
      >
        <div
          className="relative mb-3 flex min-w-0 shrink-0 items-start justify-between gap-2"
          data-detail-backbar
        >
          {onBack ? (
            <button
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl px-2 text-sm font-bold text-app-text"
              onClick={onBack}
              type="button"
            >
              <ArrowLeft aria-hidden="true" size={20} />
              {embedded ? "닫기" : backLabel}
            </button>
          ) : (
            <Link
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl px-2 text-sm font-bold text-app-text"
              to={backTo}
            >
              <ArrowLeft aria-hidden="true" size={20} />
              {backLabel}
            </Link>
          )}
          {tools ? (
            <div
              className="min-w-0"
              data-detail-tools
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setMenuOpen(false);
                  menuTriggerRef.current?.focus();
                }
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false);
              }}
            >
              <button
                ref={menuTriggerRef}
                aria-controls={menuId}
                aria-expanded={menuOpen}
                aria-label="글 더보기"
                className={
                  embedded
                    ? "ui-icon-button ui-button-secondary"
                    : "ui-icon-button ui-button-secondary lg:hidden"
                }
                onClick={() => setMenuOpen(!menuOpen)}
                type="button"
              >
                {menuOpen ? (
                  <X aria-hidden="true" size={20} />
                ) : (
                  <MoreHorizontal aria-hidden="true" size={20} />
                )}
              </button>
              <div
                id={menuId}
                data-detail-menu
                className={
                  menuOpen
                    ? "absolute right-0 top-12 z-20 flex max-w-[calc(100vw-3rem)] flex-col gap-1 rounded-2xl border border-app-border bg-app-surface p-2 shadow-card"
                    : embedded
                      ? "hidden"
                      : "hidden flex-wrap justify-end gap-2 lg:flex"
                }
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("button")) setMenuOpen(false);
                }}
              >
                {tools}
              </div>
            </div>
          ) : null}
        </div>
        {aside ? (
          embedded ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              <div className="min-w-0">{children}</div>
              <div className="min-w-0 flex-1">{aside}</div>
            </div>
          ) : (
            <ContentSplit asideOnMobile aside={aside} asideLabel="글 현황과 행동">
              <div className="h-full min-w-0">{children}</div>
            </ContentSplit>
          )
        ) : (
          children
        )}
        {/* 정렬 틀에서 휴대폰은 약관 정보줄을 본문 끝에 둔다(목록 탭의 ContentFrameBody와 같은 규칙). */}
        {embedded ? null : (
          <div className="content-frame-body-footer">
            <AppFooter />
          </div>
        )}
      </div>
    </EmbeddedDetailContext.Provider>
  );
  if (embedded) return content;
  return (
    <AppShell
      {...(navigationRole === undefined ? {} : { navigationRole })}
      // 목록 탭과 같은 정렬 틀(2026-09-30 사용자 지적: 상세만 시작선이 6px 안쪽, 오른쪽 끝이 8px 짧았다).
      alignedFrame
      contentFrame
      width="wide"
      hideMobileNavigation={hasActionBar}
    >
      {content}
    </AppShell>
  );
}

export function DetailHeading({
  title,
  kind,
  meta,
  changed = false,
  children,
}: {
  title: string;
  kind: ReactNode;
  meta?: ReactNode;
  changed?: boolean;
  children?: ReactNode;
}): React.JSX.Element {
  const embedded = useContext(EmbeddedDetailContext);
  const Heading = embedded ? "h2" : "h1";
  return (
    <header data-detail-heading>
      <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-app-muted">
        <span className="rounded-lg bg-app-surface-muted px-2 py-1">{kind}</span>
        {children}
      </div>
      <Heading
        className={
          embedded
            ? "mt-2.5 break-words text-[1.375rem] font-extrabold leading-[1.35] tracking-[-0.03em] text-app-text"
            : "mt-2.5 break-words text-[1.375rem] font-extrabold leading-[1.35] tracking-[-0.03em] text-app-text lg:text-[1.625rem]"
        }
      >
        {title}
      </Heading>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-app-muted">
        <strong className="font-bold text-app-text">선생님</strong>
        {meta}
      </div>
      {changed ? (
        <p
          className="mt-4 rounded-xl bg-[var(--color-chalk-yellow)]/20 px-3 py-2.5 text-sm font-semibold leading-6 text-app-text"
          data-detail-changed
        >
          선생님이 글을 고쳤어요
        </p>
      ) : null}
    </header>
  );
}

export function DetailActionBar({ children }: { children: ReactNode }): React.JSX.Element {
  const embedded = useContext(EmbeddedDetailContext);
  return embedded ? (
    <div
      className="mt-auto flex flex-wrap gap-2 border-t border-app-border pt-4"
      data-detail-action-bar
    >
      {children}
    </div>
  ) : (
    <div className="mt-auto pt-4" data-detail-action-bar>
      <ContentActionBar>{children}</ContentActionBar>
    </div>
  );
}

export function StudentDetailActions({
  target,
  children,
  hint,
}: {
  target: { id: string; kind: HelpRequestTargetKind };
  children: ReactNode;
  hint: string;
}): React.JSX.Element {
  const [showHelp, setShowHelp] = useState(false);
  const helpId = useId();
  useEffect(() => {
    if (!showHelp) return;
    const panel = document.getElementById(helpId);
    panel?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    panel?.focus({ preventScroll: true });
  }, [helpId, showHelp]);
  return (
    <section
      className="flex h-full min-w-0 flex-col"
      aria-label="내 확인과 질문"
      data-student-detail-actions
    >
      {showHelp ? (
        <div id={helpId} tabIndex={-1}>
          <StudentHelpRequest target={target} />
        </div>
      ) : null}
      <DetailActionBar>
        <div className="min-w-0 flex-1">
          <p className="mb-2 break-keep text-sm leading-6 text-app-muted">{hint}</p>
          <div className="flex items-stretch gap-2">
            <button
              aria-controls={helpId}
              aria-expanded={showHelp}
              className="ui-button ui-button-secondary shrink-0 px-3 text-sm"
              onClick={() => setShowHelp(!showHelp)}
              type="button"
            >
              <MessageCircle aria-hidden="true" size={18} />
              질문
            </button>
            <div className="min-w-0 flex-1">{children}</div>
          </div>
        </div>
      </DetailActionBar>
    </section>
  );
}

export function ConfirmationProgress({
  confirmed,
  changed = 0,
  remaining,
  label = "확인 현황",
}: {
  confirmed: number;
  changed?: number;
  remaining: number;
  label?: string;
}): React.JSX.Element {
  const total = confirmed + changed + remaining;
  return (
    <div
      aria-label={
        label +
        ": 확인 " +
        confirmed +
        "명, 고친 뒤 안 봄 " +
        changed +
        "명, 아직 안 봄 " +
        remaining +
        "명"
      }
      className="mt-3 flex h-2 overflow-hidden rounded-full bg-app-border"
      role="img"
      data-confirmation-progress
    >
      <span
        className="h-full bg-[#2b6149]"
        style={{ width: total ? (confirmed / total) * 100 + "%" : "0%" }}
      />
      <span
        className="h-full bg-[#f5c842]"
        style={{ width: total ? (changed / total) * 100 + "%" : "0%" }}
      />
    </div>
  );
}

export function ConfirmationDot({ state }: { state: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={
        "size-2.5 shrink-0 rounded-full " +
        (state === "modified_unconfirmed"
          ? "bg-[#f5c842]"
          : state === "confirmed" || state === "checked"
            ? "bg-[#2b6149]"
            : "bg-[#cfd4cf]")
      }
    />
  );
}

export function focusDetailTool(button: HTMLButtonElement | null): void {
  if (!button) return;
  const menu = button.closest("[data-detail-menu]");
  if (menu instanceof HTMLElement && getComputedStyle(menu).display === "none") {
    const trigger = menu
      .closest("[data-detail-tools]")
      ?.querySelector<HTMLButtonElement>("button[aria-controls]");
    trigger?.focus();
    return;
  }
  button.focus();
}
