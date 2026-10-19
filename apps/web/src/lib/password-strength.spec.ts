import { describe, expect, it } from "vitest";

import { newPasswordSchema } from "./password-policy";
import { getPasswordStrength } from "./password-strength";

describe("local advisory password strength", () => {
  it("hides empty input and uses normalized Unicode length", () => {
    expect(getPasswordStrength("")).toBeNull();
    expect(getPasswordStrength("Sky12")).toBe("weak");
    expect(getPasswordStrength("Cloud1")).toBe("moderate");
    expect(getPasswordStrength("e\u0301tangolongivelo")).toBe(
      getPasswordStrength("étangolongivelo"),
    );
  });

  it("applies the documented length and character-kind thresholds", () => {
    expect(getPasswordStrength("rainy7")).toBe("moderate");
    expect(getPasswordStrength("Cedar#72")).toBe("safe");
    expect(getPasswordStrength("orchards beside sea")).toBe("weak");
    expect(getPasswordStrength("orchards beside seas")).toBe("weak");
    expect(getPasswordStrength("우리집정원에는노란꽃이피고새들이노래해요")).toBe("weak");
  });

  it.each([
    "a".repeat(6),
    "ab".repeat(3),
    "Ab1!".repeat(2),
    "가나다".repeat(2),
    "admin12",
    "qwerty12",
    "12345678",
    "abcdef",
    "abc123!",
  ])("marks simple and repeated input as weak independently of composition: %s", (candidate) => {
    expect(newPasswordSchema.safeParse(candidate).success).toBe(
      /\p{L}/u.test(candidate) && /\p{N}/u.test(candidate),
    );
    expect(getPasswordStrength(candidate)).toBe("weak");
  });

  it("never calls invalid new-password input safe", () => {
    expect(getPasswordStrength("BlueRiverSunset7!\u200B")).toBe("weak");
    expect(getPasswordStrength("BlueRiverSunset7!".repeat(5))).toBe("weak");
  });
});
