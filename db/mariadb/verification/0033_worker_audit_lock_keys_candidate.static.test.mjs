import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWorkerAuditLockKeysCandidate,
  verifyWorkerAuditLockKeysCandidate,
} from "./0033_worker_audit_lock_keys_candidate.mjs";

test("exact operational DDL is unactivated with no seeds and discloses persistent growth", () => {
  const result = verifyWorkerAuditLockKeysCandidate();
  assert.equal(result.status, "worker_audit_lock_keys_candidate_pass");
  assert.equal(result.operationalTables, 1);
  assert.equal(result.initialRegistrations, 0);
  assert.equal(result.registrationsAccumulate, true);
  assert.equal(result.productionCleanupImplemented, false);
  assert.equal(result.runtimeActivationApplied, false);
  assert.equal(result.realMariaDbVerified, false);
  assert.deepEqual(result.runtimePrivilegesRequired, ["INSERT", "SELECT"]);
});
test("DDL contains only digest PK and no grants, identity payload, seed or cleanup writes", () => {
  const sql = buildWorkerAuditLockKeysCandidate()
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");
  assert.match(
    sql,
    /CREATE TABLE worker_security_audit_lock_keys \(\s*lock_digest BINARY\(32\) NOT NULL,\s*PRIMARY KEY \(lock_digest\)\s*\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;/u,
  );
  assert.doesNotMatch(
    sql,
    /GRANT|INSERT|UPDATE|DELETE|FOREIGN KEY|identity|created_at|expires_at|AUTO_INCREMENT|TRIGGER|PROCEDURE/u,
  );
});
for (const change of [
  (sql) => sql.replace("BINARY(32)", "BINARY(16)"),
  (sql) => sql.replace("ENGINE=InnoDB", "ENGINE=Aria"),
  (sql) => sql.replace("PRIMARY KEY (lock_digest)", "PRIMARY KEY (lock_digest), raw_identity TEXT"),
  (sql) => sql + "\nGRANT DELETE ON worker_security_audit_lock_keys TO worker;\n",
])
  test("unreviewed operational schema or permissions fail verification", () => {
    assert.throws(() =>
      verifyWorkerAuditLockKeysCandidate(() => change(buildWorkerAuditLockKeysCandidate())),
    );
  });
