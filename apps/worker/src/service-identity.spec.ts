import { hostname } from "node:os";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { readServiceIdentity } from "./service-identity.js";

describe("worker service identity for logs", () => {
  it("carries what the deployment supplies", () => {
    expect(
      readServiceIdentity("worker", {
        IMAGE_DIGEST: "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
        INSTANCE_ID: "classhub-worker-51a2b3",
        NODE_ENV: "production",
        RELEASE_ID: "2026.08.06-1",
      }),
    ).toEqual({
      environment: "production",
      image_digest: "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
      instance_id: "classhub-worker-51a2b3",
      release_id: "2026.08.06-1",
      service: "worker",
    });
  });

  it("says unknown rather than dropping the field when the deployment supplies nothing", () => {
    expect(readServiceIdentity("worker", {})).toMatchObject({
      environment: "unknown",
      image_digest: "unknown",
      instance_id: hostname(),
      release_id: "unknown",
      service: "worker",
    });
  });

  it("refuses values that would break a log line into two", () => {
    const identity = readServiceIdentity("worker", {
      IMAGE_DIGEST: 'sha256:abc\n{"level":30,"msg":"injected"}',
      INSTANCE_ID: "a".repeat(201),
      NODE_ENV: "production\r\n",
      RELEASE_ID: "  2026.08.06-1  ",
    });

    expect(identity.image_digest).toBe("unknown");
    expect(identity.instance_id).toBe(hostname());
    expect(identity.environment).toBe("production");
    expect(identity.release_id).toBe("2026.08.06-1");
  });

  it("stamps every emitted line and drops the pino defaults", () => {
    /*
     * main.ts와 같은 방식으로 로거를 만들어, 실제로 나가는 줄에 필드가 붙는지 확인한다.
     * 신원 필드는 설정만으로는 확인되지 않는다 — 나간 줄을 봐야 한다.
     */
    const lines: string[] = [];
    const logger = pino(
      { base: readServiceIdentity("worker"), level: "info" },
      { write: (line: string) => lines.push(line) },
    );

    logger.info({ action: "security_audit.worker_cycle_failed" }, "cycle failed");

    const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(record).toMatchObject({
      action: "security_audit.worker_cycle_failed",
      environment: expect.any(String),
      image_digest: expect.any(String),
      instance_id: expect.any(String),
      release_id: expect.any(String),
      service: "worker",
    });
    expect(record).not.toHaveProperty("pid");
    expect(record).not.toHaveProperty("hostname");
  });
});
