import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  destroy: vi.fn(),
  prompt: vi.fn(),
  importMeals: vi.fn(),
  delay: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
vi.mock("./operator-database.js", async (original) => ({
  ...(await original<typeof import("./operator-database.js")>()),
  openOperatorDatabase: mocks.open,
}));
vi.mock("node:readline", () => ({ createInterface: mocks.prompt }));
vi.mock("./meal-import.js", () => ({ importMeals: mocks.importMeals }));
const originalArgv = process.argv,
  originalExit = process.exitCode;
let output: string[], errors: string[];
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  output = [];
  errors = [];
  process.exitCode = undefined;
  mocks.open.mockResolvedValue({ destroy: mocks.destroy });
  mocks.destroy.mockResolvedValue(undefined);
  mocks.delay.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY", "/private");
  vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE", "a".repeat(64));
  vi.spyOn(process.stdout, "write").mockImplementation((value) => {
    output.push(String(value));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((value) => {
    errors.push(String(value));
    return true;
  });
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function run(args: string[]) {
  process.argv = ["node", "main", ...args];
  await import("./main.js");
  await new Promise<void>((resolve) => setImmediate(resolve));
}
it("exact observation command uses configured operator pool and cleans before PASS without token prompt or work", async () => {
  await run(["observe-database"]);
  expect(mocks.open).toHaveBeenCalledOnce();
  expect(mocks.destroy).toHaveBeenCalledOnce();
  expect(output).toEqual(["MARIADB_RUNTIME_OBSERVATION_PASS\n"]);
  expect(mocks.prompt).not.toHaveBeenCalled();
  expect(mocks.importMeals).not.toHaveBeenCalled();
});
it.each(["extra", "unknown", "normal", "cleanup", "open"])(
  "rejects observation %s without private errors, token prompt or business execution",
  async (kind) => {
    if (kind === "cleanup") mocks.destroy.mockRejectedValue(new Error("private"));
    if (kind === "open") mocks.open.mockRejectedValue(new Error("private"));
    await run(
      kind === "normal"
        ? ["import-meals"]
        : [
            "observe-database",
            ...(kind === "extra"
              ? ["--dry-run"]
              : kind === "unknown"
                ? ["--private-invalid-option"]
                : []),
          ],
    );
    expect(output).toEqual([]);
    expect(errors).toEqual(["MARIADB_RUNTIME_OBSERVATION_FAILED\n"]);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.importMeals).not.toHaveBeenCalled();
  },
);
it("keeps only the diagnostic main process alive after closing DB and reports success after the bounded window", async () => {
  vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_HOLD_MS", "60000");
  let finish!: () => void;
  mocks.delay.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await run(["observe-database"]);
  expect(mocks.destroy).toHaveBeenCalledOnce();
  expect(mocks.delay).toHaveBeenCalledExactlyOnceWith(60000);
  expect(mocks.destroy.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.delay.mock.invocationCallOrder[0]!,
  );
  expect(output).toEqual([]);
  expect(mocks.prompt).not.toHaveBeenCalled();
  expect(mocks.importMeals).not.toHaveBeenCalled();
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(output).toEqual(["MARIADB_RUNTIME_OBSERVATION_PASS\n"]);
});
it.each(["invalid", "hold-only", "business", "cleanup", "delay"])(
  "fails closed for inspection window %s",
  async (kind) => {
    vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_HOLD_MS", kind === "invalid" ? "60001" : "1");
    if (kind === "hold-only") {
      vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY", undefined);
      vi.stubEnv("CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE", undefined);
    }
    if (kind === "cleanup") mocks.destroy.mockRejectedValue(new Error("private DB"));
    if (kind === "delay") mocks.delay.mockRejectedValue(new Error("private timer"));
    await run(kind === "business" ? ["import-meals", "--private-option"] : ["observe-database"]);
    expect(output).toEqual([]);
    expect(errors).toEqual(["MARIADB_RUNTIME_OBSERVATION_FAILED\n"]);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.importMeals).not.toHaveBeenCalled();
    if (["invalid", "hold-only", "business"].includes(kind))
      expect(mocks.open).not.toHaveBeenCalled();
    if (kind === "cleanup") expect(mocks.delay).not.toHaveBeenCalled();
  },
);
