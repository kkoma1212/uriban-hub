import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRecordBytes } from "../OPERATIONS/project-records/store.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const LEDGER_PATH = resolve(
  REPOSITORY_ROOT,
  "QUALITY",
  "audit-corrections",
  "2026-07-26-review-corrections-r001.json",
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

function section(text, startPattern, endPattern) {
  const start = text.search(startPattern);
  assert(start >= 0, `section start not found: ${startPattern}`);
  const remainder = text.slice(start);
  const endMatch = remainder.slice(1).search(endPattern);
  assert(endMatch >= 0, `section end not found: ${endPattern}`);
  return remainder.slice(0, endMatch + 1);
}

function headingIds(text, severity) {
  return [...text.matchAll(new RegExp(`^#### (${severity}-\\d{2})\\b`, "gmu"))].map(
    (match) => match[1],
  );
}

function p2Ids(text) {
  const p2 = section(text, /^### 4\.3 P2\b/mu, /^### 4\.4 P3\b/mu);
  return [...p2.matchAll(/^\|\s*([A-Z]+-\d{2})\s*\|/gmu)].map((match) => match[1]);
}

function expandP3Ids(text) {
  const p3 = section(text, /^### 4\.4 P3\b/mu, /^### 4\.5\b/mu);
  const expression = p3.split(/\r?\n/u).find((line) => line.trimStart().startsWith("SEC-03("));
  assert(expression !== undefined, "P3 range expression not found");
  const result = [];
  for (const rawSegment of expression.split("/")) {
    const segment = rawSegment.replace(/\([^)]*\)/gu, "").trim();
    const prefixMatch = segment.match(/^([A-Z]+)-(.+)$/u);
    assert(prefixMatch !== null, `invalid P3 segment: ${rawSegment}`);
    const [, prefix, expressionBody] = prefixMatch;
    for (const rawPart of expressionBody.split(",")) {
      const part = rawPart.trim();
      const rangeMatch = part.match(/^(\d{2})(?:~(\d{2}))?$/u);
      assert(rangeMatch !== null, `invalid P3 range: ${rawPart}`);
      const first = Number(rangeMatch[1]);
      const last = Number(rangeMatch[2] ?? rangeMatch[1]);
      assert(first <= last, `descending P3 range: ${rawPart}`);
      for (let value = first; value <= last; value += 1) {
        result.push(`${prefix}-${String(value).padStart(2, "0")}`);
      }
    }
  }
  return result;
}

function userDecisionForks(text) {
  return [...text.matchAll(/^\*\*갈림길\s+(\d+)\s*[—-]/gmu)].map((match) => Number(match[1]));
}

async function verifyPinnedDocument(record) {
  const bytes = record.path.endsWith(".md")
    ? readRecordBytes(record.path)
    : await readFile(workspacePath(record.path));
  assert(bytes.length === record.bytes, `${record.path} byte length changed`);
  assert(sha256(bytes) === record.sha256, `${record.path} SHA-256 changed`);
  return bytes;
}

function verifyP2Classification(ledger, extractedIds) {
  const categories = ledger.corrections.p2.classifications;
  const classifiedIds = Object.values(categories).flat();
  assert(
    new Set(classifiedIds).size === classifiedIds.length,
    "P2 classification contains duplicate IDs",
  );
  assert(
    sameValues(classifiedIds, extractedIds),
    "P2 classification is not an exact partition of the report table",
  );
  for (const [duplicateId, canonicalId] of Object.entries(ledger.corrections.p2.duplicate_links)) {
    assert(extractedIds.includes(duplicateId), `unknown P2 duplicate ID: ${duplicateId}`);
    assert(
      extractedIds.includes(canonicalId) || /^P1-\d{2}$/u.test(canonicalId),
      `unknown duplicate target: ${canonicalId}`,
    );
  }
}

async function screenEvidenceFacts(record) {
  const bytes = await verifyPinnedDocument(record);
  const evidence = JSON.parse(bytes.toString("utf8"));
  const evidenceDirectory = dirname(workspacePath(record.path));
  const referencedScreenshots = evidence.screenshots;
  const screenshotFiles = (await readdir(evidenceDirectory)).filter((name) =>
    name.endsWith(".png"),
  );
  assert(
    sameValues(referencedScreenshots, screenshotFiles),
    "screen evidence PNG files do not exactly match screenshot references",
  );
  const hashes = await Promise.all(
    referencedScreenshots.map(async (name) =>
      sha256(await readFile(resolve(evidenceDirectory, name))),
    ),
  );
  const requestedPairs = new Set(
    evidence.pages.map((page) => `${page.role}\u0000${page.requestedPath}`),
  );
  const finalPairs = new Set(evidence.pages.map((page) => `${page.role}\u0000${page.finalPath}`));
  const redirectPairs = new Set(
    evidence.pages
      .filter((page) => page.requestedPath !== page.finalPath)
      .map((page) => `${page.role}\u0000${page.requestedPath}\u0000${page.finalPath}`),
  );
  return {
    capture_count: evidence.pages.length,
    screenshot_reference_count: referencedScreenshots.length,
    screenshot_file_count: screenshotFiles.length,
    unique_png_sha256_count: new Set(hashes).size,
    duplicate_reduction_count: hashes.length - new Set(hashes).size,
    unique_requested_role_path_count: requestedPairs.size,
    unique_final_role_path_count: finalPairs.size,
    redirect_scenario_count: redirectPairs.size,
    network_failure_record_count: evidence.diagnostics.failed.length,
  };
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
  assert(
    ledger.gate_ledger.every(
      (gate) =>
        allowedStatuses.has(gate.status) && typeof gate.basis === "string" && gate.basis.length > 0,
    ),
    "gate ledger contains an invalid status or empty basis",
  );
  const passCount = ledger.gate_ledger.filter((gate) => gate.status === "PASS").length;
  assert(passCount === ledger.gate_pass_count, "gate PASS count is inconsistent");
}

async function verifyImplementationCorrections() {
  const support = await readFile(
    resolve(REPOSITORY_ROOT, "browser-qa", "lib", "content-updates-browser-support.mjs"),
    "utf8",
  );
  assert(
    support.includes("evidence.handlerErrors.push({"),
    "diagnostic handler failures are still not captured",
  );
  assert(
    support.includes('if (typeof mutation?.status === "number") return mutation;'),
    "waitForMutation does not wait for a numeric response status",
  );
  assert(
    !support.includes("if (mutation?.status !== null) return mutation;"),
    "waitForMutation still returns before a delayed mutation entry exists",
  );

  const recovery = await readFile(
    resolve(REPOSITORY_ROOT, "OPERATIONS", "scripts", "backup-restore-drill.sh"),
    "utf8",
  );
  assert(
    recovery.includes('EXPECTED_MIGRATION_COUNT="22"') &&
      recovery.includes(
        'EXPECTED_LATEST_MIGRATION="1783700021000_poll-visibility-and-results-policy"',
      ),
    "recovery drill migration head is stale",
  );
  const currentRecoveryTables = [
    "notice_recipients",
    "poll_options",
    "poll_votes",
    "polls",
    "school_schedule_events",
    "school_schedule_import_logs",
    "seat_draw_assignments",
    "seat_draw_slots",
    "seat_draws",
    "student_assessment_records",
    "supply_recipients",
    "team_draw_assignments",
    "team_draw_groups",
    "team_draws",
  ];
  for (const table of currentRecoveryTables) {
    assert(
      recovery.includes(`'${table}',(SELECT count(*) FROM ${table})`) &&
        recovery.includes(`\n  ${table}\n`),
      `recovery drill does not fully inventory ${table}`,
    );
  }
  assert(
    recovery.includes("explicit product table inventory does not match the public schema"),
    "recovery drill lacks the public-schema exact-set guard",
  );
  assert(
    recovery.includes("synthetic fixture left product tables empty"),
    "recovery drill does not fail closed when a product table lacks fixture data",
  );
  assert(
    recovery.split("pg_get_constraintdef(c.oid, true)").length - 1 >= 2,
    "recovery drill does not compare exact source/restore constraint definitions",
  );

  const fixture = await readFile(
    resolve(REPOSITORY_ROOT, "OPERATIONS", "fixtures", "recovery-drill.sql"),
    "utf8",
  );
  for (const table of currentRecoveryTables) {
    assert(fixture.includes(`INSERT INTO ${table}`), `recovery fixture does not populate ${table}`);
  }

  const decision = readRecordBytes("QUALITY/지정대상_통합알림_V1_결정_AC_2026-07-26.md").toString(
    "utf8",
  );
  assert(
    !decision.includes("DB trigger도 recipient의 UPDATE·DELETE와 대상 키 변경을 거부한다."),
    "recipient trigger false claim remains",
  );
  assert(
    decision.includes("handler error 0건 주장은 `N/V`로 정정한다."),
    "historical handler-error PASS was not corrected",
  );
}

async function main() {
  const ledger = JSON.parse(await readFile(LEDGER_PATH, "utf8"));
  assert(ledger.schema_version === 1, "unsupported ledger schema");
  assert(ledger.revision === 1, "unexpected ledger revision");
  assert(
    ledger.status === "CURRENT_CORRECTION_NOT_RELEASE_APPROVAL",
    "ledger status is not fail-closed",
  );

  const independentBytes = await verifyPinnedDocument(ledger.source_documents.independent_report);
  await verifyPinnedDocument(ledger.source_documents.integrated_report);
  const independentText = independentBytes.toString("utf8");
  const p0 = headingIds(independentText, "P0");
  const p1 = headingIds(independentText, "P1");
  const p2 = p2Ids(independentText);
  const p3 = expandP3Ids(independentText);
  const forks = userDecisionForks(independentText);
  const expectedIndependent = ledger.mechanical_facts.independent_report;

  assert(new Set(p0).size === p0.length, "P0 headings are not unique");
  assert(new Set(p1).size === p1.length, "P1 headings are not unique");
  assert(new Set(p2).size === p2.length, "P2 table IDs are not unique");
  assert(new Set(p3).size === p3.length, "P3 expanded IDs are not unique");
  assert(p0.length === expectedIndependent.p0_heading_count, "P0 count mismatch");
  assert(p1.length === expectedIndependent.p1_heading_count, "P1 count mismatch");
  assert(p2.length === expectedIndependent.p2_table_row_count, "P2 row count mismatch");
  assert(new Set(p2).size === expectedIndependent.p2_unique_id_count, "P2 unique count mismatch");
  assert(
    p2.length - expectedIndependent.p2_explicit_duplicate_or_promoted_ids.length ===
      expectedIndependent.p2_after_explicit_duplicate_or_promoted_count,
    "P2 explicit de-duplication count mismatch",
  );
  assert(p3.length === expectedIndependent.p3_expanded_id_count, "P3 range count mismatch");
  assert(
    p3.filter((id) => id.startsWith("SEC-")).length === expectedIndependent.p3_described_id_count,
    "P3 described count mismatch",
  );
  assert(
    p3.length - expectedIndependent.p3_described_id_count ===
      expectedIndependent.p3_opaque_id_count,
    "P3 opaque count mismatch",
  );
  assert(
    p3.length + expectedIndependent.p3_separately_downgraded_count ===
      expectedIndependent.p3_raw_potential_total,
    "P3 raw potential total mismatch",
  );
  assert(
    new Set(forks).size === expectedIndependent.user_decision_fork_count,
    "user decision fork count mismatch",
  );

  verifyP2Classification(ledger, p2);
  const actualScreenFacts = await screenEvidenceFacts(
    ledger.source_documents.rendered_screen_evidence,
  );
  assert(
    JSON.stringify(actualScreenFacts) ===
      JSON.stringify(ledger.mechanical_facts.integrated_screen_evidence),
    "integrated screen evidence counts changed",
  );
  verifyGateLedger(ledger);
  await verifyImplementationCorrections();

  process.stdout.write(
    `${JSON.stringify({
      gate_pass_count: ledger.gate_pass_count,
      ledger_id: ledger.ledger_id,
      p1_headings: p1.length,
      p2_rows: p2.length,
      p3_expanded_ids: p3.length,
      revision: ledger.revision,
      screen_captures: actualScreenFacts.capture_count,
      screen_unique_pngs: actualScreenFacts.unique_png_sha256_count,
      status: "PASS",
    })}\n`,
  );
}

await main();
