export const ADMIN_ROLES = [
  "super_admin",
  "account_manager",
  "support",
  "security_auditor",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}
