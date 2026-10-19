import { describe, expect, it } from "vitest";

import { requireBootstrapSecret } from "./operator-bootstrap.js";

describe("operator bootstrap secret", () => {
  it("rejects placeholders, short values, and long repeated values", () => {
    expect(() => requireBootstrapSecret("replace-before-first-operator-bootstrap")).toThrow();
    expect(() => requireBootstrapSecret("too-short")).toThrow();
    expect(() => requireBootstrapSecret("A".repeat(64))).toThrow();
  });

  it("accepts a sufficiently diverse one-time secret", () => {
    expect(() =>
      requireBootstrapSecret("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH"),
    ).not.toThrow();
  });
});
