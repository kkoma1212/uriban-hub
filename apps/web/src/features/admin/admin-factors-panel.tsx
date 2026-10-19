import { useEffect, useRef, useState } from "react";
import { ADMIN_SESSION_EXPIRED_EVENT } from "../../api/admin-auth";
import {
  getAdminFactors,
  issueAdminRecoveryCodes,
  registerAdminPasskey,
  revokeAdminPasskey,
  type AdminFactors,
} from "../../api/admin-passkeys";

export function AdminFactorsPanel(): React.JSX.Element | null {
  const [factors, setFactors] = useState<AdminFactors>();
  const [label, setLabel] = useState("내 컴퓨터");
  const [codes, setCodes] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // 못 불러오면 영역이 오류 없이 통째로 사라졌다 — 알리고 다시 시도하게 한다(총검수 C3-11).
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    setLoadFailed(false);
    void getAdminFactors(controller.signal)
      .then((result) => {
        if (active.current) setFactors(result);
      })
      .catch(() => {
        if (active.current && !controller.signal.aborted) setLoadFailed(true);
      });
    const clear = () => {
      active.current = false;
      setCodes(undefined);
      setFactors(undefined);
    };
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, clear);
    return () => {
      active.current = false;
      controller.abort();
      window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, clear);
    };
  }, [attempt]);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setCodes(undefined);
    try {
      await action();
      const next = await getAdminFactors();
      if (active.current) setFactors(next);
    } catch (failure) {
      if (active.current)
        setError(failure instanceof Error ? failure.message : "보안 설정을 변경하지 못했습니다.");
    } finally {
      if (active.current) setBusy(false);
    }
  }
  if (loadFailed)
    return (
      <section
        className="mt-6 border-t border-app-border pt-6"
        aria-labelledby="admin-factors-title"
      >
        <h2 className="font-extrabold" id="admin-factors-title">
          패스키와 복구 코드
        </h2>
        <p className="mt-2 text-sm font-semibold text-danger-text" role="alert">
          보안 수단 정보를 불러오지 못했습니다.
        </p>
        <button
          className="ui-button ui-button-secondary mt-3 text-sm"
          onClick={() => setAttempt((current) => current + 1)}
          type="button"
        >
          다시 시도
        </button>
      </section>
    );
  if (!factors?.enabled) return null;
  return (
    <section
      className="mt-6 space-y-4 border-t border-app-border pt-6"
      aria-labelledby="admin-factors-title"
    >
      <h2 className="font-extrabold" id="admin-factors-title">
        패스키와 복구 코드
      </h2>
      <p className="text-sm leading-6 text-app-muted">
        Windows Hello PIN·지문 등 이 기기의 잠금 해제로 2차 인증합니다. PIN과 생체 정보는 서버에
        저장하지 않습니다.
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void perform(() => registerAdminPasskey(label));
        }}
      >
        <label className="auth-label" htmlFor="admin-passkey-label">
          기기 이름
        </label>
        <input
          id="admin-passkey-label"
          className="auth-input"
          maxLength={60}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          disabled={busy}
        />
        <button
          className="ui-button ui-button-primary"
          disabled={busy || !label.trim() || factors.passkeys.length >= 10}
          type="submit"
        >
          이 기기에 패스키 등록
        </button>
      </form>
      <ul className="space-y-3">
        {factors.passkeys.map((passkey) => (
          <li
            key={passkey.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-app-border p-3"
          >
            <span className="break-all font-bold">{passkey.label}</span>
            <button
              type="button"
              className="ui-button ui-button-secondary"
              disabled={busy || (!factors.totp_enabled && factors.passkeys.length === 1)}
              onClick={() => void perform(() => revokeAdminPasskey(passkey.id))}
              aria-label={`${passkey.label} 패스키 삭제`}
            >
              삭제
            </button>
          </li>
        ))}
      </ul>
      <p className="text-sm text-app-muted">
        남은 1회용 복구 코드: {factors.recovery_codes_remaining}개. 재발급하면 이전 코드는 모두
        사용할 수 없습니다.
      </p>
      <button
        type="button"
        className="ui-button ui-button-secondary"
        disabled={busy}
        onClick={() =>
          void perform(async () => {
            const result = await issueAdminRecoveryCodes();
            if (active.current) setCodes(result.codes);
          })
        }
      >
        복구 코드 10개 발급·재발급
      </button>
      {codes && (
        <div className="space-y-3 rounded-xl border border-role-border bg-role-soft p-4">
          <p className="font-bold">
            이 화면을 닫으면 다시 볼 수 없습니다. 안전한 곳에 보관해 주세요.
          </p>
          <ol className="space-y-2">
            {codes.map((code) => (
              <li key={code}>
                <code className="break-all text-sm">{code}</code>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="ui-button ui-button-secondary"
            onClick={() => {
              void navigator.clipboard
                .writeText(codes.join("\n"))
                .catch(() => setError("코드를 직접 선택해 복사해 주세요."));
            }}
          >
            코드 복사
          </button>
          <button
            type="button"
            className="ui-button ui-button-secondary"
            onClick={() => setCodes(undefined)}
          >
            보관 완료·닫기
          </button>
        </div>
      )}
      <p className="text-xs leading-5 text-app-muted">
        등록·삭제·재발급에는 인증 앱 또는 기존 패스키로 보안 확인이 필요합니다. 복구 코드만으로 인증
        수단을 바꿀 수 없습니다.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      )}
    </section>
  );
}
