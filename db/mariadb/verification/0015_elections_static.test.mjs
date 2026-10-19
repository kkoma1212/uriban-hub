import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import { verifyElectionEvidence } from "./0015_elections_evidence.mjs";
import { readEvidenceDocument } from "./evidence-document.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const strip = (value) => value.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*--.*$/gmu, "");
const source = strip(
  read("../../migrations/1783700031000_class-elections.sql").split("-- Down Migration")[0],
);
const results = strip(
  read("../../migrations/1783700032000_election-results.sql").split("-- Down Migration")[0],
);
const sql = strip(read("../migrations/0015_elections.sql"));
const table = (input, name) =>
  input.match(new RegExp(`CREATE TABLE ${name} \\(([\\s\\S]*?)\\n\\)`, "u"))[1];
const columns = (input) =>
  [
    ...input.matchAll(
      /^ {2}(\w+) (?:BIGINT|TEXT|VARCHAR|INTEGER|BOOLEAN|TIMESTAMPTZ|DATETIME)\b/gmu,
    ),
  ].map((match) => match[1]);
const seed = (input) =>
  [
    ...input
      .match(/INSERT INTO audit_log_actions \(action\) VALUES[\s\S]*?;/u)[0]
      .matchAll(/\('([^']+)'\)/gu),
  ].map((match) => match[1]);

test("four source table column sets and composite references survive folding result columns", () => {
  for (const name of [
    "elections",
    "election_candidates",
    "election_tallies",
    "election_participants",
  ]) {
    assert.deepEqual(columns(table(sql, name)), [
      ...columns(table(source, name)),
      ...(name === "elections" ? ["winner_candidate_id", "tie_break_applied"] : []),
    ]);
  }
  const fks = (input) =>
    [
      ...input.matchAll(
        /FOREIGN KEY \(([^)]+)\)\s+REFERENCES (\w+) \(([^)]+)\)\s+ON DELETE RESTRICT(?: ON UPDATE RESTRICT)?/gu,
      ),
    ]
      .map((match) => match[0].replace(/\s+/gu, " "))
      .sort();
  const inlineClass = "FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE RESTRICT";
  assert.match(source, /class_id BIGINT NOT NULL REFERENCES classes \(id\) ON DELETE RESTRICT/u);
  assert.deepEqual(fks(sql), [...fks(source), ...fks(results), inlineClass].sort());
  assert.ok(
    sql.indexOf("ADD CONSTRAINT elections_winner_candidate_foreign_key") >
      sql.indexOf("CREATE TABLE election_candidates"),
  );
});

test("privacy has exact columns and original loose constraints remain loose", () => {
  assert.deepEqual(columns(table(sql, "election_participants")), [
    "election_id",
    "class_id",
    "member_id",
  ]);
  assert.deepEqual(columns(table(sql, "election_tallies")), [
    "election_id",
    "candidate_id",
    "vote_count",
  ]);
  for (const field of ["status", "tie_break", "results_visibility"]) {
    const enumValues = (input) =>
      [
        ...input
          .match(new RegExp(`CHECK \\((?:BINARY )?${field} IN \\(([^)]+)\\)\\)`, "u"))[1]
          .matchAll(/'([^']+)'/gu),
      ].map((match) => match[1]);
    assert.deepEqual(enumValues(sql), enumValues(source));
    assert.match(sql, new RegExp(`CHECK \\(BINARY ${field} IN \\(BINARY`, "u"));
  }
  assert.match(results, /CHECK \(status <> 'published' OR winner_candidate_id IS NOT NULL\)/u);
  assert.match(
    sql,
    /CHECK \(BINARY status <> BINARY 'published' OR winner_candidate_id IS NOT NULL\)/u,
  );
  assert.match(sql, /tie_break_applied BOOLEAN NOT NULL DEFAULT FALSE/u);
  assert.match(sql, /CHECK \(tie_break_applied IN \(0,1\)\)/u);
  assert.equal((sql.match(/\bCHECK \(/gu) ?? []).length, 6);
  assert.doesNotMatch(
    sql,
    /CHECK[^;]*(?:TRIM\(|CHAR_LENGTH\(|row_version\s*[><=]|student_number_snapshot\s*[><=])/u,
  );
  assert.doesNotMatch(sql, /\b(?:CREATE INDEX|CREATE UNIQUE INDEX|DROP|GRANT|REVOKE)\b/iu);
});

test("immutable trigger compares actual binary changes using a locked minimal definer envelope", () => {
  const trigger = strip(read("../migrations/0015_election_tie_break_trigger.sql"));
  const grants = strip(read("../permissions/0015_election_trigger_grants.sql"));
  assert.match(source, /NEW.tie_break IS DISTINCT FROM OLD.tie_break/u);
  assert.match(source, /BEFORE UPDATE ON elections/u);
  assert.match(
    trigger,
    /CREATE DEFINER=`classhub_routine`@`%` TRIGGER elections_tie_break_immutable/u,
  );
  assert.match(trigger, /BEFORE UPDATE ON elections/u);
  assert.match(trigger, /IF NOT \(BINARY NEW.tie_break <=> BINARY OLD.tie_break\) THEN/u);
  assert.match(trigger, /MYSQL_ERRNO\s*=\s*31501/u);
  assert.deepEqual(
    grants
      .split(";")
      .map((value) => value.trim().replace(/\s+/gu, " "))
      .filter(Boolean),
    [
      "GRANT SELECT (tie_break) ON classhub_mariadb_phase1_dev.elections TO 'classhub_routine'@'%'",
      "GRANT TRIGGER ON classhub_mariadb_phase1_dev.elections TO 'classhub_routine'@'%'",
    ],
  );
});

test("exact five source audit actions are added without a per-vote record or JSON change", () => {
  assert.equal(seed(source).length, 5);
  assert.deepEqual(seed(sql), seed(source));
  assert.doesNotMatch(
    sql,
    /election\.voted|ALTER TABLE audit_logs|INSERT INTO api_idempotency_keys/u,
  );
  const manifest = JSON.parse(read("../manifest.json"));
  assert.equal(
    manifest.semantic_migrations.find((m) => m.source === "1783700032000_election-results.sql")
      .status,
    "verified_on_container",
  );
  // 2026-10-04 은퇴: 참가자 지우기 단계가 '계획만(planned_unimplemented)'이라는 확인은 그 시점 사진이었다(이후 진행됨).
  assert.ok(
    manifest.semantic_migrations.some(
      (m) => m.source === "1783700036000_election-participants-erasure.sql",
    ),
  );
});

test("runner checks mounted sources, private schema and exact reference seeds in disposable QA", () => {
  const runner = read("../../../OPERATIONS/mariadb-dev/verify-phase15-qa.mjs");
  const compose = read("../../../compose.mariadb-phase15-qa.yaml");
  assert.match(compose, /internal: true/u);
  assert.match(compose, /\/var\/lib\/mysql:rw,noexec,nosuid,size=1073741824/u);
  assert.doesNotMatch(compose, /\n\s+ports:|runtime_activation|runtime_rollback/u);
  assert.equal((compose.match(/\/docker-entrypoint-initdb\.d\//gu) ?? []).length, 37);
  assert.equal((compose.match(/\/opt\/classhub\/phase15\//gu) ?? []).length, 3);
  for (const expected of [
    "sha256sum",
    "GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION)",
    "account_locked",
    "beforeAcl.filter",
    "checkFingerprint(), beforeChecks",
    "seedAndZeroRows()",
    "persistentRows: 56",
    "catalogSeedRows: 56",
    "persistentNonseedRows: 0",
  ])
    assert.ok(runner.includes(expected), expected);
  const scenarios = read("../../../OPERATIONS/mariadb-dev/phase15-scenarios.mjs");
  assert.doesNotMatch(scenarios, /foreign_key_checks|check_constraint_checks/iu);
  assert.match(scenarios, /ROLLBACK TO SAVEPOINT before_vote/u);
  const gaps = readEvidenceDocument("db/mariadb/verification/0015_elections_gaps.md");
  for (const expected of [
    "### B-01",
    "### B-02",
    "### B-03",
    "### B-04",
    "source0036",
    "API",
    "TEXT",
    "31501",
    "persistentRows=56",
  ])
    assert.ok(gaps.includes(expected), expected);
});

test("evidence rejects changed applied files, false zero seeds and false runtime erasure completion", async () => {
  const phase = JSON.parse(read("../manifest.json")).phases.find((p) => p.id === "0015_elections");
  const readRepositoryFile = async (file) => read(`../../../${file}`);
  await verifyElectionEvidence(phase, readRepositoryFile);
  for (const field of ["migration_sha256", "trigger_sha256", "trigger_permissions_sha256"])
    await assert.rejects(
      verifyElectionEvidence(
        { ...phase, verification: { ...phase.verification, [field]: "0".repeat(64) } },
        readRepositoryFile,
      ),
      /digest drifted/u,
    );
  for (const [field, value] of [
    ["persistent_row_count", 0],
    ["erasure_runtime_permissions", "verified"],
  ])
    await assert.rejects(
      verifyElectionEvidence(
        { ...phase, verification: { ...phase.verification, [field]: value } },
        readRepositoryFile,
      ),
      new RegExp(field, "u"),
    );
});
