interface PageHeaderProps extends Omit<
  React.ComponentPropsWithoutRef<"header">,
  "children" | "title"
> {
  actions?: React.ReactNode;
  description: React.ReactNode;
  eyebrow: React.ReactNode;
  title: React.ReactNode;
}

/**
 * 확정 PoC의 page-header 계약을 제품 화면에서 공유한다.
 *
 * 페이지 제목은 별도 색상 hero 카드가 아니라 본문의 첫 정보 블록이다. 색은 작은 eyebrow와
 * 실제 동작에만 쓰고, 모바일 첫 화면을 제목 카드 하나로 소비하지 않는다.
 */
export function PageHeader({
  actions,
  className = "",
  description,
  eyebrow,
  title,
  ...headerProps
}: PageHeaderProps): React.JSX.Element {
  return (
    <header {...headerProps} className={`app-page-header ${className}`} data-page-header="compact">
      <div className="app-page-header-copy">
        <p className="app-page-eyebrow">{eyebrow}</p>
        <h1 className="app-page-title">{title}</h1>
        <p className="app-page-description">{description}</p>
      </div>
      {actions === undefined ? null : <div className="app-page-actions">{actions}</div>}
    </header>
  );
}
