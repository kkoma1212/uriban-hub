import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const runtimeRoots = process.argv.slice(2);
const forbiddenDirectoryNames = new Set(["__tests__", "src", "test", "tests"]);
const nonRuntimeDirectoryNames = new Set(["local-test-admin"]);
const compiledTestPattern = /(?:^|\.)(?:spec|test)\.js$/u;

if (runtimeRoots.length === 0) {
  throw new Error("at least one runtime artifact root is required");
}

async function pruneAndValidateRuntimeRoot(runtimeRoot) {
  const absoluteRoot = path.resolve(runtimeRoot);

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const artifactPath = path.join(directory, entry.name);
      const relativePath = path.relative(absoluteRoot, artifactPath);

      if (entry.isDirectory()) {
        if (nonRuntimeDirectoryNames.has(entry.name)) {
          await rm(artifactPath, { recursive: true });
          continue;
        }
        if (forbiddenDirectoryNames.has(entry.name)) {
          throw new Error(`runtime artifact contains forbidden directory: ${relativePath}`);
        }
        await visit(artifactPath);
        continue;
      }

      if (!entry.isFile()) {
        throw new Error(`runtime artifact contains a non-file entry: ${relativePath}`);
      }

      // app.factory imports openapi/contract.js at runtime; only the standalone generator is disposable.
      if (entry.name === "generate.js" && path.basename(directory) === "openapi") {
        await rm(artifactPath);
        continue;
      }

      if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".map")) {
        await rm(artifactPath);
        continue;
      }

      if (compiledTestPattern.test(entry.name)) {
        throw new Error(`runtime artifact contains a compiled test: ${relativePath}`);
      }

      if (!entry.name.endsWith(".js") && !entry.name.endsWith(".json")) {
        throw new Error(`runtime artifact contains an unexpected file type: ${relativePath}`);
      }
    }
  }

  await visit(absoluteRoot);

  const remainingEntries = [];
  async function countRemaining(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const artifactPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await countRemaining(artifactPath);
      else remainingEntries.push(artifactPath);
    }
  }
  await countRemaining(absoluteRoot);
  if (remainingEntries.length === 0) {
    throw new Error(`runtime artifact root is empty after pruning: ${absoluteRoot}`);
  }

  process.stdout.write(`validated runtime artifact root: ${absoluteRoot}\n`);
}

for (const runtimeRoot of runtimeRoots) {
  await pruneAndValidateRuntimeRoot(runtimeRoot);
}
