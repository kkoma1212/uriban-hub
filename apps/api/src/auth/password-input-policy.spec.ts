import { describe, expect, it } from "vitest";

import { PASSWORD_BLOCKLIST_V1 } from "./password-blocklist-v1.js";
import { PASSWORD_BLOCKLIST_V2 } from "./password-blocklist-v2.js";
import { hashPassword, verifyPassword } from "./password-hasher.js";
import {
  evaluateNewPassword,
  LEGACY_PASSWORD_INPUT_VERSION,
  NFC_PASSWORD_INPUT_VERSION,
  passwordForVerification,
} from "./password-input-policy.js";

describe("new password input policy", () => {
  it("keeps the six-character minimum for members and requires twelve for administrators", () => {
    // 2026-10-02 사용자 결정: 일반 6자 유지, 관리자만 새 비밀번호 12자 이상.
    const context = { accountType: "administrator" } as const;
    expect(evaluateNewPassword("Maple#72", context)).toEqual({ ok: false, reason: "length" });
    expect(evaluateNewPassword("Maple#723Cedar", context).ok).toBe(true);
    expect(evaluateNewPassword("Maple#72").ok).toBe(true);
    expect(evaluateNewPassword("Sky12", context)).toEqual({ ok: false, reason: "length" });
    expect(evaluateNewPassword("구름별하늘1", context)).toEqual({ ok: false, reason: "length" });
    expect(evaluateNewPassword("구름별하늘과바다숲길12", context).ok).toBe(true);
    expect(evaluateNewPassword("구름별하늘1").ok).toBe(true);
    expect(evaluateNewPassword("Sky12")).toEqual({ ok: false, reason: "length" });
    expect(evaluateNewPassword("123456789123456", context)).toEqual({
      ok: false,
      reason: "blocked",
    });
  });

  it("normalizes NFC before counting and returns the normalized value", () => {
    const decomposed = "e\u0301".repeat(5) + "1";
    expect(evaluateNewPassword(decomposed)).toEqual({
      normalizedPassword: "é".repeat(5) + "1",
      ok: true,
    });
  });

  it("counts Unicode code points and permits long passwords without a maximum", () => {
    expect(evaluateNewPassword("a12🧑‍🏫")).toEqual({
      ok: false,
      reason: "disallowed_character",
    });
    expect(evaluateNewPassword("😀".repeat(4) + "a1").ok).toBe(true);
    expect(evaluateNewPassword("😀".repeat(6) + "a1").ok).toBe(true);
    expect(evaluateNewPassword("😀".repeat(7) + "a1").ok).toBe(true);
    expect(evaluateNewPassword("봄날의하늘7!".repeat(128)).ok).toBe(true);
  });

  it("allows Korean, spaces and symbols while requiring letters and numbers", () => {
    expect(evaluateNewPassword("한글 쉼표1!").ok).toBe(true);
    expect(evaluateNewPassword("푸른구름가나다")).toEqual({ ok: false, reason: "composition" });
    expect(evaluateNewPassword("９９９９９９!")).toEqual({ ok: false, reason: "composition" });
  });

  it.each(["safe1\n", "safe1\u0000", "safe1\u200B"])(
    "rejects invisible or control input without echoing it: %j",
    (candidate) => {
      expect(evaluateNewPassword(candidate)).toEqual({
        ok: false,
        reason: "disallowed_character",
      });
    },
  );

  it("retains long blocked passwords when expanding the list to the current minimum", () => {
    const blocked = "123456789123456";
    expect(PASSWORD_BLOCKLIST_V2.has(blocked)).toBe(true);
    expect(evaluateNewPassword(blocked)).toEqual({ ok: false, reason: "blocked" });
  });

  it("preserves every previously blocked value when updating the source list", () => {
    for (const password of PASSWORD_BLOCKLIST_V1) {
      expect(evaluateNewPassword(password)).toEqual({ ok: false, reason: "blocked" });
    }
  });

  it.each(["abc123", "qwerty1", "password1", "Password123", "qwertyuiop1234567890"])(
    "blocks known common passwords within the supported length range: %s",
    (password) => expect(evaluateNewPassword(password)).toEqual({ ok: false, reason: "blocked" }),
  );

  it("matches complete values without substring rejection or trimming", () => {
    expect(evaluateNewPassword("abc123 밤하늘 다람쥐").ok).toBe(true);
    expect(evaluateNewPassword(" abc123 ").ok).toBe(true);
  });

  it("does not retroactively prevent verification of an existing password", async () => {
    const existing = await hashPassword("abc123");
    expect(evaluateNewPassword("abc123").ok).toBe(false);
    await expect(verifyPassword("abc123", existing)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password1", existing)).resolves.toBe(false);
  });

  it("blocks exact values directly derived from product and account identity", () => {
    expect(evaluateNewPassword("classhubclasshub")).toEqual({ ok: false, reason: "blocked" });
    expect(
      evaluateNewPassword("Cloud1", {
        displayName: "학생",
        email: "Cloud1@example.com",
      }),
    ).toEqual({ ok: false, reason: "blocked" });
    expect(
      evaluateNewPassword("학생123학생123", {
        displayName: "학생123",
      }),
    ).toEqual({ ok: false, reason: "blocked" });
  });
});

describe("password verification preprocessing", () => {
  const decomposed = "e\u0301-password-value";

  it("preserves legacy input exactly", () => {
    expect(passwordForVerification(decomposed, LEGACY_PASSWORD_INPUT_VERSION)).toBe(decomposed);
  });

  it("normalizes nfc_v1 exactly once before hashing", () => {
    expect(passwordForVerification(decomposed, NFC_PASSWORD_INPUT_VERSION)).toBe(
      decomposed.normalize("NFC"),
    );
  });

  it("fails closed for an unknown stored version", () => {
    expect(passwordForVerification(decomposed, "future_v2")).toBeNull();
  });
});
