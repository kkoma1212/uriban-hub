import { useSyncExternalStore } from "react";

import { pwaStatusController, type PwaStatusController } from "./pwa-status";

interface PwaStatusBannerProps {
  controller?: PwaStatusController;
}

export function PwaStatusBanner({
  controller = pwaStatusController,
}: PwaStatusBannerProps): React.JSX.Element | null {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );

  if (!snapshot.online) {
    return (
      <section
        aria-label="네트워크 연결 상태"
        className="pointer-events-auto w-full max-w-3xl rounded-2xl border border-warning-border bg-warning-surface px-4 py-3 text-sm text-warning-text shadow-lg"
        role="status"
      >
        <p className="font-extrabold">인터넷 연결이 끊겼어요.</p>
        <p className="mt-1 leading-6">
          화면을 계속 볼 수는 있지만 저장이나 전송은 완료되지 않을 수 있어요. 연결이 돌아오면 결과를
          다시 확인해 주세요.
        </p>
      </section>
    );
  }

  if (snapshot.updateAvailable) {
    return (
      <section
        aria-label="앱 업데이트"
        className="pointer-events-auto w-full max-w-3xl rounded-2xl border border-role-border bg-app-surface-raised px-4 py-3 text-sm text-app-text shadow-lg"
        role="status"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="font-extrabold text-app-text">새 버전이 준비됐어요.</p>
            <p className="mt-1 leading-6">
              {snapshot.updateError
                ? "업데이트를 적용하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요."
                : "지금 적용하면 화면을 한 번 새로고침해요."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-none">
            <button
              aria-busy={snapshot.updating}
              className="ui-button ui-button-primary min-w-0"
              disabled={snapshot.updating}
              onClick={() => void controller.applyUpdate()}
              type="button"
            >
              {snapshot.updating
                ? "적용 중…"
                : snapshot.updateError
                  ? "다시 시도"
                  : "지금 새로고침"}
            </button>
            <button
              className="ui-button ui-button-secondary min-w-0"
              disabled={snapshot.updating}
              onClick={controller.dismissUpdate}
              type="button"
            >
              나중에
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (snapshot.updateDownloading) {
    return (
      <section
        aria-label="앱 업데이트"
        className="pointer-events-auto w-full max-w-3xl rounded-2xl border border-role-border bg-app-surface-raised px-4 py-3 text-sm text-app-text shadow-lg"
        role="status"
      >
        <p className="font-extrabold">새 버전을 받고 있어요.</p>
        <p className="mt-1 leading-6">
          곧 화면이 한 번 새로고침돼요. 쓰던 글이 있으면 먼저 보내거나 저장해 주세요.
        </p>
      </section>
    );
  }

  if (snapshot.recovered) {
    return (
      <section
        aria-label="네트워크 연결 상태"
        className="pointer-events-auto w-full max-w-3xl rounded-2xl border border-success-border bg-success-surface px-4 py-3 text-sm font-bold text-success-text shadow-lg"
        role="status"
      >
        인터넷 연결이 복구됐어요. 저장이나 전송 결과를 확인해 주세요.
      </section>
    );
  }

  if (snapshot.registrationError) {
    return (
      <section
        aria-label="오프라인 준비 상태"
        className="pointer-events-auto flex w-full max-w-3xl items-center gap-3 rounded-2xl border border-app-border bg-app-surface-raised px-4 py-3 text-sm text-app-text shadow-lg"
        role="status"
      >
        <p className="min-w-0 flex-1 leading-6">
          오프라인 대비 기능을 준비하지 못했어요. 인터넷에 연결된 상태에서는 계속 사용할 수 있어요.
        </p>
        <button
          aria-label="오프라인 준비 알림 닫기"
          className="ui-button ui-button-secondary flex-none"
          onClick={controller.dismissRegistrationError}
          type="button"
        >
          닫기
        </button>
      </section>
    );
  }

  return null;
}
