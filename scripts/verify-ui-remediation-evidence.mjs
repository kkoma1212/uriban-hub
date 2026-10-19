import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = join(repositoryRoot, "QUALITY", "ui-remediation-evidence-2026-08-02");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
    .toUpperCase();
}

async function assertPinnedFile(root, pinnedFile) {
  const path = join(root, pinnedFile.path);
  assert.equal((await stat(path)).size, pinnedFile.bytes, `${pinnedFile.path} byte count drifted`);
  assert.equal(await sha256(path), pinnedFile.sha256, `${pinnedFile.path} SHA-256 drifted`);
}

const manifest = await readJson(join(evidenceDirectory, "manifest.json"));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.classification.fixtureOnly, true);
assert.equal(manifest.classification.releaseGateEvidence, false);
assert.equal(manifest.classification.apiContractVerified, false);
assert.equal(manifest.classification.databaseBehaviorVerified, false);
assert.equal(manifest.classification.serverBehaviorVerified, false);
assert.equal(manifest.classification.verifiedSurface, "WEB_UI_RELEASE_BLOCKER_REMEDIATIONS");
assert.equal(manifest.infrastructureObservation.fixedRuntimeProcessTouched, false);
assert.equal(manifest.infrastructureObservation.databaseOrContainerStarted, false);

assert.equal(manifest.artifacts.length, 8);
for (const artifact of manifest.artifacts) {
  await assertPinnedFile(evidenceDirectory, artifact);
}
for (const sourceInput of manifest.sourceInputs) {
  await assertPinnedFile(repositoryRoot, sourceInput);
}

const result = await readJson(join(evidenceDirectory, "results.json"));
assert.equal(result.passed, true);
assert.equal(result.fixtureOnly, true);
assert.equal(result.releaseGateEvidence, false);
assert.equal(result.apiContractVerified, false);
assert.equal(result.databaseBehaviorVerified, false);
assert.equal(result.serverBehaviorVerified, false);
assert.equal(result.verifiedSurface, "WEB_UI_RELEASE_BLOCKER_REMEDIATIONS");
assert.match(result.appOrigin, /^http:\/\/127\.0\.0\.1:\d+$/u);
assert.equal(result.contrastMinimum, 4.5);
assert.deepEqual(result.mutationAttempts, []);

assert.deepEqual(result.viewports, [
  { height: 800, name: "mobile360", width: 360 },
  { height: 844, name: "mobile390", width: 390 },
  { height: 1024, name: "tablet768", width: 768 },
  { height: 900, name: "desktop1280", width: 1280 },
  { height: 900, name: "desktop1440", width: 1440 },
]);

const surfaces = ["notices", "supplies", "updates"];
const viewportNames = result.viewports.map((viewport) => viewport.name);
const expectedHeroKeys = new Set(
  viewportNames.flatMap((viewport) => surfaces.map((surface) => `${viewport}:${surface}`)),
);
assert.equal(result.heroResults.length, expectedHeroKeys.size);

for (const hero of result.heroResults) {
  assert.equal(expectedHeroKeys.delete(`${hero.viewport}:${hero.surface}`), true);
  assert.equal(hero.found, true);
  assert.equal(hero.overflowX, false);
  assert(hero.documentWidth <= hero.innerWidth);
  assert(hero.className.scrollWidth <= hero.className.clientWidth);
  assert(hero.actionTargets.length >= 1);
  for (const actionTarget of hero.actionTargets) {
    assert(actionTarget.height >= 44);
  }
  if (hero.viewport === "mobile360" || hero.viewport === "mobile390") {
    assert.equal(hero.flexDirection, "column");
    assert(hero.action.top >= hero.copy.bottom);
    assert(hero.action.width >= hero.copy.width - 0.5);
  } else if (hero.viewport === "tablet768") {
    assert.equal(hero.flexDirection, "column");
    assert(hero.action.top >= hero.copy.bottom);
  } else {
    assert.equal(hero.flexDirection, "row");
  }
}
assert.equal(expectedHeroKeys.size, 0);
assert(
  result.heroResults
    .filter((hero) => hero.viewport === "mobile360")
    .every((hero) => hero.hero.height <= 304),
);

assert.equal(result.contrastResults.length, 5);
for (const contrast of result.contrastResults) {
  assert.equal(contrast.found, true);
  assert(contrast.contrastRatio >= result.contrastMinimum);
}

assert.equal(result.notFound.path, "/not-a-real-route");
assert.equal(result.notFound.heading, "페이지를 찾을 수 없어요.");
assert.equal(result.notFound.documentTitle, "페이지를 찾을 수 없음 | 우리반 허브");
assert.equal(result.notFound.focusedHeading, true);
assert.equal(result.notFound.overflowX, false);
assert.equal(result.notFound.bodyText.includes("인터넷 연결"), false);

assert.equal(result.homeError.h1, "반 홈을 열지 못했어요.");
assert.equal(result.homeError.mainRole, "teacher");
assert.equal(result.homeError.visibleNavigationCount, 1);
assert.equal(result.homeError.overflowX, false);
assert.match(result.homeError.alertText, /다시 시도/u);

assert.equal(result.studentFocusOrder.passed, true);
assert.deepEqual(
  result.studentFocusOrder.firstEight.map((entry) => ({
    inMain: entry.inMain,
    navigationItem: entry.navigationItem,
    skipLink: entry.skipLink,
  })),
  [
    { inMain: false, navigationItem: null, skipLink: true },
    { inMain: false, navigationItem: "홈", skipLink: false },
    { inMain: false, navigationItem: "알림", skipLink: false },
    { inMain: false, navigationItem: "활동", skipLink: false },
    { inMain: false, navigationItem: "출결", skipLink: false },
    { inMain: false, navigationItem: "캘린더", skipLink: false },
    { inMain: false, navigationItem: "급식", skipLink: false },
    { inMain: false, navigationItem: null, skipLink: false },
    { inMain: true, navigationItem: null, skipLink: false },
  ],
);

process.stdout.write(
  "UI remediation evidence verified: 8 pinned artifacts, 15 responsive hero results, 5 dark contrast results, explicit 404, retained Home error shell, student desktop focus order, fixture-only scope. PASS\n",
);
