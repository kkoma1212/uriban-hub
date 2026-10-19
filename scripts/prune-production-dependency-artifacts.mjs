import { readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const dependencyRoots = process.argv.slice(2);
const declarationPattern = /\.d\.(?:cts|mts|ts)$/u;
const sourceMapPattern = /\.map$/u;
const compiledTestPattern = /(?:^|[._-])(?:spec|test)\.(?:[cm]?[jt]s)$/u;
const pnpmPrunedAtPattern = /^(\s*"?prunedAt"?\s*:\s*)"[^"]*"(\s*,?\s*)$/gmu;

if (dependencyRoots.length === 0) {
  throw new Error("at least one production dependency root is required");
}

function resolveReproduciblePrunedAt() {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch === undefined) return null;
  if (!/^(?:0|[1-9]\d*)$/u.test(sourceDateEpoch)) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer");
  }

  const epochMilliseconds = Number(sourceDateEpoch) * 1_000;
  const date = new Date(epochMilliseconds);
  if (!Number.isSafeInteger(epochMilliseconds) || Number.isNaN(date.getTime())) {
    throw new Error("SOURCE_DATE_EPOCH is outside the supported date range");
  }
  return date.toUTCString();
}

const reproduciblePrunedAt = resolveReproduciblePrunedAt();

function isWithinRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isRemovableFile(name) {
  return (
    declarationPattern.test(name) || sourceMapPattern.test(name) || compiledTestPattern.test(name)
  );
}

async function pruneDependencyRoot(dependencyRoot) {
  const absoluteRoot = path.resolve(dependencyRoot);
  const removed = {
    declarations: 0,
    sourceMaps: 0,
    tests: 0,
    unsafeSymlinks: 0,
  };

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const artifactPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = await realpath(artifactPath);
        } catch {
          target = null;
        }
        if (target === null || !isWithinRoot(absoluteRoot, target)) {
          await rm(artifactPath);
          removed.unsafeSymlinks += 1;
        }
        continue;
      }

      if (entry.isDirectory()) {
        await visit(artifactPath);
        continue;
      }
      if (!entry.isFile() || !isRemovableFile(entry.name)) continue;

      if (declarationPattern.test(entry.name)) removed.declarations += 1;
      else if (sourceMapPattern.test(entry.name)) removed.sourceMaps += 1;
      else removed.tests += 1;
      await rm(artifactPath);
    }
  }

  await visit(absoluteRoot);

  const remaining = [];
  async function assertPruned(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const artifactPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = await realpath(artifactPath);
        } catch {
          target = null;
        }
        if (target === null || !isWithinRoot(absoluteRoot, target)) {
          remaining.push(path.relative(absoluteRoot, artifactPath));
        }
      } else if (entry.isDirectory()) await assertPruned(artifactPath);
      else if (entry.isFile() && isRemovableFile(entry.name)) {
        remaining.push(path.relative(absoluteRoot, artifactPath));
      }
    }
  }
  await assertPruned(absoluteRoot);
  if (remaining.length > 0) {
    throw new Error(`production dependencies still contain non-runtime files: ${remaining[0]}`);
  }

  let normalizedPnpmMetadata = 0;
  if (reproduciblePrunedAt !== null) {
    const modulesMetadataPath = path.join(absoluteRoot, ".modules.yaml");
    let modulesMetadata;
    try {
      modulesMetadata = await readFile(modulesMetadataPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    if (modulesMetadata !== undefined) {
      const matches = [...modulesMetadata.matchAll(pnpmPrunedAtPattern)];
      if (matches.length !== 1) {
        throw new Error(
          `expected exactly one pnpm prunedAt field in ${modulesMetadataPath}, found ${matches.length}`,
        );
      }
      const normalizedMetadata = modulesMetadata.replace(
        pnpmPrunedAtPattern,
        `$1"${reproduciblePrunedAt}"$2`,
      );
      await writeFile(modulesMetadataPath, normalizedMetadata, "utf8");
      normalizedPnpmMetadata = 1;
    }
  }

  process.stdout.write(
    `pruned production dependencies: ${absoluteRoot} declarations=${removed.declarations} source_maps=${removed.sourceMaps} tests=${removed.tests} unsafe_symlinks=${removed.unsafeSymlinks} normalized_pnpm_metadata=${normalizedPnpmMetadata}\n`,
  );
}

for (const dependencyRoot of dependencyRoots) {
  await pruneDependencyRoot(dependencyRoot);
}
