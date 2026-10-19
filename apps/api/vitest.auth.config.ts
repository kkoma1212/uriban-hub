import { configDefaults, defineConfig } from "vitest/config";
import quarantine from "./test/auth-integration-quarantine.json" with { type: "json" };

for (const entry of quarantine) {
  console.warn(`[auth quarantine ${entry.date}] ${entry.path}: ${entry.reason}`);
}
console.warn("[auth dedicated gate] poll-close-mariadb runs in mandatory test:mariadb-isolated.");

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 120_000,
    // Bound simultaneous native PostgreSQL/Nest instances on developer PCs and CI.
    maxWorkers: 4,
    include: ["test/**/*.auth.integration.spec.ts"],
    exclude: [
      ...configDefaults.exclude,
      ...quarantine.map((entry) => entry.path),
      "test/poll-close-mariadb.auth.integration.spec.ts",
    ],
    testTimeout: 120_000,
  },
});
