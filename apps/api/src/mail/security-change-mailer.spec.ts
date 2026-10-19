import { Logger } from "@nestjs/common";
import nodemailer from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notifySecurityChange,
  SmtpSecurityChangeMailer,
  type SecurityChangeKind,
} from "./security-change-mailer.js";

const options = {
  from: "notice@example.invalid",
  host: "127.0.0.1",
  port: 1025,
  publicAppOrigin: "https://classhub.example",
  secure: false,
  requireTls: true,
};
const occurredAt = new Date("2026-09-16T01:02:00Z");
function harness() {
  const sendMail = vi
    .fn()
    .mockResolvedValue({ accepted: ["recipient@example.invalid"], rejected: [] });
  vi.spyOn(nodemailer, "createTransport").mockReturnValue({ options: {}, sendMail } as never);
  const management = {
    begin: vi.fn().mockResolvedValue("receipt"),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  const mailer = new SmtpSecurityChangeMailer({ ...options, management: management as never });
  return { sendMail, mailer, management };
}
afterEach(() => vi.restoreAllMocks());
describe("account security change mail", () => {
  it.each([
    "password_changed",
    "password_reset",
    "account_enabled",
    "account_disabled",
    "admin_password_changed",
    "admin_mfa_enrolled",
    "admin_mfa_reset",
    "admin_credentials_reset",
    "admin_roles_changed",
    "admin_account_enabled",
    "admin_account_suspended",
    "admin_account_revoked",
  ] as const)(
    "records SMTP acceptance for %s without credentials or free-text details",
    async (kind) => {
      const h = harness();
      await expect(
        h.mailer.sendSecurityChange({ email: "recipient@example.invalid", kind, occurredAt }),
      ).resolves.toBe("accepted");
      const message = h.sendMail.mock.calls[0]![0] as {
        subject: string;
        text: string;
        html: string;
        to: string;
      };
      expect(message.to).toBe("recipient@example.invalid");
      expect(message.subject).toBe("[우리반 허브] 계정 보안 변경 안내");
      expect(message.text).toContain("한국 시간");
      expect(message.text).toContain("요청하지 않은 변경");
      expect(message.html).toContain('<html lang="ko">');
      expect(message.html).not.toContain("/admin/login");
      if (kind.startsWith("admin_")) expect(message.text).toContain("평소 사용하던 접속 경로");
      else expect(message.html).toContain("https://classhub.example/login");
      expect(h.management.complete).toHaveBeenCalledWith("receipt", "accepted", null);
    },
  );
  it.each([
    {
      email: "victim@example.invalid, second@example.invalid",
      kind: "password_changed",
      occurredAt,
    },
    {
      email: "victim@example.invalid\r\nBcc:second@example.invalid",
      kind: "password_changed",
      occurredAt,
    },
    { email: "victim@example.invalid", kind: "constructor", occurredAt },
    { email: "victim@example.invalid", kind: "password_changed", occurredAt: new Date("invalid") },
  ])("rejects malformed mail input before logging or sending (%j)", async (notice) => {
    const h = harness();
    await expect(
      h.mailer.sendSecurityChange({ ...notice, kind: notice.kind as SecurityChangeKind }),
    ).resolves.toBe("failed");
    expect(h.sendMail).not.toHaveBeenCalled();
    expect(h.management.begin).not.toHaveBeenCalled();
  });
  it("records delivery failure without leaking server diagnostics into the mutation result or logger", async () => {
    const h = harness();
    h.sendMail.mockRejectedValueOnce(
      Object.assign(new Error("private SMTP reply recipient and credential"), { code: "EAUTH" }),
    );
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await expect(
      notifySecurityChange(h.mailer, {
        email: "recipient@example.invalid",
        kind: "password_reset",
        occurredAt,
      }),
    ).resolves.toBeUndefined();
    expect(h.management.complete).toHaveBeenCalledWith(
      "receipt",
      "failed",
      "authentication_failed",
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith({
      failure_code: "security_change_mail_failed",
      change_kind: "password_reset",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/recipient|credential|private SMTP/u);
  });
  it("does not repeat a send after SMTP accepted but delivery-log completion failed", async () => {
    const h = harness();
    h.management.complete.mockRejectedValue(new Error("synthetic DB failure"));
    await expect(
      h.mailer.sendSecurityChange({
        email: "recipient@example.invalid",
        kind: "password_changed",
        occurredAt,
      }),
    ).resolves.toBe("accepted");
    expect(h.sendMail).toHaveBeenCalledOnce();
  });
  it("contains unexpected mailer failures without turning a completed security change into an error", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await expect(
      notifySecurityChange(
        {
          sendSecurityChange: async () => {
            throw new Error("private recipient data");
          },
        },
        {
          email: "recipient@example.invalid",
          kind: "admin_mfa_reset",
          occurredAt,
        },
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
