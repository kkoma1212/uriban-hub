import { serviceMail, type ServiceMailContent } from "./mail-template.js";
import { createSmtpTransport, type SmtpMailerOptions } from "./smtp-transport.js";
import { DEFAULT_SIGNUP_MAIL_TEMPLATE } from "./mail-management.service.js";

export const NOTIFICATION_MAILER = Symbol("NOTIFICATION_MAILER");
/** "sent" means SMTP accepted the message, not that it reached the inbox. */
export type MailDeliveryStatus = "failed" | "sent";
export type SignupMailRole = "student" | "teacher";
/** "email": 가입자가 스스로 받는 메일 인증번호. "approval": 관리자가 확인 뒤 보내는 승인번호. */
export type SignupCodePurpose = "approval" | "email";
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
    details: { code: string; role: SignupMailRole; expiresAt: Date; purpose: SignupCodePurpose },
  ): Promise<MailDeliveryStatus>;
  sendAccountRecoveryEmail(email: string, accountExists: boolean): Promise<MailDeliveryStatus>;
  sendTeacherApprovalWaitingEmail(adminEmail: string): Promise<MailDeliveryStatus>;
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
  approved: "반 참여가 승인됐어요. 로그인해서 우리 반 화면을 확인해 보세요.",
  rejected: "반 참여 요청이 승인되지 않았어요. 궁금하면 선생님께 물어보세요.",
  removed: "반 참여 상태가 바뀌었어요. 로그인해서 지금 상태를 확인해 주세요.",
  rejoin_allowed: "이제 반에 다시 참여할 수 있어요. 로그인해서 반 참여를 다시 요청해 주세요.",
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
    details: { code: string; role: SignupMailRole; expiresAt: Date; purpose: SignupCodePurpose },
  ): Promise<MailDeliveryStatus> {
    if (!/^[0-9]{6}$/u.test(details.code) || !Number.isFinite(details.expiresAt.getTime())) {
      return Promise.resolve("failed");
    }
    const expiration = new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Seoul",
    }).format(details.expiresAt);
    const oneUse = `${expiration}(한국 시간)까지 한 번만 쓸 수 있어요. 번호를 새로 받으면 이 번호는 더 이상 쓸 수 없어요.`;
    // 관리자가 보내는 번호는 화면이 '교사 승인번호'라 부르는데 메일은 '가입 인증번호'라 해서 헷갈렸다
    // (2026-10-21 첫 사용 점검). 관리자가 고치는 가입 인증 메일 틀(template)은 쓰지 않는다.
    if (details.purpose === "approval") {
      const label = details.role === "teacher" ? "교사 승인번호" : "가입 승인번호";
      return this.deliver(email, {
        title: `${label} 안내`,
        paragraphs: [
          details.role === "teacher"
            ? "관리자가 선생님임을 확인했어요. 로그인한 뒤 아래 6자리 교사 승인번호를 입력하면 반을 만들 수 있어요."
            : "관리자가 가입을 확인했어요. 로그인한 뒤 아래 6자리 가입 승인번호를 입력해 주세요.",
          oneUse,
        ],
        code: details.code,
        codeLabel: label,
        action: this.action("로그인하기", "/login"),
        note: "승인번호는 다른 사람에게 알려 주지 마세요. 직접 가입하지 않았다면 이 메일은 무시해도 괜찮아요.",
      });
    }
    const template = (await this.options.management?.template()) ?? DEFAULT_SIGNUP_MAIL_TEMPLATE;
    return this.deliver(email, {
      title: template.title,
      paragraphs: [
        ...template.introduction.split(/\r?\n/u).filter(Boolean),
        `${ROLE_LABELS[details.role]} 계정 가입 인증번호예요.`,
        oneUse,
      ],
      code: details.code,
      codeLabel: "인증번호",
      action: this.action(template.button_label, "/login"),
      note: template.footer,
    });
  }

  sendAccountRecoveryEmail(email: string, accountExists: boolean): Promise<MailDeliveryStatus> {
    return this.deliver(email, {
      title: "아이디 찾기 안내",
      paragraphs: accountExists
        ? [
            "우리반 허브 아이디를 찾았어요.",
            "비밀번호가 기억나지 않으면 로그인 화면의 '비밀번호 찾기'에서 새로 정할 수 있어요.",
          ]
        : [
            "이 이메일로 쓸 수 있는 우리반 허브 계정을 찾지 못했어요.",
            "가입할 때 다른 이메일을 쓰지 않았는지 확인해 보고, 그래도 모르겠으면 학교 관리자에게 물어봐 주세요.",
          ],
      ...(accountExists ? { highlight: { label: "내 아이디", value: email } } : {}),
      action: this.action("로그인 화면 열기", "/login"),
    });
  }

  // No applicant name or address: the admin console lists them, and this mail leaves the system.
  // No button either, because the admin console lives on a separate host from this app origin.
  sendTeacherApprovalWaitingEmail(adminEmail: string): Promise<MailDeliveryStatus> {
    return this.deliver(adminEmail, {
      title: "승인을 기다리는 선생님이 있어요",
      paragraphs: [
        "선생님 한 분이 이메일 인증을 마치고 교사 승인을 기다리고 있어요.",
        "관리자 화면의 사람 목록에서 '승인 대기'를 골라 교사인지 확인한 뒤 승인번호를 보내 주세요.",
      ],
      note: "개인정보를 지키기 위해 이 메일에는 가입자 정보를 적지 않았어요.",
    });
  }

  sendClassJoinRequestedEmail(email: string, className: string): Promise<MailDeliveryStatus> {
    return this.deliver(email, {
      title: "반 참여 요청이 접수됐어요",
      paragraphs: ["선생님이 확인한 뒤 승인 여부를 정해요. 지금 상태는 로그인해서 볼 수 있어요."],
      highlight: { label: "참여를 요청한 반", value: className },
      action: this.action("참여 상태 확인하기", "/login"),
    });
  }

  sendClassJoinRequestEmail(email: string, className: string): Promise<MailDeliveryStatus> {
    return this.deliver(email, {
      title: "확인할 반 참여 요청이 있어요",
      paragraphs: [
        `${className}에 새 참여 요청이 들어왔어요.`,
        "로그인한 뒤 학생 관리에서 요청한 사람을 확인하고 승인할지 정해 주세요.",
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
      title: "반 참여 상태 알림",
      paragraphs: [MEMBERSHIP_MESSAGES[status]],
      highlight: { label: "반", value: className },
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
