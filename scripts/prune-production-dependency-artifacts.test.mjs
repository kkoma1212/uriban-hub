import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const scriptPath = fileURLToPath(
  new URL("./prune-production-dependency-artifacts.mjs", import.meta.url),
);

async function createDependencyRoot(prunedAt = "Wed, 22 Jul 2026 03:33:32 GMT") {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "classhub-prune-production-"));
  const dependencyRoot = path.join(temporaryRoot, "node_modules");
  await mkdir(dependencyRoot);
  await writeFile(
    path.join(dependencyRoot, ".modules.yaml"),
    `settings:\n  "prunedAt": "${prunedAt}",\n`,
    "utf8",
  );
  return { dependencyRoot, temporaryRoot };
}

test("normalizes pnpm prunedAt from SOURCE_DATE_EPOCH", async (context) => {
  const { dependencyRoot, temporaryRoot } = await createDependencyRoot();
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));

  const output = execFileSync(process.execPath, [scriptPath, dependencyRoot], {
    encoding: "utf8",
    env: { ...process.env, SOURCE_DATE_EPOCH: "0" },
  });

  assert.match(output, /normalized_pnpm_metadata=1/u);
  assert.equal(
    await readFile(path.join(dependencyRoot, ".modules.yaml"), "utf8"),
    'settings:\n  "prunedAt": "Thu, 01 Jan 1970 00:00:00 GMT",\n',
  );
});

test("leaves pnpm metadata unchanged without SOURCE_DATE_EPOCH", async (context) => {
  const originalPrunedAt = "Wed, 22 Jul 2026 03:33:32 GMT";
  const { dependencyRoot, temporaryRoot } = await createDependencyRoot(originalPrunedAt);
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const environment = { ...process.env };
  delete environment.SOURCE_DATE_EPOCH;

  const output = execFileSync(process.execPath, [scriptPath, dependencyRoot], {
    encoding: "utf8",
    env: environment,
  });

  assert.match(output, /normalized_pnpm_metadata=0/u);
  assert.ok(
    (await readFile(path.join(dependencyRoot, ".modules.yaml"), "utf8")).includes(originalPrunedAt),
  );
});

test("rejects an invalid SOURCE_DATE_EPOCH before pruning", async (context) => {
  const { dependencyRoot, temporaryRoot } = await createDependencyRoot();
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const removableArtifact = path.join(dependencyRoot, "index.js.map");
  await writeFile(removableArtifact, "{}", "utf8");

  const result = spawnSync(process.execPath, [scriptPath, dependencyRoot], {
    encoding: "utf8",
    env: { ...process.env, SOURCE_DATE_EPOCH: "not-an-epoch" },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SOURCE_DATE_EPOCH must be a non-negative integer/u);
  assert.equal(await readFile(removableArtifact, "utf8"), "{}");
});
