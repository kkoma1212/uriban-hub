import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredMariaDbRuntimeGrants } from "./runtime-grant-extensions.js";

describe("prepared profile photo grants", () => {
  it("preserves the active profile and adds only the new table's necessary privileges", () => {
    const previous = requiredMariaDbRuntimeGrants("app", "app_help_chat_v1")!;
    const next = requiredMariaDbRuntimeGrants("app", "app_profile_photos_v1")!;
    expect(previous.every((grant) => next.includes(grant))).toBe(true);
    expect(next.filter((grant) => !previous.includes(grant))).toEqual([
      "table|user_profile_photos|DELETE|*",
      "table|user_profile_photos|INSERT|*",
      "table|user_profile_photos|SELECT|*",
      "table|user_profile_photos|UPDATE|image_bytes",
      "table|user_profile_photos|UPDATE|photo_version",
      "table|user_profile_photos|UPDATE|updated_at",
    ]);
    expect(Object.isFrozen(next)).toBe(true);
    for (const role of ["operator", "worker", "retention", undefined])
      expect(requiredMariaDbRuntimeGrants(role, "app_profile_photos_v1")).toBeUndefined();
    expect(requiredMariaDbRuntimeGrants("app", "app_help_chat_v1")).toEqual(previous);
  });
  it("prepares the same 64,000-byte bound and no new operating-user/definer privileges", () => {
    const sql = readFileSync(
      new URL("../../../../db/mariadb/migrations/0053_profile_photos.sql", import.meta.url),
      "utf8",
    );
    const pg = readFileSync(
      new URL("../../../../db/migrations/1783700059000_profile-photos.sql", import.meta.url),
      "utf8",
    );
    const acl = readFileSync(
      new URL("../../../../db/mariadb/permissions/0053_profile_photos_acl.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("image_bytes VARBINARY(64000) NOT NULL");
    expect(sql).toContain("BETWEEN 1 AND 64000");
    expect(pg).toContain("image_bytes BYTEA NOT NULL");
    expect(pg).toContain("BETWEEN 1 AND 64000");
    expect(sql).toContain("ON DELETE CASCADE");
    expect(acl).not.toMatch(/classhub_routine|GRANT.*ON.*users|TRIGGER|EXECUTE/u);
    expect(acl).toContain("runtimeActivationApplied=false");
  });
});
