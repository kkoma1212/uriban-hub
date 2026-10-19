import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { SecurityAuditProcessingSnapshot } from "./security-audit/processing-status.js";

export const WORKER_READINESS_RESPONSE_TIMEOUT_MS = 1_500;

export interface WorkerReadinessProbes {
  database: () => Promise<void>;
  redis: () => Promise<void>;
}

export interface WorkerHealthServerOptions {
  host: string;
  port: number;
  probes: WorkerReadinessProbes;
  responseTimeoutMs?: number;
  processingSnapshot?: () => SecurityAuditProcessingSnapshot;
}

type HealthResponse =
  | { status: "method_not_allowed" }
  | { status: "not_found" }
  | { status: "not_ready" }
  | { status: "ok" }
  | { status: "ready" };

function settleBeforeDeadline(result: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    if (typeof timeout === "object") timeout.unref();
  });

  return Promise.race([result, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: HealthResponse | SecurityAuditProcessingSnapshot,
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(serialized),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(serialized);
}

export class WorkerHealthServer {
  private readonly host: string;
  private inFlightProbe: Promise<boolean> | undefined;
  private ready = false;
  private readonly responseTimeoutMs: number;
  private readonly server: Server;
  private stopping = false;

  constructor(private readonly options: WorkerHealthServerOptions) {
    if (options.host.length === 0) {
      throw new RangeError("Worker health host must not be empty.");
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new RangeError("Worker health port must be an integer from 0 through 65535.");
    }

    const responseTimeoutMs = options.responseTimeoutMs ?? WORKER_READINESS_RESPONSE_TIMEOUT_MS;
    if (!Number.isInteger(responseTimeoutMs) || responseTimeoutMs <= 0) {
      throw new RangeError("Worker readiness response timeout must be a positive integer.");
    }

    this.host = options.host;
    this.responseTimeoutMs = responseTimeoutMs;
    this.server = createServer((request, response) => {
      void this.handleRequest(request.method, request.url, request.socket.remoteAddress, response);
    });
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Worker health server is not listening.");
    }
    return (address as AddressInfo).port;
  }

  listen(): Promise<void> {
    if (this.server.listening) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const handleError = (error: Error): void => {
        this.server.off("listening", handleListening);
        reject(error);
      };
      const handleListening = (): void => {
        this.server.off("error", handleError);
        resolve();
      };

      this.server.once("error", handleError);
      this.server.once("listening", handleListening);
      this.server.listen({
        exclusive: true,
        host: this.host,
        port: this.options.port,
      });
    });
  }

  markReady(): void {
    if (!this.stopping) this.ready = true;
  }

  markNotReady(): void {
    this.ready = false;
  }

  markStopping(): void {
    this.stopping = true;
    this.ready = false;
  }

  async close(): Promise<void> {
    this.markStopping();
    if (!this.server.listening) return;

    this.server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }

  private async handleRequest(
    method: string | undefined,
    requestUrl: string | undefined,
    remoteAddress: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    if (method !== "GET") {
      response.setHeader("allow", "GET");
      sendJson(response, 405, { status: "method_not_allowed" });
      return;
    }

    const pathname = requestUrl?.split("?", 1)[0];
    // A public bind or a forwarded header must never expose operational details.
    if (
      pathname === "/processingz" &&
      (this.host === "127.0.0.1" || this.host === "::1") &&
      (remoteAddress === "127.0.0.1" ||
        remoteAddress === "::1" ||
        remoteAddress === "::ffff:127.0.0.1") &&
      this.options.processingSnapshot !== undefined
    ) {
      try {
        const snapshot = this.options.processingSnapshot();
        sendJson(response, snapshot.status === "ok" ? 200 : 503, snapshot);
      } catch {
        sendJson(response, 503, { status: "not_ready" });
      }
      return;
    }
    if (pathname === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (pathname === "/readyz") {
      const ready = await this.isReady();
      sendJson(response, ready ? 200 : 503, {
        status: ready ? "ready" : "not_ready",
      });
      return;
    }

    sendJson(response, 404, { status: "not_found" });
  }

  private async isReady(): Promise<boolean> {
    if (!this.ready || this.stopping) return false;

    const dependenciesReady = await settleBeforeDeadline(
      this.getOrStartProbe(),
      this.responseTimeoutMs,
    );
    return dependenciesReady && this.ready && !this.stopping;
  }

  private getOrStartProbe(): Promise<boolean> {
    if (this.inFlightProbe !== undefined) return this.inFlightProbe;

    const probe = Promise.allSettled([
      Promise.resolve().then(this.options.probes.database),
      Promise.resolve().then(this.options.probes.redis),
    ]).then((results) => results.every((result) => result.status === "fulfilled"));
    this.inFlightProbe = probe;

    void probe.finally(() => {
      if (this.inFlightProbe === probe) this.inFlightProbe = undefined;
    });
    return probe;
  }
}
