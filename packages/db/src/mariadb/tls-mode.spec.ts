import { describe, expect, it, vi } from "vitest";
import {
  createMariaDbDatabase,
  parseMariaDbTlsMode,
  type MariaDbPoolConfiguration,
  type MariaDbPoolFactory,
} from "./connection.js";
import { parseMariaDbRuntimeGrants } from "./runtime-grants.js";
import { attestMariaDbRuntimeConnection, type MariaDbRuntimeIdentity } from "./runtime-role.js";

// 2026-10-07 사용자 승인: DB가 같은 서버·내부망에 있을 때 운영자가 TLS를 명시적으로 끌 수 있다.
// 기본(required)은 한 글자도 느슨해지지 않아야 하고, 꺼도 계정·버전·권한 대조는 그대로여야 한다.
const CA = "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n";
const base = { host: "db.internal", database: "qa", user: "qa_worker", password: "synthetic" };
const pool = () => ({ on: vi.fn(), getConnection: vi.fn(), end: vi.fn() });
const usage = (tail: string) => ({
  grant: "GRANT USAGE ON *.* TO `qa_worker`@`%` IDENTIFIED BY PASSWORD '*" + "A".repeat(40) + tail,
});
const tableGrant = {
  grant: "GRANT SELECT, INSERT ON `qa`.`security_audit_logs` TO `qa_worker`@`%`",
};
const identityRow = {
  account: "qa_worker@%",
  login_user: "qa_worker@172.20.0.2",
  database_name: "qa",
  active_role: null,
  server_version: "11.4.13-MariaDB-ubu2404",
  ssl_cipher: "",
  applicable_roles: 0,
  enabled_roles: 0,
};
const expected: MariaDbRuntimeIdentity = {
  role: "worker",
  user: "qa_worker",
  accountHost: "%",
  database: "qa",
};
const query = (row: object, grants: unknown[], publicGrants: unknown[] = []) =>
  vi.fn(async (statement: string) =>
    statement.startsWith("SELECT CURRENT_USER")
      ? [row]
      : statement === "SHOW GRANTS FOR PUBLIC"
        ? publicGrants
        : grants,
  );

describe("MariaDB TLS mode switch", () => {
  it("reads only required, disabled or an unset value", () => {
    expect(parseMariaDbTlsMode(undefined, "X")).toBe("required");
    expect(parseMariaDbTlsMode("", "X")).toBe("required");
    expect(parseMariaDbTlsMode("required", "X")).toBe("required");
    expect(parseMariaDbTlsMode("disabled", "X")).toBe("disabled");
    for (const value of ["off", "false", "Disabled", "none", "0"])
      expect(() => parseMariaDbTlsMode(value, "X")).toThrow("X must be required or disabled.");
  });

  it("keeps the default strict: no CA or an IP host is rejected unless TLS is explicitly disabled", () => {
    const createPool = vi.fn(pool);
    expect(() => createMariaDbDatabase(createPool, { ...base })).toThrow("trusted CA");
    expect(() => createMariaDbDatabase(createPool, { ...base, tls: "required" })).toThrow(
      "trusted CA",
    );
    expect(() =>
      createMariaDbDatabase(createPool, { ...base, host: "10.0.0.5", sslCa: CA }),
    ).toThrow("DNS host name");
    expect(() =>
      createMariaDbDatabase(createPool, { ...base, tls: "off" as never, sslCa: CA }),
    ).toThrow("TLS mode is invalid");
    expect(createPool).not.toHaveBeenCalled();
  });

  it("passes the pinned TLS settings by default and none when disabled", () => {
    const seen: MariaDbPoolConfiguration[] = [];
    const createPool: MariaDbPoolFactory = (configuration) => {
      seen.push(configuration);
      return pool() as never;
    };
    createMariaDbDatabase(createPool, { ...base, sslCa: CA });
    expect(seen[0]?.ssl).toEqual({ ca: CA, rejectUnauthorized: true, verifyIdentity: true });
    createMariaDbDatabase(createPool, { ...base, host: "10.0.0.5", tls: "disabled" });
    expect(seen[1]).not.toHaveProperty("ssl");
    expect(seen[1]?.multipleStatements).toBe(false);
  });

  it("rejects a CA supplied together with disabled TLS instead of ignoring it", () => {
    const createPool = vi.fn(pool);
    expect(() =>
      createMariaDbDatabase(createPool, { ...base, tls: "disabled", sslCa: CA }),
    ).toThrow("must not be supplied");
    expect(createPool).not.toHaveBeenCalled();
  });

  it("accepts an account without REQUIRE SSL only when TLS is disabled", () => {
    const rows = [usage("'"), tableGrant];
    const identity = { database: "qa", user: "qa_worker", accountHost: "%" };
    expect(() => parseMariaDbRuntimeGrants(rows, identity)).toThrow();
    expect(() => parseMariaDbRuntimeGrants(rows, { ...identity, tls: "required" })).toThrow();
    expect(parseMariaDbRuntimeGrants(rows, { ...identity, tls: "disabled" })).toHaveLength(2);
    // 꺼도 REQUIRE SSL이 붙은 계정은 그대로 받고, 그 밖의 꼬리는 여전히 거절한다.
    expect(
      parseMariaDbRuntimeGrants([usage("' REQUIRE SSL"), tableGrant], {
        ...identity,
        tls: "disabled",
      }),
    ).toHaveLength(2);
    for (const tail of ["' REQUIRE X509", "' WITH GRANT OPTION", "' REQUIRE SSL WITH GRANT OPTION"])
      expect(() =>
        parseMariaDbRuntimeGrants([usage(tail), tableGrant], { ...identity, tls: "disabled" }),
      ).toThrow();
  });

  it("skips only the encryption check when disabled; identity, version, PUBLIC and grants still decide", async () => {
    const grants = [usage("'"), tableGrant];
    const disabled: MariaDbRuntimeIdentity = { ...expected, tls: "disabled" };
    // 암호화되지 않은 접속 + REQUIRE SSL 없는 계정: 기본에서는 거절, 끈 경우에만 통과.
    await expect(
      attestMariaDbRuntimeConnection(query(identityRow, grants), expected),
    ).rejects.toThrow();
    await expect(
      attestMariaDbRuntimeConnection(query(identityRow, grants), disabled),
    ).resolves.toBeUndefined();
    // 끈 상태에서도 나머지 검사는 그대로 막는다.
    await expect(
      attestMariaDbRuntimeConnection(
        query({ ...identityRow, server_version: "10.4.34-MariaDB" }, grants),
        disabled,
      ),
    ).rejects.toThrow();
    await expect(
      attestMariaDbRuntimeConnection(
        query({ ...identityRow, account: "root@%" }, grants),
        disabled,
      ),
    ).rejects.toThrow();
    await expect(
      attestMariaDbRuntimeConnection(
        query(identityRow, grants, [{ grant: "GRANT SELECT ON *.* TO PUBLIC" }]),
        disabled,
      ),
    ).rejects.toThrow();
    await expect(
      attestMariaDbRuntimeConnection(
        query(identityRow, [
          ...grants,
          { grant: "GRANT DELETE ON `qa`.`security_audit_logs` TO `qa_worker`@`%`" },
        ]),
        disabled,
      ),
    ).rejects.toThrow();
  });

  it("rejects an unknown TLS mode on the identity", async () => {
    await expect(
      attestMariaDbRuntimeConnection(query(identityRow, [usage("'"), tableGrant]), {
        ...expected,
        tls: "off" as never,
      }),
    ).rejects.toThrow();
  });
});
