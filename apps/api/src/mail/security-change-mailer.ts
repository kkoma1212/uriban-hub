import { Logger } from "@nestjs/common";
import { z } from "zod";
import { serviceMail } from "./mail-template.js";
import { createSmtpTransport, type SmtpMailerOptions } from "./smtp-transport.js";

export const SECURITY_CHANGE_MAILER = Symbol("SECURITY_CHANGE_MAILER");
const messages = {
  password_changed: "계정 비밀번호가 바뀌었어요.",
  password_reset: "계정 비밀번호가 새로 정해졌어요.",
  account_enabled: "계정을 다시 쓸 수 있게 됐어요.",
  account_disabled: "계정 이용이 정지됐어요.",
  // 총검수 I1-03·I1-04(2026-10-02 사용자 결정): 빠른 로그인 연결이 바뀌면 본인에게 알린다.
  social_linked: "계정에 빠른 로그인(구글·카카오·네이버)이 새로 연결됐어요.",
  social_unlinked: "계정에서 빠른 로그인(구글·카카오·네이버) 연결이 해제됐어요.",
  social_links_removed:
    "비밀번호를 새로 정하면서 연결돼 있던 빠른 로그인(구글·카카오·네이버)을 모두 해제했어요. 필요하면 로그인한 뒤 설정에서 다시 연결해 주세요.",
  admin_password_changed: "관리자 계정 비밀번호가 바뀌었어요.",
  admin_mfa_enrolled: "관리자 계정에 2단계 인증이 등록됐어요.",
  admin_mfa_reset: "관리자 계정의 2단계 인증이 초기화됐어요.",
  admin_credentials_reset: "관리자 계정의 비밀번호와 2단계 인증이 초기화됐어요.",
  admin_roles_changed: "관리자 계정의 권한이 바뀌었어요.",
  admin_account_enabled: "관리자 계정을 다시 쓸 수 있게 됐어요.",
  admin_account_suspended: "관리자 계정 이용이 정지됐어요.",
  admin_account_revoked: "관리자 계정 권한이 회수됐어요.",
  // 총검수 C1-04·C1-05: 로그인 수단이 바뀌거나 2단계 확인이 거듭 틀리면 본인에게 알린다.
  admin_passkey_registered: "관리자 계정에 새 패스키가 등록됐어요.",
  admin_passkey_removed: "관리자 계정의 패스키가 삭제됐어요.",
  admin_totp_removed: "관리자 계정의 인증 앱(OTP) 연결이 해제됐어요.",
  admin_recovery_codes_issued:
    "관리자 계정의 복구 코드가 새로 발급됐어요. 이전 복구 코드는 더 이상 쓸 수 없어요.",
  admin_recovery_code_used: "관리자 계정에 복구 코드로 로그인했어요.",
  admin_mfa_failures:
    "관리자 계정의 2단계 확인이 1시간 안에 여러 번 틀렸어요. 비밀번호가 다른 사람에게 알려졌을 수 있으니 비밀번호를 바꿔 주세요.",
} as const;
export type SecurityChangeKind = keyof typeof messages;
export interface SecurityChangeNotice {
  email: string;
  kind: SecurityChangeKind;
  occurredAt: Date;
}
export interface SecurityChangeMailer {
  /** accepted is only the SMTP server's acknowledgement, never inbox delivery or reading. */
  sendSecurityChange(notice: SecurityChangeNotice): Promise<"accepted" | "failed">;
}
const logger = new Logger("SecurityChangeNotification");

/** Invoke once, after the domain transaction has committed. Never turn mail failure into a failed mutation. */
export async function notifySecurityChange(
  mailer: SecurityChangeMailer | undefined,
  notice: SecurityChangeNotice | undefined,
): Promise<void> {
  if (!mailer || !notice) return;
  try {
    if ((await mailer.sendSecurityChange(notice)) === "accepted") return;
  } catch {
    // SMTP and database exceptions may contain recipients, credentials or message content.
  }
  logger.warn({ failure_code: "security_change_mail_failed", change_kind: notice.kind });
}

export class SmtpSecurityChangeMailer implements SecurityChangeMailer {
  private readonly transporter;
  constructor(private readonly options: SmtpMailerOptions) {
    this.transporter = createSmtpTransport(options);
  }
  async sendSecurityChange(notice: SecurityChangeNotice): Promise<"accepted" | "failed"> {
    try {
      if (
        !Object.hasOwn(messages, notice.kind) ||
        !z.string().email().max(320).safeParse(notice.email).success ||
        !Number.isFinite(notice.occurredAt.getTime())
      )
        return "failed";
      const occurredAt = new Intl.DateTimeFormat("ko-KR", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Seoul",
      }).format(notice.occurredAt);
      const administrator = notice.kind.startsWith("admin_");
      const content = serviceMail({
        title: "계정 보안 변경 안내",
        paragraphs: [
          messages[notice.kind],
          `바뀐 시각: ${occurredAt} (한국 시간)`,
          "직접 요청한 변경이라면 따로 할 일은 없어요.",
          administrator
            ? "요청하지 않은 변경이라면 평소 알고 있는 연락처로 학교 관리자나 운영자에게 바로 알려 주세요. 관리자 화면은 평소 사용하던 접속 경로로 직접 열어 주세요."
            : "요청하지 않은 변경이라면 로그인 화면의 '비밀번호 찾기'로 비밀번호를 새로 정하고, 선생님이나 학교 관리자에게 알려 주세요.",
        ],
        ...(administrator
          ? {}
          : {
              action: {
                label: "로그인 화면 열기",
                url: new URL("/login", this.options.publicAppOrigin).toString(),
              },
            }),
        note: "비밀번호, 인증번호, 복구키를 메일에 답장하거나 다른 사람에게 보내지 마세요.",
      });
      await this.transporter.sendMail({
        from: this.options.from,
        to: notice.email,
        subject: "[우리반 허브] 계정 보안 변경 안내",
        ...content,
      });
      return "accepted";
    } catch {
      return "failed";
    }
  }
}
