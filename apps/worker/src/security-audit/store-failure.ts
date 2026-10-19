import { types } from "node:util";

export const SECURITY_AUDIT_STORE_FAILURE_REASONS = [
  "reference_missing",
  "constraint_rejected",
  "permission_denied",
  "connection_unavailable",
  "contention",
  "unknown",
] as const;
export type SecurityAuditStoreFailureReason = (typeof SECURITY_AUDIT_STORE_FAILURE_REASONS)[number];
export type SecurityAuditStoreFailureCounts = Partial<
  Record<SecurityAuditStoreFailureReason, number>
>;

function ownValue(error: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(error, key)?.value;
}

/** Only fixed categories leave this boundary. Never inspect messages, SQL, causes or getters. */
export function classifySecurityAuditStoreFailure(error: unknown): SecurityAuditStoreFailureReason {
  if (typeof error !== "object" || error === null || types.isProxy(error)) return "unknown";
  const rawCode = ownValue(error, "code");
  const code = typeof rawCode === "string" ? rawCode : "";
  if (code === "MARIADB_SECURITY_AUDIT_STORE_FAILED") {
    const reason = ownValue(error, "failureReason");
    return SECURITY_AUDIT_STORE_FAILURE_REASONS.find((value) => value === reason) ?? "unknown";
  }
  const rawErrno = ownValue(error, "errno");
  const errno = typeof rawErrno === "number" ? rawErrno : 0;
  const sqlState = ownValue(error, "sqlState");
  if (code === "23503" || (errno === 1452 && sqlState === "23000")) return "reference_missing";
  if (
    ["23502", "23514", "22001", "22003", "22P02"].includes(code) ||
    (sqlState === "23000" && (errno === 1048 || errno === 4025))
  )
    return "constraint_rejected";
  if (code === "42501" || (sqlState === "42000" && [1142, 1143, 1370].includes(errno)))
    return "permission_denied";
  if (
    ["40001", "40P01", "55P03"].includes(code) ||
    (errno === 1213 && sqlState === "40001") ||
    (errno === 1205 && sqlState === "HY000")
  )
    return "contention";
  if (
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "EPIPE",
      "PROTOCOL_CONNECTION_LOST",
      "08000",
      "08003",
      "08006",
      "57P01",
      "57P02",
      "57P03",
      "53300",
      "connection_closed",
      "driver_closed",
    ].includes(code)
  )
    return "connection_unavailable";
  if (
    code === "WORKER_MARIADB_DATABASE_FAILED" &&
    ["connection", "connection_queue_full", "connection_timeout", "query_timeout", "closed"].some(
      (reason) => reason === ownValue(error, "reason"),
    )
  )
    return "connection_unavailable";
  if (
    code === "MARIADB_RUNTIME_ROLE_ATTESTATION_FAILED" &&
    ["identity_rejected", "privileges_rejected"].some(
      (reason) => reason === ownValue(error, "reason"),
    )
  )
    return "permission_denied";
  return "unknown";
}
