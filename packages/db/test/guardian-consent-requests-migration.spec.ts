import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../db/migrations/1783700038000_guardian-consent-requests.sql",
  import.meta.url,
);

const migrationSource = await readFile(migrationUrl, "utf8");
const tableDefinition = migrationSource.match(
  /CREATE TABLE guardian_consent_requests \(([\s\S]*?)\n\);/u,
)?.[1];
const stateConstraint = tableDefinition?.match(
  /CONSTRAINT guardian_consent_requests_state_check CHECK \(([\s\S]*?)\n  \)/u,
)?.[1];

if (tableDefinition === undefined) {
  throw new Error("guardian_consent_requests table definition is missing");
}

if (stateConstraint === undefined) {
  throw new Error("guardian_consent_requests state constraint is missing");
}

describe("guardian consent requests migration contract", () => {
  it("stores only the approved guardian-consent fields", () => {
    const columnNames = [...tableDefinition.matchAll(/^  ([a-z][a-z0-9_]*)\s+/gmu)].map(
      ([, columnName]) => columnName,
    );

    expect(columnNames).toEqual([
      "id",
      "guardian_email_normalized",
      "approval_token_hash",
      "completion_token_hash",
      "terms_policy_version",
      "privacy_policy_version",
      "requested_at",
      "expires_at",
      "approved_at",
      "consumed_at",
      "invalidated_at",
      "user_id",
    ]);
    expect(tableDefinition).not.toMatch(
      /\b(?:guardian_name|guardian_phone|ip_address|requested_ip|birth_date|profile_json)\b/u,
    );
  });

  it("enforces normalized identifiers, 32-byte tokens, and valid state timestamps", () => {
    expect(tableDefinition).toContain(
      "guardian_email_normalized = lower(btrim(guardian_email_normalized))",
    );
    expect(tableDefinition).toContain("octet_length(approval_token_hash) = 32");
    expect(tableDefinition).toContain("octet_length(completion_token_hash) = 32");
    expect(tableDefinition).toContain("expires_at > requested_at");
    expect(tableDefinition).toContain("CONSTRAINT guardian_consent_requests_timestamp_order_check");
    expect(tableDefinition).toContain("CONSTRAINT guardian_consent_requests_state_check");
    expect(tableDefinition).toContain(
      "user_id BIGINT UNIQUE REFERENCES users (id) ON DELETE CASCADE",
    );
  });

  it("clears single-use hashes as pending requests advance or terminate", () => {
    expect(stateConstraint).toMatch(
      /approved_at IS NULL[\s\S]*?approval_token_hash IS NOT NULL[\s\S]*?completion_token_hash IS NOT NULL[\s\S]*?user_id IS NULL/u,
    );
    expect(stateConstraint).toMatch(
      /approved_at IS NOT NULL[\s\S]*?approval_token_hash IS NULL[\s\S]*?completion_token_hash IS NOT NULL[\s\S]*?user_id IS NULL/u,
    );
    expect(stateConstraint).toMatch(
      /consumed_at IS NOT NULL[\s\S]*?approval_token_hash IS NULL[\s\S]*?completion_token_hash IS NULL[\s\S]*?user_id IS NOT NULL/u,
    );
    expect(stateConstraint).toMatch(
      /invalidated_at IS NOT NULL[\s\S]*?user_id IS NULL[\s\S]*?approval_token_hash IS NULL[\s\S]*?completion_token_hash IS NULL/u,
    );
  });

  it("indexes open tokens and retention, grants only the app role, and drops safely", () => {
    expect(migrationSource).toContain("guardian_consent_requests_open_approval_token_index");
    expect(migrationSource).toContain("guardian_consent_requests_open_completion_token_index");
    expect(migrationSource).toContain("guardian_consent_requests_expiry_index");
    expect(migrationSource).toContain("guardian_consent_requests_retention_index");
    expect(migrationSource).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON guardian_consent_requests\s+TO classhub_app;/u,
    );
    expect(migrationSource).toMatch(
      /GRANT SELECT, DELETE\s+ON guardian_consent_requests\s+TO classhub_retention;/u,
    );
    expect(migrationSource).not.toMatch(/GRANT[^;]*(?:INSERT|UPDATE)[^;]*TO classhub_retention;/u);
    expect(migrationSource).toMatch(
      /guardian_consent_requests_retention_index\s+ON guardian_consent_requests \(requested_at\)\s+WHERE user_id IS NULL;/u,
    );
    expect(migrationSource).not.toMatch(/\bTO PUBLIC\b/u);
    expect(migrationSource).toMatch(
      /-- Down Migration\s+DROP TABLE guardian_consent_requests;\s*$/u,
    );
    expect(migrationSource).not.toMatch(/DROP TABLE guardian_consent_requests CASCADE/u);
  });
});
