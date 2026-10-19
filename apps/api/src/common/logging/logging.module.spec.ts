import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import { pinoHttp } from "pino-http";
import { describe, expect, it } from "vitest";

import { recordHttpRequestFailureForLog, registerHttpRequestForLog } from "./http-observability.js";
import { createPinoHttpOptions } from "./logging.module.js";

describe("production Pino HTTP wiring", () => {
  it("distinguishes success, denial, failure, delay, and recovery without personal data", async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const requestLogger = pinoHttp(createPinoHttpOptions("info"), destination);
    const server = createServer((request, response) => {
      const requestWithApplicationData = request as typeof request & {
        body: { password: string };
        id: string;
        query: { q: string; token: string };
        routeOptions: { url: string };
      };
      const path = request.url?.split("?", 1)[0] ?? "/";
      const probe =
        path === "/denied"
          ? {
              failureCode: "ROLE_INSUFFICIENT",
              id: "00000000-0000-4000-8000-000000000002",
              route: "/api/v1/notices/:id",
              status: 403,
            }
          : path === "/failed"
            ? {
                failureCode: "HOME_UNAVAILABLE",
                id: "00000000-0000-4000-8000-000000000003",
                route: "/api/v1/home",
                status: 503,
              }
            : path === "/delayed"
              ? {
                  id: "00000000-0000-4000-8000-000000000004",
                  route: "/api/v1/home",
                  status: 200,
                }
              : path === "/recovered"
                ? {
                    id: "00000000-0000-4000-8000-000000000005",
                    route: "/api/v1/home",
                    status: 200,
                  }
                : {
                    id: "00000000-0000-4000-8000-000000000001",
                    route: "/api/v1/home",
                    status: 200,
                  };
      requestWithApplicationData.id = probe.id;
      requestWithApplicationData.routeOptions = { url: probe.route };
      requestWithApplicationData.body = { password: "body-secret" };
      requestWithApplicationData.query = {
        q: "private-student-name",
        token: "query-secret",
      };
      registerHttpRequestForLog(requestWithApplicationData);
      if (probe.failureCode !== undefined) {
        recordHttpRequestFailureForLog(requestWithApplicationData, probe.failureCode);
      }
      requestLogger(requestWithApplicationData, response);
      response.statusCode = probe.status;
      const finish = () => response.end("ok");
      if (path === "/delayed") setTimeout(finish, 20);
      else finish();
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const { port } = server.address() as AddressInfo;
      for (const path of ["/ok", "/denied", "/failed", "/delayed", "/recovered"]) {
        await new Promise<void>((resolve, reject) => {
          const request = httpRequest(
            {
              headers: {
                authorization: "Bearer auth-secret",
                baggage: "student=private-student-name",
                cookie: "session=cookie-secret",
                "proxy-authorization": "Bearer proxy-secret",
                "x-api-key": "api-secret",
                "x-csrf-token": "csrf-secret",
                "x-local-admin-csrf": "local-admin-secret",
                "x-student-email": "student@example.invalid",
              },
              host: "127.0.0.1",
              method: "GET",
              path: `${path}?token=query-secret&q=private-student-name`,
              port,
            },
            (response) => {
              response.resume();
              response.once("end", resolve);
            },
          );
          request.once("error", reject);
          request.end();
        });
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }

    const rawLines = lines
      .join("")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    const records = rawLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const completionRecords = records.filter((entry) => entry.action === "http.request.completed");
    const byRequestId = new Map(
      completionRecords.map((entry) => [entry.request_id as string, entry]),
    );
    const serialized = JSON.stringify(completionRecords);

    expect(completionRecords).toHaveLength(5);
    expect(byRequestId.get("00000000-0000-4000-8000-000000000001")).toMatchObject({
      level: 30,
      outcome: "success",
      route: "/api/v1/home",
      status_code: 200,
      user_impact: "none",
    });
    expect(byRequestId.get("00000000-0000-4000-8000-000000000002")).toMatchObject({
      failure_code: "ROLE_INSUFFICIENT",
      level: 40,
      outcome: "denied",
      route: "/api/v1/notices/:id",
      status_code: 403,
      user_impact: "access_denied",
    });
    expect(byRequestId.get("00000000-0000-4000-8000-000000000003")).toMatchObject({
      failure_code: "HOME_UNAVAILABLE",
      level: 50,
      outcome: "failed",
      route: "/api/v1/home",
      status_code: 503,
      user_impact: "request_failed",
    });
    expect(
      byRequestId.get("00000000-0000-4000-8000-000000000004")?.duration_ms,
    ).toBeGreaterThanOrEqual(10);
    expect(byRequestId.get("00000000-0000-4000-8000-000000000005")).toMatchObject({
      failure_code: null,
      outcome: "success",
      route: "/api/v1/home",
      status_code: 200,
    });
    for (const record of completionRecords) {
      // 장애 때 이 줄만 보고 어느 서비스·어느 배포본인지 짚을 수 있어야 한다.
      expect(record).toMatchObject({
        environment: expect.any(String),
        image_digest: expect.any(String),
        instance_id: expect.any(String),
        release_id: expect.any(String),
        service: "api",
      });
      expect(record).not.toHaveProperty("req");
      expect(record).not.toHaveProperty("res");
      expect(record).not.toHaveProperty("err");
      expect(record).not.toHaveProperty("hostname");
      expect(record).not.toHaveProperty("pid");
      expect(record).not.toHaveProperty("responseTime");
      expect(record).not.toHaveProperty("remoteAddress");
      expect(record).not.toHaveProperty("remotePort");
    }
    for (const line of rawLines) {
      expect(line.match(/"request_id":/gu)).toHaveLength(1);
    }
    expect(serialized).not.toContain("auth-secret");
    expect(serialized).not.toContain("cookie-secret");
    expect(serialized).not.toContain("csrf-secret");
    expect(serialized).not.toContain("local-admin-secret");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("private-student-name");
    expect(serialized).not.toContain("body-secret");
    expect(serialized).not.toContain("proxy-secret");
    expect(serialized).not.toContain("api-secret");
    expect(serialized).not.toContain("student@example.invalid");
  });
});
