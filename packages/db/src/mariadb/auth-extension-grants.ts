/** Exact optional authentication grants. Installation is an approved, separate operation. */
export const socialLoginGrants = Object.freeze(
  [
    ...["social_identities", "social_oauth_flows"].flatMap((table) =>
      ["SELECT", "INSERT", "DELETE"].map((action) => `table|${table}|${action}|*`),
    ),
    "table|social_identities|UPDATE|used_at",
    "table|social_oauth_flows|UPDATE|encrypted_payload",
    "table|social_oauth_flows|UPDATE|consumed_at",
  ].sort(),
);
export const adminPasskeyGrants = Object.freeze(
  [
    ...[
      "admin_passkeys",
      "admin_recovery_codes",
      "admin_webauthn_challenges",
      "admin_mfa_stepups",
    ].flatMap((table) => [`table|${table}|SELECT|*`, `table|${table}|INSERT|*`]),
    ...["signature_counter", "backed_up", "used_at", "revoked_at"].map(
      (column) => `table|admin_passkeys|UPDATE|${column}`,
    ),
    ...["used_at", "revoked_at"].map((column) => `table|admin_recovery_codes|UPDATE|${column}`),
    "table|admin_webauthn_challenges|UPDATE|consumed_at",
    "table|admin_mfa_stepups|UPDATE|method",
    "table|admin_mfa_stepups|UPDATE|verified_at",
    "table|admin_mfa_stepups|DELETE|*",
  ].sort(),
);
