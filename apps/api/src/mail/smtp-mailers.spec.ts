import { describe, expect, it, vi } from "vitest";

import { SmtpPasswordResetMailer } from "./password-reset-mailer.js";
import { SmtpVerificationMailer } from "./verification-mailer.js";

interface TransportOptions {
  auth?: {
    pass: string;
    user: string;
  };
  requireTLS?: boolean;
  secure?: boolean;
}

function readTransportOptions(mailer: object): TransportOptions {
  return (
    mailer as {
      transporter: {
        options: TransportOptions;
      };
    }
  ).transporter.options;
}

const MAILER_OPTIONS = {
  auth: {
    password: "synthetic-password",
    username: "synthetic-user",
  },
  from: "no-reply@classhub.example",
  host: "smtp.internal",
  port: 587,
  publicAppOrigin: "https://classhub.example",
  requireTls: true,
  secure: false,
} as const;

describe("SMTP mailer transports", () => {
  it.each([
    ["verification", () => new SmtpVerificationMailer(MAILER_OPTIONS)],
    ["password reset", () => new SmtpPasswordResetMailer(MAILER_OPTIONS)],
  ])(
    "configures STARTTLS and authentication for the %s mailer without sending",
    (_label, makeMailer) => {
      const options = readTransportOptions(makeMailer());

      expect(options).toMatchObject({
        auth: {
          pass: "synthetic-password",
          user: "synthetic-user",
        },
        requireTLS: true,
        secure: false,
      });
    },
  );

  it("places the guardian approval token only in the URL fragment", async () => {
    const mailer = new SmtpVerificationMailer(MAILER_OPTIONS);
    const sendMail = vi.fn().mockResolvedValue(undefined);
    (
      mailer as unknown as {
        transporter: { sendMail: typeof sendMail };
      }
    ).transporter.sendMail = sendMail;
    const rawToken = "a".repeat(43);

    await mailer.sendGuardianConsentEmail("guardian@example.com", rawToken);

    expect(sendMail).toHaveBeenCalledOnce();
    const message = sendMail.mock.calls[0]?.[0] as { html: string; text: string; to: string };
    expect(message.to).toBe("guardian@example.com");
    expect(message.text).toContain(`/guardian-consent#token=${rawToken}`);
    expect(message.html).toContain(`/guardian-consent#token=${rawToken}`);
    expect(message.text).not.toContain(`?token=${rawToken}`);
    expect(message.html).not.toContain(`?token=${rawToken}`);
    for (const body of [message.text, message.html]) {
      expect(body).toContain("학생이 기본 이름, 이메일, 비밀번호를 직접 제출해 계정을 만듭니다");
      expect(body).toContain("이메일, 동의 상태, 동의 시점만 기록");
      expect(body).toContain("보호자 이름, 전화번호, 생년월일, 증빙서류는 받지 않습니다");
      expect(body).toContain("링크를 여는 것만으로 동의가 완료되지는 않습니다");
      expect(body).toContain("동의합니다");
    }
  });

  it("uses the approved email confirmation language", async () => {
    const mailer = new SmtpVerificationMailer(MAILER_OPTIONS);
    const sendMail = vi.fn().mockResolvedValue(undefined);
    (
      mailer as unknown as {
        transporter: { sendMail: typeof sendMail };
      }
    ).transporter.sendMail = sendMail;

    await mailer.sendVerificationEmail("student@example.com", "a".repeat(43));

    const message = sendMail.mock.calls[0]?.[0] as {
      html: string;
      subject: string;
      text: string;
    };
    expect(message.subject).toBe("[우리반 허브] 이메일을 확인해 주세요");
    expect(message.text).toContain("이메일 확인을 완료하려면");
    expect(message.html).toContain("이메일 확인하기");
    expect(`${message.subject}${message.text}${message.html}`).not.toContain("이메일 인증");
    expect(message.html).toContain('<html lang="ko">');
  });

  it("keeps password reset tokens in the fragment and the thirty-minute expiry in the common form", async () => {
    const mailer = new SmtpPasswordResetMailer(MAILER_OPTIONS);
    const sendMail = vi.fn().mockResolvedValue(undefined);
    (mailer as unknown as { transporter: { sendMail: typeof sendMail } }).transporter.sendMail =
      sendMail;
    await mailer.sendPasswordResetEmail("student@example.invalid", "a".repeat(43));
    const message = sendMail.mock.calls[0]![0] as { text: string; html: string };
    expect(message.text).toContain(`/reset-password#token=${"a".repeat(43)}`);
    expect(message.text).toContain("30분 동안 한 번만");
    expect(message.html).toContain('<html lang="ko">');
    expect(message.html).not.toContain("?token=");
  });
});
