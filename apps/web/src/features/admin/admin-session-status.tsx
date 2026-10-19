import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ADMIN_SESSION_EXPIRED_EVENT,
  getAdminSession,
  renewAdminSession,
  type AdminSessionResponse,
} from "../../api/admin-auth";
import { ApiRequestError } from "../../api/auth";
import { adminSessionDeadline, installAdminSessionPrivacy } from "../../lib/admin-session-privacy";
import type { SessionPrivacyState } from "../../lib/authenticated-session-privacy";
import { SessionPrivacyPanel } from "../layout/session-privacy-boundary";
import "./admin-workspace.css";

export function AdminSessionStatus({
  session,
  onSessionChange,
}: {
  session: AdminSessionResponse;
  onSessionChange: (session: AdminSessionResponse | undefined) => void;
}): React.JSX.Element {
  const [privacy, setPrivacy] = useState<SessionPrivacyState>("visible");
  const privacyRef = useRef<ReturnType<typeof installAdminSessionPrivacy> | undefined>(undefined);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const deadline = useMemo(() => adminSessionDeadline(session), [session]);
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((deadline - performance.now()) / 1000)),
  );

  useLayoutEffect(() => {
    const guard = installAdminSessionPrivacy({
      session,
      check: getAdminSession,
      onVerified: onSessionChange,
      onEnded: () => onSessionChange(undefined),
      onState: setPrivacy,
    });
    privacyRef.current = guard;
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
      setRemaining(Number.isFinite(seconds) ? seconds : 0);
    };
    const interval = window.setInterval(tick, 1000);
    const initial = window.setTimeout(tick, 0);
    return () => {
      guard.dispose();
      if (privacyRef.current === guard) privacyRef.current = undefined;
      window.clearInterval(interval);
      window.clearTimeout(initial);
    };
  }, [deadline, onSessionChange, session]);

  async function renew() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      onSessionChange(await renewAdminSession());
    } catch (failure) {
      if (failure instanceof ApiRequestError && failure.code === "ADMIN_SESSION_REQUIRED") {
        window.dispatchEvent(new Event(ADMIN_SESSION_EXPIRED_EVENT));
      } else setError("로그인 시간을 연장하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }
  const stable = remaining > 5 * 60 && error === undefined && !busy && privacy === "visible";
  const showExplanation = remaining <= 5 * 60 || error !== undefined;
  return (
    <>
      <SessionPrivacyPanel state={privacy} onRetry={() => privacyRef.current?.retry()} />
      <aside
        className="admin-session"
        data-stable={stable}
        data-explain={showExplanation}
        aria-label="관리자 로그인 유효 시간"
      >
        <div>
          <div>
            <p>로그인·2단계 인증 완료</p>
            <p>
              남은 시간 {Math.floor(remaining / 60)}분 {remaining % 60}초
            </p>
            <p>
              {new Date(session.session.absolute_expires_at).toLocaleString("ko-KR")}까지
              유효합니다.
            </p>
          </div>
          <button
            className="ui-button ui-button-secondary"
            type="button"
            disabled={busy || remaining === 0}
            aria-busy={busy}
            onClick={() => void renew()}
          >
            {busy ? "연장 중…" : "30분 연장"}
          </button>
        </div>
        {remaining > 0 && remaining <= 5 * 60 ? (
          <p role="status">만료가 가까워요. 작업을 계속하려면 시간을 연장해 주세요.</p>
        ) : null}
        {/* 안정 상태는 모바일 설명을 줄이고 만료 임박·오류에는 원래 설명을 보여 줍니다. */}
        <p className="admin-session-explanation">
          만료 전에 누르면 추가 인증 없이 지금부터 30분 연장됩니다(로그인 후 최대 12시간). 연장하지
          않으면 로그아웃되며 비밀번호와 등록한 2차 인증 수단으로 다시 로그인해야 합니다.
        </p>
        {error === undefined ? null : <p role="alert">{error}</p>}
      </aside>
    </>
  );
}
