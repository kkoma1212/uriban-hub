import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";

import type { AppEnvironment } from "../config/environment.js";
import { AuthService } from "./auth.service.js";
import type { SignUpCommand } from "./auth.types.js";

// 2026-10-02 사용자 결정(P-025②·P-021): 시범 동안 만 14세 미만(보호자 동의) 새 가입을 닫는다.
function service(enabled: boolean | undefined) {
  const environment = new ConfigService<AppEnvironment, true>(
    enabled === undefined ? {} : { UNDER_14_SIGNUP_ENABLED: enabled },
  );
  const limiter = { consume: vi.fn(), consumeAll: vi.fn() };
  const mailer = { sendGuardianConsentEmail: vi.fn(), sendVerificationEmail: vi.fn() };
  return {
    auth: new AuthService(
      {} as never,
      limiter as never,
      mailer as never,
      { emailHmacKey: "synthetic-under-14-key", emailHmacKeyVersion: "qa" } as never,
      { close: vi.fn(), publish: vi.fn() } as never,
      environment,
    ),
    limiter,
    mailer,
  };
}

const guardianSignup = {
  role: "student",
  age_route: "guardian_consent",
  email: "child@example.invalid",
  display_name: "시험 학생",
  password: "Safe1!x8",
  consents: { terms: true, privacy: true },
  guardian_consent: { request_id: "00000000-0000-4000-8000-000000000000", completion_token: "x" },
} as unknown as SignUpCommand;

describe("under-14 signup switch", () => {
  it("is closed by the environment and refuses guardian requests and signups before any work", async () => {
    const { auth, limiter, mailer } = service(false);
    expect(auth.signUpOptions()).toMatchObject({ under_14_signup: false });
    await expect(
      auth.requestGuardianConsent("parent@example.invalid", "203.0.113.1"),
    ).rejects.toMatchObject({ response: { code: "UNDER_14_SIGNUP_CLOSED" } });
    await expect(auth.signUp(guardianSignup, "203.0.113.1")).rejects.toMatchObject({
      response: { code: "UNDER_14_SIGNUP_CLOSED" },
    });
    expect(limiter.consume).not.toHaveBeenCalled();
    expect(mailer.sendGuardianConsentEmail).not.toHaveBeenCalled();
  });

  it("stays open when the environment opens it", () => {
    expect(service(true).auth.signUpOptions()).toMatchObject({ under_14_signup: true });
  });
});
