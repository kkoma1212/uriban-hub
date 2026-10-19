import { describe, expect, it } from "vitest";
import { profilePhotosEnabled } from "./profile-photo.config.js";
describe("photo opt-in", () => {
  it("keeps an absent/false flag off", () => {
    expect(profilePhotosEnabled({})).toBe(false);
    expect(profilePhotosEnabled({ PROFILE_PHOTOS_ENABLED: "false" })).toBe(false);
    expect(profilePhotosEnabled({ PROFILE_PHOTOS_ENABLED: "true" })).toBe(true);
  });
  it.each([true, 1, "1", null, "TRUE"])("rejects an ambiguous switch", (value) => {
    expect(() => profilePhotosEnabled({ PROFILE_PHOTOS_ENABLED: value })).toThrow(TypeError);
  });
});
