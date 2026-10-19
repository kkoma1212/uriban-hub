import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/admin-passkeys-mariadb.integration.spec.ts",
      "test/social-login-mariadb.integration.spec.ts",
    ],
    hookTimeout: 120000,
    testTimeout: 60000,
    maxWorkers: 1,
  },
});
