import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = join(repositoryRoot, "QUALITY", "local-qa-safety-evidence-2026-07-28");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
    .toUpperCase();
}

function assertFixtureScope(result, expectedSurface) {
  assert.equal(result.passed, true);
  assert.equal(result.verifiedSurface, expectedSurface);
  assert.equal(result.fixtureOnly, true);
  assert.equal(result.releaseGateEvidence, false);
  assert.equal(result.apiContractVerified, false);
  assert.equal(result.databaseBehaviorVerified, false);
  assert.equal(result.serverBehaviorVerified, false);
}

const manifest = await readJson(join(evidenceDirectory, "manifest.json"));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.classification.fixtureOnly, true);
assert.equal(manifest.classification.releaseGateEvidence, false);
assert.equal(manifest.classification.apiContractVerified, false);
assert.equal(manifest.classification.databaseBehaviorVerified, false);
assert.equal(manifest.classification.serverBehaviorVerified, false);
assert.equal(manifest.boundaryIncident.occurred, true);
assert.equal(manifest.boundaryIncident.writeOrMigrationObserved, false);
assert.equal(manifest.boundaryIncident.testcontainersStarted, false);

const artifacts = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
assert.equal(artifacts.size, 3);

for (const artifact of artifacts.values()) {
  const path = join(evidenceDirectory, artifact.path);
  assert.equal((await stat(path)).size, artifact.bytes, `${artifact.path} byte count drifted`);
  assert.equal(await sha256(path), artifact.sha256, `${artifact.path} SHA-256 drifted`);
}

const idempotency = await readJson(join(evidenceDirectory, "idempotency-ui-results.json"));
assertFixtureScope(idempotency, "WEB_CLIENT_IDEMPOTENT_RETRY_UX");
assert.equal(idempotency.results.length, 3);
assert.equal(idempotency.actualApiMutationRequestsForwarded, 0);
assert.equal(idempotency.realDatabaseMutations, 0);
assert.equal(idempotency.serverIdempotencyVerified, false);
assert.equal(
  idempotency.results.reduce((total, result) => total + result.lostResponses, 0),
  3,
);
assert.equal(
  idempotency.results.reduce((total, result) => total + result.rapidDuplicatePostsWhilePending, 0),
  3,
);

const navigation = await readJson(join(evidenceDirectory, "navigation-responsive-results.json"));
assertFixtureScope(navigation, "WEB_UI_NAVIGATION_AND_RESPONSIVE_LAYOUT");
assert.equal(navigation.responsiveResults.length, 9);
assert.equal(navigation.mutationAttempts.length, 0);
assert.equal(navigation.actualBrowserZoom, "BROWSER_MANAGED_200_PERCENT_DETECTED");

const screenState = await readJson(join(evidenceDirectory, "screen-state-results.json"));
assertFixtureScope(screenState, "WEB_UI_STATE_RENDERING");
assert.equal(screenState.results.length, 18);
assert.deepEqual(screenState.stateTransitions, [
  "loading",
  "empty",
  "initial_error",
  "success",
  "stale",
  "recovered",
]);
assert.equal(
  screenState.results.reduce((total, result) => total + result.consoleErrors.length, 0),
  0,
);

const [onboardingAdapter, onboardingRuntime, onboardingRunner, guardianRunner] = await Promise.all([
  readFile(
    join(repositoryRoot, "browser-qa", "lib", "onboarding-role-fixture-adapter.mjs"),
    "utf8",
  ),
  readFile(join(repositoryRoot, "browser-qa", "lib", "onboarding-role-runtime.mjs"), "utf8"),
  readFile(join(repositoryRoot, "browser-qa", "run-isolated-onboarding-role-e2e.mjs"), "utf8"),
  readFile(join(repositoryRoot, "browser-qa", "run-isolated-guardian-consent-e2e.mjs"), "utf8"),
]);
assert.match(onboardingAdapter, /DISPOSABLE_NATIVE_SERVICES/u);
assert.match(onboardingAdapter, /realPersonalData !== false/u);
assert.match(onboardingAdapter, /process\.env\.NODE_ENV !== "test"/u);
assert.match(onboardingAdapter, /runtime-issued opaque capability/u);
assert.match(onboardingAdapter, /inspectNativeTestService/u);
assert.match(onboardingAdapter, /inspection\?\.running !== true/u);
assert.match(onboardingAdapter, /binarySha256 !== "string"/u);
assert.match(onboardingAdapter, /inspection\?\.disposable !== true/u);
assert.match(onboardingAdapter, /fingerprint\.startTicks/u);
assert.match(onboardingAdapter, /createOnboardingRoleFixtureBoundaryForTests/u);
assert.match(onboardingAdapter, /snapshotOnboardingRoleOperatorServiceInput/u);
assert.match(onboardingAdapter, /utilTypes\.isProxy/u);
assert.doesNotMatch(onboardingAdapter, /export function createOnboardingRoleFixtureBoundary\(\)/u);
assert.doesNotMatch(onboardingAdapter, /apps\/operator-cli\/dist/u);
assert.match(onboardingRuntime, /startedInfrastructureRegistry = new WeakMap/u);
assert.match(onboardingRuntime, /registerStartedInfrastructure/u);
assert.match(onboardingRuntime, /revokeStartedInfrastructure/u);
assert.match(onboardingRuntime, /createRuntimeFixtureAdapter\(infrastructure, fixtureScope\)/u);
assert.match(onboardingRuntime, /snapshotOnboardingRoleOperatorServiceInput/u);
assert.doesNotMatch(onboardingRuntime, /\.\.\.input/u);
assert.doesNotMatch(onboardingRuntime, /BoundaryForTests/u);
assert.match(onboardingRuntime, /Object\.freeze\(\{/u);
assert.match(onboardingRuntime, /captureOnboardingScreenshotSafely/u);
assert.match(onboardingRuntime, /associatedLabelText/u);
assert.match(onboardingRuntime, /ariaLabelledByText/u);
assert.match(onboardingRuntime, /비밀번호/u);
assert.match(onboardingRuntime, /not_verified_no_ocr/u);
assert.doesNotMatch(
  onboardingRuntime,
  /"(?:bootstrap-operator|provision-teacher|reset-teacher-password)"/u,
);
for (const runner of [onboardingRunner, guardianRunner]) {
  assert.match(runner, /ONBOARDING_ROLE_FIXTURE_GUARD_ENV/u);
  assert.match(runner, /NODE_ENV: "test"/u);
}

process.stdout.write(
  "Local QA safety evidence verified: 3 artifacts remain fixture-only; onboarding secrets use the guarded in-process QA adapter. PASS\n",
);
