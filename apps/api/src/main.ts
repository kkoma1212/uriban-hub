import { ShutdownSignal } from "@nestjs/common";

import { createApplication } from "./app.factory.js";

async function bootstrap(): Promise<void> {
  const { app, environment } = await createApplication();
  app.enableShutdownHooks([ShutdownSignal.SIGINT, ShutdownSignal.SIGTERM]);
  await app.listen(environment.API_PORT, environment.API_HOST);
}

await bootstrap();
