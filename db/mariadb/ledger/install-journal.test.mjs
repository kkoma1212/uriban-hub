import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import test from "node:test";
import { executeMariaDbInstallation } from "./install-journal.mjs";
import { buildRuntimeInstallPlan, verifyRuntimeInstallPlan } from "./runtime-install-plan.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const root = resolve(".local-backups");
mkdirSync(root, { recursive: true });
function scenario(t, failAt) {
  const directory = mkdtempSync(resolve(root, "install-journal-test-"));
  t.after(() => {
    assert.ok(directory.startsWith(root + sep + "install-journal-test-"));
    rmSync(directory, { recursive: true });
  });
  const readSource = (path) => Buffer.from(path + "\n");
  const steps = ["identities", "foundation", "permissions"].map((id, i) => ({
    id,
    source_path: id + ".sql",
    ledger_version: i === 0 ? null : i,
    byte_length: readSource(id + ".sql").length,
    sha256: sha(readSource(id + ".sql")),
  }));
  const plan = {
    steps,
    ledger: {},
    automatic_resume: false,
    static_dependencies_complete: true,
    plan_sha256: sha("synthetic plan"),
  };
  const trace = [],
    rows = new Map();
  const call = (name) => {
    trace.push(name);
    if (name === failAt) throw new Error("private adapter diagnostics must not be journaled");
  };
  const adapter = {
    targetIdentity: "synthetic-journal-test",
    async acquireExclusive() {
      call("lock");
    },
    async releaseExclusive() {
      call("unlock");
    },
    async assertFresh() {
      call("fresh");
    },
    async applySource(step) {
      call("apply:" + step.id);
    },
    async verifyStep(step) {
      call("verify:" + step.id);
      return { verified: true };
    },
    async bootstrapLedger() {
      call("bootstrap");
    },
    async recordLedger(step) {
      const row = {
        version: String(step.ledger_version),
        description: step.id,
        source_sha256: step.sha256,
        applied_at_utc: "2026-09-08 08:00:00.123456",
        server_version: "11.4.13-MariaDB",
      };
      rows.set(step.ledger_version, row);
      call("record:" + step.id);
      return { affectedRows: 1 };
    },
    async readLedger(version) {
      call("read:" + version);
      return rows.get(version);
    },
    async verifyFinal() {
      call("final");
      return { verified: true };
    },
  };
  const options = {
    plan,
    adapter,
    readSource,
    journalDirectory: resolve(directory, "attempt"),
    verifyPlan: (value) => assert.deepEqual(value, plan),
  };
  const journal = () =>
    readFileSync(resolve(options.journalDirectory, "install.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { options, trace, rows, journal };
}

test("all current selected sources produce a stable complete plan and reject a forged digest", () => {
  const plan = buildRuntimeInstallPlan();
  assert.equal(verifyRuntimeInstallPlan(plan), true);
  assert.equal(plan.product_tables.length, 54);
  assert.equal(plan.expected_base_table_count, 57);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(plan.final_runtime_grants).map(([role, entries]) => [role, entries.length]),
    ),
    { app: 251, operator: 195, worker: 4, retention: 44 },
  );
  assert.throws(() => verifyRuntimeInstallPlan({ ...plan, plan_sha256: "0".repeat(64) }));
});

test("durable source-start precedes SQL, postconditions precede ledger, and records form an intact chain", async (t) => {
  const s = scenario(t);
  const apply = s.options.adapter.applySource;
  s.options.adapter.applySource = async (step) => {
    assert.equal(s.journal().at(-1).status, "source_started");
    await apply(step);
  };
  const result = await executeMariaDbInstallation(s.options);
  assert.deepEqual(result.recordedVersions, [1, 2]);
  assert.deepEqual(s.trace, [
    "lock",
    "fresh",
    "apply:identities",
    "verify:identities",
    "bootstrap",
    "apply:foundation",
    "verify:foundation",
    "record:foundation",
    "read:1",
    "apply:permissions",
    "verify:permissions",
    "record:permissions",
    "read:2",
    "final",
    "unlock",
  ]);
  let previous = "0".repeat(64);
  for (const [i, item] of s.journal().entries()) {
    const { record_sha256: hash, ...record } = item;
    assert.equal(record.sequence, i + 1);
    assert.equal(record.previous_sha256, previous);
    assert.equal(hash, sha(JSON.stringify(record)));
    previous = hash;
  }
  assert.equal(s.journal().at(-1).status, "installation_verified");
});

for (const failure of [
  "fresh",
  "apply:foundation",
  "verify:foundation",
  "record:foundation",
  "read:1",
  "final",
]) {
  test(`failure at ${failure} is never automatically retried or reported complete`, async (t) => {
    const s = scenario(t, failure);
    await assert.rejects(executeMariaDbInstallation(s.options), {
      code: "MARIADB_INSTALLATION_STOPPED",
    });
    assert.equal(s.trace.filter((entry) => entry === failure).length, 1);
    assert.equal(s.trace.at(-1), "unlock");
    assert.equal(s.journal().at(-1).status, "attempt_stopped");
    assert.ok(!JSON.stringify(s.journal()).includes("private adapter"));
    if (["fresh", "apply:foundation", "verify:foundation"].includes(failure))
      assert.equal(s.rows.size, 0);
    const before = [...s.trace];
    await assert.rejects(executeMariaDbInstallation(s.options));
    assert.deepEqual(s.trace, before, "existing local journal blocks another DB attempt");
  });
}
