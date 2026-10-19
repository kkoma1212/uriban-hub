import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspectMariaDbSemanticSql } from "./active-semantic-sql.mjs";

const roles = ["app", "operator", "worker", "retention"];
const retainedSeedTables = [
  "attendance_notifications",
  "guardian_consent_requests",
  "student_assessment_records",
];
function statements(source) {
  // These five reviewed files use whole-line ordinary comments only. Do not silently
  // strip executable comments, inline syntax, or translate another SQL dialect.
  inspectMariaDbSemanticSql(source);
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("-- "));
}

/** Expand the deliberately narrow, pinned GRANT grammar into the driver's exact entries. */
export function inspectOptionalRuntimeAcl(source) {
  const result = Object.fromEntries(roles.map((role) => [role, []]));
  for (const line of statements(source)) {
    const routine =
      /^GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev\.([a-z_]+) TO 'classhub_(app|operator|worker|retention)'@'%';$/u.exec(
        line,
      );
    if (routine) {
      result[routine[2]].push(`procedure|${routine[1]}|EXECUTE`);
      continue;
    }
    const table =
      /^GRANT (.+) ON classhub_mariadb_phase1_dev\.`([a-z_]+)` TO 'classhub_(app|operator|worker|retention)'@'%';$/u.exec(
        line,
      );
    assert.ok(table, "Unreviewed optional runtime GRANT statement");
    for (const clause of table[1].split(/, (?=[A-Z])/u)) {
      const privilege =
        /^(DELETE|INSERT|SELECT|UPDATE)(?: \((`[a-z_][a-z0-9_]*`(?:, `[a-z_][a-z0-9_]*`)*)\))?$/u.exec(
          clause,
        );
      assert.ok(privilege, "Unreviewed optional runtime privilege clause");
      const columns = privilege[2] ? privilege[2].replaceAll("`", "").split(", ") : ["*"];
      assert.ok(
        privilege[1] !== "DELETE" || privilege[2] === undefined,
        "DELETE cannot be a column grant",
      );
      for (const column of columns)
        result[table[3]].push(`table|${table[2]}|${privilege[1]}|${column}`);
    }
  }
  for (const entries of Object.values(result)) {
    assert.equal(new Set(entries).size, entries.length, "Duplicate optional runtime privilege");
    entries.sort();
  }
  return result;
}

/** Installer-owned static seeds are unrelated to the worker's dynamic registrations. */
export function inspectOptionalLockSchema(source, table) {
  assert.ok(["worker_security_audit_lock_keys", "retention_lock_keys"].includes(table));
  const lines = statements(source);
  assert.deepEqual(lines.slice(0, 4), [
    `CREATE TABLE ${table} (`,
    "lock_digest BINARY(32) NOT NULL,",
    "PRIMARY KEY (lock_digest)",
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;",
  ]);
  if (table === "worker_security_audit_lock_keys") {
    assert.equal(lines.length, 4, "Worker registrations must start empty, without installer seeds");
    return { table, committed_seed_rows: 0, seed_sha256: [], seed_tables: [] };
  }
  assert.equal(lines.length, 10, "Retention schema must contain exactly three committed seeds");
  assert.equal(lines[4], "START TRANSACTION;");
  assert.equal(lines[5], "INSERT INTO retention_lock_keys (lock_digest) VALUES");
  assert.equal(lines[9], "COMMIT;", "Retention seed commit is required before runtime activation");
  const seeds = lines.slice(6, 9).map((line, index) => {
    const match = /^\(0x([a-f0-9]{64})\)([,;])$/u.exec(line);
    assert.ok(match, "Unreviewed retention seed literal");
    assert.equal(match[2], index === 2 ? ";" : ",");
    return match[1];
  });
  const expected = retainedSeedTables.map((name) =>
    createHash("sha256")
      .update(
        "classhub:mariadb:transaction-lock:v1:pg-hashtext\0classhub." + name + ".retention.v1",
      )
      .digest("hex"),
  );
  assert.deepEqual(seeds, expected, "Retention seeds must match only the three retained callers");
  return {
    table,
    committed_seed_rows: 3,
    seed_sha256: seeds,
    seed_tables: [...retainedSeedTables],
  };
}
