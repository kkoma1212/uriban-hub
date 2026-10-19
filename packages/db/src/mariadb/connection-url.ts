import { isIP } from "node:net";

/** Decode connection identity without forwarding URL options to the SQL driver. */
export function parseMariaDbUrl(value: string, expectedUsername?: string) {
  try {
    const url = new URL(value);
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    const port = url.port === "" ? 3306 : Number(url.port);
    if (
      !["mariadb:", "mysql:"].includes(url.protocol) ||
      !url.hostname ||
      isIP(url.hostname.replace(/^\[|\]$/gu, "")) !== 0 ||
      !/^[A-Za-z0-9.-]+$/u.test(url.hostname) ||
      !/^[A-Za-z0-9_]+$/u.test(user) ||
      !/^[A-Za-z0-9_]+$/u.test(database) ||
      password.length === 0 ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      url.search !== "" ||
      url.hash !== "" ||
      (expectedUsername !== undefined && user !== expectedUsername)
    ) {
      throw new Error("invalid");
    }
    return { host: url.hostname, port, user, password, database };
  } catch {
    // Never include the URL, password, or parser's original error in configuration errors.
    throw new Error(
      "MariaDB DATABASE_URL requires a DNS host, explicit account/password/database, and no URL options.",
    );
  }
}
