import { afterEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { loadReminderMailEnvironment, loadRetentionEnvironment } from "./environment.js";
import { SmtpTemporaryPasswordReminderMailer } from "./temporary-password-reminder-mailer.js";

const base = {
  NODE_ENV: "test",
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: "1025",
  SMTP_FROM: "fixture@example.invalid",
  PUBLIC_APP_ORIGIN: "http://localhost:5174",
};
const protectedMail = {
  ...base,
  NODE_ENV: "production",
  SMTP_HOST: "smtp.example.invalid",
  SMTP_PORT: "587",
  SMTP_REQUIRE_TLS: "true",
  SMTP_USERNAME: "fixture",
  SMTP_PASSWORD: " synthetic-password ",
  PUBLIC_APP_ORIGIN: "https://example.invalid",
};
afterEach(() => vi.restoreAllMocks());
describe("reminder SMTP environment", () => {
  it.each([{ NODE_ENV: "production" }, { NODE_ENV: "test", PUBLIC_PREVIEW_ENABLED: "true" }])(
    "requires encryption and authentication in the protected environment %j",
    (boundary) => {
      expect(() => loadReminderMailEnvironment({ ...base, ...boundary })).toThrow("require TLS");
      expect(() =>
        loadReminderMailEnvironment({ ...base, ...boundary, SMTP_REQUIRE_TLS: "true" }),
      ).toThrow("require authentication");
      expect(() =>
        loadReminderMailEnvironment({
          ...protectedMail,
          ...boundary,
          SMTP_SECURE: "false",
          SMTP_REQUIRE_TLS: "false",
        }),
      ).toThrow("require TLS");
    },
  );
  it.each([
    { SMTP_REQUIRE_TLS: "true", SMTP_SECURE: "false" },
    { SMTP_REQUIRE_TLS: "false", SMTP_SECURE: "true" },
  ])(
    "permits authenticated STARTTLS or implicit TLS while preserving password bytes %j",
    (mode) => {
      const result = loadReminderMailEnvironment({ ...protectedMail, ...mode });
      expect(result.auth?.password).toBe(" synthetic-password ");
      expect(result.requireTls || result.secure).toBe(true);
    },
  );
  it.each(["SMTP_USERNAME", "SMTP_PASSWORD"] as const)(
    "rejects incomplete %s authentication",
    (field) => {
      expect(() => loadReminderMailEnvironment({ ...protectedMail, [field]: " " })).toThrow(
        "set together",
      );
    },
  );
  it("rejects certificate verification bypass and insecure production links", () => {
    expect(() =>
      loadReminderMailEnvironment({ ...protectedMail, NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
    ).toThrow("certificate verification");
    expect(() =>
      loadReminderMailEnvironment({
        ...protectedMail,
        PUBLIC_APP_ORIGIN: "http://example.invalid",
      }),
    ).toThrow("require HTTPS");
  });
  it.each([
    "javascript:alert(1)",
    "https://user:password@example.invalid",
    "https://example.invalid/path",
    "https://example.invalid/?x=1",
    "https://example.invalid/#x",
    'https://example.invalid/"onclick=alert(1)',
  ])("rejects a malformed reminder link %s", (origin) => {
    expect(() => loadReminderMailEnvironment({ ...base, PUBLIC_APP_ORIGIN: origin })).toThrow(
      "PUBLIC_APP_ORIGIN",
    );
  });
  it("preserves the local mail sink and does not require SMTP for unrelated retention jobs", () => {
    expect(loadReminderMailEnvironment(base)).toMatchObject({
      auth: undefined,
      secure: false,
      requireTls: false,
    });
    expect(
      loadRetentionEnvironment({
        NODE_ENV: "test",
        RETENTION_DATABASE_URL: "postgresql://classhub_retention:synthetic@127.0.0.1/synthetic",
      }).databaseEngine,
    ).toBe("postgres");
  });
  it.each(["production-ish", "", "TEST"])(
    "does not weaken protections for an invalid NODE_ENV %j",
    (NODE_ENV) => {
      expect(() => loadReminderMailEnvironment({ ...base, NODE_ENV })).toThrow("NODE_ENV");
    },
  );
  it("passes certificate verification, TLS floor and exact credentials into the real transport factory", () => {
    const create = vi.spyOn(nodemailer, "createTransport");
    new SmtpTemporaryPasswordReminderMailer(loadReminderMailEnvironment(protectedMail));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        requireTLS: true,
        secure: false,
        auth: { user: "fixture", pass: " synthetic-password " },
        tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      }),
    );
  });
});
