import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { loadEnvironment } from "./environment.js";

describe("EMAIL_HMAC_KEY_VERSION storage boundary", () => {
  it("accepts 64 characters and rejects 65 before events can be published", () => {
    expect(
      loadEnvironment({
        NODE_ENV: "development",
        EMAIL_HMAC_KEY_VERSION: "v.".repeat(32),
      }).EMAIL_HMAC_KEY_VERSION,
    ).toHaveLength(64);

    for (const invalid of ["v".repeat(65), "a".repeat(43), "has space", "version/1", "\nsecret"]) {
      try {
        loadEnvironment({
          NODE_ENV: "development",
          EMAIL_HMAC_KEY_VERSION: invalid,
        });
        throw new Error("환경 검증이 실패해야 합니다.");
      } catch (error) {
        expect(error).toBeInstanceOf(ZodError);
        expect((error as ZodError).issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: ["EMAIL_HMAC_KEY_VERSION"] })]),
        );
      }
    }
  });
});
