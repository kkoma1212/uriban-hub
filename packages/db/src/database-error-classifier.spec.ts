import { describe, expect, it } from "vitest";

import {
  matchesDatabaseConstraint,
  postgresDatabaseErrorClassifier,
  type DatabaseErrorClassifier,
} from "./database-error-classifier.js";

function postgresError(
  code: string,
  constraint?: string,
): Error & {
  code: string;
  constraint?: string;
} {
  return Object.assign(new Error(`private SQL detail for ${code}`), {
    code,
    ...(constraint === undefined ? {} : { constraint }),
    connectionString: "postgresql://secret@private-db/classhub",
  });
}

describe("postgresDatabaseErrorClassifier", () => {
  it.each([
    ["40P01", "deadlock"],
    ["40001", "serialization_failure"],
    ["23505", "unique_violation"],
    ["23503", "foreign_key_violation"],
  ] as const)("classifies PostgreSQL %s as %s", (code, kind) => {
    expect(postgresDatabaseErrorClassifier.classify(postgresError(code))).toEqual({
      kind,
      vendorCode: code,
    });
  });

  it("copies only the safe constraint name and vendor code", () => {
    const classified = postgresDatabaseErrorClassifier.classify(
      postgresError("23505", "users_email_normalized_unique"),
    );

    expect(classified).toEqual({
      kind: "unique_violation",
      objectName: "users_email_normalized_unique",
      vendorCode: "23505",
    });
    expect(classified).not.toHaveProperty("message");
    expect(classified).not.toHaveProperty("connectionString");
    expect(classified).not.toHaveProperty("cause");
  });

  it.each([null, "23505", { code: 23_505 }, { code: "99999" }, new Error("boom")])(
    "fails closed for an unsupported value",
    (error) => {
      expect(postgresDatabaseErrorClassifier.classify(error)).toEqual({ kind: "unknown" });
    },
  );
});

describe("matchesDatabaseConstraint", () => {
  it("matches a known kind and exact object name", () => {
    expect(
      matchesDatabaseConstraint(postgresError("23505", "classes_active_identity_unique"), {
        kind: "unique_violation",
        objectName: "classes_active_identity_unique",
      }),
    ).toBe(true);
  });

  it("fails closed when a required object name is absent or different", () => {
    expect(
      matchesDatabaseConstraint(postgresError("23505"), {
        kind: "unique_violation",
        objectName: "classes_active_identity_unique",
      }),
    ).toBe(false);
    expect(
      matchesDatabaseConstraint(postgresError("23505", "another_constraint"), {
        kind: "unique_violation",
        objectName: "classes_active_identity_unique",
      }),
    ).toBe(false);
  });

  it("accepts an injected future database adapter without inspecting the raw error", () => {
    const mariaDbClassifier: DatabaseErrorClassifier = {
      classify: () => ({
        kind: "unique_violation",
        objectName: "classes_active_identity_unique",
        vendorCode: "ER_DUP_ENTRY",
      }),
    };

    expect(
      matchesDatabaseConstraint(
        new Error("driver-specific private text"),
        {
          kind: "unique_violation",
          objectName: "classes_active_identity_unique",
        },
        mariaDbClassifier,
      ),
    ).toBe(true);
  });
});
