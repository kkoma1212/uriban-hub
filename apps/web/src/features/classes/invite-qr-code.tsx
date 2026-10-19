import { QRCodeSVG } from "qrcode.react";

import { inviteJoinUrl } from "../../lib/invite-link";

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
        학생이 휴대폰 카메라로 찍으면 초대 코드가 채워진 참여 화면이 열립니다. 학생은 로그인한 뒤
        &lsquo;참여 요청&rsquo;만 누르면 됩니다.
      </figcaption>
    </figure>
  );
}
