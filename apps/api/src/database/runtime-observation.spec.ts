import { ConfigService } from "@nestjs/config";
import { beforeEach, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../config/environment.js";
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
vi.mock("./mariadb-database.js", () => ({ openApiMariaDbDatabase: mocks.open }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.read }));
import { openConfiguredApplicationDatabase } from "./database.module.js";
const env = {
  CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY: "/private",
  CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE: "a".repeat(64),
};
const config = (extra = {}) =>
  new ConfigService<AppEnvironment, true>({
    DATABASE_ENGINE: "mariadb",
    DATABASE_URL: "mariadb://classhub_app:synthetic@db.example/classhub",
    DATABASE_TLS_MODE: "required",
    DATABASE_TLS_CA_FILE: "/ca",
    DATABASE_ACCOUNT_HOST: "%",
    API_SURFACE: "user",
    ...extra,
  } as AppEnvironment);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.configured.mockReturnValue({ sink: mocks.sink, assertCaptured: mocks.captured });
  mocks.open.mockResolvedValue({ destroy: mocks.destroy });
  mocks.destroy.mockResolvedValue(undefined);
  mocks.read.mockResolvedValue("synthetic");
  mocks.captured.mockImplementation(() => {});
});
it.each(["user", "admin"])(
  "binds %s API to its real configured pool and asserts capture after open",
  async (surface) => {
    await openConfiguredApplicationDatabase(config({ API_SURFACE: surface }), env);
    expect(mocks.configured).toHaveBeenCalledWith(`${surface}-api`, env);
    expect(mocks.open.mock.calls[0]?.[1]).toMatchObject({
      onRuntimeObservation: mocks.sink,
      user: "classhub_app",
    });
    expect(mocks.open.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.captured.mock.invocationCallOrder[0]!,
    );
    expect(mocks.destroy).not.toHaveBeenCalled();
  },
);
it.each([
  { API_SURFACE: "all" },
  { DATABASE_ENGINE: "postgres" },
  { DATABASE_TLS_MODE: "disabled" },
])("rejects incompatible opt-in before pool creation", async (extra) => {
  await expect(openConfiguredApplicationDatabase(config(extra), env)).rejects.toThrow(
    "MARIADB_RUNTIME_OBSERVATION_FAILED",
  );
  expect(mocks.open).not.toHaveBeenCalled();
});
it("destroys the same returned pool when capture is absent", async () => {
  mocks.captured.mockImplementation(() => {
    throw new Error("private");
  });
  await expect(openConfiguredApplicationDatabase(config(), env)).rejects.toThrow(
    "MARIADB_RUNTIME_OBSERVATION_FAILED",
  );
  expect(mocks.destroy).toHaveBeenCalledOnce();
});
it("real helper rejects incomplete and unsupported Windows opt-in before any pool", async () => {
  const actual = await vi.importActual<typeof import("@classhub/db")>("@classhub/db");
  mocks.configured.mockImplementation(actual.createConfiguredRuntimeObservation);
  await expect(
    openConfiguredApplicationDatabase(config(), {
      CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY: "/private",
    }),
  ).rejects.toMatchObject({ code: "MARIADB_RUNTIME_OBSERVATION_FAILED" });
  if (process.platform === "win32")
    await expect(openConfiguredApplicationDatabase(config(), env)).rejects.toMatchObject({
      code: "MARIADB_RUNTIME_OBSERVATION_FAILED",
    });
  expect(mocks.open).not.toHaveBeenCalled();
});
