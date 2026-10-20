// 관리자 원격 접속(T-ADMIN-REMOTE)의 PC 관리자 프로그램. 직접 실행하지 않고
// OPERATIONS/native-runtime/start-admin-remote.ps1 → start-admin-remote-process.mjs가 걸러진 설정으로 띄운다.
// 설정 파일은 고치지 않고 이 프로세스 안에서만 관리자 주소·패스키 도메인을 바꾼다(admin-remote-environment.mjs).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "../apps/api/dist/config/environment.js";
import { createAdminRemoteInput } from "./admin-remote-environment.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [adminOrigin, userOrigin] = process.argv.slice(2);
const environment = loadEnvironment(createAdminRemoteInput(process.env, adminOrigin, userOrigin));
process.env.NODE_ENV = environment.NODE_ENV;
const { createApplication } = await import("../apps/api/dist/app.factory.js");
// 관리자 화면은 루트 Web/이 아니라 corepack pnpm admin-remote:web 으로 만든 별도 빌드다.
const { app } = await createApplication({
  environment,
  webRoot: resolve(repositoryRoot, ".local-runtime/admin-remote-web"),
});
app.enableShutdownHooks(["SIGINT", "SIGTERM"]);
await app.listen(environment.API_PORT, environment.API_HOST);
process.stdout.write(
  JSON.stringify({
    status: "admin_remote_listening",
    origin: adminOrigin,
    port: environment.API_PORT,
    apiSurface: environment.API_SURFACE,
    passkeysEnabled: environment.ADMIN_PASSKEYS_ENABLED,
  }) + "\n",
);
