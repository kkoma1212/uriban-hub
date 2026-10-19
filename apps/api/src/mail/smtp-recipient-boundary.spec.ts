import nodemailer, { type SendMailOptions } from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSmtpTransport } from "./smtp-transport.js";

describe("reserved SMTP test recipients", () => {
  afterEach(() => vi.restoreAllMocks());
  function harness(host: string) {
    const sendMail = vi.fn().mockResolvedValue({ accepted: ["fixture"], rejected: [] });
    vi.spyOn(nodemailer, "createTransport").mockReturnValue({
      options: {},
      sendMail,
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const transport = createSmtpTransport({
      host,
      port: 587,
      secure: false,
      requireTls: true,
      from: "fixture@example.com",
      publicAppOrigin: "https://example.com",
    });
    return { sendMail, transport };
  }
  it("never submits an invalid-domain test recipient to external SMTP", async () => {
    const h = harness("smtp.example.com");
    await expect(
      h.transport.sendMail({ to: "audit-fixture@example.invalid", text: "fixture" }),
    ).rejects.toThrow("SMTP delivery failed.");
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it("preserves ordinary external-recipient delivery", async () => {
    const h = harness("smtp.example.com");
    await h.transport.sendMail({ to: "recipient@naver.com", text: "fixture" });
    expect(h.sendMail).toHaveBeenCalledOnce();
  });
  it.each([
    "teacher@example.com",
    "student@example.net",
    "student@example.org",
    "student@qa.example.com",
    "student@nested.qa.example.net",
    "student@qa.example.org",
    "student@fixture.invalid",
    "student@classhub.example",
    "student@real-domain.test",
    "student@fixture.test",
    "student@fixture.localhost",
    "student@localhost",
    "Teacher <teacher@EXAMPLE.COM>",
    "teacher@EXAMPLE.COM.",
    "teacher@example。com",
    "Recipients: legitimate@naver.com, teacher@example.com;",
    '"teacher@naver.com" <teacher@example.com>',
    "legitimate@naver.com, student@example.com",
  ])("blocks reserved recipient %s before external SMTP submission", async (to) => {
    const h = harness("smtp.naver.com");
    await expect(h.transport.sendMail({ to, text: "fixture" })).rejects.toThrow(
      "SMTP delivery failed.",
    );
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it.each<SendMailOptions>([
    { cc: "Teacher <teacher@example.com>" },
    { bcc: ["legitimate@naver.com", { name: "Student", address: "student@qa.example.org" }] },
    { cc: "Class: legitimate@naver.com, teacher@example.net;" },
    { envelope: { from: "sender@naver.com", to: "student@example.com" } },
    {
      envelope: { from: "sender@naver.com", to: ["legitimate@naver.com", "student@fixture.test"] },
    },
    { envelope: { to: "legitimate@naver.com", cc: "student@example.net" } },
    { envelope: { to: "legitimate@naver.com", bcc: "student@example.org" } },
    { headers: { Bcc: "student@example.com" } },
    { headers: [{ key: "cC", value: "student@example.net" }] },
    { headers: { TO: ["legitimate@naver.com", "student@example.org"] } },
    { headers: { bcc: { prepared: true, value: "student@fixture.test" } } },
    { headers: { ["Bc\u0000c"]: "student@example.com" } },
    { headers: [{ key: "C\u007fc", value: "student@example.net" }] },
    { headers: { ["B\tc\tc"]: "student@example.org" } },
  ])("blocks reserved recipients in additional fields %#", async (additional) => {
    const h = harness("smtp.naver.com");
    await expect(
      h.transport.sendMail({ to: "legitimate@naver.com", text: "fixture", ...additional }),
    ).rejects.toThrow("SMTP delivery failed.");
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it.each([
    "recipient@naver.com",
    "recipient@gmail.com",
    "recipient@school.kr",
    "recipient@example.com.school.kr",
    "recipient@notexample.com",
    "recipient@examplecompany.org",
    '"example.com" <recipient@naver.com>',
  ])("preserves legitimate external recipient %s", async (to) => {
    const h = harness("smtp.naver.com");
    await h.transport.sendMail({
      to,
      cc: [{ address: "teacher@school.kr", name: "Teacher" }],
      bcc: "recipient@gmail.com",
      headers: { "X-ClassHub-Fixture": "boundary-test", "Reply-To": "teacher@school.kr" },
      text: "fixture",
    });
    expect(h.sendMail).toHaveBeenCalledOnce();
  });
  it.each(["127.0.0.1", "localhost", "::1", "[::1]"])(
    "allows synthetic recipients in the loopback mail sink %s",
    async (host) => {
      const h = harness(host);
      await h.transport.sendMail({
        to: "audit-fixture@example.invalid",
        cc: "teacher@example.com",
        bcc: "student@fixture.test",
        envelope: { to: "student@example.org" },
        text: "fixture",
      });
      expect(h.sendMail).toHaveBeenCalledOnce();
    },
  );
});
