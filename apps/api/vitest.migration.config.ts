import { defineConfig } from "vitest/config";

/*
 * 마이그레이션 되돌리기를 실제로 돌려 보는 통합 스펙만 모은다. 단위 설정은
 * *.integration.spec.ts 를 제외하고, 나머지 통합 설정은 .auth / .redis / app 만
 * 집어 가므로, 이 이름의 스펙은 실행 경로를 따로 만들어 주지 않으면 아무 데서도
 * 돌지 않는다 — 있는데 안 도는 테스트가 제일 위험하다.
 */
export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 120_000,
    include: ["test/**/*.migration.integration.spec.ts"],
    testTimeout: 120_000,
  },
});
