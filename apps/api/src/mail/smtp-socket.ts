import { createConnection, type Socket } from "node:net";

// Use the OS resolver (including Windows hosts/VPN DNS) instead of a separate DNS client.
// The deadline includes name resolution, which Nodemailer's TCP timeout does not cover.
export function connectSmtpSocket(
  options: {
    host?: string | undefined;
    port?: number | undefined;
    connectionTimeout?: number | undefined;
  },
  callback: (error: Error | null, result: { connection: Socket } | false) => void,
): void {
  const socket = createConnection({
    host: (options.host ?? "localhost").replace(/^\[|\]$/gu, ""),
    port: options.port ?? 587,
  });
  let settled = false;
  const fail = (cause: NodeJS.ErrnoException) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    socket.destroy();
    callback(
      Object.assign(new Error("SMTP connection failed."), {
        code: cause.code === "ETIMEDOUT" ? "ETIMEDOUT" : "ECONNECTION",
      }),
      false,
    );
  };
  const deadline = setTimeout(
    () => fail(Object.assign(new Error("SMTP connection timed out."), { code: "ETIMEDOUT" })),
    options.connectionTimeout ?? 5_000,
  );
  socket.once("error", fail);
  socket.once("connect", () => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    socket.removeListener("error", fail);
    // Nodemailer retains the original hostname and performs STARTTLS or implicit TLS.
    // Do not mark this plain TCP socket as already secured.
    callback(null, { connection: socket });
  });
}
