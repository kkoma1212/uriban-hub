import { createServer, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SmtpTemporaryPasswordReminderMailer } from "../../../retention-cli/src/temporary-password-reminder-mailer.js";
import { SmtpSecurityChangeMailer } from "./security-change-mailer.js";

describe("SMTP TLS downgrade boundary on a real loopback connection", () => {
  it.each(["security", "reminder"] as const)(
    "rejects an untrusted TLS certificate before %s sends authentication",
    async (kind) => {
      const prefix = join(tmpdir(), "classhub-security-smtp-");
      const directory = mkdtempSync(prefix);
      const sockets = new Set<Socket>();
      let connections = 0;
      let authenticatedConnections = 0;
      const openssl =
        process.platform === "win32"
          ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git/usr/bin/openssl.exe")
          : "openssl";
      try {
        execFileSync(
          openssl,
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-keyout",
            join(directory, "test-key.pem"),
            "-out",
            join(directory, "test-cert.pem"),
          ],
          { windowsHide: true, stdio: "ignore" },
        );
        const server = createTlsServer(
          {
            key: readFileSync(join(directory, "test-key.pem")),
            cert: readFileSync(join(directory, "test-cert.pem")),
          },
          (socket) => {
            authenticatedConnections++;
            sockets.add(socket);
            socket.on("error", () => undefined);
            socket.write("220 synthetic TLS SMTP\r\n");
          },
        );
        server.on("tlsClientError", () => undefined);
        server.on("connection", (socket) => {
          connections++;
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test port");
        expect([3000, 3001, 3301, 3306, 5173, 5174]).not.toContain(address.port);
        const options = {
          host: "127.0.0.1",
          port: address.port,
          from: "fixture@example.invalid",
          publicAppOrigin: "https://example.invalid",
          secure: true,
          requireTls: false,
          auth: { username: "synthetic", password: "synthetic-password" },
        };
        try {
          if (kind === "security")
            await expect(
              new SmtpSecurityChangeMailer(options).sendSecurityChange({
                email: "recipient@example.invalid",
                kind: "password_changed",
                occurredAt: new Date(),
              }),
            ).resolves.toBe("failed");
          else
            await expect(
              new SmtpTemporaryPasswordReminderMailer(options).sendExpiryReminder(
                "recipient@example.invalid",
                new Date(),
              ),
            ).rejects.toThrow();
          expect(authenticatedConnections).toBe(0);
        } finally {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        expect(connections).toBeGreaterThanOrEqual(1);
      } finally {
        const absolute = resolve(directory);
        if (!absolute.startsWith(resolve(prefix)) || absolute === resolve(tmpdir()))
          throw new Error("Unsafe temporary cleanup path");
        rmSync(absolute, { recursive: true });
      }
    },
    15_000,
  );
  it.each(["security", "reminder"] as const)(
    "never sends credentials or mail when %s SMTP cannot upgrade to TLS",
    async (kind) => {
      const sockets = new Set<Socket>();
      const commands: string[] = [];
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);
        socket.write("220 synthetic SMTP\r\n");
        let pending = "";
        socket.on("data", (bytes) => {
          pending += bytes.toString();
          for (;;) {
            const end = pending.indexOf("\r\n");
            if (end < 0) break;
            const line = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const verb = line.split(" ")[0]!.toUpperCase();
            commands.push(verb);
            if (verb === "EHLO") socket.write("250-synthetic\r\n250 AUTH PLAIN LOGIN\r\n");
            else if (verb === "STARTTLS") socket.write("454 TLS unavailable\r\n");
            else if (verb === "QUIT") socket.end("221 bye\r\n");
            else socket.write("250 OK\r\n");
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      expect([3000, 3001, 3301, 3306, 5173, 5174]).not.toContain(address.port);
      const options = {
        host: "127.0.0.1",
        port: address.port,
        from: "fixture@example.invalid",
        publicAppOrigin: "https://example.invalid",
        secure: false,
        requireTls: true,
        auth: { username: "synthetic", password: "synthetic-password" },
      };
      try {
        if (kind === "security")
          await expect(
            new SmtpSecurityChangeMailer(options).sendSecurityChange({
              email: "recipient@example.invalid",
              kind: "password_changed",
              occurredAt: new Date(),
            }),
          ).resolves.toBe("failed");
        else
          await expect(
            new SmtpTemporaryPasswordReminderMailer(options).sendExpiryReminder(
              "recipient@example.invalid",
              new Date(),
            ),
          ).rejects.toThrow();
        expect(commands).toContain("EHLO");
        expect(commands).toContain("STARTTLS");
        expect(commands).not.toContain("AUTH");
        expect(commands).not.toContain("MAIL");
        expect(commands).not.toContain("DATA");
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    15_000,
  );
});
