import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAllTestMigrationPaths as loadApiMigrationPaths } from "../apps/api/test/migration-test-source.ts";
import { loadAllTestMigrationPaths as loadOperatorMigrationPaths } from "../apps/operator-cli/src/migration-test-source.ts";
import { loadAllTestMigrationPaths as loadWorkerMigrationPaths } from "../apps/worker/test/migration-test-source.ts";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = join(repositoryRoot, "db", "migrations");
const migrationFilePattern = /^[0-9]{13}_[a-z0-9-]+\.sql$/u;
const hardCodedMigrationPathPattern = /db\/migrations\/[0-9]{13}_[a-z0-9-]+\.sql/u;

const harnessPaths = [
  "apps/api/test/account-deletion.auth.integration.spec.ts",
  "apps/api/test/auth.auth.integration.spec.ts",
  "apps/api/test/local-test-admin.auth.integration.spec.ts",
  "apps/api/test/supplies-test-harness.ts",
  "apps/operator-cli/src/meal-import.integration.spec.ts",
  "apps/operator-cli/src/onboarding.integration.spec.ts",
  "apps/worker/test/security-audit-worker.integration.spec.ts",
];

async function collectSourcePaths(directory) {
  const paths = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      paths.push(...(await collectSourcePaths(join(directory, entry.name))));
      continue;
    }
    if (entry.isFile() && /\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name)) {
      paths.push(join(directory, entry.name));
    }
  }

  return paths;
}

const migrationFileNames = (await readdir(migrationsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name)
  .sort();
assert(migrationFileNames.length > 0, "Migration source inventory is empty");
for (const fileName of migrationFileNames) {
  assert.match(fileName, migrationFilePattern);
}

const expectedMigrationPaths = migrationFileNames.map((fileName) =>
  resolve(migrationsDirectory, fileName),
);
for (const [loaderName, loadPaths] of [
  ["api", loadApiMigrationPaths],
  ["operator", loadOperatorMigrationPaths],
  ["worker", loadWorkerMigrationPaths],
]) {
  const actualPaths = (await loadPaths()).map((path) => resolve(path));
  assert.deepEqual(
    actualPaths,
    expectedMigrationPaths,
    `${loaderName} test loader does not match the complete migration source inventory`,
  );
  assert.deepEqual(
    actualPaths.map((path) => basename(path)),
    migrationFileNames,
    `${loaderName} test loader order is not deterministic`,
  );
}

for (const relativePath of harnessPaths) {
  const source = await readFile(join(repositoryRoot, relativePath), "utf8");
  assert(
    source.includes("await loadAllTestMigrationPaths()"),
    `${relativePath} does not load the complete dynamic migration inventory`,
  );
}

const hardCodedMigrationSources = [];
for (const sourcePath of await collectSourcePaths(join(repositoryRoot, "apps"))) {
  const source = await readFile(sourcePath, "utf8");
  if (hardCodedMigrationPathPattern.test(source.replaceAll("\\", "/"))) {
    hardCodedMigrationSources.push(sourcePath);
  }
}
assert.deepEqual(
  hardCodedMigrationSources,
  [],
  "Application test sources contain hard-coded migration file paths",
);

process.stdout.write(
  `Test migration source verified: ${migrationFileNames.length} source migrations, 3 dynamic loaders, 7 harnesses, 0 hard-coded file lists. PASS\n`,
);
