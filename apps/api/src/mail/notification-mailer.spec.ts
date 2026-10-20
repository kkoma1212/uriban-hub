import { describe, expect, it, vi } from "vitest";

import { SmtpNotificationMailer } from "./notification-mailer.js";

function harness() {
  const mailer = new SmtpNotificationMailer({
    from: "no-reply@example.invalid",
    host: "smtp.example.invalid",
    port: 587,
    publicAppOrigin: "https://classhub.example",
    requireTls: true,
    secure: false,
  });
  const sendMail = vi.fn().mockResolvedValue(undefined);
  (mailer as unknown as { transporter: { sendMail: typeof sendMail } }).transporter.sendMail =
    sendMail;
  return { mailer, sendMail };
}

describe("account and membership notifications", () => {
  it("sends exactly the issued six digits using escaped shared HTML and the stored expiry", async () => {
    const h = harness();
    await expect(
      h.mailer.sendSignupApprovalEmail("student@example.invalid", {
        code: "001234",
        role: "student",
        expiresAt: new Date("2030-01-01T00:10:00Z"),
      }),
    ).resolves.toBe("sent");
    const message = h.sendMail.mock.calls[0]![0] as { text: string; html: string; subject: string };
    expect(message.text).toContain("001234");
    expect(message.html).toContain("001234");
    expect(message.text).toContain("2030. 1. 1.");
    expect(message.text).toContain("한 번만");
    expect(message.html).toContain('<html lang="ko">');
    expect(message.html).toContain("https://classhub.example/login");
  });

  it("does not generate replacement digits or transmit malformed approval codes", async () => {
    const h = harness();
    await expect(
      h.mailer.sendSignupApprovalEmail("student@example.invalid", {
        code: "12345",
        role: "student",
        expiresAt: new Date("2030-01-01"),
      }),
    ).resolves.toBe("failed");
    expect(h.sendMail).not.toHaveBeenCalled();
  });

  it("escapes names and describes a pending signup without approving it", async () => {
    const h = harness();
    await h.mailer.sendSignupEmail("student@example.invalid", {
      displayName: "<학생 & 이름>",
      role: "student",
      approvalPending: true,
    });
    const message = h.sendMail.mock.calls[0]![0] as { text: string; html: string };
    expect(message.html).toContain("&lt;학생 &amp; 이름&gt;");
    expect(message.html).not.toContain("<학생 & 이름>");
    expect(message.text).toContain("로그인한 뒤 화면에 표시되는 다음 절차");
    expect(message.text).toContain("비밀번호는 메일로 보내지 않습니다");
  });

  it("shows a found account id in its own escaped box and omits the box when no account exists", async () => {
    const h = harness();
    await h.mailer.sendAccountRecoveryEmail("a&b@example.invalid", true);
    await h.mailer.sendAccountRecoveryEmail("missing@example.invalid", false);
    const found = h.sendMail.mock.calls[0]![0] as { text: string; html: string };
    const missing = h.sendMail.mock.calls[1]![0] as { text: string; html: string };
    expect(found.html).toContain("내 아이디");
    expect(found.html).toContain("a&amp;b@example.invalid");
    expect(found.html).not.toContain("a&b@example.invalid");
    expect(found.text).toContain("내 아이디: a&b@example.invalid");
    expect(missing.html).not.toContain("내 아이디");
    expect(missing.text).not.toContain("missing@example.invalid");
  });

  it("limits class mail to the class and status without recipient lists or free-text reasons", async () => {
    const h = harness();
    await h.mailer.sendClassJoinRequestEmail("teacher@example.invalid", "1반 <script>");
    await h.mailer.sendMembershipStatusEmail("student@example.invalid", "1반", "approved");
    const teacher = h.sendMail.mock.calls[0]![0] as { html: string; to: string };
    const student = h.sendMail.mock.calls[1]![0] as { text: string; to: string };
    expect(teacher.html).toContain("1반 &lt;script&gt;");
    expect(teacher.html).toContain("/members/manage?tab=pending");
    expect(student.text).toContain("반 참여가 승인됐어요");
    expect(student.text).not.toContain(teacher.to);
  });

  it("tells an administrator a teacher is waiting without naming the applicant or linking this host", async () => {
    const h = harness();
    await expect(h.mailer.sendTeacherApprovalWaitingEmail("owner@example.invalid")).resolves.toBe(
      "sent",
    );
    const message = h.sendMail.mock.calls[0]![0] as {
      html: string;
      subject: string;
      text: string;
      to: string;
    };
    expect(message.to).toBe("owner@example.invalid");
    expect(message.subject).toBe("[우리반 허브] 승인을 기다리는 선생님이 있어요");
    expect(message.text).toContain("'승인 대기'");
    expect(message.html).not.toContain("https://classhub.example");
    expect(message.text).not.toMatch(/@/u);
  });

  it("returns a delivery result without throwing private SMTP errors", async () => {
    const h = harness();
    h.sendMail.mockRejectedValueOnce(new Error("private SMTP authentication reply"));
    await expect(
      h.mailer.sendClassJoinRequestedEmail("student@example.invalid", "1반"),
    ).resolves.toBe("failed");
  });
});
