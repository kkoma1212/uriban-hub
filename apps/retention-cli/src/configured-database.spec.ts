import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RetentionEnvironment } from "./environment.js";
import { openConfiguredRetentionDatabase } from "./configured-database.js";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  createPool: vi.fn(),
  openMaria: vi.fn(),
  openPg: vi.fn(),
  observation: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("@classhub/db", async (original) => ({
  ...(await original<typeof import("@classhub/db")>()),
  createMysql2MariaDbPool: mocks.createPool,
  createConfiguredRuntimeObservation: mocks.observation,
}));
vi.mock("./database.js", () => ({ openRetentionDatabase: mocks.openPg }));
vi.mock("./mariadb/database.js", () => ({ openRetentionMariaDbDatabase: mocks.openMaria }));
const environment: RetentionEnvironment = {
  databaseEngine: "mariadb",
  databaseUrl: "mariadb://classhub_retention:synthetic%2Fsecret@db.internal:3307/classhub",
  nodeEnvironment: "test",
  mariaDb: {
    tlsCaFile: "/private/ca.pem",
    tls: "required",
    accountHost: "%",
    connectionLimit: 1,
    mailLogsGrantInstalled: false,
    auditConsentsGrantInstalled: false,
    adminRecordsGrantInstalled: false,
  },
};
const database = { destroy: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.observation.mockReset().mockReturnValue(undefined);
  mocks.readFile.mockReset().mockResolvedValue("synthetic trusted CA");
  mocks.openMaria.mockReset().mockResolvedValue(database);
  mocks.openPg.mockReset().mockResolvedValue(database);
});
describe("retention configured database", () => {
  it("passes capture sink through the configured role and checks it after normal open", async () => {
    const sink = vi.fn(),
      assertCaptured = vi.fn();
    mocks.observation.mockReturnValue({ sink, assertCaptured });
    await openConfiguredRetentionDatabase(environment);
    expect(mocks.observation).toHaveBeenCalledWith("retention", process.env);
    expect(mocks.openMaria.mock.calls[0]?.[1]).toMatchObject({
      onRuntimeObservation: sink,
      user: "classhub_retention",
    });
    expect(assertCaptured).toHaveBeenCalledOnce();
  });
  it.each(["postgres", "disabled"])(
    "rejects incompatible observation %s before opening",
    async (mode) => {
      mocks.observation.mockReturnValue({ sink: vi.fn(), assertCaptured: vi.fn() });
      await expect(
        openConfiguredRetentionDatabase(
          mode === "postgres"
            ? { ...environment, databaseEngine: "postgres" }
            : { ...environment, mariaDb: { ...environment.mariaDb!, tls: "disabled" } },
        ),
      ).rejects.toThrow("MARIADB_RUNTIME_OBSERVATION_FAILED");
      expect(mocks.openMaria).not.toHaveBeenCalled();
      expect(mocks.openPg).not.toHaveBeenCalled();
    },
  );
  it("cleans the same retention pool and masks missing capture", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.openMaria.mockResolvedValue({ destroy });
    mocks.observation.mockReturnValue({
      sink: vi.fn(),
      assertCaptured: () => {
        throw new Error("private");
      },
    });
    await expect(openConfiguredRetentionDatabase(environment)).rejects.toThrow(
      "MARIADB_RUNTIME_OBSERVATION_FAILED",
    );
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("opens the actual mysql2 adapter with explicitly selected TLS options", async () => {
    await expect(openConfiguredRetentionDatabase(environment)).resolves.toBe(database);
    expect(mocks.openMaria).toHaveBeenCalledExactlyOnceWith(mocks.createPool, {
      host: "db.internal",
      port: 3307,
      database: "classhub",
      user: "classhub_retention",
      password: "synthetic/secret",
      tls: "required",
      sslCa: "synthetic trusted CA",
      accountHost: "%",
      connectionLimit: 1,
      mailLogsGrantInstalled: false,
      auditConsentsGrantInstalled: false,
      adminRecordsGrantInstalled: false,
    });
    expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith("/private/ca.pem", "utf8");
    expect(mocks.openPg).not.toHaveBeenCalled();
  });
  it("keeps PostgreSQL selection free of MariaDB file reads", async () => {
    await openConfiguredRetentionDatabase({ ...environment, databaseEngine: "postgres" });
    expect(mocks.openPg).toHaveBeenCalledExactlyOnceWith(environment.databaseUrl);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.openMaria).not.toHaveBeenCalled();
  });
  it("contains native CA path and credentials on read failure", async () => {
    mocks.readFile.mockRejectedValue(new Error("ENOENT /private/ca.pem private-password"));
    const error = await openConfiguredRetentionDatabase(environment).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ reason: "trusted_ca" });
    expect(String(error) + JSON.stringify(error)).not.toMatch(/private|ENOENT/u);
    expect(error).not.toHaveProperty("cause");
    expect(mocks.openMaria).not.toHaveBeenCalled();
  });
  it("rejects missing options and an invalid role before opening or reading the CA", async () => {
    const { mariaDb: _unused, ...missing } = environment;
    await expect(openConfiguredRetentionDatabase(missing)).rejects.toMatchObject({
      reason: "configuration",
    });
    await expect(
      openConfiguredRetentionDatabase({
        ...environment,
        databaseUrl: environment.databaseUrl.replace("classhub_retention", "classhub_app"),
      }),
    ).rejects.toMatchObject({ reason: "configuration" });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.openMaria).not.toHaveBeenCalled();
  });
  it("never falls back to PostgreSQL after MariaDB failure", async () => {
    mocks.openMaria.mockRejectedValue(new Error("safe failure"));
    await expect(openConfiguredRetentionDatabase(environment)).rejects.toThrow("safe failure");
    expect(mocks.openPg).not.toHaveBeenCalled();
  });
});
