import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.spec.{ts,tsx}"],
    // 87 suite files share the machine with the rest of `pnpm check`. Under CPU
    // contention the suite runs ~4.5x slower, so the 5s default starves async
    // assertions and reports load as a product failure.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
