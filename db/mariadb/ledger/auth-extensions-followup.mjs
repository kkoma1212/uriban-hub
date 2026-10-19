import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const root = new URL("../../../", import.meta.url);
// Reserved authentication deltas. Import into the approved deployment/backup catalog; never auto-apply.
export const authenticationArtifacts = Object.freeze([
  {
    id: "admin-passkeys",
    ledger_version: 90,
    source_path: "db/mariadb/migrations/0055_admin_passkeys.sql",
    byte_length: 3458,
    sha256: "8d7d797c8eb7cf50abae17a45e84fe067291df20fd1ea5c5cd1a079ba42938b8",
  },
  {
    id: "admin-passkeys-acl",
    ledger_version: 91,
    source_path: "db/mariadb/permissions/0055_admin_passkeys_acl.sql",
    byte_length: 997,
    sha256: "97fb49478799083a49d199039c20102570e5c7febae0518704135d30c665edc5",
  },
  {
    id: "social-login",
    ledger_version: 92,
    source_path: "db/mariadb/migrations/0057_social_login.sql",
    byte_length: 1591,
    sha256: "5b0235b1b0ace0ab076c8c51483aea22f256843bfe24ae49453eeb482749e1b9",
  },
  {
    id: "social-login-acl",
    ledger_version: 93,
    source_path: "db/mariadb/permissions/0057_social_login_acl.sql",
    byte_length: 512,
    sha256: "9ba8495e01d16ec949f9f7bb9d75dc599d984f10336ecf3263a8ec2fbccdbf3a",
  },
]);
export function readAuthenticationSql(artifact) {
  assert(authenticationArtifacts.includes(artifact), "Unrecognized authentication artifact");
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}
