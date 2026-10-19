import { beforeEach, describe, expect, it, vi } from "vitest";
import { openRetentionMariaDbDatabase } from "./database.js";
const mocks = vi.hoisted(() => ({
  createDatabase: vi.fn(),
  boundedPool: vi.fn(),
  executeQuery: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@classhub/db", async (original) => ({
  ...(await original<typeof import("@classhub/db")>()),
  createMariaDbDatabase: mocks.createDatabase,
  boundedMariaDbPoolFactory: mocks.boundedPool,
}));
const options = {
  host: "db.internal",
  database: "classhub",
  user: "classhub_retention",
  password: "synthetic",
  sslCa: "synthetic trusted CA",
  accountHost: "%",
  connectionLimit: 1,
};
const createPool = vi.fn();
const wrappedPool = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeQuery.mockReset().mockResolvedValue({ rows: [{ ready: 1 }] });
  mocks.destroy.mockReset().mockResolvedValue(undefined);
  mocks.createDatabase.mockReset().mockReturnValue({
    getExecutor: () => ({
      transformQuery: (node: unknown) => node,
      compileQuery: () => ({}),
      executeQuery: mocks.executeQuery,
    }),
    destroy: mocks.destroy,
  });
  mocks.boundedPool.mockReset().mockReturnValue(wrappedPool);
});
describe("retention MariaDB opener boundary", () => {
  it.each(["active", "legacy"] as const)(
    "attests the explicit %s archive grant profile",
    async (classArchivesGrantProfile) => {
      await openRetentionMariaDbDatabase(createPool, {
        ...options,
        mailLogsGrantInstalled: true,
        auditConsentsGrantInstalled: true,
        adminRecordsGrantInstalled: true,
        classArchivesGrantProfile,
      });
      expect(mocks.createDatabase.mock.calls[0]?.[1]?.runtimeGrantProfile).toBe(
        classArchivesGrantProfile === "legacy"
          ? "retention_class_archives_legacy_v1"
          : "retention_class_archives_v1",
      );
    },
  );
  it("fixes strict retention_v1 and the shared 10-second query profile", async () => {
    await openRetentionMariaDbDatabase(createPool, {
      ...options,
      ...{ runtimeRole: "worker", runtimeGrantProfile: "worker_security_audit_v1" },
    });
    expect(mocks.boundedPool).toHaveBeenCalledWith(
      createPool,
      expect.any(Function),
      undefined,
      expect.any(Function),
      10000,
    );
    expect(mocks.boundedPool.mock.calls[0]![1]()).toBe(false);
    expect(mocks.createDatabase).toHaveBeenCalledExactlyOnceWith(wrappedPool, {
      ...options,
      runtimeRole: "retention",
      runtimeGrantProfile: "retention_v1",
    });
    expect(mocks.destroy).not.toHaveBeenCalled();
  });
  it("attests the mail log grant set only when the grant is marked installed (I5-04)", async () => {
    await openRetentionMariaDbDatabase(createPool, { ...options, mailLogsGrantInstalled: true });
    expect(mocks.createDatabase).toHaveBeenCalledExactlyOnceWith(wrappedPool, {
      ...options,
      runtimeRole: "retention",
      runtimeGrantProfile: "retention_mail_logs_v1",
    });
  });
  it("attests the audit/consent grant set when that grant is marked installed (I3-01)", async () => {
    await openRetentionMariaDbDatabase(createPool, {
      ...options,
      mailLogsGrantInstalled: true,
      auditConsentsGrantInstalled: true,
    });
    expect(mocks.createDatabase).toHaveBeenCalledExactlyOnceWith(wrappedPool, {
      ...options,
      runtimeRole: "retention",
      runtimeGrantProfile: "retention_audit_consents_v1",
    });
  });
  it("attests the admin record grant set when that grant is marked installed (2026-10-04)", async () => {
    await openRetentionMariaDbDatabase(createPool, {
      ...options,
      mailLogsGrantInstalled: true,
      auditConsentsGrantInstalled: true,
      adminRecordsGrantInstalled: true,
    });
    expect(mocks.createDatabase).toHaveBeenCalledExactlyOnceWith(wrappedPool, {
      ...options,
      runtimeRole: "retention",
      runtimeGrantProfile: "retention_admin_records_v1",
    });
  });
  it("rejects a failed readiness/attestation lease and destroys the pool without native diagnostics", async () => {
    mocks.executeQuery.mockRejectedValue(new Error("private SQL URL path"));
    const error = await openRetentionMariaDbDatabase(createPool, options).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ reason: "role" });
    expect(String(error) + JSON.stringify(error)).not.toContain("private");
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
  it("reports cleanup failure safely", async () => {
    mocks.executeQuery.mockRejectedValue(new Error("private"));
    mocks.destroy.mockRejectedValue(new Error("private cleanup"));
    await expect(openRetentionMariaDbDatabase(createPool, options)).rejects.toMatchObject({
      reason: "cleanup",
    });
  });
  it("rejects pool/configuration failure before a database exists", async () => {
    mocks.createDatabase.mockImplementation(() => {
      throw new Error("private config");
    });
    await expect(openRetentionMariaDbDatabase(createPool, options)).rejects.toMatchObject({
      reason: "configuration",
    });
    expect(mocks.destroy).not.toHaveBeenCalled();
  });
});
