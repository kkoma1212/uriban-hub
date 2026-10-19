import { MapPinOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";

export function NotFoundPage(): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <main
      className="grid min-h-dvh place-items-center bg-app-canvas px-5 py-10 text-app-text"
      data-not-found-page
    >
      <section className="w-full max-w-lg rounded-[1.75rem] border border-app-border bg-app-surface-raised p-6 shadow-card sm:p-8">
        <div
          aria-hidden="true"
          className="grid size-12 place-items-center rounded-2xl bg-role-soft text-role-primary"
        >
          <MapPinOff size={23} />
        </div>
        <p className="mt-5 text-sm font-extrabold text-role-primary">404 · 주소 확인</p>
        <h1
          className="mt-2 break-keep text-2xl font-black tracking-tight text-app-text focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-role-primary"
          ref={headingRef}
          tabIndex={-1}
        >
          페이지를 찾을 수 없어요.
        </h1>
        <p className="mt-3 break-keep leading-7 text-app-muted">
          입력한 주소가 잘못됐거나 페이지가 이동됐을 수 있어요. 주소를 확인하거나 안전한 화면으로
          돌아가 주세요.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Link className="ui-button ui-button-primary w-full" to="/home">
            홈으로 이동
          </Link>
          <Link className="ui-button ui-button-secondary w-full" to="/login">
            로그인 화면으로 이동
          </Link>
        </div>
      </section>
    </main>
  );
}
