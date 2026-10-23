import { Maximize2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { inviteJoinUrl } from "../../lib/invite-link";
import { useModalIsolation } from "../layout/use-modal-isolation";

/*
 * 교실 화면에 띄워 학생이 휴대폰 카메라로 찍게 한다. 찍으면 초대 코드가 채워진
 * 참여 화면이 열린다(요청은 학생이 직접 누른다). 만료된 코드는 QR을 만들지 않는다.
 */
export function InviteQrCode({
  code,
  compact = false,
}: {
  code: string;
  compact?: boolean;
}): React.JSX.Element {
  const url = inviteJoinUrl(code);
  return (
    <figure
      className={compact ? "shrink-0" : "mt-4 flex flex-wrap items-center gap-4"}
      data-invite-qr="true"
    >
      <div
        className={
          compact
            ? "rounded-xl border border-app-border bg-white p-1.5"
            : "rounded-2xl bg-white p-3"
        }
      >
        <QRCodeSVG
          aria-label="반 참여 QR 코드"
          level="M"
          marginSize={4}
          role="img"
          size={compact ? 96 : 148}
          value={url}
        />
      </div>
      <figcaption
        className={
          compact ? "sr-only" : "min-w-0 flex-1 break-keep text-sm leading-6 text-app-muted"
        }
      >
        학생이 휴대폰 카메라로 찍으면 초대 코드가 채워진 참여 화면이 열려요. 학생은 로그인한 뒤
        &lsquo;참여 요청&rsquo;만 누르면 돼요.
      </figcaption>
    </figure>
  );
}

/*
 * 반 관리의 96px QR은 교실 화면에 띄우면 자리에서 찍기 어려웠다(2026-10-21 첫 사용 점검 22).
 * 화면 높이에 맞춘 큰 QR을 창으로 띄운다. 높이 기준은 1366×768 노트북의 안쪽 높이에서도
 * 닫기 단추까지 스크롤 없이 보이게 고른 값이다.
 */
export function InviteQrEnlargeButton({ code }: { code: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // 사파리는 단추를 눌러도 초점을 주지 않아 닫은 뒤 돌아갈 곳을 직접 알려 준다.
  const openerRef = useRef<HTMLButtonElement>(null);
  const close = (): void => setOpen(false);
  useModalIsolation({
    dialogRef,
    initialFocusRef: closeButtonRef,
    onDismiss: close,
    open,
    returnFocusTo: openerRef.current,
  });

  return (
    <>
      <button
        className="ui-button ui-button-secondary min-h-11 px-2 text-sm sm:px-3"
        onClick={() => setOpen(true)}
        ref={openerRef}
        type="button"
      >
        <Maximize2 aria-hidden="true" size={16} />
        QR 크게 보기
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-[2px] sm:p-6"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) close();
              }}
            >
              <div
                aria-labelledby={titleId}
                aria-modal="true"
                className="flex max-h-full w-full max-w-xl flex-col items-center overflow-y-auto rounded-shell border border-app-border bg-app-surface-raised p-5 text-center text-app-text shadow-2xl sm:p-6"
                ref={dialogRef}
                role="dialog"
                tabIndex={-1}
              >
                <h2 className="break-keep text-lg font-extrabold" id={titleId}>
                  휴대폰 카메라로 찍으면 반 참여 화면이 열려요
                </h2>
                <div className="mt-4 rounded-2xl bg-white p-3">
                  <QRCodeSVG
                    aria-label="반 참여 QR 코드 크게 보기"
                    className="size-[min(52dvh,80vw,480px)]"
                    level="M"
                    marginSize={4}
                    role="img"
                    size={480}
                    value={inviteJoinUrl(code)}
                  />
                </div>
                <code className="mt-3 text-[28px] font-extrabold leading-tight tracking-[0.06em] text-role-primary">
                  {code}
                </code>
                <button
                  className="ui-button ui-button-primary mt-4 min-h-11 w-full max-w-xs"
                  onClick={close}
                  ref={closeButtonRef}
                  type="button"
                >
                  닫기
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
