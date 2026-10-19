import catalog from "./runtime-grant-catalog.json" with { type: "json" };

/** Reviewed role-specific extensions; never an arbitrary caller-supplied grant list. */
export type MariaDbRuntimeGrantProfile = "worker_security_audit_v1" | "retention_v1";

const workerSecurityAuditV1 = Object.freeze(
  [
    ...catalog.roles.worker,
    "table|worker_security_audit_lock_keys|INSERT|*",
    "table|worker_security_audit_lock_keys|SELECT|*",
  ].sort(),
);
const retentionV1 = Object.freeze(
  [...catalog.roles.retention, "table|retention_lock_keys|SELECT|*"].sort(),
);

/** Undefined means configuration rejection, not permission to skip attestation. */
export function requiredMariaDbRuntimeGrants(
  role: unknown,
  profile: unknown,
): readonly string[] | undefined {
  if (typeof role !== "string" || !Object.hasOwn(catalog.roles, role)) return undefined;
  if (profile === undefined) return catalog.roles[role as keyof typeof catalog.roles];
  if (role === "worker" && profile === "worker_security_audit_v1") return workerSecurityAuditV1;
  if (role === "retention" && profile === "retention_v1") return retentionV1;
  return undefined;
}
