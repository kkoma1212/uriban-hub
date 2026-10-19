import { describe, expect, it, vi } from "vitest";
import {
  createMariaDbDatabase,
  type MariaDbConnectionOptions,
  type MariaDbPoolFactory,
} from "./connection.js";
import type { MariaDbPool } from "./guarded-driver.js";

const options = {
  host: "synthetic.invalid",
  database: "synthetic",
  user: "classhub_app",
  password: "synthetic",
  sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----",
};
const pool: MariaDbPool = {
  getConnection: () => {
    throw new Error("unit test must not connect");
  },
  end: (callback) => callback(null),
};
describe("MariaDB connection candidate", () => {
  it("pins TLS identity, single statements and lossless text conversions without forwarding extra overrides", () => {
    const factory = vi.fn(() => pool);
    createMariaDbDatabase(factory, {
      ...options,
      ...{ ssl: { rejectUnauthorized: false }, multipleStatements: true, dateStrings: false },
    });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: { ca: options.sslCa, rejectUnauthorized: true, verifyIdentity: true },
        multipleStatements: false,
        dateStrings: true,
        bigNumberStrings: true,
        supportBigNumbers: true,
        decimalNumbers: false,
        jsonStrings: true,
        timezone: "Z",
        charset: "utf8mb4_bin",
      }),
    );
  });
  it.each([
    { sslCa: "" },
    { host: " " },
    { host: "127.0.0.1" },
    { host: "::1" },
    { database: "" },
    { user: "" },
    { port: 0 },
    { port: 65536 },
    { connectionLimit: 0 },
  ])("rejects invalid connection setup before constructing a pool: %o", (invalid) => {
    const factory = vi.fn(() => pool);
    expect(() => createMariaDbDatabase(factory, { ...options, ...invalid })).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it("accepts only the reviewed worker profile without forwarding attestation options to mysql2", () => {
    const factory = vi.fn<MariaDbPoolFactory>(() => pool);
    createMariaDbDatabase(factory, {
      ...options,
      runtimeRole: "worker",
      accountHost: "%",
      runtimeGrantProfile: "worker_security_audit_v1",
    });
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[0]).not.toHaveProperty("runtimeGrantProfile");
    expect(factory.mock.calls[0]?.[0]).not.toHaveProperty("runtimeRole");
  });
  it.each([
    { runtimeRole: undefined, accountHost: undefined },
    { runtimeRole: undefined },
    { runtimeRole: "app" },
    { runtimeRole: "operator" },
    { runtimeRole: "retention" },
    { runtimeGrantProfile: "worker_security_audit_v2" },
    { runtimeGrantProfile: "" },
    { runtimeGrantProfile: null },
    { runtimeGrantProfile: 4 },
    { runtimeGrantProfile: ["worker_security_audit_v1"] },
    { runtimeGrantProfile: { privileges: ["SELECT", "INSERT"] } },
  ])("rejects profile configuration before pool creation: %o", (invalid) => {
    const factory = vi.fn(() => pool);
    const configuration = {
      ...options,
      runtimeRole: "worker",
      accountHost: "%",
      runtimeGrantProfile: "worker_security_audit_v1",
      ...invalid,
    } as unknown as MariaDbConnectionOptions;
    expect(() => createMariaDbDatabase(factory, configuration)).toThrow(
      expect.objectContaining({ reason: "configuration_rejected" }),
    );
    expect(factory).not.toHaveBeenCalled();
  });
});
