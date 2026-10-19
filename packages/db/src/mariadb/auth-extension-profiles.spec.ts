import { describe, expect, it } from "vitest";

import { adminPasskeyGrants, socialLoginGrants } from "./auth-extension-grants.js";
import {
  requiredMariaDbRuntimeGrants,
  selectAppRuntimeGrantProfile,
  type MariaDbAuthDatabaseExtensions,
} from "./runtime-grant-extensions.js";

const combos: [boolean, MariaDbAuthDatabaseExtensions, string][] = [
  [false, "none", "app_help_chat_v1"],
  [false, "passkeys", "app_help_chat_passkeys_v1"],
  [false, "social", "app_help_chat_social_v1"],
  [false, "all", "app_help_chat_passkeys_social_v1"],
  [true, "none", "app_class_chat_v1"],
  [true, "passkeys", "app_class_chat_passkeys_v1"],
  [true, "social", "app_class_chat_social_v1"],
  [true, "all", "app_class_chat_passkeys_social_v1"],
];

describe("installed authentication extension profiles", () => {
  it.each(combos)(
    "classChat=%s auth=%s selects the fixed profile %s = base + exactly the installed grants",
    (classChat, auth, name) => {
      const profile = selectAppRuntimeGrantProfile({ classChat, auth });
      expect(profile).toBe(name);
      const grants = requiredMariaDbRuntimeGrants("app", profile)!;
      const base = requiredMariaDbRuntimeGrants(
        "app",
        classChat ? "app_class_chat_v1" : "app_help_chat_v1",
      )!;
      const extra = [
        ...(auth === "passkeys" || auth === "all" ? adminPasskeyGrants : []),
        ...(auth === "social" || auth === "all" ? socialLoginGrants : []),
      ];
      expect(grants).toEqual([...base, ...extra].sort());
      expect(new Set(grants).size).toBe(grants.length);
      expect(Object.isFrozen(grants)).toBe(true);
    },
  );

  // 2026-09-29: 사진(원장 96·97) 설치 여부까지 16개 고정 조합.
  it.each(combos)(
    "with profile photos installed, classChat=%s auth=%s adds exactly the photo grants to %s",
    (classChat, auth, name) => {
      const profile = selectAppRuntimeGrantProfile({ classChat, auth, profilePhotos: true });
      expect(profile).toBe(name.replace(/^app_(help|class)_chat/u, "app_$1_chat_photos"));
      const grants = requiredMariaDbRuntimeGrants("app", profile)!;
      const withoutPhotos = requiredMariaDbRuntimeGrants("app", name)!;
      const photoGrants = requiredMariaDbRuntimeGrants("app", "app_profile_photos_v1")!.filter(
        (grant) => !requiredMariaDbRuntimeGrants("app", "app_help_chat_v1")!.includes(grant),
      );
      expect(photoGrants.every((grant) => grant.startsWith("table|user_profile_photos|"))).toBe(
        true,
      );
      expect(grants).toEqual([...withoutPhotos, ...photoGrants].sort());
      expect(new Set(grants).size).toBe(grants.length);
      expect(Object.isFrozen(grants)).toBe(true);
    },
  );

  it("rejects anything outside the fixed combinations", () => {
    expect(() =>
      selectAppRuntimeGrantProfile({ classChat: false, auth: "everything" as never }),
    ).toThrow();
    expect(requiredMariaDbRuntimeGrants("app", "app_help_chat_admin_v1")).toBeUndefined();
    expect(requiredMariaDbRuntimeGrants("operator", "app_help_chat_passkeys_v1")).toBeUndefined();
    expect(requiredMariaDbRuntimeGrants("app", "toString")).toBeUndefined();
  });
});

describe("installed teacher library fixed profiles", () => {
  it.each([
    { classChat: false, auth: "none" as const },
    {
      classChat: true,
      auth: "all" as const,
      profilePhotos: true,
      birthDates: true,
      adminAccessLogs: true,
      pollEdit: true,
    },
  ])("adds exactly the reviewed three grants without changing the default", (installed) => {
    const base = selectAppRuntimeGrantProfile(installed);
    expect(selectAppRuntimeGrantProfile({ ...installed, teacherLibrary: false })).toBe(base);
    const selected = selectAppRuntimeGrantProfile({ ...installed, teacherLibrary: true });
    expect(selected).toBe(base.replace(/_v1$/u, "_teacherlibrary_v1"));
    const grants = requiredMariaDbRuntimeGrants("app", selected)!;
    expect(grants).toEqual(
      [
        ...requiredMariaDbRuntimeGrants("app", base)!,
        "table|teacher_library_items|DELETE|*",
        "table|teacher_library_items|INSERT|*",
        "table|teacher_library_items|SELECT|*",
      ].sort(),
    );
    expect(Object.isFrozen(grants)).toBe(true);
    expect(new Set(grants).size).toBe(grants.length);
  });
  it("rejects unreviewed suffixes and non-app roles", () => {
    expect(
      requiredMariaDbRuntimeGrants("app", "app_help_chat_teacherlibrary_admin_v1"),
    ).toBeUndefined();
    expect(
      requiredMariaDbRuntimeGrants("app", "app_help_chat_teacherlibrary_teacherlibrary_v1"),
    ).toBeUndefined();
    expect(
      requiredMariaDbRuntimeGrants("operator", "app_help_chat_teacherlibrary_v1"),
    ).toBeUndefined();
  });
});
