export type DatabaseErrorKind =
  | "deadlock"
  | "foreign_key_violation"
  | "lock_timeout"
  | "serialization_failure"
  | "unique_violation"
  | "unknown";

/**
 * A privacy-safe database error summary. Raw driver errors, SQL text, values,
 * connection details, and causal chains must never be copied into this value.
 */
export interface ClassifiedDatabaseError {
  kind: DatabaseErrorKind;
  objectName?: string;
  vendorCode?: string;
}

export interface DatabaseErrorClassifier {
  classify(error: unknown): ClassifiedDatabaseError;
}

function optionalStringProperty(error: object, property: string): string | undefined {
  const value = (error as Record<string, unknown>)[property];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Current production default. A MariaDB classifier will be supplied by the
 * future driver adapter after its exact runtime error shape is captured in the
 * pinned container; guessing from human-readable messages is deliberately not
 * part of this PostgreSQL-compatible seam.
 */
export const postgresDatabaseErrorClassifier: DatabaseErrorClassifier = {
  classify(error): ClassifiedDatabaseError {
    if ((typeof error !== "object" || error === null) && typeof error !== "function") {
      return { kind: "unknown" };
    }

    const code = optionalStringProperty(error, "code");
    const objectName = optionalStringProperty(error, "constraint");
    let kind: DatabaseErrorKind;

    switch (code) {
      case "23503": {
        kind = "foreign_key_violation";
        break;
      }
      case "23505": {
        kind = "unique_violation";
        break;
      }
      case "40001": {
        kind = "serialization_failure";
        break;
      }
      case "40P01": {
        kind = "deadlock";
        break;
      }
      default: {
        return { kind: "unknown" };
      }
    }

    return {
      kind,
      ...(objectName === undefined ? {} : { objectName }),
      ...(code === undefined ? {} : { vendorCode: code }),
    };
  },
};

export interface DatabaseConstraintExpectation {
  kind: "foreign_key_violation" | "unique_violation";
  objectName?: string;
}

/**
 * Matches only metadata supplied by the selected driver adapter. If a caller
 * asks for a named constraint and the driver did not identify it, the result is
 * false rather than parsing an error message and risking a wrong domain error.
 */
export function matchesDatabaseConstraint(
  error: unknown,
  expectation: DatabaseConstraintExpectation,
  classifier: DatabaseErrorClassifier = postgresDatabaseErrorClassifier,
): boolean {
  const classified = classifier.classify(error);
  if (classified.kind !== expectation.kind) return false;
  return expectation.objectName === undefined || classified.objectName === expectation.objectName;
}
