import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDirectory = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));
const migrationFilePattern = /^[0-9]{13}_[a-z0-9-]+\.sql$/u;

export async function loadAllTestMigrationPaths(): Promise<string[]> {
  const fileNames = [];

  for (const entry of await readdir(migrationsDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    if (!migrationFilePattern.test(entry.name)) {
      throw new Error(`Unexpected SQL migration filename: ${entry.name}`);
    }
    fileNames.push(entry.name);
  }

  if (fileNames.length === 0) {
    throw new Error("No SQL migrations were found for the API integration tests.");
  }

  return fileNames.sort().map((fileName) => join(migrationsDirectory, fileName));
}
