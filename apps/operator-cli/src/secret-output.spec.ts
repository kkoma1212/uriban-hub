import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INTERACTIVE_SECRET_OUTPUT_REQUIRED,
  renderBootstrapSecretOutput,
  renderTeacherPasswordResetOutput,
  renderTeacherProvisionOutput,
  runInteractiveSecretCommand,
} from "./secret-output.js";

const MAIN_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));
const SECRET_MARKER = "unit-secret-marker";
const TSX_IMPORT = import.meta.resolve("tsx");

let restoreStdoutTty: (() => void) | undefined;

function setStdoutTty(isTTY: boolean): void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: isTTY,
  });
  restoreStdoutTty = () => {
    if (previousDescriptor === undefined) {
      delete (process.stdout as Partial<NodeJS.WriteStream>).isTTY;
      return;
    }
    Object.defineProperty(process.stdout, "isTTY", previousDescriptor);
  };
}

function runCli(args: readonly string[]) {
  const environment = { ...process.env };
  delete environment.OPERATOR_BOOTSTRAP_SECRET;
  delete environment.OPERATOR_DATABASE_URL;

  return spawnSync(process.execPath, ["--import", TSX_IMPORT, MAIN_PATH, ...args], {
    encoding: "utf8",
    env: environment,
    windowsHide: true,
    timeout: 10_000,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreStdoutTty?.();
  restoreStdoutTty = undefined;
});

describe("interactive secret output boundary", () => {
  it("rejects non-TTY output before mutation without writing the secret", async () => {
    setStdoutTty(false);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const mutate = vi.fn(async () => ({ secret: SECRET_MARKER }));
    const render = vi.fn((result: { secret: string }) => `SECRET=${result.secret}\n`);

    await expect(runInteractiveSecretCommand(mutate, render)).rejects.toThrow(
      INTERACTIVE_SECRET_OUTPUT_REQUIRED,
    );

    expect(mutate).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it("writes an interactive result once and preserves its one-time secret guidance", async () => {
    setStdoutTty(true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const mutate = vi.fn(async () => ({
      email: "operator@example.com",
      operatorId: "operator-id",
      rawToken: SECRET_MARKER,
      runId: "run-id",
    }));

    await runInteractiveSecretCommand(mutate, renderBootstrapSecretOutput);

    expect(mutate).toHaveBeenCalledOnce();
    expect(stdoutWrite).toHaveBeenCalledOnce();
    const output = String(stdoutWrite.mock.calls[0]?.[0]);
    expect(output.split(SECRET_MARKER)).toHaveLength(2);
    expect(output).toContain("다시 표시되지 않습니다.");
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it.each([
    [
      "teacher provision",
      renderTeacherProvisionOutput({
        created: true,
        displayName: "담임 선생님",
        email: "teacher@example.com",
        rawTemporaryPassword: SECRET_MARKER,
        runId: "run-id",
        temporaryPasswordExpiresAt: new Date("2026-08-31T00:00:00.000Z"),
        userId: "teacher-id",
      }),
    ],
    [
      "teacher password reset",
      renderTeacherPasswordResetOutput({
        email: "teacher@example.com",
        rawTemporaryPassword: SECRET_MARKER,
        revokedSessionCount: 1,
        runId: "run-id",
        temporaryPasswordExpiresAt: new Date("2026-08-31T00:00:00.000Z"),
        userId: "teacher-id",
      }),
    ],
  ])("renders the %s secret and one-time guidance exactly once", (_command, output) => {
    expect(output.split(SECRET_MARKER)).toHaveLength(2);
    expect(output.match(/다시 표시되지 않습니다\./gu)).toHaveLength(1);
  });

  it("keeps an idempotent teacher provision result free of a secret field", () => {
    const output = renderTeacherProvisionOutput({
      created: false,
      displayName: "담임 선생님",
      email: "teacher@example.com",
      rawTemporaryPassword: null,
      runId: null,
      temporaryPasswordExpiresAt: null,
      userId: "teacher-id",
    });

    expect(output).not.toContain("TEMPORARY_PASSWORD=");
  });
});

describe("operator CLI non-interactive boundary", () => {
  it.each([
    ["bootstrap-operator", ["bootstrap-operator", "--email", "operator@example.com"]],
    [
      "provision-teacher",
      ["provision-teacher", "--email", "teacher@example.com", "--display-name", "담임 선생님"],
    ],
    ["reset-teacher-password", ["reset-teacher-password", "--email", "teacher@example.com"]],
  ])("fails closed for %s before reading credentials or writing secrets", (_command, args) => {
    const result = runCli(args);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(INTERACTIVE_SECRET_OUTPUT_REQUIRED);
    expect(result.stderr).not.toContain("Operator token:");
    expect(`${result.stdout}${result.stderr}`).not.toContain("OPERATOR_TOKEN=");
    expect(`${result.stdout}${result.stderr}`).not.toContain("TEMPORARY_PASSWORD=");
  });

  it("keeps a non-secret help command available with piped stdout", () => {
    const result = runCli(["--help"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("우리반 허브 운영 CLI");
    expect(result.stderr).toBe("");
  });

  it("keeps a non-secret dry-run command on its normal non-TTY validation path", () => {
    const result = runCli(["sync-neis-schools", "--dry-run"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("OPERATOR_DATABASE_URL");
    expect(result.stderr).not.toContain(INTERACTIVE_SECRET_OUTPUT_REQUIRED);
  });
});
