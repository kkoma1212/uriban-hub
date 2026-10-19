import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".agents/**",
      ".claude/**",
      // 방법론·에이전트 도구(앱 아님, .claude와 같은 취급) — 2026-10-01 린트 기준선 정리
      "_hexstack_upgrade_*/**",
      "hexstack/**",
      "webwork-agent.cjs",
      ".hexstack-analysis/**",
      ".local-runtime/**",
      ".local-backups/**",
      "PRD/**",
      "우리반 허브_검증/**",
      "우리반 허브_안전보존/**",
      "**/dist/**",
      "Web/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/playwright-report/**",
      "packages/api-client/openapi/**",
      "packages/api-client/src/generated.ts",
      "packages/db/src/generated/**",
      // Git 밖 로컬 폴더(인수인계 사본·별도 소개 사이트 저장소·임시 산출물). 사본 안의
      // 중첩 tsconfig가 전 파일 파싱 오류를 냈다 — 2026-10-16 게이트 진단.
      "우리반허브_인수인계_*/**",
      "uriban-hub-site/**",
      "output/**",
      ".runtime/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...js.configs.recommended,
  },
  {
    files: [
      "apps/migrator/**/*.{js,mjs,cjs}",
      // HexStack 도구도 같은 성격의 Node CLI 스크립트다. 무시 목록에 넣지 않는 이유는
      // 실제 오류까지 함께 놓치기 때문 — 환경만 주고 검사는 계속 받게 한다.
      "hexstack/tools/**/*.{js,mjs,cjs}",
      "scripts/**/*.{js,mjs,cjs}",
      "db/mariadb/**/*.mjs",
      "OPERATIONS/**/*.mjs",
      "QUALITY/**/*.mjs",
      "browser-qa/**/*.mjs",
      "*.mjs",
    ],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        AbortSignal: "readonly",
        Blob: "readonly",
        Buffer: "readonly",
        FormData: "readonly",
        Headers: "readonly",
        ReadableStream: "readonly",
        Request: "readonly",
        Response: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        WebSocket: "readonly",
        clearImmediate: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        fetch: "readonly",
        performance: "readonly",
        process: "readonly",
        queueMicrotask: "readonly",
        setImmediate: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        structuredClone: "readonly",
      },
    },
  },
  {
    files: ["browser-qa/session-role-probe.mjs"],
    languageOptions: {
      globals: {
        WebSocket: "readonly",
        fetch: "readonly",
        process: "readonly",
      },
    },
  },
  {
    // 콘솔에 붙여넣어 실행하는 계측 스크립트라 빌드에 포함되지 않고 브라우저에서만 돈다.
    files: ["browser-qa/render-audit-console.js"],
    languageOptions: {
      globals: {
        Node: "readonly",
        console: "readonly",
        document: "readonly",
        getComputedStyle: "readonly",
        location: "readonly",
        matchMedia: "readonly",
        window: "readonly",
      },
    },
  },
  {
    // active98-retention-supplemental-fixture.mjs가 이 파일의 SHA-256을 고정한다 — 린트용으로
    // 한 글자라도 고치면 고정자료 시험 5건이 깨진다(2026-10-16 실측). 제어 문자 거부 정규식과
    // 쓰지 않는 콜백 인자 2가지만 이 파일에서 끈다.
    files: ["OPERATIONS/mariadb-dev/company-first95-native-recovery.mjs"],
    rules: {
      "no-control-regex": "off",
      "no-unused-vars": ["error", { args: "none" }],
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
