import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import { verifyLayoutTemplateEvidence } from "./0017_classroom_layout_templates_evidence.mjs";
import { verifyFeaturePhaseEvidence } from "./feature_phase_evidence.mjs";
import { readEvidenceDocument } from "./evidence-document.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const strip = (value) => value.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*--.*$/gmu, "");
const source = strip(
  read("../../migrations/1783700035000_classroom-layout-templates.sql").split(
    "-- Down Migration",
  )[0],
);
const sql = strip(read("../migrations/0017_classroom_layout_templates.sql"));
const columns = (input) =>
  [...input.matchAll(/^ {2}(\w+) (?:BIGSERIAL|BIGINT|TEXT|JSONB?|TIMESTAMPTZ|DATETIME)\b/gmu)].map(
    (match) => match[1],
  );
const manifest = () => JSON.parse(read("../manifest.json"));
const readRepositoryFile = async (file) => read(`../../../${file}`);

test("source columns, owner references and descending history index survive", () => {
  assert.deepEqual(columns(sql), columns(source));
  assert.deepEqual(columns(sql), [
    "id",
    "class_id",
    "member_id",
    "name",
    "payload",
    "row_version",
    "created_at",
    "updated_at",
  ]);
  assert.match(source, /id BIGSERIAL PRIMARY KEY/u);
  assert.match(sql, /id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY/u);
  const member =
    /FOREIGN KEY \(member_id, class_id\)\s+REFERENCES class_members \(id, class_id\) ON DELETE RESTRICT/u;
  assert.match(source, member);
  assert.match(sql, member);
  assert.match(source, /class_id BIGINT NOT NULL REFERENCES classes \(id\) ON DELETE RESTRICT/u);
  assert.match(sql, /FOREIGN KEY \(class_id\) REFERENCES classes \(id\) ON DELETE RESTRICT/u);
  const history =
    /CREATE INDEX classroom_layout_templates_owner_updated_at_index\s+ON classroom_layout_templates \(class_id, member_id, updated_at DESC\)/u;
  assert.match(source, history);
  assert.match(sql, history);
});

test("TEXT name keeps the source bound and the unique prefix covers every valid character", () => {
  assert.match(source, /name = btrim\(name\)/u);
  assert.match(source, /char_length\(name\) BETWEEN 1 AND 40/u);
  assert.match(source, /name !~ '\[\[:cntrl:\]\]'/u);
  assert.match(sql, /name TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL/u);
  assert.match(sql, /BINARY name = BINARY TRIM\(name\)/u);
  assert.match(sql, /name NOT REGEXP '\[\[:cntrl:\]\]'/u);
  const bound = Number(sql.match(/CHAR_LENGTH\(name\) BETWEEN 1 AND (\d+)/u)[1]);
  const prefix = Number(
    sql.match(/ON classroom_layout_templates \(class_id, member_id, name\((\d+)\)\)/u)[1],
  );
  assert.equal(bound, 40);
  assert.equal(prefix, bound);
  assert.match(source, /ON classroom_layout_templates \(class_id, member_id, name\)/u);
  assert.doesNotMatch(sql, /name VARCHAR|name\([123][0-9]\)/u);
});

test("JSON and positive version preserve source checks without adding API policy or side effects", () => {
  assert.match(source, /payload JSONB NOT NULL/u);
  assert.match(sql, /payload JSON NOT NULL/u);
  for (const input of [source, sql]) assert.match(input, /CHECK \(row_version >= 1\)/u);
  assert.equal((sql.match(/\bCHECK \(/gu) ?? []).length, 2);
  assert.doesNotMatch(
    sql,
    /JSON_TYPE|JSON_LENGTH|JSON_SCHEMA|OCTET_LENGTH|ON UPDATE|CREATE TRIGGER|CREATE EVENT/u,
  );
  assert.match(
    source,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON classroom_layout_templates TO classhub_app/u,
  );
  assert.doesNotMatch(sql, /\b(?:GRANT|REVOKE|INSERT INTO|DELETE FROM|CREATE USER|PROCEDURE)\b/iu);
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

test("QA checks complete prefix/direction metadata, untouched ACL and seeded isolation", () => {
  const runner = read("../../../OPERATIONS/mariadb-dev/verify-phase17-qa.mjs");
  const compose = read("../../../compose.mariadb-phase17-qa.yaml");
  assert.match(compose, /internal: true/u);
  assert.match(compose, /\/var\/lib\/mysql:rw,noexec,nosuid,size=1073741824/u);
  assert.doesNotMatch(compose, /\n\s+ports:|runtime_activation|runtime_rollback/u);
  assert.equal((compose.match(/\/docker-entrypoint-initdb\.d\//gu) ?? []).length, 41);
  assert.equal((compose.match(/\/opt\/classhub\/phase17\//gu) ?? []).length, 1);
  for (const expected of [
    "ORDER BY BINARY INDEX_NAME",
    "SUB_PART",
    "name:A:40",
    "updated_at:D:full",
    "const expectedAddedAcl = []",
    "seedAndZeroRows()",
    "persistentRows: 56",
    "persistentNonseedRows: 0",
  ])
    assert.ok(runner.includes(expected), expected);
  const scenarios = read("../../../OPERATIONS/mariadb-dev/phase17-scenarios.mjs");
  assert.doesNotMatch(scenarios, /foreign_key_checks|check_constraint_checks/iu);
  const gaps = readEvidenceDocument(
    "db/mariadb/verification/0017_classroom_layout_templates_gaps.md",
  );
  for (const expected of [
    "### B-01",
    "### B-02",
    "### B-03",
    "### B-04",
    "name(40)",
    "JSONB",
    "32KiB",
    "advisory",
    "persistentRows=56",
  ])
    assert.ok(gaps.includes(expected), expected);
});

test("template evidence rejects changed SQL, incomplete name index and false zero seed report", async () => {
  const phase = manifest().phases.find((p) => p.id === "0017_classroom_layout_templates");
  await verifyLayoutTemplateEvidence(phase, readRepositoryFile);
  await assert.rejects(
    verifyLayoutTemplateEvidence(
      { ...phase, verification: { ...phase.verification, migration_sha256: "0".repeat(64) } },
      readRepositoryFile,
    ),
    /digest drifted/u,
  );
  for (const [field, value] of [
    ["persistent_row_count", 0],
    ["name_index_prefix_characters", 39],
    ["automatic_timestamp_update", true],
  ])
    await assert.rejects(
      verifyLayoutTemplateEvidence(
        { ...phase, verification: { ...phase.verification, [field]: value } },
        readRepositoryFile,
      ),
      new RegExp(field, "u"),
    );
});

test("extracted dispatcher still enforces all six phase contracts and refuses unknown phases", async () => {
  const phases = manifest().phases.filter((p) =>
    ["0012", "0013", "0014", "0015", "0016", "0017"].includes(p.id.slice(0, 4)),
  );
  assert.equal(phases.length, 6);
  for (const phase of phases) {
    await verifyFeaturePhaseEvidence(phase, readRepositoryFile);
    await assert.rejects(
      verifyFeaturePhaseEvidence(
        { ...phase, verification: { ...phase.verification, migration_sha256: "0".repeat(64) } },
        readRepositoryFile,
      ),
      /digest drifted/u,
    );
  }
  for (const id of ["0099_unknown", "constructor", "__proto__"])
    await assert.rejects(
      verifyFeaturePhaseEvidence({ id }, readRepositoryFile),
      /has no evidence contract/u,
    );
});
