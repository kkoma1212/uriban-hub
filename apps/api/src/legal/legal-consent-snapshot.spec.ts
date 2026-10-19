import { describe, expect, it } from "vitest";
import {
  CONSENT_DOCUMENT_TYPES,
  parseLegalConsentSnapshot,
  requireLegalConsentSnapshot,
  sameLegalConsentSnapshot,
  type LegalConsentSnapshot,
} from "./legal-consent-snapshot.js";

export const snapshot = Object.fromEntries(
  CONSENT_DOCUMENT_TYPES.map((type, index) => [
    type,
    {
      id: `00000000-0000-4000-8000-00000000000${index}`,
      policy_version: type + "-1",
      content_sha256: String(index).repeat(64),
    },
  ]),
) as LegalConsentSnapshot;

describe("four document consent evidence", () => {
  it("accepts a database JSON value or MariaDB JSON text without depending on key order", () => {
    expect(parseLegalConsentSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(
      sameLegalConsentSnapshot(Object.fromEntries(Object.entries(snapshot).reverse()), snapshot),
    ).toBe(true);
  });
  it.each(CONSENT_DOCUMENT_TYPES)("rejects a missing %s document", (type) => {
    const value: Record<string, unknown> = { ...snapshot };
    delete value[type];
    expect(parseLegalConsentSnapshot(value)).toBeNull();
  });
  it.each(CONSENT_DOCUMENT_TYPES)(
    "rejects a changed %s hash, even if the version label is unchanged",
    (type) => {
      const changed = {
        ...snapshot,
        [type]: { ...snapshot[type], content_sha256: "f".repeat(64) },
      };
      expect(() => requireLegalConsentSnapshot(snapshot, changed)).toThrow();
    },
  );
  it.each([
    null,
    undefined,
    "broken",
    {},
    { ...snapshot, extra: true },
    { ...snapshot, terms: { ...snapshot.terms, content_sha256: "a".repeat(63) } },
    { ...snapshot, terms: { ...snapshot.terms, id: "not-a-version-id" } },
  ])("rejects malformed evidence without filling gaps from today's documents", (value) => {
    expect(parseLegalConsentSnapshot(value)).toBeNull();
    expect(sameLegalConsentSnapshot(value, snapshot)).toBe(false);
  });
});
