import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["test/**/*.integration.spec.ts"],
    maxWorkers: 1,
    // T-HUB-03 진단 프로브. 실패 순간의 접속 대상만 남기고 동작은 바꾸지 않는다.
    setupFiles: ["test/migration-diagnostics.setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
