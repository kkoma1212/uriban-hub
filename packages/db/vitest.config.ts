import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/**/*.integration.spec.ts"],
    include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
  },
});
