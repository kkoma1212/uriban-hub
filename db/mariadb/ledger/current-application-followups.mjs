import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const currentApplicationFollowupIds = Object.freeze([
  "signup_role",
  "admin_user_status",
  "admin_member_status",
]);
export const currentApplicationArtifactCatalog =
  "db/mariadb/ledger/current-application-artifacts.json";
const catalogSha256 = "ab41271803e80590ac1255c9c93a59e196f6876c5f148a47a8b5e320524411c8";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** New application overlays have their own mapping; historical source47/65 evidence stays intact. */
export function readCurrentApplicationFollowups(followups, readRepoFile) {
  const selected = currentApplicationFollowupIds.filter((id) => followups.includes(id));
  if (selected.length === 0) return { ids: [], steps: [] };
  const bytes = Buffer.from(readRepoFile(currentApplicationArtifactCatalog));
  assert.equal(digest(bytes), catalogSha256, "current application artifact mapping changed");
  const catalog = JSON.parse(bytes.toString("utf8"));
  assert.equal(catalog.schema_version, 1);
  assert.equal(catalog.runtime_activation_applied, false);
  assert.deepEqual(
    catalog.followups.map((group) => group.id),
    currentApplicationFollowupIds,
  );
  const steps = catalog.followups
    .filter((group) => selected.includes(group.id))
    .flatMap((group) => group.steps);
  for (const step of steps) {
    assert.match(
      step.source_path,
      /^db\/mariadb\/(?:migrations|permissions)\/(?:003[78]|0040)_[a-z_]+\.sql$/u,
    );
    const source = Buffer.from(readRepoFile(step.source_path));
    assert.equal(source.length, step.byte_length, "current application artifact length changed");
    assert.equal(digest(source), step.sha256, "current application artifact checksum changed");
    assert.ok(["schema", "runtime_grant"].includes(step.kind));
    assert.ok(
      Number.isSafeInteger(step.ledger_version) &&
        step.ledger_version >= 59 &&
        step.ledger_version <= 63,
    );
  }
  return { ids: selected, steps, catalogSha256 };
}
