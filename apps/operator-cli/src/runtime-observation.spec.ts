import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  configured: vi.fn(),
  open: vi.fn(),
  read: vi.fn(),
  sink: vi.fn(),
  captured: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@classhub/db", async (original) => ({
  ...(await original<typeof import("@classhub/db")>()),
  createConfiguredRuntimeObservation: mocks.configured,
}));
vi.mock("./mariadb/operator-database.js", () => ({ openMariaDbOperatorDatabase: mocks.open }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.read }));
import { openOperatorDatabase } from "./operator-database.js";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_ENGINE", "mariadb");
  vi.stubEnv("OPERATOR_DATABASE_TLS_MODE", "required");
  vi.stubEnv("OPERATOR_DATABASE_TLS_CA_FILE", "/ca");
  vi.stubEnv("OPERATOR_DATABASE_ACCOUNT_HOST", "%");
  mocks.configured.mockReturnValue({ sink: mocks.sink, assertCaptured: mocks.captured });
  mocks.open.mockResolvedValue({ destroy: mocks.destroy });
  mocks.destroy.mockResolvedValue(undefined);
  mocks.read.mockResolvedValue("synthetic");
  mocks.captured.mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());
it("passes operator sink through normal role opener and checks capture after it returns", async () => {
  await openOperatorDatabase("mariadb://classhub_operator:synthetic@db.example/classhub");
  expect(mocks.configured).toHaveBeenCalledWith("operator", process.env);
  expect(mocks.open.mock.calls[0]?.[1]).toMatchObject({
    onRuntimeObservation: mocks.sink,
    runtimeGrantProfile: "operator_commands_v1",
  });
  expect(mocks.captured).toHaveBeenCalledOnce();
});
it.each(["postgres", "disabled"])("rejects incompatible %s before pool creation", async (mode) => {
  if (mode === "postgres") vi.stubEnv("DATABASE_ENGINE", mode);
  else vi.stubEnv("OPERATOR_DATABASE_TLS_MODE", mode);
  await expect(
    openOperatorDatabase("mariadb://classhub_operator:synthetic@db.example/classhub"),
  ).rejects.toThrow("MARIADB_RUNTIME_OBSERVATION_FAILED");
  expect(mocks.open).not.toHaveBeenCalled();
});
it("destroys same returned pool on missing capture without exposing its error", async () => {
  mocks.captured.mockImplementation(() => {
    throw new Error("private");
  });
  await expect(
    openOperatorDatabase("mariadb://classhub_operator:synthetic@db.example/classhub"),
  ).rejects.toThrow("MARIADB_RUNTIME_OBSERVATION_FAILED");
  expect(mocks.destroy).toHaveBeenCalledOnce();
});
