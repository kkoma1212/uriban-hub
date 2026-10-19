import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyLedger } from "./verify-ledger.mjs";

const ledgerDirectory = dirname(fileURLToPath(import.meta.url));
const migrationBytes = readFileSync(
  resolve(ledgerDirectory, "../migrations/0001_identity_foundation.sql"),
);
const recordSql = readFileSync(
  resolve(ledgerDirectory, "0001_identity_foundation_applied.sql"),
  "utf8",
);

test("ledger artifact matches the exact phase-0001 source bytes", () => {
  assert.deepEqual(verifyLedger(), {
    ledgerTable: "classhub_schema_migrations",
    migration: "0001_identity_foundation.sql",
    sourceBytes: 8231,
    sourceSha256: "8dd18cce674a69209e2cd96df27796ddb22681dfb21a769669fc8f821611987a",
    status: "pass",
  });
});

test("byte-level source drift fails closed", () => {
  assert.throws(
    () => verifyLedger({ migrationBytes: Buffer.concat([migrationBytes, Buffer.from("\n")]) }),
    /record SHA-256 does not match source bytes/u,
  );
});

test("an ignore-on-conflict record artifact is rejected", () => {
  assert.throws(
    () => verifyLedger({ recordSql: recordSql.replace("INSERT INTO", "INSERT IGNORE INTO") }),
    /plain ledger insert contract is missing|fail-closed plain INSERT/u,
  );
});

test("a non-failing partial table guard is rejected", () => {
  assert.throws(
    () => verifyLedger({ recordSql: recordSql.replace("THEN 1 ELSE 0", "THEN 1 ELSE 1") }),
    /partial-phase guard is missing/u,
  );
});
