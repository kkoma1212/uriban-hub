import { createHash } from "node:crypto";

export type CanonicalJson =
  boolean | null | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

export class IdempotencyKeyRequiredError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REQUIRED";

  constructor() {
    super("Idempotency-Key header is required.");
    this.name = "IdempotencyKeyRequiredError";
  }
}

export class InvalidIdempotencyKeyError extends Error {
  readonly code = "INVALID_IDEMPOTENCY_KEY";

  constructor() {
    super("Idempotency-Key header must be a UUID.");
    this.name = "InvalidIdempotencyKeyError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function normalizeIdempotencyKey(value: string | string[] | undefined): string {
  if (value === undefined) {
    throw new IdempotencyKeyRequiredError();
  }

  if (Array.isArray(value) || !UUID_PATTERN.test(value)) {
    throw new InvalidIdempotencyKeyError();
  }

  return value.toLowerCase();
}

export function materializeOptionalFields(
  value: Readonly<Record<string, unknown>>,
  optionalFields: readonly string[],
): Record<string, unknown> {
  const materialized = { ...value };

  for (const field of optionalFields) {
    if (!(field in materialized) || materialized[field] === undefined) {
      materialized[field] = null;
    }
  }

  return materialized;
}

function canonicalize(value: unknown): CanonicalJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Canonical request numbers must be safe integers.");
    }

    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical request objects must be plain objects.");
    }

    const source = value as Record<string, unknown>;
    const result: Record<string, CanonicalJson> = {};

    for (const key of Object.keys(source).sort()) {
      result[key] = canonicalize(source[key]);
    }

    return result;
  }

  throw new TypeError("Canonical requests contain an unsupported value.");
}

export interface CanonicalRequestInput {
  body: Readonly<Record<string, unknown>>;
  effectiveClassId: string | null;
  optionalFields?: readonly string[];
}

export function serializeCanonicalRequest(input: CanonicalRequestInput): string {
  const body = materializeOptionalFields(input.body, input.optionalFields ?? []);

  return JSON.stringify(
    canonicalize({
      effective_class_id: input.effectiveClassId,
      request: body,
    }),
  );
}

export function createIdempotencyRequestHash(input: CanonicalRequestInput): Buffer {
  return createHash("sha256").update(serializeCanonicalRequest(input), "utf8").digest();
}

export function createIdempotencyRouteKey(route: string, effectiveClassId: string | null): string {
  if (route.length === 0) {
    throw new RangeError("route must not be empty.");
  }

  return effectiveClassId === null ? route : `${route}|class:${effectiveClassId}`;
}
