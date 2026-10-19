import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import {
  buildTransactionLockKeysCandidate,
  transactionLockKeysFiles,
  verifyTransactionLockKeysCandidate,
} from "./0032_transaction_lock_keys_candidate.mjs";

/*
 * 2026-10-04 은퇴(사용자 결정, T-VERIFICATION-DOCS-DRIFT): 이 후보는 PostgreSQL 시절 잠금 호출부 7곳
 * (pg_advisory_xact_lock)을 전제로 한다. 운영자 코드가 MariaDB 잠금(lockOperatorTransaction)으로 바뀌어 후보 생성이
 * 늘 실패하고, 아래 '거부' 시험들은 이유와 무관하게 통과하는 가짜 통과가 됐다. 후보는 운영에 적용된 적이 없다
 * (realMariaDbVerified: false). 파일·후보 코드는 다른 QA가 참조하므로 보관하고 시험만 건너뛴다.
 */
const RETIRED = { skip: "retired 2026-10-04: PG-era candidate, operator lock now MariaDB" };

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path) => readFileSync(resolve(root, path), "utf8");
const modified = (path, transform) => (source) =>
  source === path ? transform(read(source)) : read(source);

test(
  "exact checked-in DDL contains five digests and preserves seven PG source callers",
  RETIRED,
  () => {
    assert.deepEqual(verifyTransactionLockKeysCandidate(), {
      status: "transaction_lock_keys_candidate_pass",
      registeredKeys: 5,
      sourceCallers: 7,
      runtimeActivationApplied: false,
      genericDynamicIdentitySupport: false,
      realMariaDbVerified: false,
      migrationSha256: "3b68bb0c5986a3d40ad80c83c74f6d7ab566762eb6f80ea3991ed78ac48004a7",
    });
  },
);
test("DDL persists no raw identity, grants, cleanup or dynamic registration", RETIRED, () => {
  const { migrationSql, digests } = buildTransactionLockKeysCandidate();
  assert.equal(digests.length, 5);
  assert.equal(new Set(digests).size, 5);
  assert.equal((migrationSql.match(/\(0x[0-9a-f]{64}\)/gu) ?? []).length, 5);
  assert.doesNotMatch(
    migrationSql,
    /classhub:|GRANT |CREATE USER|INSERT IGNORE|ON DUPLICATE|DELETE FROM|FOREIGN KEY|created_at|expires_at/u,
  );
});
for (const [name, change] of [
  ["dynamic identity", (registry) => registry.identities.push("worker:private@example.invalid")],
  [
    "pg hashtext namespace",
    (registry) => {
      registry.sourceAlgorithm = "pg_hashtext";
    },
  ],
  [
    "nonzero seed",
    (registry) => {
      registry.sourceSeed = "1";
    },
  ],
])
  test(`rejects registry drift: ${name}`, RETIRED, () => {
    assert.throws(() =>
      buildTransactionLockKeysCandidate(
        modified(transactionLockKeysFiles.registry, (text) => {
          const registry = JSON.parse(text);
          change(registry);
          return JSON.stringify(registry);
        }),
      ),
    );
  });
test("rejects one importer changing its shared contention identity", RETIRED, () => {
  assert.throws(() =>
    buildTransactionLockKeysCandidate(
      modified("apps/operator-cli/src/neis-meal-sync.ts", (text) =>
        text.replace('"classhub:meal-import"', '"classhub:school-import"'),
      ),
    ),
  );
});
test("rejects lifecycle shared lock becoming exclusive", RETIRED, () => {
  assert.throws(() =>
    buildTransactionLockKeysCandidate(
      modified("apps/operator-cli/src/operator-auth.ts", (text) =>
        text.replace("pg_advisory_xact_lock_shared(", "pg_advisory_xact_lock("),
      ),
    ),
  );
});
test("rejects a PG source algorithm or seed change", RETIRED, () => {
  assert.throws(() =>
    buildTransactionLockKeysCandidate(
      modified("apps/operator-cli/src/meal-import.ts", (text) =>
        text.replace("hashtextextended(${IMPORT_LOCK_NAME}, 0)", "hashtext(${IMPORT_LOCK_NAME})"),
      ),
    ),
  );
});
for (const suffix of [
  "\nGRANT SELECT ON transaction_lock_keys TO app;\n",
  "\nDELETE FROM transaction_lock_keys;\n",
])
  test("rejects unreviewed candidate mutation", RETIRED, () => {
    assert.throws(() =>
      verifyTransactionLockKeysCandidate(
        modified(transactionLockKeysFiles.migration, (text) => text + suffix),
      ),
    );
  });
