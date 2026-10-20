import { serviceMail } from "./mail-template.js";
import { createSmtpTransport, type SmtpMailerOptions } from "./smtp-transport.js";

export interface PasswordResetMailer {
  sendPasswordResetEmail(email: string, rawToken: string): Promise<void>;
}

export type SmtpPasswordResetMailerOptions = SmtpMailerOptions;

export class SmtpPasswordResetMailer implements PasswordResetMailer {
  private readonly transporter;

  constructor(private readonly options: SmtpPasswordResetMailerOptions) {
    this.transporter = createSmtpTransport(options);
  }

  async sendPasswordResetEmail(email: string, rawToken: string): Promise<void> {
    const resetUrl = new URL("/reset-password", this.options.publicAppOrigin);
    resetUrl.hash = `token=${rawToken}`;
    const link = resetUrl.toString();

    await this.transporter.sendMail({
      from: this.options.from,
      to: email,
      subject: "[우리반 허브] 비밀번호를 재설정해 주세요",
      ...serviceMail({
        title: "비밀번호를 재설정해 주세요",
        paragraphs: [
          "아래 버튼을 누르고 우리반 허브 화면에서 새 비밀번호를 직접 정해 주세요.",
          "이 링크는 30분 동안 한 번만 쓸 수 있어요.",
        ],
        action: { label: "비밀번호 재설정하기", url: link },
      }),
    });
  }
}
