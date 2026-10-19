import { serviceMail } from "./mail-template.js";
import { createSmtpTransport, type SmtpMailerOptions } from "./smtp-transport.js";

export interface VerificationMailer {
  sendGuardianConsentEmail(email: string, rawToken: string): Promise<void>;
  sendVerificationEmail(email: string, rawToken: string): Promise<void>;
}

export type SmtpVerificationMailerOptions = SmtpMailerOptions;

export class SmtpVerificationMailer implements VerificationMailer {
  private readonly transporter;

  constructor(private readonly options: SmtpVerificationMailerOptions) {
    this.transporter = createSmtpTransport(options);
  }

  async sendGuardianConsentEmail(email: string, rawToken: string): Promise<void> {
    const consentUrl = new URL("/guardian-consent", this.options.publicAppOrigin);
    consentUrl.hash = `token=${rawToken}`;
    const link = consentUrl.toString();

    await this.transporter.sendMail({
      from: this.options.from,
      to: email,
      subject: "[우리반 허브] 보호자 동의를 확인해 주세요",
      ...serviceMail({
        title: "보호자 동의를 확인해 주세요",
        paragraphs: [
          "만 14세 미만 학생의 우리반 허브 가입 절차에 대한 보호자 동의 요청입니다.",
          "승인 후 학생이 기본 이름, 이메일, 비밀번호를 직접 제출해 계정을 만듭니다. 보호자 쪽에는 이메일, 동의 상태, 동의 시점만 기록하며 보호자 이름, 전화번호, 생년월일, 증빙서류는 받지 않습니다.",
          // 학생 생년월일 수집이 요약에서 빠져 있었다(총검수 B3-14).
          "학생이 생년월일을 입력하면 만 14세 확인과 담임 선생님의 학생 확인에 쓰고, 생일 알림은 학생이 켤 때만 보입니다.",
          "링크를 여는 것만으로 동의가 완료되지는 않습니다. 확인 화면의 내용을 읽고 '동의합니다' 버튼을 눌러야 합니다.",
          "이 링크는 24시간 동안 한 번만 사용할 수 있습니다.",
        ],
        action: { label: "보호자 동의 확인 화면 열기", url: link },
      }),
    });
  }

  async sendVerificationEmail(email: string, rawToken: string): Promise<void> {
    const verificationUrl = new URL("/verify-email", this.options.publicAppOrigin);
    verificationUrl.hash = `token=${rawToken}`;
    const link = verificationUrl.toString();

    await this.transporter.sendMail({
      from: this.options.from,
      to: email,
      subject: "[우리반 허브] 이메일을 확인해 주세요",
      ...serviceMail({
        title: "이메일을 확인해 주세요",
        paragraphs: [
          "우리반 허브 이메일 확인을 완료하려면 아래 버튼을 눌러 주세요.",
          "이 링크는 24시간 동안 한 번만 사용할 수 있습니다.",
        ],
        action: { label: "이메일 확인하기", url: link },
      }),
    });
  }
}
