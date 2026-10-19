import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");

/** A new directory is the exclusive local attempt marker. Existing attempts never resume. */
export function createInstallJournal(directory, { planSha256, targetIdentity }) {
  assert.ok(isAbsolute(directory));
  assert.match(planSha256, /^[a-f0-9]{64}$/u);
  assert.match(targetIdentity, /^[a-zA-Z0-9_.:-]{1,160}$/u);
  mkdirSync(directory, { recursive: false });
  const descriptor = openSync(resolve(directory, "install.jsonl"), "wx", 0o600);
  let closed = false,
    sequence = 0,
    previous = "0".repeat(64);
  const attempt = randomUUID();
  function append(event) {
    assert.equal(closed, false);
    assert.ok(
      [
        "attempt_started",
        "source_started",
        "source_verified",
        "ledger_recorded",
        "installation_verified",
        "attempt_stopped",
      ].includes(event.status),
    );
    for (const key of Object.keys(event))
      assert.ok(
        [
          "status",
          "artifact",
          "source_sha256",
          "ledger_version",
          "stage",
          "verification_sha256",
        ].includes(key),
      );
    if (event.artifact !== undefined) assert.match(event.artifact, /^[a-z][a-z0-9-]{1,100}$/u);
    const record = {
      sequence: ++sequence,
      attempt,
      at_utc: new Date().toISOString(),
      plan_sha256: planSha256,
      target_identity: targetIdentity,
      previous_sha256: previous,
      ...event,
    };
    const bytes = JSON.stringify(record);
    previous = digest(bytes);
    const line = JSON.stringify({ ...record, record_sha256: previous }) + "\n";
    assert.equal(writeSync(descriptor, line), Buffer.byteLength(line));
    fsyncSync(descriptor);
  }
  append({ status: "attempt_started" });
  return {
    append,
    close() {
      if (!closed) {
        closed = true;
        closeSync(descriptor);
      }
    },
    attempt,
  };
}

/** SQL transport and independent postconditions belong to a strictly attested target adapter.
 * No target discovery, credential loading, automatic retry or existing-schema adoption here.
 */
export async function executeMariaDbInstallation({
  plan,
  adapter,
  readSource,
  journalDirectory,
  verifyPlan,
}) {
  verifyPlan(plan);
  assert.ok(plan.steps.length > 0);
  assert.equal(plan.automatic_resume, false);
  assert.equal(plan.static_dependencies_complete, true);
  assert.match(plan.plan_sha256, /^[a-f0-9]{64}$/u);
  for (const name of [
    "acquireExclusive",
    "assertFresh",
    "applySource",
    "verifyStep",
    "bootstrapLedger",
    "recordLedger",
    "readLedger",
    "verifyFinal",
    "releaseExclusive",
  ])
    assert.equal(typeof adapter[name], "function");
  const sources = new Map();
  for (const step of plan.steps) {
    const bytes = Buffer.from(readSource(step.source_path));
    assert.equal(bytes.length, step.byte_length);
    assert.equal(digest(bytes), step.sha256, `Source changed before installation: ${step.id}`);
    sources.set(step.id, bytes);
  }
  const journal = createInstallJournal(journalDirectory, {
    planSha256: plan.plan_sha256,
    targetIdentity: adapter.targetIdentity,
  });
  let exclusive = false,
    stage = "acquire_exclusive",
    current;
  const recorded = [];
  try {
    await adapter.acquireExclusive();
    exclusive = true;
    stage = "assert_fresh";
    await adapter.assertFresh();
    for (const [index, step] of plan.steps.entries()) {
      current = step;
      assert.equal(
        digest(Buffer.from(readSource(step.source_path))),
        step.sha256,
        `Source changed during installation: ${step.id}`,
      );
      stage = "apply_source";
      journal.append({
        status: "source_started",
        artifact: step.id,
        source_sha256: step.sha256,
        ledger_version: step.ledger_version,
      });
      await adapter.applySource(step, sources.get(step.id));
      stage = "verify_source";
      const verification = await adapter.verifyStep(step);
      assert.equal(verification.verified, true);
      journal.append({
        status: "source_verified",
        artifact: step.id,
        verification_sha256: digest(JSON.stringify(verification)),
      });
      if (step.ledger_version === null) {
        assert.equal(index, 0);
        stage = "bootstrap_ledger";
        await adapter.bootstrapLedger(plan.ledger);
      } else {
        stage = "record_ledger";
        const result = await adapter.recordLedger(step);
        assert.equal(result.affectedRows, 1);
        stage = "verify_ledger";
        const row = await adapter.readLedger(step.ledger_version);
        assert.equal(row.version, String(step.ledger_version));
        assert.equal(row.description, step.id);
        assert.equal(row.source_sha256, step.sha256);
        assert.match(row.applied_at_utc, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/u);
        assert.match(row.server_version, /^11\.4\.13-MariaDB(?:-|$)/u);
        recorded.push(step.ledger_version);
        journal.append({
          status: "ledger_recorded",
          artifact: step.id,
          source_sha256: step.sha256,
          ledger_version: step.ledger_version,
        });
      }
    }
    stage = "verify_installation";
    assert.deepEqual(
      recorded,
      plan.steps.filter((step) => step.ledger_version !== null).map((step) => step.ledger_version),
    );
    const final = await adapter.verifyFinal(plan);
    assert.equal(final.verified, true);
    journal.append({
      status: "installation_verified",
      verification_sha256: digest(JSON.stringify(final)),
    });
    return {
      status: "mariadb_installation_verified",
      recordedVersions: recorded,
      final,
      attempt: journal.attempt,
      runtimeActivationApplied: false,
    };
  } catch {
    journal.append({
      status: "attempt_stopped",
      stage,
      ...(current ? { artifact: current.id } : {}),
    });
    throw Object.assign(
      new Error(
        `MariaDB installation stopped at ${stage}; inspect this attempt before any new installation.`,
      ),
      { code: "MARIADB_INSTALLATION_STOPPED", stage, artifact: current?.id },
    );
  } finally {
    try {
      if (exclusive) await adapter.releaseExclusive();
    } finally {
      journal.close();
    }
  }
}
