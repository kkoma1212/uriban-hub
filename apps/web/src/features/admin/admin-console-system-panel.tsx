import { Activity, BellRing, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type * as React from "react";

import {
  getAdminSystemState,
  updateAdminSystemState,
  type AdminSystemState,
} from "../../api/admin-management";
import {
  adminErrorMessage,
  InlineNotice,
  ActionError,
  LoadState,
  PanelFrame,
  StepUpHint,
} from "./admin-console-shared";

function stateBoolean(states: AdminSystemState[], key: "maintenance_mode"): boolean {
  const value = states.find((state) => state.key === key)?.value_json;
  if (typeof value === "boolean") return value;
  return (
    typeof value === "object" &&
    value !== null &&
    "enabled" in value &&
    (value as { enabled?: unknown }).enabled === true
  );
}

function stateAnnouncement(states: AdminSystemState[]): { enabled: boolean; message: string } {
  const value = states.find((state) => state.key === "announcement")?.value_json;
  if (typeof value === "string") return { enabled: value.length > 0, message: value };
  if (typeof value === "object" && value !== null) {
    const candidate = value as { enabled?: unknown; message?: unknown };
    return {
      enabled: candidate.enabled === true,
      message: typeof candidate.message === "string" ? candidate.message : "",
    };
  }
  return { enabled: false, message: "" };
}

export function SystemPanel({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [states, setStates] = useState<AdminSystemState[]>();
  const [maintenance, setMaintenance] = useState(false);
  const [announcementEnabled, setAnnouncementEnabled] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<"announcement" | "maintenance_mode">();
  const [error, setError] = useState<string>();
  // 저장 실패는 양식 옆에(불러오기 실패 상자와 분리, 총검수 C3-03).
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await getAdminSystemState();
      setStates(result.states);
      setMaintenance(stateBoolean(result.states, "maintenance_mode"));
      const nextAnnouncement = stateAnnouncement(result.states);
      setAnnouncementEnabled(nextAnnouncement.enabled);
      setAnnouncement(nextAnnouncement.message);
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "시스템 상태를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(key: "announcement" | "maintenance_mode"): Promise<void> {
    if (!canWrite || busyKey !== undefined) return;
    setBusyKey(key);
    setActionError(undefined);
    setNotice(undefined);
    try {
      const value =
        key === "maintenance_mode"
          ? { enabled: maintenance }
          : { enabled: announcementEnabled, message: announcement.trim() };
      const result = await updateAdminSystemState(key, value);
      setStates((current) => [...(current ?? []).filter((item) => item.key !== key), result.state]);
      setNotice(
        key === "maintenance_mode"
          ? "점검 설정을 저장했습니다. 사용자 저장·변경은 새 요청부터 적용되며 화면 안내는 다음 갱신에 반영됩니다."
          : "공지 설정을 저장했습니다. 사용자 화면의 다음 안내 갱신에 반영됩니다.",
      );
    } catch (requestError) {
      setActionError(adminErrorMessage(requestError, "시스템 상태를 저장하지 못했습니다."));
    } finally {
      setBusyKey(undefined);
    }
  }

  return (
    <PanelFrame
      description="사용자 저장·변경 점검과 공개 공지를 관리합니다. 교육 기록 조회·인증 복구·관리자 설정 해제는 유지합니다."
      icon={Activity}
      title="시스템 상태"
    >
      {canWrite ? (
        <StepUpHint />
      ) : (
        <p className="mt-4 rounded-2xl bg-app-surface-muted px-4 py-3 text-sm font-semibold text-app-muted">
          보안 감사자는 현재 상태를 조회할 수 있으며 변경은 최고 관리자만 수행합니다.
        </p>
      )}
      <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold leading-6 text-amber-900">
        점검 중에도 교육 기록 조회와 로그인·복구는 유지합니다. 사용자 저장·변경은 서버에서 차단하고
        공지는 화면 안내 갱신 시 표시합니다.
      </p>
      <LoadState error={error} loading={loading} onRetry={() => void load()} />
      {notice === undefined ? null : <InlineNotice>{notice}</InlineNotice>}
      <ActionError message={actionError} />
      {!loading && states !== undefined ? (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-app-border bg-app-surface-raised p-5">
            <div className="flex items-start gap-3">
              <span
                className={`grid size-10 shrink-0 place-items-center rounded-xl ${maintenance ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}
              >
                <Wrench aria-hidden="true" size={20} />
              </span>
              <div>
                <h3 className="font-black text-app-text">점검 모드</h3>
                <p className="mt-1 text-sm font-semibold text-app-muted">
                  {/* 체크박스가 아니라 서버에 저장된 값을 보여 준다(총검수 C3-06). */}
                  저장된 설정:{" "}
                  {stateBoolean(states, "maintenance_mode")
                    ? "점검 모드 사용"
                    : "점검 모드 사용 안 함"}
                  {maintenance !== stateBoolean(states, "maintenance_mode")
                    ? " · 저장 안 된 변경 있음"
                    : ""}
                </p>
              </div>
            </div>
            <label className="mt-5 flex min-h-12 items-center gap-3 rounded-xl bg-app-surface-muted px-4 text-sm font-bold text-app-text">
              <input
                checked={maintenance}
                className="size-5 accent-role-primary"
                disabled={!canWrite}
                onChange={(event) => setMaintenance(event.target.checked)}
                type="checkbox"
              />{" "}
              점검 모드 사용
            </label>
            {canWrite ? (
              <button
                aria-busy={busyKey === "maintenance_mode"}
                className="ui-button ui-button-primary mt-4 w-full text-sm"
                disabled={busyKey !== undefined}
                onClick={() => void save("maintenance_mode")}
                type="button"
              >
                설정 저장
              </button>
            ) : null}
          </section>
          <section className="rounded-2xl border border-app-border bg-app-surface-raised p-5">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-role-soft text-role-primary">
                <BellRing aria-hidden="true" size={20} />
              </span>
              <div>
                <h3 className="font-black text-app-text">전체 공지 배너</h3>
                <p className="mt-1 text-sm font-semibold text-app-muted">
                  로그인 전과 학생·교사 화면에 표시할 일반 텍스트 공지입니다. 개인정보와 비밀값을
                  넣지 마세요.
                </p>
              </div>
            </div>
            <label className="mt-5 flex min-h-12 items-center gap-3 rounded-xl bg-app-surface-muted px-4 text-sm font-bold text-app-text">
              <input
                checked={announcementEnabled}
                className="size-5 accent-role-primary"
                disabled={!canWrite}
                onChange={(event) => setAnnouncementEnabled(event.target.checked)}
                type="checkbox"
              />{" "}
              공지 배너 표시
            </label>
            <label className="auth-label mt-4" htmlFor="system-announcement">
              공지 내용
            </label>
            <textarea
              className="ui-input h-auto min-h-28 py-3"
              disabled={!canWrite}
              id="system-announcement"
              onChange={(event) => setAnnouncement(event.target.value)}
              value={announcement}
            />
            {canWrite ? (
              <button
                aria-busy={busyKey === "announcement"}
                className="ui-button ui-button-primary mt-4 w-full text-sm"
                disabled={
                  busyKey !== undefined || (announcementEnabled && announcement.trim().length === 0)
                }
                onClick={() => void save("announcement")}
                type="button"
              >
                공지 저장
              </button>
            ) : null}
          </section>
        </div>
      ) : null}
    </PanelFrame>
  );
}
