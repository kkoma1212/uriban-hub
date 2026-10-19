import { ChevronLeft } from "lucide-react";
import {
  Children,
  isValidElement,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { Link } from "react-router";

import { AppFooter } from "./app-chrome";
import "./content-frame.css";

/**
 * 얇은 스크롤 막대의 실제 폭(기기·배율마다 다름: Windows 약 10px, 휴대폰 겹침 막대 0px)을 재어
 * `--content-frame-scrollbar`에 둔다. content-frame.css가 이 폭만큼 막대를 내용 끝선 바깥으로 비킨다.
 */
function measureFrameScrollbar(): void {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;scrollbar-width:thin";
  document.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  document.documentElement.style.setProperty("--content-frame-scrollbar", `${width}px`);
}

/**
 * 제목 영역 아래의 주 본문. AppShell `alignedFrame`에서는 남은 높이를 채우고 안에서 스크롤한다.
 * 기존 화면의 본문이 `<section>`이면 `as="section"`으로 감싸는 요소를 늘리지 않는다.
 */
export function ContentFrameBody({
  as: Element = "div",
  children,
  className = "",
  ...props
}: ComponentPropsWithoutRef<"div"> & { as?: "div" | "section" }): React.JSX.Element {
  useLayoutEffect(() => {
    measureFrameScrollbar();
    // 화면 배율을 바꾸면 막대의 CSS 폭도 바뀌고, 브라우저는 이때 resize를 보낸다.
    window.addEventListener("resize", measureFrameScrollbar);
    return () => window.removeEventListener("resize", measureFrameScrollbar);
  }, []);
  return (
    <Element {...props} className={`content-frame-body ${className}`} data-content-body="true">
      {children}
      {/* 휴대폰에서는 정보줄이 본문을 가리지 않게 본문 스크롤 끝에 둔다(PC는 AppShell의 정보줄). */}
      <div className="content-frame-body-footer">
        <AppFooter />
      </div>
    </Element>
  );
}

export function ContentFrameHeader({
  title,
  actions,
  children,
  className = "",
  ...props
}: Omit<ComponentPropsWithoutRef<"header">, "title"> & {
  title: ReactNode;
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <header
      {...props}
      className={`content-frame-header ${Children.toArray(children).length === 0 ? "content-frame-header-title-only" : ""} ${className}`}
    >
      <div className="content-frame-heading">
        <h1>{title}</h1>
        {actions ? <div className="content-frame-tools">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

export function ContentSplit({
  children,
  aside,
  asideLabel = "선택한 항목",
  asideOnMobile = false,
  className = "",
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  aside: ReactNode;
  asideLabel?: string;
  asideOnMobile?: boolean;
}): React.JSX.Element {
  const asideRef = useRef<HTMLElement>(null);
  const selectedKey = isValidElement(aside) ? aside.key : null;
  useLayoutEffect(() => {
    if (asideRef.current) asideRef.current.scrollTop = 0;
  }, [selectedKey]);
  return (
    <div {...props} className={`content-split ${className}`}>
      <div className="content-split-main">{children}</div>
      {aside === undefined || aside === null ? null : (
        <aside
          ref={asideRef}
          aria-label={asideLabel}
          className={`content-split-aside ${asideOnMobile ? "content-split-aside-mobile" : ""}`}
        >
          {aside}
        </aside>
      )}
    </div>
  );
}

export function ContentPanel({
  children,
  className = "",
  ...props
}: ComponentPropsWithoutRef<"section">): React.JSX.Element {
  return (
    <section {...props} className={`content-panel ${className}`}>
      {children}
    </section>
  );
}

export function ContentFilters({
  children,
  label = "목록 거르개",
  className = "",
  role = "group",
  "aria-label": ariaLabel,
  ...props
}: ComponentPropsWithRef<"div"> & { label?: string }): React.JSX.Element {
  return (
    <div className="content-filter-strip">
      <div
        {...props}
        aria-label={ariaLabel ?? label}
        className={`content-filters ${className}`}
        role={role}
      >
        {children}
      </div>
    </div>
  );
}

export function ContentActionBar({
  children,
  embedded = false,
  className = "",
  ...props
}: ComponentPropsWithoutRef<"div"> & { embedded?: boolean }): React.JSX.Element {
  return (
    <div
      {...props}
      className={`content-action-bar ${embedded ? "content-action-bar-embedded" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

export function ContentBackbar({
  to,
  label,
  actions,
  className = "",
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  to: string;
  label: string;
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <div {...props} className={`content-backbar ${className}`}>
      <Link className="content-back-link" to={to}>
        <ChevronLeft aria-hidden="true" size={20} />
        {label}
      </Link>
      {actions ? <div className="content-frame-tools">{actions}</div> : null}
    </div>
  );
}
