import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "test/**/*.integration.spec.ts"],
    globals: true,
    include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
  },
});
