import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const LEDGER_PATH = resolve(
  REPOSITORY_ROOT,
  "QUALITY",
  "audit-corrections",
  "2026-07-28-final-review-corrections-r001.json",
);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function workspacePath(relativePath) {
  return resolve(REPOSITORY_ROOT, ...relativePath.split("/"));
}

function sorted(values) {
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

function sameValues(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

async function verifyPinnedFile(record) {
  const bytes = await readFile(workspacePath(record.path));
  assert(bytes.length === record.bytes, `${record.path} byte length changed`);
  assert(sha256(bytes) === record.sha256, `${record.path} SHA-256 changed`);
  return bytes;
}

function verifyGateLedger(ledger) {
  const expectedIds = Array.from(
    { length: 14 },
    (_, index) => `GATE-${String(index + 1).padStart(2, "0")}`,
  );
  const actualIds = ledger.gate_ledger.map((gate) => gate.id);
  assert(sameValues(actualIds, expectedIds), "gate ledger is not the exact GATE-01..14 set");
  assert(new Set(actualIds).size === 14, "gate ledger contains duplicate IDs");

  const allowedStatuses = new Set(["PASS", "PARTIAL", "FAIL", "N/V"]);
  const actualSummary = { PASS: 0, PARTIAL: 0, FAIL: 0, "N/V": 0 };
  for (const gate of ledger.gate_ledger) {
    assert(allowedStatuses.has(gate.status), `invalid gate status: ${gate.status}`);
    assert(typeof gate.basis === "string" && gate.basis.length > 0, `${gate.id} basis is empty`);
    actualSummary[gate.status] += 1;
  }
  assert(
    JSON.stringify(actualSummary) === JSON.stringify(ledger.gate_summary),
    "gate summary does not match gate ledger",
  );
  assert(
    ledger.gate_ledger.find((gate) => gate.id === "GATE-07")?.status === "FAIL",
    "GATE-07 contrast failure correction is missing",
  );
}

function verifyCorrectionIds(ledger) {
  const expectedIds = Array.from(
    { length: 12 },
    (_, index) => `COR-20260728-${String(index + 1).padStart(3, "0")}`,
  );
  const actualIds = ledger.corrections.map((correction) => correction.id);
  assert(sameValues(actualIds, expectedIds), "correction IDs are incomplete or unexpected");
  assert(new Set(actualIds).size === expectedIds.length, "correction IDs are duplicated");
}

async function main() {
  const ledger = JSON.parse(await readFile(LEDGER_PATH, "utf8"));
  assert(ledger.schema_version === 1, "unsupported ledger schema");
  assert(ledger.revision === 1, "unexpected ledger revision");
  assert(
    ledger.status === "CURRENT_CORRECTION_NOT_RELEASE_APPROVAL",
    "ledger status is not fail-closed",
  );
  assert(ledger.baseline.release_status === "NOT_READY", "release status is not fail-closed");
  assert(ledger.baseline.official_current_score === "N/V", "official score must remain N/V");
  assert(
    ledger.baseline.claude_auxiliary_score_status === "NON_CANONICAL_REFERENCE_ONLY",
    "Claude auxiliary score is incorrectly canonicalized",
  );

  const sourceEntries = Object.values(ledger.source_documents);
  const normativeEntries = Object.values(ledger.normative_documents);
  const sourceBytes = await Promise.all(sourceEntries.map(verifyPinnedFile));
  await Promise.all(normativeEntries.map(verifyPinnedFile));
  await Promise.all(ledger.durable_browser_evidence.files.map(verifyPinnedFile));

  const [browserReport, claudeReport, functionalReport] = sourceBytes.map((bytes) =>
    bytes.toString("utf8"),
  );
  assert(browserReport.includes("# NOT READY"), "browser report no longer contains NOT READY");
  assert(
    claudeReport.includes("아래 즉시 차단 6건") && claudeReport.includes("즉시 차단 8건 중"),
    "Claude report no longer contains the pinned blocker-count inconsistency",
  );
  assert(
    claudeReport.includes("`#e11d48` on `#1e2232`") && claudeReport.includes("3.36:1"),
    "Claude report no longer contains the verified contrast calculation",
  );
  assert(
    functionalReport.includes("사용자 승인 하"),
    "functional report no longer contains the provenance wording being corrected",
  );

  const quality = ledger.normative_documents.quality_current;
  const appendix = ledger.normative_documents.release_appendix;
  assert(
    quality.sha256 !== appendix.pinned_quality_sha256,
    "quality hash drift disappeared; create a new ledger revision and rescore",
  );
  const appendixText = (await readFile(workspacePath(appendix.path), "utf8")).toUpperCase();
  assert(
    appendixText.includes(appendix.pinned_quality_sha256),
    "release appendix no longer contains the pinned quality hash",
  );

  const evidencePaths = ledger.durable_browser_evidence.files.map((record) => record.path);
  assert(new Set(evidencePaths).size === 6, "durable browser evidence must contain six files");
  assert(
    new Set(ledger.durable_browser_evidence.files.map((record) => record.sha256)).size === 6,
    "durable browser evidence contains duplicate hashes",
  );
  assert(
    ledger.durable_browser_evidence.not_persisted.includes("RAW_NETWORK_LOG") &&
      ledger.durable_browser_evidence.not_persisted.includes("RAW_FOCUS_TRACE"),
    "missing browser evidence limitations are not recorded",
  );

  verifyCorrectionIds(ledger);
  verifyGateLedger(ledger);

  process.stdout.write(
    `${JSON.stringify({
      durable_screenshots: evidencePaths.length,
      gate_summary: ledger.gate_summary,
      ledger_id: ledger.ledger_id,
      official_current_score: ledger.baseline.official_current_score,
      revision: ledger.revision,
      status: "PASS",
    })}\n`,
  );
}

await main();
