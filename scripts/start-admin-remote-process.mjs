import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvironment } from "../apps/api/dist/config/environment.js";
import { loadLocalEnvironment } from "../OPERATIONS/native-runtime/local-environment.mjs";
import { assertProjectNode } from "../OPERATIONS/native-runtime/project-node.mjs";
import { createAdminRemoteInput } from "./admin-remote-environment.mjs";

// 공개 미리보기 실행기(start-phone-preview-process.mjs)와 같은 구조: 이 짧은 실행기만 설정 파일을 읽고,
// 관리자 프로그램은 걸러진 설정(admin-remote-environment.mjs)만 받는다.
assertProjectNode();
const [adminOrigin, userOrigin, logDirectory, mode] = process.argv.slice(2);
assert(
  adminOrigin &&
    userOrigin &&
    logDirectory &&
    (process.argv.length === 5 || (process.argv.length === 6 && mode === "--check")),
);
const environment = createAdminRemoteInput(loadLocalEnvironment(), adminOrigin, userOrigin);
try {
  loadEnvironment(environment);
} catch {
  throw new Error("Administrator program configuration was rejected before starting a process.");
}
if (mode === "--check") {
  process.stdout.write(JSON.stringify({ configurationValid: true, apiSurface: "admin" }) + "\n");
  process.exit(0);
}
const stdout = openSync(resolve(logDirectory, "admin.stdout.log"), "w");
let stderr;
try {
  stderr = openSync(resolve(logDirectory, "admin.stderr.log"), "w");
  const child = spawn(
    process.execPath,
    ["scripts/admin-remote-server.mjs", adminOrigin, userOrigin],
    {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      env: environment,
      stdio: ["ignore", stdout, stderr],
    },
  );
  await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("spawn", done);
  });
  assert(Number.isSafeInteger(child.pid));
  child.unref();
  process.stdout.write(JSON.stringify({ adminPid: child.pid }) + "\n");
} finally {
  closeSync(stdout);
  if (stderr !== undefined) closeSync(stderr);
}
