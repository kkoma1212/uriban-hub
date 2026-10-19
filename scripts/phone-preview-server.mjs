import { loadEnvironment } from "../apps/api/dist/config/environment.js";
import { createPhonePreviewInput } from "./phone-preview-environment.mjs";

const origin = process.argv[2];
const input = createPhonePreviewInput(
  process.env,
  origin,
  loadEnvironment({ NODE_ENV: "development" }).DATABASE_URL,
);
const environment = loadEnvironment(input);
process.env.NODE_ENV = environment.NODE_ENV;
const { createApplication } = await import("../apps/api/dist/app.factory.js");
const { app } = await createApplication({ environment });
app.enableShutdownHooks(["SIGINT", "SIGTERM"]);
await app.listen(environment.API_PORT, environment.API_HOST);
process.stdout.write(
  JSON.stringify({
    status: "phone_preview_listening",
    origin,
    port: environment.API_PORT,
    databaseEngine: environment.DATABASE_ENGINE,
    adminWebEnabled: environment.ADMIN_WEB_ENABLED,
    localAdminEnabled: false,
  }) + "\n",
);
