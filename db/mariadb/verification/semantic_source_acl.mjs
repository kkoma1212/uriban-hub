import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const semanticSourceMigrations = [
  "1783700000000_identity-foundation.sql",
  "1783700001000_class-membership-foundation.sql",
  "1783700002000_content-meals.sql",
  "1783700003000_audit-import-logs.sql",
  "1783700004000_tighten-runtime-privileges.sql",
  "1783700005000_account-password-runtime-privilege.sql",
  "1783700006000_attendance-notifications.sql",
  "1783700007000_operator-runtime-privileges.sql",
  "1783700008000_in-app-reminders.sql",
  "1783700009000_content-audiences.sql",
  "1783700010000_operator-onboarding-privileges.sql",
  "1783700011000_neis-meal-source.sql",
  "1783700012000_neis-meal-calorie.sql",
  "1783700013000_neis-school-schedules.sql",
  "1783700014000_neis-school-details.sql",
  "1783700015000_student-assessment-records.sql",
  "1783700016000_class-polls.sql",
  "1783700017000_seat-draws.sql",
  "1783700018000_team-draws.sql",
  "1783700019000_seat-draw-adjustment-audit.sql",
  "1783700020000_team-draw-adjustment-audit.sql",
  "1783700021000_poll-visibility-and-results-policy.sql",
  "1783700022000_operator-teacher-password-reset.sql",
  "1783700023000_temporary-password-reminder.sql",
  "1783700024000_operator-class-transfer.sql",
  "1783700025000_operator-reissue-cooldown.sql",
  "1783700026000_operator-class-transfer-audit.sql",
  "1783700027000_retention-job-visibility.sql",
  "1783700028000_class-duty-rosters.sql",
  "1783700029000_supply-categories.sql",
  "1783700030000_audit-action-catalog.sql",
  "1783700031000_class-elections.sql",
  "1783700032000_election-results.sql",
  "1783700033000_layout-draft-autosaves.sql",
  "1783700034000_layout-draft-autosave-retention-grants.sql",
  "1783700035000_classroom-layout-templates.sql",
  "1783700036000_election-participants-erasure.sql",
  "1783700037000_public-holidays.sql",
  "1783700038000_guardian-consent-requests.sql",
  "1783700039000_operator-suspended-class-transfer.sql",
  "1783700040000_password-input-version.sql",
  "1783700041000_admin-auth-foundation.sql",
  "1783700042000_admin-signup-approval.sql",
  "1783700043000_admin-inquiries-system-state.sql",
  "1783700044000_admin-terms-management.sql",
  "1783700045000_admin-account-management.sql",
  "1783700046000_admin-security-audit-read.sql",
].map((name) => `db/migrations/${name}`);

const roleNames = ["classhub_app", "classhub_operator", "classhub_worker", "classhub_retention"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sortedEntries = (map) => [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

function splitList(value) {
  const result = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "(") depth++;
    if (value[index] === ")") depth--;
    if (value[index] === "," && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  assert.equal(depth, 0, "unbalanced privilege column list");
  result.push(value.slice(start).trim());
  return result;
}

// Preserve line coordinates and hide literals so quoted action values and dynamic
// local-admin SQL cannot be mistaken for top-level runtime permission statements.
function maskCommentsAndStrings(sql) {
  return sql.replace(/'(?:''|[^'])*'|\/\*[\s\S]*?\*\/|--[^\r\n]*/gu, (match) =>
    match.replace(/[^\r\n]/gu, " "),
  );
}

function applyTableStatement(state, statement, origin) {
  const match = statement.match(/^(GRANT|REVOKE) (.+) ON (.+) (?:TO|FROM) (.+);$/u);
  assert.ok(match, `unsupported direct permission statement: ${statement}`);
  const [, operation, privilegeText, objectText, granteeText] = match;
  if (/^(?:SEQUENCE|ALL SEQUENCES|FUNCTION)\b/u.test(objectText)) return;
  const grantees = splitList(granteeText).filter((role) => roleNames.includes(role));
  if (grantees.length === 0) return;
  if (objectText === "ALL TABLES IN SCHEMA public") {
    assert.equal(operation, "REVOKE", "schema-wide runtime grant is not a whitelist");
    assert.match(privilegeText, /^ALL(?: PRIVILEGES)?$/u);
    for (const role of grantees) state[role].clear();
    return;
  }
  const tables = splitList(objectText.replace(/^TABLE /u, ""));
  for (const table of tables) assert.match(table, /^[a-z][a-z0-9_]*$/u);
  for (const role of grantees) {
    for (const table of tables) {
      if (/^ALL(?: PRIVILEGES)?$/u.test(privilegeText)) {
        assert.equal(operation, "REVOKE");
        state[role].delete(table);
        continue;
      }
      if (!state[role].has(table)) state[role].set(table, new Map());
      const privileges = state[role].get(table);
      for (const item of splitList(privilegeText)) {
        const privilege = item.match(/^(SELECT|INSERT|UPDATE|DELETE)(?: \((.*)\))?$/u);
        assert.ok(privilege, `unsupported table privilege: ${item}`);
        const [, name, columns] = privilege;
        if (operation === "REVOKE") {
          assert.equal(columns, undefined, "column REVOKE requires a provenance-aware extension");
          privileges.delete(name);
          continue;
        }
        if (!privileges.has(name)) privileges.set(name, { columns: new Set(), origins: [] });
        const grant = privileges.get(name);
        if (!columns) grant.columns = "*";
        else if (grant.columns !== "*")
          for (const column of splitList(columns)) {
            assert.match(column, /^[a-z][a-z0-9_]*$/u);
            grant.columns.add(column);
          }
        grant.origins.push({ ...origin, columns: columns ? splitList(columns).sort() : "*" });
      }
      if (privileges.size === 0) state[role].delete(table);
    }
  }
}

export async function deriveSourceAcl(readRepoFile) {
  const state = Object.fromEntries(roleNames.map((role) => [role, new Map()]));
  const sourceMigrations = [];
  for (const path of semanticSourceMigrations) {
    const source = await readRepoFile(path);
    assert.equal(typeof source, "string", `${path}: UTF-8 source string required`);
    sourceMigrations.push({ path, sha256: hash(source) });
    const boundary = source.indexOf("-- Down Migration");
    assert.notEqual(boundary, -1, `${path}: Down boundary missing`);
    const up = maskCommentsAndStrings(source.slice(0, boundary)).replace(
      /\bALTER DEFAULT PRIVILEGES\b[^;]*;/gu,
      (match) => match.replace(/[^\r\n]/gu, " "),
    );
    for (const match of up.matchAll(/^[\t ]*(?:GRANT|REVOKE)\s+[^;]*;/gmu)) {
      const line = up.slice(0, match.index).split("\n").length;
      applyTableStatement(state, match[0].replace(/\s+/gu, " ").trim(), { source: path, line });
    }
  }
  const roles = {};
  const grantSources = [];
  for (const role of roleNames) {
    roles[role] = {};
    for (const [table, privileges] of sortedEntries(state[role])) {
      roles[role][table] = {};
      for (const [privilege, grant] of sortedEntries(privileges)) {
        roles[role][table][privilege] = grant.columns === "*" ? "*" : [...grant.columns].sort();
        for (const origin of grant.origins)
          grantSources.push({ role, table, privilege, ...origin });
      }
    }
  }
  return {
    schemaVersion: 1,
    scope: "PostgreSQL source Up direct table/column ACL only; not MariaDB activation authority",
    excluded: [
      "PostgreSQL sequences and functions, including source0039 transfer-function EXECUTE",
      "PUBLIC, optional classhub_local_admin, object ownership and role inheritance",
      "ALTER DEFAULT PRIVILEGES (future-object policy), runtime authentication and effective-role attestation",
      "MariaDB invariant-core exceptions and any shared/production activation",
    ],
    inventoryBoundary:
      "Exactly these 47 migrations; callers must compare repository filenames for additions",
    sourceSetHashFormat: "SHA-256 of JSON.stringify(sourceMigrations), in migration filename order",
    sourceSetSha256: hash(JSON.stringify(sourceMigrations)),
    sourceMigrations,
    roles,
    grantSources,
  };
}
