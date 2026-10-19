import { describe, expect, it } from "vitest";

import { canonicalDevelopmentUrl } from "./canonical-development-origin";

describe("canonicalDevelopmentUrl", () => {
  it("keeps the full route while replacing the loopback IP with localhost in development", () => {
    expect(canonicalDevelopmentUrl("http://127.0.0.1:5173/login?next=%2Fhome#form", true)).toBe(
      "http://localhost:5173/login?next=%2Fhome#form",
    );
  });

  it("does not redirect an already canonical localhost URL", () => {
    expect(canonicalDevelopmentUrl("http://localhost:5173/login", true)).toBeNull();
  });

  it("never rewrites an origin outside the development build", () => {
    expect(canonicalDevelopmentUrl("http://127.0.0.1:5173/login", false)).toBeNull();
  });
});
