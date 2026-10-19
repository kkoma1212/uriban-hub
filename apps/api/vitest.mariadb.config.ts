import { defineConfig } from "vitest/config";

if (
  !process.env.POLL_CLOSE_QA_MARIADB_CONFIG ||
  !process.env.LEGAL_CONSENT_QA_MARIADB_CONFIG ||
  !process.env.PUSH_SUBSCRIPTIONS_QA_MARIADB_CONFIG ||
  !process.env.PUSH_OUTBOX_QA_MARIADB_CONFIG ||
  !process.env.SCHEDULE_LINKS_QA_MARIADB_CONFIG ||
  !process.env.HELP_REQUESTS_QA_MARIADB_CONFIG ||
  !process.env.HELP_CHAT_QA_MARIADB_CONFIG ||
  !process.env.CLASS_CHAT_QA_MARIADB_CONFIG ||
  !process.env.PAST_CLASSES_QA_MARIADB_CONFIG ||
  !process.env.TEACHER_LIBRARY_QA_MARIADB_CONFIG ||
  !process.env.PROFILE_PHOTOS_QA_MARIADB_CONFIG
) {
  throw new Error(
    "All owned MariaDB fixtures are required. Run corepack pnpm test:mariadb-isolated.",
  );
}

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 120_000,
    testTimeout: 120_000,
    maxWorkers: 1,
    include: [
      "test/poll-close-mariadb.auth.integration.spec.ts",
      "test/legal-consent.auth.integration.spec.ts",
      "test/push-subscriptions-mariadb.integration.spec.ts",
      "test/push-outbox-mariadb.integration.spec.ts",
      "test/schedule-links-mariadb.integration.spec.ts",
      "test/help-requests-mariadb.integration.spec.ts",
      "test/help-chat-mariadb.integration.spec.ts",
      "test/class-chat-mariadb.integration.spec.ts",
      "test/past-classes-mariadb.integration.spec.ts",
      "test/teacher-library-mariadb.integration.spec.ts",
      "test/profile-photos-mariadb.integration.spec.ts",
    ],
  },
});
