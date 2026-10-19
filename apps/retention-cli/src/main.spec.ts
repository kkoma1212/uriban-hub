import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  run: vi.fn(),
  audit: vi.fn(),
  destroy: vi.fn(),
  delay: vi.fn(),
  environment: { databaseEngine: "mariadb", databaseUrl: "synthetic" },
  command: { target: "student-assessments", mode: "execute" },
}));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
vi.mock("./configured-database.js", () => ({ openConfiguredRetentionDatabase: mocks.open }));
vi.mock("./commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./commands.js")>()),
  runRetentionCommand: mocks.run,
}));
vi.mock("./cli-arguments.js", () => ({ parseRetentionCommand: () => mocks.command }));
vi.mock("./environment.js", () => ({ loadRetentionEnvironment: () => mocks.environment }));
vi.mock("./job-audit.js", () => ({ recordJobFailure: mocks.audit }));
const originalExitCode = process.exitCode;
const originalArgv = process.argv;
let output: string[] = [];
let errors: string[] = [];
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  output = [];
  errors = [];
  process.exitCode = undefined;
  process.argv = [...originalArgv];
  mocks.open.mockReset().mockResolvedValue({ destroy: mocks.destroy });
  mocks.run.mockReset().mockResolvedValue({ capped: false, deleted_count: 1 });
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.destroy.mockReset().mockResolvedValue(undefined);
  mocks.delay.mockReset().mockResolvedValue(undefined);
  mocks.command.mode = "execute";
  vi.spyOn(process.stdout, "write").mockImplementation((text) => {
    output.push(String(text));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((text) => {
    errors.push(String(text));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  process.argv = originalArgv;
  vi.unstubAllEnvs();
});
async function runMain() {
  await import("./main.js");
  await new Promise<void>((resolve) => setImmediate(resolve));
}
describe("retention main lifecycle", () => {
  it("holds only the live diagnostic process after closing DB and before PASS", async () => {
    process.argv = ["node", "main", "observe-database"];
    vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY", "/private");
    vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE", "a".repeat(64));
    vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_HOLD_MS", "60000");
    let finish!: () => void;
    mocks.delay.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await runMain();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.delay).toHaveBeenCalledExactlyOnceWith(60000);
    expect(mocks.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.delay.mock.invocationCallOrder[0]!,
    );
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(output).toEqual([]);
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(output).toEqual(["MARIADB_RUNTIME_OBSERVATION_PASS\n"]);
  });
  it.each(["invalid", "hold-only", "business", "cleanup", "delay"])(
    "fails closed for diagnostic window %s",
    async (kind) => {
      process.argv = [
        "node",
        "main",
        kind === "business" ? "student-assessments" : "observe-database",
      ];
      vi.stubEnv(
        "CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY",
        kind === "hold-only" ? undefined : "/private",
      );
      vi.stubEnv(
        "CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE",
        kind === "hold-only" ? undefined : "a".repeat(64),
      );
      vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_HOLD_MS", kind === "invalid" ? "60001" : "1");
      if (kind === "cleanup") mocks.destroy.mockRejectedValue(new Error("private DB"));
      if (kind === "delay") mocks.delay.mockRejectedValue(new Error("private timer"));
      await runMain();
      expect(output).toEqual([]);
      expect(errors).toEqual(["MARIADB_RUNTIME_OBSERVATION_FAILED\n"]);
      expect(mocks.run).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
      if (["invalid", "hold-only", "business"].includes(kind))
        expect(mocks.open).not.toHaveBeenCalled();
      if (kind === "cleanup") expect(mocks.delay).not.toHaveBeenCalled();
    },
  );
  it("runs exact observe-database through normal opener without jobs or audit and only prints after cleanup", async () => {
    process.argv = ["node", "main", "observe-database"];
    vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY", "/private");
    vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE", "a".repeat(64));
    await runMain();
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(mocks.environment);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(output).toEqual(["MARIADB_RUNTIME_OBSERVATION_PASS\n"]);
  });
  it.each(["extra", "normal", "cleanup"])(
    "observation %s failure has no job/audit/secret output",
    async (kind) => {
      process.argv =
        kind === "normal"
          ? ["node", "main", "student-assessments"]
          : ["node", "main", "observe-database", ...(kind === "extra" ? ["--dry-run"] : [])];
      vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY", "/private");
      vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE", "a".repeat(64));
      if (kind === "cleanup") mocks.destroy.mockRejectedValue(new Error("private"));
      await runMain();
      expect(output).toEqual([]);
      expect(errors).toEqual(["MARIADB_RUNTIME_OBSERVATION_FAILED\n"]);
      expect(mocks.run).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );
  it("keeps failed dry-runs read-only and closes the connection", async () => {
    mocks.command.mode = "dry-run";
    mocks.run.mockRejectedValue(new Error("private missing candidate schema"));
    await runMain();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(errors.join(" ")).not.toContain("private");
  });
  it("selects the configured engine, prints success and always closes", async () => {
    await runMain();
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(mocks.environment);
    expect(mocks.run).toHaveBeenCalledWith({ destroy: mocks.destroy }, mocks.command, "mariadb", {
      mailLogsGrantInstalled: false,
      auditConsentsGrantInstalled: false,
      adminRecordsGrantInstalled: false,
      classArchivesGrantProfile: "none",
    });
    expect(JSON.parse(output[0]!)).toEqual({ capped: false, deleted_count: 1 });
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("returns exit 2 for a completed capped run", async () => {
    mocks.run.mockResolvedValue({ capped: true });
    await runMain();
    expect(process.exitCode).toBe(2);
  });
  it("records failure after the job rejects and closes even when the failure audit fails", async () => {
    const failure = new Error("private job diagnostics");
    mocks.run.mockRejectedValue(failure);
    mocks.audit.mockRejectedValue(new Error("private audit SQL"));
    await runMain();
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(
      { destroy: mocks.destroy },
      "student-assessments",
      failure,
      "mariadb",
    );
    expect(mocks.audit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.destroy.mock.invocationCallOrder[0]!,
    );
    expect(errors).toHaveLength(2);
    expect(errors.join(" ")).not.toContain("private");
    expect(process.exitCode).toBe(1);
  });
  it("does not audit a job or run it when connection fails", async () => {
    mocks.open.mockRejectedValue(new Error("private connection"));
    await runMain();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(JSON.parse(errors[0]!)).toMatchObject({ error: "retention_cli_failed", job: null });
    expect(errors.join(" ")).not.toContain("private");
    expect(process.exitCode).toBe(1);
  });
});
