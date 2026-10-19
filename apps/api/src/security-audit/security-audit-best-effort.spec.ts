import { randomUUID } from "node:crypto";

import type { SecurityAuditEvent } from "@classhub/db";
import { describe, expect, it, vi } from "vitest";

import { publishSecurityAuditBestEffort } from "./security-audit-best-effort.js";

function event(): SecurityAuditEvent {
  return {
    version: 1,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    actor_user_id: null,
    actor_email_hmac: null,
    hmac_key_version: null,
    actor_ip: "127.0.0.1",
    actor_class_id: null,
    target_class_id: null,
    action: "rate_limited",
    resource: "auth",
    sanitized_path: "/api/v1/auth/sign-up",
    method: "POST",
    deny_reason: "rate_limited",
    failure_code: null,
    request_id: randomUUID(),
    user_agent: "test-agent",
  };
}

describe("publishSecurityAuditBestEffort", () => {
  it("resolves when the injected publisher rejects", async () => {
    const publisher = {
      close: vi.fn(),
      publish: vi.fn().mockRejectedValue(new Error("transport secret")),
    };

    await expect(publishSecurityAuditBestEffort(publisher, event())).resolves.toBeUndefined();
    expect(publisher.publish).toHaveBeenCalledOnce();
  });

  it("resolves when the injected publisher throws synchronously", async () => {
    const publisher = {
      close: vi.fn(),
      publish: vi.fn(() => {
        throw new Error("synchronous transport failure");
      }),
    };

    await expect(
      publishSecurityAuditBestEffort(publisher as never, event()),
    ).resolves.toBeUndefined();
    expect(publisher.publish).toHaveBeenCalledOnce();
  });
});
