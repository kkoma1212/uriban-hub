import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvironment } from "../apps/api/dist/config/environment.js";
import { assertProjectNode } from "../OPERATIONS/native-runtime/project-node.mjs";
import { createPhonePreviewInput } from "./phone-preview-environment.mjs";

// Only this short-lived launcher reads the mixed local/admin env files. The
// serving process receives the unchanged shared keys and no ADMIN_* credentials.
assertProjectNode();
const [origin, logDirectory, mode] = process.argv.slice(2);
assert(
  origin &&
    logDirectory &&
    (process.argv.length === 4 || (process.argv.length === 5 && mode === "--check")),
);
const environment = createPhonePreviewInput(process.env, origin);
try {
  loadEnvironment(environment);
} catch {
  throw new Error("Public preview configuration was rejected before starting a process.");
}
if (mode === "--check") {
  process.stdout.write(JSON.stringify({ configurationValid: true, adminWebEnabled: false }) + "\n");
  process.exit(0);
}
const stdout = openSync(resolve(logDirectory, "api.stdout.log"), "w");
let stderr;
try {
  stderr = openSync(resolve(logDirectory, "api.stderr.log"), "w");
  const child = spawn(process.execPath, ["scripts/phone-preview-server.mjs", origin], {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    env: environment,
    stdio: ["ignore", stdout, stderr],
  });
  await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("spawn", done);
  });
  assert(Number.isSafeInteger(child.pid));
  child.unref();
  process.stdout.write(JSON.stringify({ apiPid: child.pid }) + "\n");
} finally {
  closeSync(stdout);
  if (stderr !== undefined) closeSync(stderr);
}
