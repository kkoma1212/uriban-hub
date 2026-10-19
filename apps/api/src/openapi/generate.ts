import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createOpenApiApplication, createOpenApiDocument } from "../app.factory.js";
import { loadEnvironment } from "../config/environment.js";

const FORBIDDEN_OPERATIONAL_PATH_PREFIXES = ["/api/v1/local-test-admin"] as const;

const OPENAPI_ENVIRONMENT = loadEnvironment({
  ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"),
  ADMIN_MFA_KEY_VERSION: "openapi-1",
  ADMIN_WEB_ENABLED: "true",
  ATTENDANCE_NOTIFICATIONS_ENABLED: "true",
  CLASS_CHAT_ENABLED: "true",
  PROFILE_PHOTOS_ENABLED: "true",
  CONTENT_SELECTED_AUDIENCE_ENABLED: "false",
  DATABASE_URL:
    "postgresql://classhub_app:synthetic-openapi@database.example.invalid:5432/classhub",
  EMAIL_HMAC_KEY: "synthetic-openapi-key-at-least-32-bytes",
  LOCAL_TEST_ADMIN_ENABLED: "false",
  NODE_ENV: "test",
  PASSWORD_RESET_ENABLED: "true",
  POLLS_ENABLED: "true",
  ELECTIONS_ENABLED: "true",
  PUBLIC_API_ORIGIN: "https://classhub.example.invalid",
  PUBLIC_APP_ORIGIN: "https://classhub.example.invalid",
  REDIS_URL: "redis://redis.example.invalid:6379",
  SERVE_WEB: "false",
  SMTP_HOST: "smtp.example.invalid",
  STUDENT_ASSESSMENTS_ENABLED: "true",
  // RFC 8291 부록 A의 합성 키 쌍. 명세 생성 전용이며 발송에는 쓰지 않는다.
  WEB_PUSH_ENABLED: "true",
  WEB_PUSH_SUBJECT: "mailto:operator@example.invalid",
  WEB_PUSH_VAPID_PRIVATE_KEY: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  WEB_PUSH_VAPID_PUBLIC_KEY:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
});

async function generateOpenApi(): Promise<void> {
  const { values } = parseArgs({ options: { output: { type: "string" } } });
  const outputFile =
    values.output === undefined
      ? fileURLToPath(
          new URL("../../../../packages/api-client/openapi/openapi.json", import.meta.url),
        )
      : resolve(values.output);
  const app = await createOpenApiApplication(OPENAPI_ENVIRONMENT);

  try {
    const document = createOpenApiDocument(app);
    const forbiddenPath = Object.keys(document.paths).find((path) =>
      FORBIDDEN_OPERATIONAL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
    );

    if (forbiddenPath !== undefined) {
      throw new Error(`Operational OpenAPI unexpectedly contains a dormant path: ${forbiddenPath}`);
    }

    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  } finally {
    await app.close();
  }
}

void generateOpenApi().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : "Unknown OpenAPI generation failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
