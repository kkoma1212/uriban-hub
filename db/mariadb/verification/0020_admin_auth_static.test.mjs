import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import { sourceColumns } from "../../../OPERATIONS/mariadb-dev/phase20-metadata.mjs";
import {
  rejectionScenarios,
  acceptanceScenarios,
  operatorActions,
} from "../../../OPERATIONS/mariadb-dev/phase20-scenarios.mjs";
import { verifyFeaturePhaseEvidence } from "./feature_phase_evidence.mjs";
import { readEvidenceDocument } from "./evidence-document.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const strip = (sql) => sql.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*--.*$/gmu, "");
const source = strip(
  read("../../migrations/1783700041000_admin-auth-foundation.sql").split("-- Down Migration")[0],
);
const sql = strip(read("../migrations/0020_admin_auth.sql"));
const bodies = (text) =>
  Object.fromEntries(
    [...text.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\)/gu)].map((m) => [m[1], m[2]]),
  );
const columns = (body) =>
  [
    ...body.matchAll(
      /^ {2}(\w+) (?:BIGINT|TEXT|LONGTEXT|VARCHAR|BYTEA|VARBINARY|TIMESTAMPTZ|DATETIME|INTEGER|INT|UUID)\b/gmu,
    ),
  ].map((m) => m[1]);
const readRepositoryFile = async (file) => read(`../../../${file}`);
const phase = () =>
  JSON.parse(read("../manifest.json")).phases.find((p) => p.id === "0020_admin_auth");

test("six source table column sets survive with one explicit MFA projection", () => {
  assert.deepEqual(Object.keys(bodies(sql)), Object.keys(bodies(source)));
  let count = 0;
  for (const [table, body] of Object.entries(bodies(source))) {
    assert.deepEqual(columns(body), sourceColumns[table], table);
    assert.deepEqual(
      columns(bodies(sql)[table]),
      [
        ...sourceColumns[table],
        ...(table === "admin_mfa_factors" ? ["current_admin_account_id"] : []),
      ],
      table,
    );
    count += columns(body).length;
  }
  assert.equal(count, 61);
  assert.equal((sql.match(/GENERATED ALWAYS AS \(/gu) ?? []).length, 1);
  assert.match(source, /ON admin_mfa_factors \(admin_account_id\)\s+WHERE revoked_at IS NULL/u);
  assert.match(sql, /CASE WHEN revoked_at IS NULL THEN admin_account_id ELSE NULL END/u);
  assert.match(sql, /ON admin_mfa_factors \(current_admin_account_id\)/u);
});

test("all named table CHECKs preserve source expressions after dialect normalization", () => {
  const namedChecks = (input) => {
    const checks = {};
    for (const match of input.matchAll(/CONSTRAINT (admin_\w+_check) CHECK \(/gu)) {
      let end = match.index + match[0].length;
      const start = end;
      let depth = 1;
      let quoted = false;
      for (; end < input.length && depth; end++) {
        const character = input[end];
        if (character === "'") quoted = !quoted;
        if (!quoted && character === "(") depth++;
        if (!quoted && character === ")") depth--;
      }
      assert.equal(depth, 0);
      checks[match[1]] = input
        .slice(start, end - 1)
        .replace(/\bBINARY /gu, "")
        .replace(/NOT REGEXP/gu, "!~")
        .replace(/REGEXP/gu, "~")
        .replaceAll("'\\\\A", "'^")
        .replaceAll("\\\\z'", () => "$'")
        .replace(/\bbtrim\b/gu, "trim")
        .replace(/\b(?:CHAR_LENGTH|OCTET_LENGTH|LOWER|TRIM)\b/gu, (value) => value.toLowerCase())
        .replace(/\s+/gu, " ")
        .trim();
    }
    return checks;
  };
  assert.equal(Object.keys(namedChecks(source)).length, 33);
  assert.deepEqual(namedChecks(sql), namedChecks(source));
});

test("operator action and JSON key replacements preserve every source branch", () => {
  const actions = (value) =>
    [
      ...value
        .match(
          /operator_audit_logs_action_check CHECK \(\s*(?:BINARY )?action IN \(([\s\S]*?)\)\s*\)/u,
        )[1]
        .matchAll(/'([^']+)'/gu),
    ]
      .map((m) => m[1])
      .sort();
  assert.deepEqual(actions(sql), actions(source));
  assert.deepEqual(actions(sql), [...operatorActions].sort());
  const original = [...source.matchAll(/ARRAY\[([^\]]+)\]/gu)].map((m) =>
    [...m[1].matchAll(/'([^']+)'/gu)].map((item) => item[1]),
  );
  const replacement = [...sql.matchAll(/JSON_CONTAINS\('(\[[^']+\])'/gu)].map((m) =>
    JSON.parse(m[1]),
  );
  assert.deepEqual(replacement, original);
  assert.doesNotMatch(sql, /DROP CONSTRAINT operator_audit_logs_actor_check/u);
});

test("storage and runtime boundaries avoid padding, truncation, and false cryptographic claims", () => {
  assert.match(sql, /email_normalized LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL UNIQUE/u);
  assert.match(sql, /role VARCHAR\(64\) COLLATE utf8mb4_nopad_bin NOT NULL/u);
  for (const [column, size] of [
    ["secret_ciphertext", 256],
    ["secret_iv", 12],
    ["secret_auth_tag", 16],
    ["challenge_hash", 32],
    ["session_hash", 32],
    ["csrf_token_hash", 32],
  ])
    assert.match(sql, new RegExp(`${column} VARBINARY\\(${size}\\)`, "u"));
  assert.doesNotMatch(sql, /\b(?:GRANT|REVOKE|CREATE USER|CREATE TRIGGER|ON UPDATE)\b/iu);
  assert.equal((source.match(/GENERATED ALWAYS AS IDENTITY/gu) ?? []).length, 5);
  assert.equal((sql.match(/AUTO_INCREMENT PRIMARY KEY/gu) ?? []).length, 5);
  const gaps = readEvidenceDocument("db/mariadb/verification/0020_admin_auth_gaps.md");
  for (const marker of [
    "### B-01",
    "### B-02",
    "### B-03",
    "### B-04",
    "GENERATED ALWAYS AS IDENTITY",
    "AUTO_INCREMENT",
    "TOTP",
    "HASH",
    "clock_timestamp",
    "source0045",
    "SET NULL",
    "persistentRows=56",
  ])
    assert.ok(gaps.includes(marker), marker);
});

test("QA covers state combinations and exact temporary isolation without changing existing ACLs", () => {
  const compose = read("../../../compose.mariadb-phase20-qa.yaml");
  const runner = read("../../../OPERATIONS/mariadb-dev/verify-phase20-qa.mjs");
  const metadata = read("../../../OPERATIONS/mariadb-dev/phase20-metadata.mjs");
  assert.match(compose, /internal: true/u);
  assert.match(compose, /\/var\/lib\/mysql:rw,noexec,nosuid,size=1073741824/u);
  assert.doesNotMatch(compose, /\n\s+ports:|runtime_activation|runtime_rollback/u);
  assert.equal((compose.match(/\/docker-entrypoint-initdb\.d\//gu) ?? []).length, 44);
  assert.equal((compose.match(/\/opt\/classhub\/phase20\//gu) ?? []).length, 1);
  assert.equal(rejectionScenarios.length, 189);
  assert.equal(acceptanceScenarios.length, 57);
  assert.equal(
    new Set([...rejectionScenarios, ...acceptanceScenarios].map(([id]) => id)).size,
    246,
  );
  assert.equal(
    [...rejectionScenarios, ...acceptanceScenarios].filter(([id]) => id.startsWith("mfa_state_"))
      .length,
    12,
  );
  assert.equal(
    [...rejectionScenarios, ...acceptanceScenarios].filter(([id]) =>
      id.startsWith("audit_hmac_pair_"),
    ).length,
    8,
  );
  for (const value of [
    "const expectedAddedAcl = []",
    "seedAndZeroRows()",
    "persistentNonseedRows: 0",
  ])
    assert.ok(runner.includes(value));
  assert.match(metadata, /ORDER BY BINARY TABLE_NAME,BINARY INDEX_NAME/u);
});

test("evidence refuses SQL drift and false identity, crypto or clean-apply completion", async () => {
  const current = phase();
  await verifyFeaturePhaseEvidence(current, readRepositoryFile);
  for (const [field, value, pattern] of [
    ["migration_sha256", "0".repeat(64), /digest drifted/u],
    ["verification_run", "clean_apply", /verification_run/u],
    ["persistent_row_count", 0, /persistent_row_count/u],
    ["generated_always_identity_parity", "verified", /generated_always_identity_parity/u],
    ["cryptography_scope", "fully_verified", /cryptography_scope/u],
  ])
    await assert.rejects(
      verifyFeaturePhaseEvidence(
        { ...current, verification: { ...current.verification, [field]: value } },
        readRepositoryFile,
      ),
      pattern,
    );
});
