import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { assertProductionDatabaseUrl } from "@classhub/db";

const require = createRequire(import.meta.url);
const migrationCliPath = require.resolve("node-pg-migrate/bin/node-pg-migrate");
const databaseUrlVariable = "MIGRATOR_DATABASE_URL";
const requestedArguments = process.argv.slice(2);
const informationalCommand =
  requestedArguments.length === 1 &&
  (requestedArguments[0] === "--help" || requestedArguments[0] === "--version");

function rejectStartup(message) {
  console.error(`migrator startup rejected: ${message}`);
  process.exit(1);
}

function hasExactArguments(expectedArguments) {
  return (
    requestedArguments.length === expectedArguments.length &&
    requestedArguments.every((argument, index) => argument === expectedArguments[index])
  );
}

let effectiveArguments;
if (informationalCommand) {
  effectiveArguments = requestedArguments;
} else {
  const productionUp = hasExactArguments(["up"]);
  const productionDryRun = hasExactArguments(["up", "--dry-run"]);
  if (!productionUp && !productionDryRun) {
    rejectStartup("migrator only permits up or up --dry-run");
  }

  const databaseUrl = process.env[databaseUrlVariable];
  if (!databaseUrl || databaseUrl.trim() === "") {
    rejectStartup(`${databaseUrlVariable} is required`);
  }

  try {
    assertProductionDatabaseUrl(databaseUrl, {
      environment: process.env,
      expectedUsername: "classhub_migrator",
      variableName: databaseUrlVariable,
    });
  } catch (error) {
    rejectStartup(error instanceof Error ? error.message : `${databaseUrlVariable} is invalid`);
  }

  effectiveArguments = [
    "up",
    "--database-url-var",
    databaseUrlVariable,
    "--migrations-dir",
    "db/migrations",
    ...(productionDryRun ? ["--dry-run"] : []),
  ];
}

const child = spawn(process.execPath, [migrationCliPath, ...effectiveArguments], {
  env: process.env,
  stdio: "inherit",
});

let forwardedSignal;
const forwardSignal = (signal) => {
  forwardedSignal = signal;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
};
const onSigint = () => forwardSignal("SIGINT");
const onSigterm = () => forwardSignal("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

await new Promise((resolve) => {
  let settled = false;
  const finish = (exitCode) => {
    if (settled) return;
    settled = true;
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.exitCode = exitCode;
    resolve();
  };

  child.once("error", () => {
    console.error("migrator process failed to start");
    finish(1);
  });
  child.once("exit", (code, signal) => {
    if (code !== null) {
      finish(code);
      return;
    }
    const terminalSignal = signal ?? forwardedSignal;
    finish(terminalSignal === "SIGINT" ? 130 : terminalSignal === "SIGTERM" ? 143 : 1);
  });
});
