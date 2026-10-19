import type { ConfigService } from "@nestjs/config";
import { domainToASCII } from "node:url";
import nodemailer, { type SendMailOptions } from "nodemailer";
import addressparser from "nodemailer/lib/addressparser/index.js";

import type { AppEnvironment } from "../config/environment.js";
import type { MailManagementService } from "./mail-management.service.js";
import { connectSmtpSocket } from "./smtp-socket.js";

function recipientAddresses(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(recipientAddresses);
  if (typeof value === "object" && "address" in value) return recipientAddresses(value.address);
  if (typeof value !== "string")
    throw Object.assign(new Error("Invalid recipient."), { code: "EENVELOPE" });
  const parsed = addressparser(value, { flatten: true });
  if (parsed.length === 0)
    throw Object.assign(new Error("Invalid recipient."), { code: "EENVELOPE" });
  return parsed.map(({ address }) => address);
}

function isReservedTestRecipient(address: string): boolean {
  const separator = address.lastIndexOf("@");
  if (separator < 1) throw Object.assign(new Error("Invalid recipient."), { code: "EENVELOPE" });
  const domain = domainToASCII(address.slice(separator + 1).trim())
    .toLowerCase()
    .replace(/\.+$/u, "");
  if (!domain) throw Object.assign(new Error("Invalid recipient."), { code: "EENVELOPE" });
  return [
    "example.com",
    "example.net",
    "example.org",
    "example",
    "invalid",
    "test",
    "localhost",
  ].some((reserved) => domain === reserved || domain.endsWith("." + reserved));
}

function hasCustomRecipientHeaders(headers: SendMailOptions["headers"]): boolean {
  if (headers === undefined) return false;
  const names = Array.isArray(headers) ? headers.map(({ key }) => key) : Object.keys(headers);
  return names.some(
    (name) => /[\u0000-\u001f\u007f]/u.test(name) || /^(?:to|cc|bcc)$/iu.test(name.trim()),
  );
}

export interface SmtpMailerOptions {
  auth?: { password: string; username: string } | undefined;
  from: string;
  host: string;
  port: number;
  publicAppOrigin: string;
  requireTls: boolean;
  secure: boolean;
  management?: MailManagementService;
}

export function smtpMailerOptions(
  config: ConfigService<AppEnvironment, true>,
  management?: MailManagementService,
): SmtpMailerOptions {
  const password = config.get("SMTP_PASSWORD", { infer: true });
  const username = config.get("SMTP_USERNAME", { infer: true });
  return {
    ...(management === undefined ? {} : { management }),
    auth: password === undefined || username === undefined ? undefined : { password, username },
    from: config.get("SMTP_FROM", { infer: true }),
    host: config.get("SMTP_HOST", { infer: true }),
    port: config.get("SMTP_PORT", { infer: true }),
    // 메일 링크는 학생·교사 화면으로 간다. 관리자 프로그램(API_SURFACE=admin)은 USER_APP_ORIGIN이 필수다.
    publicAppOrigin:
      config.get("USER_APP_ORIGIN", { infer: true }) ??
      config.get("PUBLIC_APP_ORIGIN", { infer: true }),
    requireTls: config.get("SMTP_REQUIRE_TLS", { infer: true }),
    secure: config.get("SMTP_SECURE", { infer: true }),
  };
}

export function createSmtpTransport(options: SmtpMailerOptions) {
  const transport = nodemailer.createTransport({
    ...(options.auth === undefined
      ? {}
      : { auth: { pass: options.auth.password, user: options.auth.username } }),
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    getSocket: connectSmtpSocket,
    host: options.host,
    port: options.port,
    requireTLS: options.requireTls,
    secure: options.secure,
    socketTimeout: 10_000,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
  });
  return {
    options: transport.options,
    async sendMail(message: SendMailOptions) {
      const recipient = typeof message.to === "string" ? message.to : undefined;
      if (recipient === undefined) throw new Error("One valid recipient is required.");
      const recordId = await options.management?.begin(
        recipient,
        message.subject ?? "우리반 허브 안내",
      );
      let info;
      try {
        // Reserved test recipients have no public mailbox. Keep them inside a local mail sink.
        const localMailSink = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
          options.host.toLowerCase(),
        );
        if (!localMailSink) {
          // Custom recipient headers can add recipients beyond the top-level routing fields.
          if (hasCustomRecipientHeaders(message.headers)) {
            throw Object.assign(new Error("Custom recipient headers are not supported."), {
              code: "EENVELOPE",
            });
          }
          const recipients = [
            message.to,
            message.cc,
            message.bcc,
            message.envelope?.to,
            message.envelope && "cc" in message.envelope ? message.envelope.cc : undefined,
            message.envelope && "bcc" in message.envelope ? message.envelope.bcc : undefined,
          ].flatMap(recipientAddresses);
          if (recipients.some(isReservedTestRecipient)) {
            throw Object.assign(new Error("Reserved test recipient."), { code: "EENVELOPE" });
          }
        }
        info = await transport.sendMail(message);
        if (
          info &&
          ((info.rejected?.length ?? 0) > 0 || (info.accepted && info.accepted.length === 0))
        )
          throw Object.assign(new Error("Recipient was not accepted."), { code: "EENVELOPE" });
      } catch (cause) {
        const code =
          typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
        const failure =
          code === "EAUTH"
            ? "authentication_failed"
            : code === "EENVELOPE"
              ? "recipient_rejected"
              : code === "ETIMEDOUT" || code === "ECONNECTION" || code === "EDNS"
                ? "connection_failed"
                : code === "ETLS"
                  ? "tls_failed"
                  : "smtp_failed";
        if (recordId)
          await options.management?.complete(recordId, "failed", failure).catch(() => undefined);
        throw new Error("SMTP delivery failed.");
      }
      // A pending record after a DB failure means the final delivery result needs checking.
      if (recordId)
        await options.management?.complete(recordId, "accepted", null).catch(() => undefined);
      return info;
    },
  };
}
