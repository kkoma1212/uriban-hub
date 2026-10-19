import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerDatabase } from "./database.js";
import type { WorkerEnvironment } from "./environment.js";
import {
  createConfiguredSecurityAuditStore,
  openConfiguredWorkerDatabase,
  probeConfiguredWorkerDatabaseReadiness,
} from "./configured-database.js";
import { MariaDbSecurityAuditStore } from "./security-audit/mariadb-security-audit-store.js";
import { PostgresSecurityAuditStore } from "./security-audit/postgres-security-audit-store.js";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  createPool: vi.fn(),
  openMaria: vi.fn(),
  openPostgres: vi.fn(),
  probeMaria: vi.fn(),
  probePostgres: vi.fn(),
  configuredObservation: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("@classhub/db", async (original) => ({
  ...(await original<typeof import("@classhub/db")>()),
  createMysql2MariaDbPool: mocks.createPool,
  createConfiguredRuntimeObservation: mocks.configuredObservation,
}));
vi.mock("./database.js", () => ({
  openWorkerDatabase: mocks.openPostgres,
  probeWorkerDatabaseReadiness: mocks.probePostgres,
}));
vi.mock("./mariadb/database.js", () => ({
  openWorkerMariaDbDatabase: mocks.openMaria,
  probeWorkerMariaDbReadiness: mocks.probeMaria,
}));

const mariaEnvironment: WorkerEnvironment = {
  databaseEngine: "mariadb",
  workerDatabaseUrl:
    "mariadb://classhub_worker:synthetic%2Fsecret%40value@db.internal:3307/classhub",
  mariaDb: {
    tlsCaFile: "/private/synthetic-ca.pem",
    tls: "required",
    accountHost: "172.20.%",
    connectionLimit: 3,
  },
  nodeEnvironment: "development",
  healthHost: "127.0.0.1",
  healthPort: 3001,
  logLevel: "info",
  redisUrl: "redis://127.0.0.1:6379",
};
const postgresEnvironment: WorkerEnvironment = {
  ...mariaEnvironment,
  databaseEngine: "postgres",
  workerDatabaseUrl: "postgresql://classhub_worker:synthetic@db.internal/classhub",
};
const database = { transaction: vi.fn() } as unknown as WorkerDatabase;
const ca = "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configuredObservation.mockReset().mockReturnValue(undefined);
  mocks.readFile.mockReset().mockResolvedValue(ca);
  mocks.openMaria.mockReset().mockResolvedValue(database);
  mocks.openPostgres.mockReset().mockResolvedValue(database);
  mocks.probeMaria.mockReset().mockResolvedValue(undefined);
  mocks.probePostgres.mockReset().mockResolvedValue(undefined);
});

describe("configured worker database selection", () => {
  it("passes opt-in sink through the normal worker opener and asserts the same pool capture", async () => {
    const sink = vi.fn(),
      assertCaptured = vi.fn();
    const input = {
      CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY: "/private",
      CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE: "a".repeat(64),
    };
    mocks.configuredObservation.mockReturnValue({ sink, assertCaptured });
    await openConfiguredWorkerDatabase(mariaEnvironment, undefined, input);
    expect(mocks.configuredObservation).toHaveBeenCalledWith("worker", input);
    expect(mocks.openMaria.mock.calls[0]?.[1]).toMatchObject({
      onRuntimeObservation: sink,
      runtimeGrantProfile: "worker_security_audit_v1",
    });
    expect(assertCaptured).toHaveBeenCalledOnce();
  });
  it.each(["postgres", "disabled"])(
    "rejects opt-in incompatible %s before opening",
    async (mode) => {
      mocks.configuredObservation.mockReturnValue({ sink: vi.fn(), assertCaptured: vi.fn() });
      const environment =
        mode === "postgres"
          ? postgresEnvironment
          : {
              ...mariaEnvironment,
              mariaDb: { ...mariaEnvironment.mariaDb!, tls: "disabled" as const },
            };
      await expect(openConfiguredWorkerDatabase(environment)).rejects.toThrow(
        "MARIADB_RUNTIME_OBSERVATION_FAILED",
      );
      expect(mocks.openMaria).not.toHaveBeenCalled();
      expect(mocks.openPostgres).not.toHaveBeenCalled();
    },
  );
  it("cleans the returned worker pool and masks missing capture", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.openMaria.mockResolvedValue({ destroy });
    mocks.configuredObservation.mockReturnValue({
      sink: vi.fn(),
      assertCaptured: () => {
        throw new Error("private");
      },
    });
    await expect(openConfiguredWorkerDatabase(mariaEnvironment)).rejects.toThrow(
      "MARIADB_RUNTIME_OBSERVATION_FAILED",
    );
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("reads the CA and calls the product mysql2 opener with the fixed reviewed worker profile", async () => {
    const observer = vi.fn();
    await expect(openConfiguredWorkerDatabase(mariaEnvironment, observer)).resolves.toBe(database);
    expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith("/private/synthetic-ca.pem", "utf8");
    expect(mocks.openMaria).toHaveBeenCalledExactlyOnceWith(
      mocks.createPool,
      {
        host: "db.internal",
        port: 3307,
        user: "classhub_worker",
        password: "synthetic/secret@value",
        database: "classhub",
        accountHost: "172.20.%",
        connectionLimit: 3,
        tls: "required",
        sslCa: ca,
        runtimeGrantProfile: "worker_security_audit_v1",
      },
      observer,
    );
    expect(mocks.openPostgres).not.toHaveBeenCalled();
    expect(mocks.createPool).not.toHaveBeenCalled();
  });
  it("does not pass additional unreviewed MariaDB options into the opener", async () => {
    await openConfiguredWorkerDatabase({
      ...mariaEnvironment,
      mariaDb: {
        ...mariaEnvironment.mariaDb!,
        ...{ runtimeGrantProfile: "unreviewed", runtimeRole: "app", ssl: false },
      },
    });
    const options = mocks.openMaria.mock.calls[0]![1];
    expect(options).toHaveProperty("runtimeGrantProfile", "worker_security_audit_v1");
    expect(options).not.toHaveProperty("runtimeRole");
    expect(options).not.toHaveProperty("ssl");
  });
  it("uses the PostgreSQL opener without reading the unused MariaDB CA", async () => {
    const observer = vi.fn();
    await expect(openConfiguredWorkerDatabase(postgresEnvironment, observer)).resolves.toBe(
      database,
    );
    expect(mocks.openPostgres).toHaveBeenCalledExactlyOnceWith(
      postgresEnvironment.workerDatabaseUrl,
      observer,
    );
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.openMaria).not.toHaveBeenCalled();
  });
  it("rejects absent MariaDB configuration before reading a CA or opening a database", async () => {
    const { mariaDb: _unused, ...missing } = mariaEnvironment;
    await expect(openConfiguredWorkerDatabase(missing)).rejects.toThrow(
      "Worker MariaDB environment is missing",
    );
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.openMaria).not.toHaveBeenCalled();
    expect(mocks.openPostgres).not.toHaveBeenCalled();
  });
  it("contains a native CA read failure without leaking its path or cause", async () => {
    mocks.readFile.mockRejectedValue(
      Object.assign(new Error("EACCES /private/synthetic-ca.pem private-token"), {
        path: "/private/synthetic-ca.pem",
      }),
    );
    const error: unknown = await openConfiguredWorkerDatabase(mariaEnvironment).catch(
      (error: unknown) => error,
    );
    expect(String(error)).toBe("Error: Worker MariaDB trusted CA file could not be read.");
    expect(String(error) + JSON.stringify(error)).not.toMatch(/private|synthetic-ca|EACCES/u);
    expect(error).not.toHaveProperty("cause");
    expect(mocks.openMaria).not.toHaveBeenCalled();
  });
  it("rejects an invalid worker URL before calling the MariaDB opener without exposing credentials", async () => {
    const error: unknown = await openConfiguredWorkerDatabase({
      ...mariaEnvironment,
      workerDatabaseUrl: "mariadb://classhub_app:private%2Fpassword@private.internal/classhub",
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error) + JSON.stringify(error)).not.toMatch(/private|classhub_app/u);
    expect(error).not.toHaveProperty("cause");
    expect(mocks.openMaria).not.toHaveBeenCalled();
    expect(mocks.openPostgres).not.toHaveBeenCalled();
  });
  it.each(["mariadb", "postgres"] as const)(
    "selects matching %s readiness and store implementations",
    async (engine) => {
      const environment = engine === "mariadb" ? mariaEnvironment : postgresEnvironment;
      const selected = engine === "mariadb" ? mocks.probeMaria : mocks.probePostgres;
      const other = engine === "mariadb" ? mocks.probePostgres : mocks.probeMaria;
      const promise = Promise.resolve();
      selected.mockReturnValue(promise);
      expect(probeConfiguredWorkerDatabaseReadiness(database, environment)).toBe(promise);
      await promise;
      expect(selected).toHaveBeenCalledExactlyOnceWith(database);
      expect(other).not.toHaveBeenCalled();
      expect(createConfiguredSecurityAuditStore(database, environment)).toBeInstanceOf(
        engine === "mariadb" ? MariaDbSecurityAuditStore : PostgresSecurityAuditStore,
      );
      expect(database.transaction).not.toHaveBeenCalled();
    },
  );
  it("never falls back to PostgreSQL after a MariaDB opener or readiness failure", async () => {
    const failure = new Error("safe MariaDB failure");
    mocks.openMaria.mockRejectedValue(failure);
    await expect(openConfiguredWorkerDatabase(mariaEnvironment)).rejects.toBe(failure);
    mocks.probeMaria.mockRejectedValue(failure);
    await expect(probeConfiguredWorkerDatabaseReadiness(database, mariaEnvironment)).rejects.toBe(
      failure,
    );
    expect(mocks.openPostgres).not.toHaveBeenCalled();
    expect(mocks.probePostgres).not.toHaveBeenCalled();
  });
});
