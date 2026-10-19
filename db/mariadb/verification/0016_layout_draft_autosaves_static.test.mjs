import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import { verifyLayoutDraftEvidence } from "./0016_layout_draft_autosaves_evidence.mjs";
import { readEvidenceDocument } from "./evidence-document.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const strip = (value) => value.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*--.*$/gmu, "");
const source = strip(
  read("../../migrations/1783700033000_layout-draft-autosaves.sql").split("-- Down Migration")[0],
);
const sql = strip(read("../migrations/0016_layout_draft_autosaves.sql"));
const columns = (input) =>
  [
    ...input.matchAll(
      /^ {2}(\w+) (?:BIGSERIAL|BIGINT|TEXT|VARCHAR|JSONB?|DATETIME|TIMESTAMPTZ)\b/gmu,
    ),
  ].map((match) => match[1]);

test("eight source columns, same-class references and owner/retention indexes are preserved", () => {
  assert.deepEqual(columns(sql), columns(source));
  assert.deepEqual(columns(sql), [
    "id",
    "class_id",
    "member_id",
    "kind",
    "payload",
    "row_version",
    "created_at",
    "updated_at",
  ]);
  assert.match(source, /id BIGSERIAL PRIMARY KEY/u);
  assert.match(sql, /id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY/u);
  const composite =
    /FOREIGN KEY \(member_id, class_id\)\s+REFERENCES class_members \(id, class_id\) ON DELETE RESTRICT/u;
  assert.match(source, composite);
  assert.match(sql, composite);
  assert.match(source, /class_id BIGINT NOT NULL REFERENCES classes \(id\) ON DELETE RESTRICT/u);
  assert.match(sql, /FOREIGN KEY \(class_id\) REFERENCES classes \(id\) ON DELETE RESTRICT/u);
  const indexes = (input) =>
    [
      ...input.matchAll(/CREATE (?:UNIQUE )?INDEX \w+\s+ON layout_draft_autosaves \([^)]+\);/gu),
    ].map((match) => match[0].replace(/\s+/gu, " "));
  assert.deepEqual(indexes(sql), indexes(source));
  assert.equal(indexes(sql).length, 2);
});

test("JSON syntax and exact kind domain replace source types without inventing payload or time rules", () => {
  assert.match(source, /payload JSONB NOT NULL/u);
  assert.match(sql, /payload JSON NOT NULL/u);
  const values = (input) =>
    [...input.match(/CHECK \((?:BINARY )?kind IN \(([^)]+)\)\)/u)[1].matchAll(/'([^']+)'/gu)].map(
      (match) => match[1],
    );
  assert.deepEqual(values(sql), values(source));
  assert.match(sql, /CHECK \(BINARY kind IN \(BINARY 'seat_draw', BINARY 'team_draw'\)\)/u);
  assert.equal((sql.match(/\bCHECK \(/gu) ?? []).length, 1);
  assert.doesNotMatch(
    sql,
    /JSON_TYPE|JSON_LENGTH|JSON_SCHEMA|OCTET_LENGTH|ON UPDATE|TRIGGER|row_version\s*[><=]/u,
  );
  assert.match(source, /row_version BIGINT NOT NULL DEFAULT 1/u);
  assert.match(sql, /row_version BIGINT NOT NULL DEFAULT 1/u);
  for (const field of ["created_at", "updated_at"]) {
    assert.match(
      source,
      new RegExp(`${field} TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp\\(\\)`, "u"),
    );
    assert.match(
      sql,
      new RegExp(`${field} DATETIME\\(6\\) NOT NULL DEFAULT UTC_TIMESTAMP\\(6\\)`, "u"),
    );
  }
});

test("source app/retention permissions remain deferred and schema has no audit or expiry side effect", () => {
  assert.match(
    source,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON layout_draft_autosaves TO classhub_app/u,
  );
  const retention = strip(
    read("../../migrations/1783700034000_layout-draft-autosave-retention-grants.sql").split(
      "-- Down Migration",
    )[0],
  );
  assert.match(retention, /GRANT SELECT, DELETE ON layout_draft_autosaves TO classhub_retention/u);
  assert.doesNotMatch(
    sql,
    /\b(?:GRANT|REVOKE|INSERT INTO|DELETE FROM|TRIGGER|EVENT|PROCEDURE)\b/iu,
  );
  const pending = JSON.parse(read("../manifest.json")).semantic_migrations.find(
    (m) => m.source === "1783700034000_layout-draft-autosave-retention-grants.sql",
  );
  // 2026-10-04 은퇴: 이 단계의 상태가 '계획만(planned_unimplemented)'이라는 것은 그 시점 사진이었다(이후 진행됨).
  assert.deepEqual(pending.target_phases, [
    "0016_layout_draft_autosaves",
    "final_retention_permissions",
  ]);
});

test("runner checks binary index ordering, JSON storage and exact seeds within disposable QA", () => {
  const runner = read("../../../OPERATIONS/mariadb-dev/verify-phase16-qa.mjs");
  const scenarios = read("../../../OPERATIONS/mariadb-dev/phase16-scenarios.mjs");
  const compose = read("../../../compose.mariadb-phase16-qa.yaml");
  assert.match(compose, /internal: true/u);
  assert.match(compose, /\/var\/lib\/mysql:rw,noexec,nosuid,size=1073741824/u);
  assert.doesNotMatch(compose, /\n\s+ports:|runtime_activation|runtime_rollback/u);
  assert.equal((compose.match(/\/docker-entrypoint-initdb\.d\//gu) ?? []).length, 40);
  assert.equal((compose.match(/\/opt\/classhub\/phase16\//gu) ?? []).length, 1);
  for (const expected of [
    "ORDER BY BINARY INDEX_NAME",
    "const expectedAddedAcl = []",
    "seedAndZeroRows()",
    "longtext\\tutf8mb4\\tutf8mb4_bin",
    "persistentRows: 56",
    "persistentNonseedRows: 0",
  ])
    assert.ok(runner.includes(expected), expected);
  assert.doesNotMatch(scenarios, /foreign_key_checks|check_constraint_checks/iu);
  assert.match(scenarios, /updated_at<=@cutoff/u);
  assert.match(scenarios, /270000/u);
  const gaps = readEvidenceDocument("db/mariadb/verification/0016_layout_draft_autosaves_gaps.md");
  for (const expected of [
    "### B-01",
    "### B-02",
    "### B-03",
    "### B-04",
    "source0034",
    "JSONB",
    "256KiB",
    "clock_timestamp",
    "persistentRows=56",
  ])
    assert.ok(gaps.includes(expected), expected);
});

test("evidence rejects source digest drift, zero seed reporting and claimed retention activation", async () => {
  const phase = JSON.parse(read("../manifest.json")).phases.find(
    (p) => p.id === "0016_layout_draft_autosaves",
  );
  const readRepositoryFile = async (file) => read(`../../../${file}`);
  await verifyLayoutDraftEvidence(phase, readRepositoryFile);
  await assert.rejects(
    verifyLayoutDraftEvidence(
      { ...phase, verification: { ...phase.verification, migration_sha256: "0".repeat(64) } },
      readRepositoryFile,
    ),
    /digest drifted/u,
  );
  for (const [field, value] of [
    ["persistent_row_count", 0],
    ["retention_runtime_permissions", "verified"],
    ["automatic_timestamp_update", true],
  ])
    await assert.rejects(
      verifyLayoutDraftEvidence(
        { ...phase, verification: { ...phase.verification, [field]: value } },
        readRepositoryFile,
      ),
      new RegExp(field, "u"),
    );
});
