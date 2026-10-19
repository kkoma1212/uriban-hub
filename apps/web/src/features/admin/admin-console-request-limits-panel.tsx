import { TimerReset } from "lucide-react";
import { useEffect, useState } from "react";
import { getAdminSystemState, updateAdminSystemState } from "../../api/admin-management";
import {
  ActionError,
  adminErrorMessage,
  InlineNotice,
  LoadState,
  PanelFrame,
} from "./admin-console-shared";

export function RequestLimitsPanel({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [attempts, setAttempts] = useState("3");
  const [seconds, setSeconds] = useState("60");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // 불러오기 실패와 저장 실패를 나눈다. 불러오지 못하면 기본값 양식을 숨겨 실제 설정을 덮어쓰지 않게 한다(총검수 C3-02·C3-03).
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string>();

  async function load(): Promise<void> {
    setLoading(true);
    setLoadError(undefined);
    try {
      const result = await getAdminSystemState();
      const value = result.states.find((state) => state.key === "request_limits")?.value_json;
      setSaved(typeof value === "object" && value !== null);
      if (typeof value === "object" && value !== null) {
        const policy = value as { max_attempts?: number; cooldown_seconds?: number };
        setAttempts(String(policy.max_attempts ?? 3));
        setSeconds(String(policy.cooldown_seconds ?? 60));
      }
    } catch (cause) {
      setLoadError(adminErrorMessage(cause, "요청 제한 설정을 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!canWrite || busy) return;
    const maxAttempts = Number(attempts),
      cooldownSeconds = Number(seconds);
    if (
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 20 ||
      !Number.isInteger(cooldownSeconds) ||
      cooldownSeconds < 1 ||
      cooldownSeconds > 3600
    ) {
      setActionError("횟수는 1~20회, 대기 시간은 1~3600초로 입력해 주세요.");
      return;
    }
    setBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    try {
      await updateAdminSystemState("request_limits", {
        max_attempts: maxAttempts,
        cooldown_seconds: cooldownSeconds,
      });
      setSaved(true);
      setNotice(
        `${maxAttempts}회 · ${cooldownSeconds}초 대기로 저장했습니다. 새 요청부터 함께 적용됩니다.`,
      );
    } catch (cause) {
      setActionError(adminErrorMessage(cause, "설정을 저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelFrame
      icon={TimerReset}
      title="요청 횟수·대기 시간"
      description="로그인, 인증 메일, 승인번호, 반 참여 등 반복 요청에 같은 기준을 적용합니다."
    >
      <LoadState error={loadError} loading={loading} onRetry={() => void load()} />
      {notice === undefined ? null : <InlineNotice>{notice}</InlineNotice>}
      {!loading && loadError === undefined ? (
        <form className="mt-6 space-y-5" onSubmit={(event) => void save(event)}>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="auth-label" htmlFor="request-limit-attempts">
              허용 횟수 (회)
              <input
                className="ui-input mt-2"
                id="request-limit-attempts"
                type="number"
                min={1}
                max={20}
                step={1}
                required
                value={attempts}
                disabled={!canWrite || busy}
                onChange={(event) => setAttempts(event.target.value)}
              />
            </label>
            <label className="auth-label" htmlFor="request-limit-seconds">
              대기 시간 (초)
              <input
                className="ui-input mt-2"
                id="request-limit-seconds"
                type="number"
                min={1}
                max={3600}
                step={1}
                required
                value={seconds}
                disabled={!canWrite || busy}
                onChange={(event) => setSeconds(event.target.value)}
              />
            </label>
          </div>
          <p className="text-sm leading-6 text-app-muted">
            기본값은 3회와 60초입니다. 대기 중 다시 눌러도 시간이 늘어나지 않습니다. 화면에는 남은
            시간이 표시됩니다.
          </p>
          {saved ? null : (
            <p className="text-sm font-semibold text-app-text" data-request-limits-default>
              아직 저장된 설정이 없어 기본값을 보여 줍니다.
            </p>
          )}
          <ActionError message={actionError} />
          {canWrite ? (
            <button
              className="ui-button ui-button-primary"
              type="submit"
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? "저장 중…" : "횟수와 시간 함께 저장"}
            </button>
          ) : (
            <p className="text-sm text-app-muted">설정 변경은 최고 관리자만 할 수 있습니다.</p>
          )}
        </form>
      ) : null}
    </PanelFrame>
  );
}
