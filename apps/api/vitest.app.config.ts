import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 120_000,
    include: ["test/app.integration.spec.ts"],
    testTimeout: 120_000,
  },
});
