import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import { verifyFeaturePhaseEvidence } from "./feature_phase_evidence.mjs";
import {
  operatorActions,
  probeCounts,
  rejectionScenarios,
  acceptanceScenarios,
} from "../../../OPERATIONS/mariadb-dev/phase18-19-scenarios.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const strip = (value) => value.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*--.*$/gmu, "");
const source = (name) => strip(read(`../../migrations/${name}`).split("-- Down Migration")[0]);
const holiday = strip(read("../migrations/0018_public_holidays.sql"));
const guardian = strip(read("../migrations/0019_guardian_consent_requests.sql"));
const holidaySource = source("1783700037000_public-holidays.sql");
const guardianSource = source("1783700038000_guardian-consent-requests.sql");
const columns = (sql) =>
  [
    ...sql.matchAll(
      /^ {2}(\w+) (?:UUID|BIGINT|LONGTEXT|TEXT|VARBINARY|BYTEA|DATE|TIMESTAMPTZ|DATETIME)\b/gmu,
    ),
  ].map((m) => m[1]);
const readRepositoryFile = async (file) => read(`../../../${file}`);
const phases = () =>
  JSON.parse(read("../manifest.json")).phases.filter((p) =>
    ["0018", "0019"].includes(p.id.slice(0, 4)),
  );

test("source column sets and named checks survive both ports", () => {
  assert.deepEqual(columns(holiday), columns(holidaySource));
  assert.deepEqual(columns(guardian), columns(guardianSource));
  assert.equal(columns(holiday).length, 6);
  assert.equal(columns(guardian).length, 12);
  for (const [ported, original, count] of [
    [holiday, holidaySource, 3],
    [guardian, guardianSource, 8],
  ]) {
    const names = (sql) =>
      [
        ...sql.matchAll(
          /CONSTRAINT ((?:public_holidays|guardian_consent_requests)_\w+_check) CHECK/gu,
        ),
      ].map((m) => m[1]);
    assert.deepEqual(names(ported), names(original));
    assert.equal(names(ported).length, count);
    assert.doesNotMatch(ported, /\b(?:GRANT|REVOKE|CREATE USER|CREATE TRIGGER|ON UPDATE)\b/iu);
  }
  assert.match(guardian, /FOREIGN KEY \(user_id\) REFERENCES users \(id\) ON DELETE CASCADE/u);
  assert.match(holiday, /BINARY source = BINARY 'kasi'/u);
  assert.match(holiday, /CHAR_LENGTH\(name\) BETWEEN 1 AND 60/u);
});

test("holiday operator actions and key sets match the complete source replacement", () => {
  const actions = (sql) =>
    [
      ...sql
        .match(/CHECK \(\s*(?:BINARY )?action IN \(([\s\S]*?)\)\s*\)/u)[1]
        .matchAll(/'([^']+)'/gu),
    ]
      .map((m) => m[1])
      .sort();
  assert.deepEqual(actions(holiday), actions(holidaySource));
  assert.deepEqual(actions(holiday), [...operatorActions].sort());
  assert.equal(operatorActions.length, 21);
  const sourceKeySets = [...holidaySource.matchAll(/ARRAY\[([^\]]+)\]/gu)].map((m) =>
    [...m[1].matchAll(/'([^']+)'/gu)].map((v) => v[1]),
  );
  const portedKeySets = [...holiday.matchAll(/JSON_CONTAINS\('(\[[^']+\])'/gu)].map((m) =>
    JSON.parse(m[1]),
  );
  assert.deepEqual(portedKeySets, sourceKeySets);
  assert.doesNotMatch(holiday, /DROP CONSTRAINT operator_audit_logs_actor_check/u);
});

test("guardian presence and timestamp predicates match source without hidden tightening", () => {
  const state = (sql) =>
    sql
      .match(/CONSTRAINT guardian_consent_requests_state_check CHECK \(([\s\S]*?)\n {2}\)/u)[1]
      .replace(/\s+/gu, " ")
      .trim();
  assert.equal(state(guardian), state(guardianSource));
  for (const check of ["expiry", "timestamp_order"]) {
    const clause = (sql) =>
      sql
        .match(
          new RegExp(
            `CONSTRAINT guardian_consent_requests_${check}_check CHECK \\(([\\s\\S]*?)\\n  \\)`,
            "u",
          ),
        )[1]
        .replace(/\s+/gu, " ")
        .trim();
    assert.equal(clause(guardian), clause(guardianSource));
  }
  assert.equal((guardian.match(/VARBINARY\(32\)/gu) ?? []).length, 2);
  assert.equal((guardian.match(/OCTET_LENGTH\(\w+_hash\) = 32/gu) ?? []).length, 2);
  assert.equal((guardian.match(/LONGTEXT NOT NULL/gu) ?? []).length, 3);
  assert.match(
    guardian,
    /BINARY guardian_email_normalized = BINARY LOWER\(TRIM\(guardian_email_normalized\)\)/u,
  );
  assert.match(
    guardian,
    /ON guardian_consent_requests \(consumed_at, invalidated_at, expires_at\)/u,
  );
  assert.match(guardian, /ON guardian_consent_requests \(user_id, requested_at\)/u);
  assert.doesNotMatch(guardian, /GENERATED ALWAYS|UUID\(\)|CHAR_LENGTH|REGEXP/u);
});

test("grouped QA has isolated mounts and exhaustive guardian state coverage", () => {
  const compose = read("../../../compose.mariadb-phase18-19-qa.yaml");
  const runner = read("../../../OPERATIONS/mariadb-dev/verify-phase18-19-qa.mjs");
  assert.match(compose, /internal: true/u);
  assert.match(compose, /\/var\/lib\/mysql:rw,noexec,nosuid,size=1073741824/u);
  assert.doesNotMatch(compose, /\n\s+ports:|runtime_activation|runtime_rollback/u);
  assert.equal((compose.match(/\/docker-entrypoint-initdb\.d\//gu) ?? []).length, 42);
  assert.equal((compose.match(/\/opt\/classhub\/phase18-19\//gu) ?? []).length, 2);
  assert.equal(rejectionScenarios.filter(([id]) => /^guardian_state_/u.test(id)).length, 59);
  assert.equal(acceptanceScenarios.filter(([id]) => /^guardian_valid_state_/u.test(id)).length, 5);
  assert.deepEqual(probeCounts, {
    public_holidays: { rejected: 84, accepted: 25 },
    guardian_consent_requests: { rejected: 100, accepted: 15 },
  });
  const ids = [...rejectionScenarios, ...acceptanceScenarios].map(([id]) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const text of [
    "const expectedAddedAcl = []",
    "persistentNonseedRows: 0",
    "seedAndZeroRows()",
    "operator_audit_logs_json_allowlist_check",
    "probeCounts",
  ])
    assert.ok(runner.includes(text), text);
});

test("both evidence contracts reject source drift and group/per-phase count confusion", async () => {
  assert.equal(phases().length, 2);
  for (const phase of phases()) {
    await verifyFeaturePhaseEvidence(phase, readRepositoryFile);
    for (const [field, value, error] of [
      ["migration_sha256", "0".repeat(64), /digest drifted/u],
      ["group_rejection_probe_count", 368, /group_rejection_probe_count/u],
      ["new_table_count", 2, /new_table_count/u],
      ["persistent_row_count", 0, /persistent_row_count/u],
      ["timestamp_parity", "verified", /timestamp_parity/u],
    ])
      await assert.rejects(
        verifyFeaturePhaseEvidence(
          { ...phase, verification: { ...phase.verification, [field]: value } },
          readRepositoryFile,
        ),
        error,
      );
    const peer = phase.id.startsWith("0018")
      ? "db/mariadb/migrations/0019_guardian_consent_requests.sql"
      : "db/mariadb/migrations/0018_public_holidays.sql";
    await assert.rejects(
      verifyFeaturePhaseEvidence(
        {
          ...phase,
          verification: {
            ...phase.verification,
            group_migration_sha256: {
              ...phase.verification.group_migration_sha256,
              [peer]: "0".repeat(64),
            },
          },
        },
        readRepositoryFile,
      ),
      /group digest drifted/u,
    );
  }
});
