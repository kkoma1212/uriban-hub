import { serviceMail, type ServiceMailContent } from "./mail-template.js";
import { createSmtpTransport, type SmtpMailerOptions } from "./smtp-transport.js";
import { DEFAULT_SIGNUP_MAIL_TEMPLATE } from "./mail-management.service.js";

export const NOTIFICATION_MAILER = Symbol("NOTIFICATION_MAILER");
/** "sent" means SMTP accepted the message, not that it reached the inbox. */
export type MailDeliveryStatus = "failed" | "sent";
export type SignupMailRole = "student" | "teacher";
export type MembershipMailStatus = "approved" | "rejected" | "removed" | "rejoin_allowed";

export async function notificationDelivery(
  operation: () => Promise<MailDeliveryStatus>,
): Promise<MailDeliveryStatus> {
  try {
    return await operation();
  } catch {
    return "failed";
  }
}

export interface NotificationMailer {
  sendSignupEmail(
    email: string,
    details: { displayName: string; role: SignupMailRole; approvalPending: boolean },
  ): Promise<MailDeliveryStatus>;
  sendSignupApprovalEmail(
    email: string,
    details: { code: string; role: SignupMailRole; expiresAt: Date },
  ): Promise<MailDeliveryStatus>;
  sendAccountRecoveryEmail(email: string, accountExists: boolean): Promise<MailDeliveryStatus>;
  sendClassJoinRequestedEmail(email: string, className: string): Promise<MailDeliveryStatus>;
  sendClassJoinRequestEmail(email: string, className: string): Promise<MailDeliveryStatus>;
  sendMembershipStatusEmail(
    email: string,
    className: string,
    status: MembershipMailStatus,
  ): Promise<MailDeliveryStatus>;
}

const ROLE_LABELS: Record<SignupMailRole, string> = { student: "학생", teacher: "선생님" };
const MEMBERSHIP_MESSAGES: Record<MembershipMailStatus, string> = {
  approved: "반 참여가 승인되었습니다. 로그인해 우리 반 화면을 확인해 주세요.",
  rejected: "반 참여 요청이 승인되지 않았습니다. 필요한 경우 선생님에게 확인해 주세요.",
  removed: "반 참여 상태가 변경되었습니다. 로그인해 현재 상태를 확인해 주세요.",
  rejoin_allowed: "반에 다시 참여할 수 있습니다. 로그인해 반 참여 요청을 진행해 주세요.",
};

/** Call after the domain transaction commits. No mail failure changes that result. */
export class SmtpNotificationMailer implements NotificationMailer {
  private readonly transporter;

  constructor(private readonly options: SmtpMailerOptions) {
    this.transporter = createSmtpTransport(options);
  }

  sendSignupEmail(
    email: string,
    details: { displayName: string; role: SignupMailRole; approvalPending: boolean },
  ): Promise<MailDeliveryStatus> {
    return this.deliver(email, {
      title: "회원가입을 마쳤습니다",
      paragraphs: [
        `${details.displayName}님, 우리반 허브 ${ROLE_LABELS[details.role]} 계정이 만들어졌습니다.`,
        `로그인 아이디는 ${email}입니다.`,
        "로그인한 뒤 화면에 표시되는 다음 절차를 진행해 주세요.",
      ],
      action: this.action("로그인하기", "/login"),
      note: "비밀번호는 메일로 보내지 않습니다. 본인이 가입하지 않았다면 학교 관리자에게 알려 주세요.",
    });
  }

  async sendSignupApprovalEmail(
    email: string,
    details: { code: string; role: SignupMailRole; expiresAt: Date },
  ): Promise<MailDeliveryStatus> {
    if (!/^[0-9]{6}$/u.test(details.code) || !Number.isFinite(details.expiresAt.getTime())) {
      return Promise.resolve("failed");
    }
    const expiration = new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Seoul",
    }).format(details.expiresAt);
    const template = (await this.options.management?.template()) ?? DEFAULT_SIGNUP_MAIL_TEMPLATE;
    return this.deliver(email, {
      title: template.title,
      paragraphs: [
        ...template.introduction.split(/\r?\n/u).filter(Boolean),
        `${ROLE_LABELS[details.role]} 계정의 가입 인증번호입니다.`,
        `사용 기한은 ${expiration}(한국 시간)이며 한 번만 사용할 수 있습니다. 새 번호를 발급받으면 이전 번호는 사용할 수 없습니다.`,
      ],
      code: details.code,
      action: this.action(template.button_label, "/login"),
      note: template.footer,
    });
  }

  sendAccountRecoveryEmail(email: string, accountExists: boolean): Promise<MailDeliveryStatus> {
    return this.deliver(email, {
      title: "아이디 찾기 안내",
      paragraphs: accountExists
        ? [
            `우리반 허브에 가입한 아이디는 ${email}입니다.`,
            "비밀번호를 잊었다면 로그인 화면의 비밀번호 찾기에서 재설정 링크를 요청해 주세요.",
          ]
        : [
            "이 이메일로 사용할 수 있는 우리반 허브 계정을 확인하지 못했습니다.",
            "가입할 때 다른 이메일을 사용했는지 확인하거나 학교 관리자에게 문의해 주세요.",
          ],
      action: this.action("로그인 화면 열기", "/login"),
    });
  }

  sendClassJoinRequestedEmail(email: string, className: string): Promise<MailDeliveryStatus> {
    return this.deliver(email, {
      title: "반 참여 요청을 접수했습니다",
      paragraphs: [
        `${className} 반 참여 요청을 접수했습니다.`,
        "선생님이 확인한 뒤 승인 여부가 결정됩니다. 현재 상태는 로그인 후 확인할 수 있습니다.",
      ],
      action: this.action("참여 상태 확인하기", "/login"),
    });
  }

  sendClassJoinRequestEmail(email: string, className: string): Promise<MailDeliveryStatus> {
    return this.deliver(email, {
      title: "확인할 반 참여 요청이 있습니다",
      paragraphs: [
        `${className}에 새로운 반 참여 요청이 접수되었습니다.`,
        "로그인 후 학생 관리에서 요청자를 확인하고 승인 여부를 결정해 주세요.",
      ],
      action: this.action("학생 관리 열기", "/members/manage?tab=pending"),
    });
  }

  sendMembershipStatusEmail(
    email: string,
    className: string,
    status: MembershipMailStatus,
  ): Promise<MailDeliveryStatus> {
    return this.deliver(email, {
      title: "반 참여 상태를 안내합니다",
      paragraphs: [className, MEMBERSHIP_MESSAGES[status]],
      action: this.action("참여 상태 확인하기", "/login"),
    });
  }

  private action(label: string, path: string) {
    return { label, url: new URL(path, this.options.publicAppOrigin).toString() };
  }

  private async deliver(email: string, content: ServiceMailContent): Promise<MailDeliveryStatus> {
    try {
      await this.transporter.sendMail({
        from: this.options.from,
        to: email,
        subject: `[우리반 허브] ${content.title}`,
        ...serviceMail(content),
      });
      return "sent";
    } catch {
      // SMTP errors can contain recipients, credentials or server replies. Do not log them.
      return "failed";
    }
  }
}
