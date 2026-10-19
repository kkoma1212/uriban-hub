import nodemailer from "nodemailer";

/*
 * apps/api의 verification-mailer와 같은 SMTP 설정을 쓰지만 별도로 둔다.
 * 공용 패키지로 추출하면 동작 중인 API 메일 경로를 건드리는 리팩토링이 되고,
 * 사용처가 아직 둘뿐이라 Rule of Three(CODING_RULES §B-2)에 이르지 않았다.
 * 세 번째 사용처가 생기면 그때 packages/로 합친다.
 */

export interface TemporaryPasswordReminderMailer {
  sendExpiryReminder(email: string, expiresAt: Date): Promise<void>;
}

export interface SmtpTemporaryPasswordReminderMailerOptions {
  auth?:
    | {
        password: string;
        username: string;
      }
    | undefined;
  from: string;
  host: string;
  port: number;
  publicAppOrigin: string;
  requireTls: boolean;
  secure: boolean;
}

function formatExpiry(expiresAt: Date): string {
  // 교사가 읽는 메일이라 ISO 문자열 대신 한국 시간 기준으로 적는다.
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(expiresAt);
}

export class SmtpTemporaryPasswordReminderMailer implements TemporaryPasswordReminderMailer {
  private readonly transporter;

  constructor(private readonly options: SmtpTemporaryPasswordReminderMailerOptions) {
    this.transporter = nodemailer.createTransport({
      ...(options.auth === undefined
        ? {}
        : { auth: { pass: options.auth.password, user: options.auth.username } }),
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      host: options.host,
      port: options.port,
      requireTLS: options.requireTls,
      secure: options.secure,
      socketTimeout: 10_000,
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });
  }

  async sendExpiryReminder(email: string, expiresAt: Date): Promise<void> {
    const loginUrl = new URL("/login", this.options.publicAppOrigin).toString();
    const deadline = formatExpiry(expiresAt);

    // 임시 비밀번호 자체는 절대 싣지 않는다. 이 메일은 "아직 안 쓰셨다"는
    // 신호일 뿐이고, 비밀번호는 운영자가 시스템 밖 채널로 이미 전달했다.
    await this.transporter.sendMail({
      from: this.options.from,
      to: email,
      subject: "[우리반 허브] 임시 비밀번호 사용 기한이 곧 끝납니다",
      text:
        `관리자에게 받은 임시 비밀번호의 사용 기한이 ${deadline}에 끝납니다.\n\n` +
        `그 전에 아래 주소에서 로그인하고 새 비밀번호로 바꿔 주세요.\n\n${loginUrl}\n\n` +
        `기한이 지나면 임시 비밀번호로는 로그인할 수 없고, 관리자에게 다시 요청해 주세요.\n` +
        `이 메일에는 비밀번호가 들어 있지 않습니다.`,
      html:
        `<p>관리자에게 받은 임시 비밀번호의 사용 기한이 <strong>${deadline}</strong>에 끝납니다.</p>` +
        `<p>그 전에 아래 주소에서 로그인하고 새 비밀번호로 바꿔 주세요.</p>` +
        `<p><a href="${loginUrl}">우리반 허브 로그인</a></p>` +
        `<p>기한이 지나면 임시 비밀번호로는 로그인할 수 없고, 관리자에게 다시 요청해 주세요.<br>` +
        `이 메일에는 비밀번호가 들어 있지 않습니다.</p>`,
    });
  }
}
